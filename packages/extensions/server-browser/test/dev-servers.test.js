import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  createDevServerScanner,
  devServerGrants,
  excludedProcesses,
  parseLsofListeners,
  parseProcListeners,
} from '../src/dev-servers.js';

// host 100 runs OpenCode 200, this service 300, and a terminal shell 400.
// The shell runs a dev server 500; the service runs Chrome 310 and its renderer 311.
const parents = new Map([[200, 100], [300, 100], [400, 100], [500, 400], [310, 300], [311, 310]]);

test('parses lsof and proc listener tables into loopback listeners', () => {
  assert.deepEqual(parseLsofListeners('p500\ncnode\nn*:5173\nn127.0.0.1:5173\np200\ncopencode\nn127.0.0.1:37737\nn10.0.0.2:8080\nn127.0.0.1:5000->127.0.0.1:6000\n'), [
    { port: 5173, pid: 500, hosts: ['127.0.0.1', '::1'], inode: null },
    { port: 5173, pid: 500, hosts: ['127.0.0.1'], inode: null },
    { port: 37737, pid: 200, hosts: ['127.0.0.1'], inode: null },
    { port: 8080, pid: 200, hosts: [], inode: null },
  ]);
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1',
    '   1: 00000000:9335 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1',
    '   2: 0100007F:C000 0100007F:1435 01 00000000:00000000 00:00000000 00000000  1000        0 333 1',
  ].join('\n');
  assert.deepEqual(parseProcListeners(table, 4), [
    { port: 5173, pid: null, hosts: ['127.0.0.1'], inode: '111' },
    { port: 37685, pid: null, hosts: ['127.0.0.1', '::1'], inode: '222' },
  ]);
});

test('excludes this service with everything it started, the host, and the host\'s own children', () => {
  const excluded = excludedProcesses(parents, { selfPid: 300, hostPid: 100 });
  assert.deepEqual([...excluded].sort((left, right) => left - right), [100, 200, 300, 310, 311, 400]);
  assert.equal(excluded.has(500), false);
});

test('grants only ports that no excluded process uses and that are not ignored services', () => {
  const listeners = [
    { port: 5173, pid: 500, hosts: ['127.0.0.1', '::1'] },
    { port: 37737, pid: 200, hosts: ['127.0.0.1'] },
    { port: 37737, pid: 500, hosts: ['::1'] },
    { port: 5432, pid: 500, hosts: ['127.0.0.1'] },
  ];
  assert.deepEqual(devServerGrants(listeners, (listener) => listener.pid === 200), [
    { host: '127.0.0.1', port: 5173 },
    { host: '::1', port: 5173 },
  ]);
});

const spawnWith = (outputs) => (command) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    if (outputs[command] === undefined) child.emit('error', new Error('not found'));
    else {
      child.stdout.emit('data', outputs[command]);
      child.emit('close', 0);
    }
  });
  return child;
};

const procFiles = (tables, fds) => ({
  async readdir(path) {
    if (path === '/proc') return ['100', '200', '300', '400', '500', '310', '311', 'self'];
    const pid = /^\/proc\/(\d+)\/fd$/.exec(path)?.[1];
    if (pid && fds[pid]) return Object.keys(fds[pid]);
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  },
  async readFile(path) {
    const pid = Number(/^\/proc\/(\d+)\/stat$/.exec(path)?.[1]);
    if (parents.has(pid)) return `${pid} (proc name) S ${parents.get(pid)} 1 1`;
    if (pid === 100) return '100 (open chamber) S 1 1 1';
    if (tables[path] !== undefined) return tables[path];
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  },
  async readlink(path) {
    const [, pid, fd] = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path) ?? [];
    return fds[pid]?.[fd] ?? '';
  },
});

test('falls back to proc sockets without lsof and grants nothing where it cannot tell owners apart', async () => {
  // Given no lsof, a dev server on 5173, and OpenCode's socket on 37737.
  const tables = {
    '/proc/net/tcp': [
      'header',
      '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1',
      '   1: 0100007F:9339 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1',
    ].join('\n'),
  };
  const fds = { 200: { 3: 'socket:[222]' }, 500: { 4: 'socket:[111]' } };
  const scanner = createDevServerScanner({ platform: 'linux', spawn: spawnWith({}), files: procFiles(tables, fds), selfPid: 300, hostPid: 100 });

  // Then only the dev server is granted.
  assert.deepEqual(await scanner.grants(), [{ host: '127.0.0.1', port: 5173 }]);

  // When the platform has no process table this service can read, then nothing is granted.
  const windows = createDevServerScanner({ platform: 'win32', spawn: spawnWith({ lsof: 'p500\nn127.0.0.1:5173\n' }), selfPid: 300, hostPid: 100 });
  assert.deepEqual(await windows.grants(), []);
});


