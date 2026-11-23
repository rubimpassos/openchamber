import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createIntegrity } from '../protected-mcp/service/integrity.js';
import { install, uninstall } from '../protected-mcp/service/install.js';
import { downloadRelease, findRelease } from './release.js';
import { fail } from './accounts.js';
import { exists } from './host-files.js';
import { isRecord } from './host-inputs.js';
import { isString } from '../shared/guards.js';
import type { HostAccount } from './accounts.js';
export { PACKAGE_SUBDIR, layout } from './host-paths.js';
export { exists, readJson, writeRootFile, writeConfig, replaceSymlink, linkCommand, linkedVersion } from './host-files.js';
export { obtainPackage } from './release.js';

const run = (command: string, args: readonly string[], options: ExecFileOptions = {}) => new Promise<string>((resolve, reject) => {
  execFile(command, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(new Error(`${command} ${args[0] ?? ''} failed: ${String(stderr).trim().slice(-2000)}`), { stderr: String(stderr) }));
    else resolve(String(stdout));
  });
});

async function readHealth(response: Response) {
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (!isRecord(body) || !isString(body['openchamberVersion'])) return null;
  return { openchamberVersion: body['openchamberVersion'] };
}

export function createSystem() {
  return {
    trustedOwners: [0], isRoot: () => process.getuid?.() === 0,
    hasSystemd: () => fs.stat('/run/systemd/system').then(() => true, () => false),
    async account(user: string) {
      const entry = (await run('getent', ['passwd', '--', user]).catch(() => '')).trim();
      if (!entry) fail('owner_unknown', `There is no account "${user}"`);
      const [, , uid, gid, , home, shell] = entry.split(':');
      if (home === undefined || shell === undefined) fail('owner_unknown', `The account "${user}" has an invalid passwd entry`);
      const gids = (await run('id', ['-G', '--', user])).trim().split(/\s+/).map(Number);
      const groups = (await run('id', ['-Gn', '--', user])).trim().split(/\s+/).filter(Boolean);
      return { name: user, uid: Number(uid), gid: Number(gid), gids, groups, home, shell };
    },
    run,
    async runResult(command: string, args: readonly string[]) {
      try { return { code: 0, stdout: await run(command, args), stderr: '' }; }
      catch (error) { if (!(error instanceof Error)) throw error; return { code: 1, stdout: '', stderr: error.message }; }
    },
    chown: (target: string, uid: number, gid: number) => fs.lchown(target, uid, gid),
    systemctl: (args: readonly string[]) => run('systemctl', args),
    async isActive(unit: string) {
      try { return (await run('systemctl', ['is-active', unit])).trim(); }
      catch (error) { return String(isRecord(error) ? error['stderr'] ?? '' : '').trim() || 'inactive'; }
    },
    nodeVersion: (node: string) => run(node, ['--version']),
    npm: (node: string, npmCli: string, args: readonly string[], env: NodeJS.ProcessEnv) => run(node, [npmCli, ...args], { timeout: 15 * 60_000, env }),
    installOpenCode: (owner: Pick<HostAccount, 'name' | 'home'>, node: string, app: string) => run('runuser', ['-u', owner.name, '--', 'env', `HOME=${owner.home}`, 'PATH=/usr/local/bin:/usr/bin:/bin', node, '--input-type=module', '-e',
      `const { installOpenCodeV2 } = await import(${JSON.stringify(`${app}/build/server/lib/opencode/v2-install.js`)}); process.stdout.write(await installOpenCodeV2());`], { timeout: 10 * 60_000, cwd: '/' }),
    findRelease, downloadRelease,
    async health(url: string) {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return readHealth(response);
    },
    async agentHealth(url: string, token: string) {
      const login = await fetch(`${url}/auth/session`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: token }), signal: AbortSignal.timeout(2000) });
      const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
      await login.body?.cancel();
      if (!login.ok || !cookie) return null;
      const session = await fetch(`${url}/auth/session`, { redirect: 'error', headers: { cookie }, signal: AbortSignal.timeout(2000) });
      if (!session.ok) return null;
      const authentication: unknown = await session.json();
      if (!isRecord(authentication) || authentication['authenticated'] !== true) return null;
      const health = await fetch(`${url}/health`, { redirect: 'error', headers: { cookie }, signal: AbortSignal.timeout(2000) });
      return readHealth(health);
    },
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    protectedMcp: { install, uninstall },
    async backupDatabase(source: string, destination: string) {
      const { DatabaseSync, backup } = await import('node:sqlite');
      const db = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
      try { await backup(db, destination); } finally { db.close(); }
    },
  };
}
export type HostSystem = ReturnType<typeof createSystem>;
type TrustSystem = { readonly trustedOwners: readonly number[] };
type TrustOwner = Pick<HostAccount, 'uid' | 'gids'>;

export async function requireTrusted(system: TrustSystem, owner: TrustOwner, target: string, code: string) {
  const { findings } = await createIntegrity({ owners: system.trustedOwners, groups: [0], engine: { uid: owner.uid, gids: owner.gids } }).inspect(target);
  if (findings.length) fail(code, `${target}: ${findings.map((finding) => `${finding.code} ${finding.subject}`).join(', ')}`);
}
export async function trustedToolchain(system: TrustSystem & Pick<HostSystem, 'nodeVersion'>, owner: TrustOwner, root: string) {
  let node;
  for (const candidate of ['/usr/bin/node', '/usr/local/bin/node']) {
    if (!await exists(path.join(root, candidate))) continue;
    await requireTrusted(system, owner, path.join(root, candidate), 'untrusted_node');
    const match = /^v(\d+)\.(\d+)/.exec((await system.nodeVersion(path.join(root, candidate))).trim());
    if (!match || Number(match[1]) < 24 || (Number(match[1]) === 24 && Number(match[2]) < 14)) fail('node_too_old', `${candidate} must be Node.js 24.14 or newer`);
    node = candidate;
    break;
  }
  if (!node) fail('node_missing', 'Install Node.js 24.14+ system-wide at /usr/bin/node, owned by root, then run this again');
  for (const candidate of ['/usr/lib/node_modules/npm/bin/npm-cli.js', '/usr/local/lib/node_modules/npm/bin/npm-cli.js']) {
    if (!await exists(path.join(root, candidate))) continue;
    await requireTrusted(system, owner, path.join(root, candidate), 'untrusted_npm');
    return { node, npm: candidate };
  }
  fail('npm_missing', 'Install npm system-wide with Node.js, owned by root, then run this again');
}
export async function prepare(system: Pick<HostSystem, 'isRoot' | 'hasSystemd'>) {
  if (!system.isRoot()) fail('root_required', 'Run this as root');
  if (!await system.hasSystemd()) fail('systemd_required', 'The host install needs systemd');
}
