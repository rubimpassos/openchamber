import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { SpaceError, spaceErrorProperty } from '../spaces/errors.js';
import { runCommand } from '../spaces/run-command.js';
import type { RunCommand, CommandOptions } from '../spaces/command-contracts.js';
import { isString } from '../shared/object-guards.js';

const ENVIRONMENT = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C.UTF-8' });

export function createSystem() {
  const run: RunCommand = (file, args, options = {}) => runCommand(file, args, { env: ENVIRONMENT, timeoutMs: 60_000, ...options });
  return {
    run,
    spawn: (file: string, args: readonly string[]) => spawn(file, args, { env: ENVIRONMENT, cwd: '/', shell: false, stdio: ['pipe', 'pipe', 'pipe'] }),
    chown: (file: string, uid: number, gid: number) => fs.lchown(file, uid, gid),
    async ipPath() {
      for (const candidate of ['/usr/bin/ip', '/usr/sbin/ip']) if (await fs.access(candidate, fs.constants.X_OK).then(() => true, () => false)) return candidate;
      throw new SpaceError('ip_missing', 'Install iproute2 system-wide');
    },
  };
}

export type HostdSystem = ReturnType<typeof createSystem>;

export async function checked(system: Pick<HostdSystem, 'run'>, file: string, args: string[], options?: CommandOptions): Promise<string> {
  const result = await system.run(file, args, options);
  if (result.code !== 0) throw new SpaceError('hostd_command_failed', `${file} ${args[0] ?? ''} failed: ${result.stderr.slice(-2000)}`);
  return result.stdout;
}

function propertiesOf(text: string): Record<string, string | undefined> {
  return Object.fromEntries(text.trimEnd().split('\n').map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
}

export const showUnit = async (system: Pick<HostdSystem, 'run'>, unit: string) => propertiesOf(await checked(system, '/usr/bin/systemctl', ['show', '--all', unit]));

export async function checkRequirements(system: Pick<HostdSystem, 'ipPath' | 'run'>) {
  const unavailable = (code: string, message: string) => ({ available: false as const, code, message });
  const required: readonly (readonly [string, string, string])[] = [
    ['/usr/bin/node', 'node_missing', 'Install Node.js 24.14+ at /usr/bin/node'],
    ['/usr/bin/slirp4netns', 'slirp4netns_missing', 'Install slirp4netns'],
    ['/dev/net/tun', 'tun_missing', 'Enable /dev/net/tun'],
    ['/usr/bin/curl', 'curl_missing', 'Install curl'], ['/usr/bin/git', 'git_missing', 'Install git'],
    ...['systemctl', 'systemd-run', 'systemd-analyze', 'setpriv', 'unshare', 'nsenter', 'mount', 'umount', 'getent'].map((name) => [`/usr/bin/${name}`, `${name.replaceAll('-', '_')}_missing`, `Install ${name}`] as const),
    ...['useradd', 'userdel'].map((name) => [`/usr/sbin/${name}`, `${name}_missing`, `Install ${name}`] as const),
  ];
  for (const [file, code, message] of required) if (!await fs.access(file).then(() => true, () => false)) return unavailable(code, message);
  let version;
  let nodeVersion;
  try {
    await system.ipPath();
    const result = await system.run('/usr/bin/systemctl', ['--version']);
    version = /^systemd (\d+)/.exec(result.stdout)?.[1];
    if (result.code !== 0 || !version || Number(version) < 259) return unavailable('systemd_version', 'Host spaces require systemd 259 or newer');
    const node = await system.run('/usr/bin/node', ['--version']);
    if (node.code !== 0 || !/^v24\.(?:1[4-9]|[2-9]\d)\.|^v(?:2[5-9]|[3-9]\d)\./.test(node.stdout)) return unavailable('node_version', 'Install Node.js 24.14+ at /usr/bin/node');
    nodeVersion = node.stdout.trim();
  } catch (error) {
    const code = spaceErrorProperty(error, 'code');
    return unavailable(isString(code) ? code : 'hostd_requirements_failed', error instanceof Error ? error.message : String(error));
  }
  return { available: true as const, version, os: 'linux', arch: process.arch, nodeVersion, hostIsolation: true };
}