test('finds a detached development server on this machine but never this process\'s own listener', { skip: process.platform === 'linux' ? false : 'Linux only' }, async (context) => {
  // Given a listener in this process, and a server detached like one started from a terminal.
  const own = http.createServer();
  await new Promise((resolve) => own.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => own.close(resolve)));
  const launcher = spawn('sh', ['-c', `${JSON.stringify(process.execPath)} -e "require('http').createServer((q, s) => s.end()).listen(0, '127.0.0.1', function () { console.log(this.address().port + ' ' + process.pid) })" &`], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const [port, pid] = await new Promise((resolve) => launcher.stdout.once('data', (chunk) => resolve(String(chunk).trim().split(' ').map(Number))));
  context.after(() => process.kill(pid));
  if (launcher.exitCode === null) await new Promise((resolve) => launcher.once('exit', resolve));

  // When the scanner looks at the machine, then only the detached server is granted.
  const grants = await createDevServerScanner().grants();
  assert.ok(grants.some((grant) => grant.host === '127.0.0.1' && grant.port === port));
  assert.equal(grants.some((grant) => grant.port === own.address().port), false);

  // When lsof is missing, then the kernel's socket tables give the same answer.
  const procGrants = await createDevServerScanner({ spawn: spawnWith({}) }).grants();
  assert.ok(procGrants.some((grant) => grant.host === '127.0.0.1' && grant.port === port));
  assert.equal(procGrants.some((grant) => grant.port === own.address().port), false);
});
test('grants a chat only the development servers running inside its project', { skip: process.platform === 'linux' ? false : 'Linux only' }, async (context) => {
  // Given one detached server started inside the project and another started elsewhere.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-servers-project-'));
  context.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const project = path.join(scratch, 'app');
  const elsewhere = path.join(scratch, 'other');
  fs.mkdirSync(path.join(project, 'web'), { recursive: true });
  fs.mkdirSync(elsewhere);
  const startDetached = async (cwd) => {
    const launcher = spawn('sh', ['-c', `${JSON.stringify(process.execPath)} -e "require('http').createServer((q, s) => s.end()).listen(0, '127.0.0.1', function () { console.log(this.address().port + ' ' + process.pid) })" &`], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [port, pid] = await new Promise((resolve) => launcher.stdout.once('data', (chunk) => resolve(String(chunk).trim().split(' ').map(Number))));
    context.after(() => process.kill(pid));
    if (launcher.exitCode === null) await new Promise((resolve) => launcher.once('exit', resolve));
    return port;
  };
  const inside = await startDetached(path.join(project, 'web'));
  const outside = await startDetached(elsewhere);

  // When the project's grants are read, then only its own server is reachable.
  const scanner = createDevServerScanner();
  const grants = await scanner.projectGrants(project);
  assert.ok(grants.some((grant) => grant.host === '127.0.0.1' && grant.port === inside));
  assert.equal(grants.some((grant) => grant.port === outside), false);

  // And a scope that is not a project directory gets none.
  assert.deepEqual(await scanner.projectGrants('profile:abc'), []);
  assert.deepEqual(await scanner.projectGrants(elsewhere + '-missing'), []);
});

test('does not grant a project a port another process also listens on', async () => {
  // Given a project server on 0.0.0.0:4200 and an unrelated service on [::1]:4200.
  const tables = {
    '/proc/net/tcp': ['header', '   0: 00000000:1068 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1'].join('\n'),
    '/proc/net/tcp6': ['header', '   0: 00000000000000000000000001000000:1068 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1'].join('\n'),
  };
  const files = procFiles(tables, { 500: { 4: 'socket:[111]' }, 400: { 3: 'socket:[222]' } });
  const readlink = files.readlink;
  files.readlink = async (target) => (target === '/proc/500/cwd' ? '/srv/app' : target === '/proc/400/cwd' ? '/srv/other' : readlink(target));
  const scanner = createDevServerScanner({ platform: 'linux', spawn: spawnWith({}), files, selfPid: 300, hostPid: 100 });

  // Then the shared port is granted on neither address.
  assert.deepEqual(await scanner.projectGrants('/srv/app'), []);
});
