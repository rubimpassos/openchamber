import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNetwork } from './network.js';
import { layout } from './state.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

/** A holder that exits without printing, its pipes already closed: Node emits exit and close in one callback. */
const exitingHolder = (stderr) => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  setTimeout(() => {
    child.stderr.write(stderr);
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
  }, 10);
  return child;
};

describe('the space network', () => {
  it('creates the same namespace topology and files with a synthetic system', async () => {
    // Given no existing network account and a holder that announces its namespace pid.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-network-')); roots.push(root);
    const paths = layout(root);
    const id = 'aabbcc112233';
    const directory = path.join(paths.pins, id);
    const holder = new EventEmitter();
    holder.stdin = new PassThrough();
    holder.stdout = new PassThrough();
    holder.stderr = new PassThrough();
    holder.kill = vi.fn(() => { holder.emit('close', 0, null); return true; });
    let lookups = 0;
    const system = {
      run: vi.fn(async (file) => {
        if (file !== '/usr/bin/getent') return { code: 0, stdout: '', stderr: '' };
        lookups += 1;
        return lookups === 1 ? { code: 2, stdout: '', stderr: '' } : { code: 0, stdout: `openchamber-net-${id}:x:996:997::/nonexistent:/usr/sbin/nologin\n`, stderr: '' };
      }),
      spawn: vi.fn(() => { queueMicrotask(() => holder.stdout.write('4321\n')); return holder; }),
    };
    // When creating the topology, then fixed executables receive the original ordered argv.
    await createNetwork({ system, paths, ipPath: '/usr/bin/ip' }).create({ id, subnet: 1 });
    expect(system.run.mock.calls).toEqual([
      ['/usr/bin/getent', ['passwd', `openchamber-net-${id}`]],
      ['/usr/sbin/useradd', ['--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', `openchamber-net-${id}`], undefined],
      ['/usr/bin/getent', ['passwd', `openchamber-net-${id}`]],
      ['/usr/bin/ip', ['netns', 'add', `ocs-${id}`], undefined],
      ...['user', 'net'].map((name) => ['/usr/bin/mount', ['--bind', `/proc/4321/ns/${name}`, path.join(directory, name)], undefined]),
      ['/usr/bin/ip', ['link', 'add', `vs-${id}`, 'type', 'veth', 'peer', 'name', `vg-${id}`], undefined],
      ['/usr/bin/ip', ['link', 'set', `vs-${id}`, 'netns', `ocs-${id}`], undefined],
      ['/usr/bin/ip', ['link', 'set', `vg-${id}`, 'netns', '4321'], undefined],
      ...[
        [`--net=/run/netns/ocs-${id}`, '10.233.0.6', `vs-${id}`],
        [`--net=${directory}/net`, '10.233.0.5', `vg-${id}`],
      ].flatMap(([namespace, address, device]) => [
        ['/usr/bin/nsenter', [namespace, '--', '/usr/bin/ip', 'addr', 'add', `${address}/30`, 'dev', device], undefined],
        ...['lo', device].map((name) => ['/usr/bin/nsenter', [namespace, '--', '/usr/bin/ip', 'link', 'set', name, 'up'], undefined]),
      ]),
    ]);
    expect(system.spawn.mock.calls[0][0]).toBe('/usr/bin/setpriv');
    expect(system.spawn.mock.calls[0][1].slice(0, 5)).toEqual(['--reuid=996', '--regid=997', '--clear-groups', '--inh-caps=+sys_admin', '--ambient-caps=+sys_admin']);
    expect(holder.kill).toHaveBeenCalledWith('SIGTERM');
    expect(holder.stdin.writableEnded).toBe(true);
    for (const [name, text] of Object.entries({
      'resolv.conf': 'nameserver 10.0.2.3\n',
      'space-resolv.conf': 'nameserver 127.0.0.1\noptions timeout:1 attempts:1\n',
      hosts: '127.0.0.1 localhost\n10.233.0.5 gatekeeper\n',
      'gatekeeper-hosts': '127.0.0.1 localhost\n',
      'space.hostname': `space-${id}\n`,
      'gatekeeper.hostname': `gatekeeper-${id}\n`,
    })) {
      expect(await fs.readFile(path.join(directory, name), 'utf8')).toBe(text);
      expect((await fs.stat(path.join(directory, name))).mode & 0o777).toBe(0o644);
    }
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of ['user', 'net']) expect((await fs.stat(path.join(directory, name))).mode & 0o777).toBe(0o600);
  });
  it('retains pins and reports cleanup errors after trying every resource', async () => {
    // Given pinned namespaces and an unmount that fails for a non-idempotent reason.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-network-')); roots.push(root);
    const paths = layout(root);
    const id = 'aabbcc112233';
    const directory = path.join(paths.pins, id);
    await fs.mkdir(directory, { recursive: true });
    const system = { run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'permission denied' })) };
    // When destroying the network, then all cleanup commands run and the pins remain for retry.
    await expect(createNetwork({ system, paths, ipPath: '/usr/bin/ip' }).destroy(id)).rejects.toMatchObject({ code: 'namespace_cleanup_failed' });
    expect(system.run.mock.calls).toEqual([
      ['/usr/bin/umount', [path.join(directory, 'net')]],
      ['/usr/bin/umount', [path.join(directory, 'user')]],
      ['/usr/bin/ip', ['netns', 'delete', `ocs-${id}`]],
      ['/usr/bin/ip', ['link', 'delete', `vs-${id}`]],
    ]);
    expect((await fs.stat(directory)).isDirectory()).toBe(true);
  });
  it('fails, and does not wait forever, when the namespace holder exits on its own', async () => {
    // Given a holder that exits at once, as one that cannot enter its namespaces does.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-network-')); roots.push(root);
    const system = {
      run: vi.fn(async (file) => (file === '/usr/bin/getent' ? { code: 0, stdout: 'openchamber-net-aabbcc112233:x:996:996::/nonexistent:/usr/sbin/nologin\n', stderr: '' } : { code: 0, stdout: '', stderr: '' })),
      spawn: vi.fn(() => exitingHolder('unshare: unshare failed: Operation not permitted\n')),
    };
    const network = createNetwork({ system, paths: layout(root), ipPath: '/usr/bin/ip' });
    // When the space's network is made, then the create fails with the holder's reason, in bounded time.
    const outcome = await Promise.race([
      network.create({ id: 'aabbcc112233', subnet: 0 }).then(() => 'created', (error) => error),
      new Promise((resolve) => { setTimeout(() => resolve('still waiting'), 2000); }),
    ]);
    expect(outcome).toMatchObject({ code: 'namespace_failed', message: expect.stringContaining('Operation not permitted') });
  });
});
