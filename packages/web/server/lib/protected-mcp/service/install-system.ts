import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import type { ExecFileOptions } from 'node:child_process';
import type { JsonValue } from '../../shared/json-values.js';

const run = (command: string, args: readonly string[], options: ExecFileOptions = {}) => new Promise<string>((resolve, reject) => {
  execFile(command, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(new Error(`${command} failed`), { code: error.code, stderr: String(stderr).slice(-2000) }));
    else resolve(String(stdout));
  });
});

export function createSystem() {
  const exists = (command: string, args: readonly string[]) => run(command, args).then(() => true, () => false);
  return {
    trustedOwners: [0],
    isRoot: () => process.getuid?.() === 0,
    hasSystemd: () => fs.stat('/run/systemd/system').then(() => true, () => false),
    async identity(user: string) {
      const [uid, gids] = await Promise.all([run('id', ['-u', '--', user]), run('id', ['-G', '--', user])]);
      return { uid: Number(uid.trim()), gids: gids.trim().split(/\s+/).map(Number) };
    },
    async ensureGroup(name: string) {
      if (!await exists('getent', ['group', name])) await run('groupadd', ['--system', name]);
      return Number((await run('getent', ['group', name])).split(':')[2]);
    },
    async ensureUser(name: string, { home }: { readonly home: string }) {
      if (!await exists('id', ['-u', '--', name])) {
        await run('useradd', ['--system', '--user-group', '--home-dir', home, '--no-create-home', '--shell', '/usr/sbin/nologin', name]);
      }
      return Number((await run('id', ['-u', '--', name])).trim());
    },
    addToGroup: (user: string, group: string) => run('usermod', ['--append', '--groups', group, user]),
    removeFromGroup: (user: string, group: string) => run('gpasswd', ['--delete', user, group]).catch(() => {}),
    removeUser: (name: string) => run('userdel', [name]).catch(() => {}),
    removeGroup: (name: string) => run('groupdel', [name]).catch(() => {}),
    chown: (target: string, uid: number, gid: number) => fs.lchown(target, uid, gid),
    systemctl: (args: readonly string[]) => run('systemctl', args),
    createTmpfiles: (file: string) => run('systemd-tmpfiles', ['--create', file]),
    nodeVersion: (node: string) => run(node, ['--version']),
    connect: (socket: string) => new Promise<JsonValue>((resolve, reject) => {
      const client = net.createConnection(socket);
      let answer = '';
      client.setEncoding('utf8');
      client.once('connect', () => client.write('{"type":"status"}\n'));
      client.on('data', (chunk: string) => { answer += chunk; });
      client.once('error', reject);
      client.once('close', () => {
        try { resolve(JSON.parse(answer)); }
        catch (error) { reject(error); }
      });
    }),
  };
}
