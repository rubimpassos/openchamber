import fs from 'node:fs/promises';
import path from 'node:path';
import { hashUiPassword, normalizeUiPassword } from '../ui-auth/ui-password-hash.js';
import { compareVersions } from '../version-order.js';
import { ensureAccounts, fail, separationConfig } from './accounts.js';
import { setupAgentDocker, setupFrontDoorDocker } from './agent-docker.js';
import { writeAgentLink } from './agent-link.js';
import { deploy, requireOwnUnits } from './host-deploy.js';
import { migrateAccounts } from './migrate-accounts.js';
import { readTrustedBotWorktrees } from './bot-migration-access.js';
import { projectSharing } from './root-commands.js';
import { REPO_PATTERN } from './release.js';
import { createSystem, exists, layout, linkCommand, linkedVersion, obtainPackage, prepare, trustedToolchain, writeRootFile } from './host-support.js';
import type { HostSystem } from './host-support.js';
import type { HostLayout } from './host-paths.js';
import type { HostAccount } from './accounts.js';
import type { ReadOptions } from './bot-migration-access.types.js';
import { hasCode, isRecord } from './host-inputs.js';
import { readHostConfig } from './host-config.js';
import type { HostConfig } from './host-config.js';
import { AGENT_UNIT, ALL_UNITS, APP_UNIT, HOSTD_SOCKET, HOSTD_UNIT, UPDATER_PATH, UPDATER_TIMER, UPDATER_UNIT } from './host-units.js';
export { layout } from './host-support.js';
export { rollback } from './host-rollback.js';
export { APP_UNIT, UPDATER_UNIT, UPDATER_TIMER, UPDATER_PATH } from './host-units.js';

type HostOptions = {
  readonly root?: string | undefined;
  readonly system?: HostSystem | undefined;
  readonly say?: ((message: string) => void) | undefined;
};
type PackageOptions = HostOptions & { readonly tarball?: string | null | undefined; readonly version?: string | null | undefined };
type InstallOptions = PackageOptions & {
  readonly owner?: string | undefined; readonly repo?: string | undefined;
  readonly port?: number | undefined; readonly host?: string | undefined; readonly autoUpdate?: boolean | undefined;
  readonly protectedMcp?: boolean | undefined; readonly acceptUnprotected?: boolean | undefined;
  readonly separation?: boolean | undefined; readonly agentUser?: string | undefined; readonly agentPort?: number | undefined;
  readonly dryRun?: boolean | undefined; readonly readUiPassword?: (() => Promise<string | null>) | undefined;
  readonly botWorktreesFile?: ReadOptions['file']; readonly readBotWorktreesIdentity?: ReadOptions['readIdentity'];
};

async function prepareRequestDir(system: Pick<HostSystem, 'chown'>, paths: HostLayout, front: Pick<HostAccount, 'uid' | 'gid'>) {
  await fs.mkdir(path.dirname(paths.requestDir), { recursive: true, mode: 0o755 });
  await system.chown(path.dirname(paths.requestDir), 0, 0);
  await fs.chmod(path.dirname(paths.requestDir), 0o755);
  await fs.mkdir(paths.requestDir, { recursive: true, mode: 0o700 });
  await system.chown(paths.requestDir, front.uid, front.gid);
  await fs.chmod(paths.requestDir, 0o700);
}
const UI_PASSWORD_SET = /^OPENCHAMBER_UI_PASSWORD(?:_HASH)?=\S/m;

async function uiPasswordLine(paths: HostLayout, readUiPassword: () => Promise<string | null>) {
  const env = await fs.readFile(paths.envFile, 'utf8').catch((error) => { if (hasCode(error, 'ENOENT')) return ''; throw error; });
  if (UI_PASSWORD_SET.test(env)) return null;
  const password = normalizeUiPassword(await readUiPassword() ?? '');
  if (!password) fail('ui_password_required', `OpenChamber runs only behind its UI password. Run this from a terminal to type one, pipe it in with --ui-password-stdin, or put OPENCHAMBER_UI_PASSWORD_HASH=<the output of: openchamber hash-password> in ${paths.live.envFile}, then run this again`);
  return `OPENCHAMBER_UI_PASSWORD_HASH=${hashUiPassword(password)}\n`;
}

export async function install({
  root = '/', system = createSystem(), say = () => {}, owner: ownerName, repo, port, host, autoUpdate,
  protectedMcp, acceptUnprotected, tarball = null, version = null, separation, agentUser, agentPort, dryRun = false,
  readUiPassword = async () => null,
  botWorktreesFile, readBotWorktreesIdentity,
}: InstallOptions) {
  await prepare(system);
  const paths = layout(root);
  const existing = await readHostConfig(paths.configFile);
  const config = {
    version: 1, owner: ownerName ?? existing?.owner, repo: repo ?? existing?.repo,
    port: port ?? existing?.port ?? 3000, host: host ?? existing?.host ?? '127.0.0.1',
    autoUpdate: autoUpdate ?? existing?.['autoUpdate'] ?? true,
    protectedMcp: protectedMcp ?? existing?.['protectedMcp'] ?? true,
    acceptUnprotected: acceptUnprotected ?? existing?.['acceptUnprotected'] ?? false,
  };
  if (!config.owner || !/^[a-z_][a-z0-9_-]{0,31}$/.test(config.owner)) fail('owner_required', 'Give --owner with the human account that owns the projects');
  if (!config.repo || !REPO_PATTERN.test(config.repo)) fail('repo_required', 'Give --repo with the GitHub repository whose releases to install, as owner/name');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) fail('invalid_port', `Invalid port ${config.port}`);
  if (!/^[0-9A-Za-z.:-]{1,255}$/.test(config.host)) fail('invalid_host', `Invalid host ${config.host}`);
  const owner = await system.account(config.owner);
  if (owner.uid === 0) fail('owner_is_root', 'OpenChamber must not run as root; give the account of the person who uses it');
  if (existing?.owner && existing.owner !== owner.name) fail('owner_changed', `This host is installed for ${existing.owner}. Uninstall first to change the owner`);
  const configured: HostConfig = { ...config, owner: config.owner, repo: config.repo, separation: separationConfig({ existing, enabled: separation, owner: config.owner, agentUser, agentPort, port: config.port }) };
  await requireOwnUnits(paths);
  const toolchain = await trustedToolchain(system, owner, root);
  const trustedBotWorktrees = await readTrustedBotWorktrees({ root, file: botWorktreesFile, readIdentity: readBotWorktreesIdentity });
  if (dryRun) {
    if (!configured.separation) return { config: configured, dryRun: true };
    const agentName = configured.separation.agent;
    const agent = await system.account(agentName).catch((error) => { if (hasCode(error, 'owner_unknown')) return { name: agentName, home: `/home/${agentName}` }; throw error; });
    const accounts = { human: owner, front: { name: 'openchamber', home: '/var/lib/openchamber' }, agent };
    const uiPassword = UI_PASSWORD_SET.test(await fs.readFile(paths.envFile, 'utf8').catch(() => '')) ? 'set' : 'required';
    return { config: configured, dryRun: true, uiPassword, migration: await migrateAccounts({ root, system, accounts, envFile: paths.envFile, dryRun: true, trustedBotWorktrees, say }) };
  }
  const passwordLine = configured.separation ? await uiPasswordLine(paths, readUiPassword) : null;
  const accounts = await ensureAccounts({ system, root, config: configured, say });
  for (const account of [accounts.front, accounts.agent]) await trustedToolchain(system, account, root);
  if (await exists(path.join(root, owner.home, '.config/systemd/user', APP_UNIT))) say(`${owner.name} also has a user unit ${APP_UNIT}. Turn it off as ${owner.name}: systemctl --user disable --now ${APP_UNIT}`);
  const source = await obtainPackage({ system, paths, config: configured, tarball, version });
  let migration: Awaited<ReturnType<typeof migrateAccounts>> | undefined;
  let docker: (Awaited<ReturnType<typeof setupAgentDocker>> & { frontDoor?: Awaited<ReturnType<typeof setupFrontDoorDocker>> }) | undefined;
  try {
    if (!await exists(paths.envFile)) await writeRootFile(system, paths.envFile, '# Environment for OpenChamber, such as OPENCHAMBER_UI_PASSWORD=...\n', 0o600);
    if (passwordLine) {
      const env = await fs.readFile(paths.envFile, 'utf8');
      await writeRootFile(system, paths.envFile, `${env}${env === '' || env.endsWith('\n') ? '' : '\n'}${passwordLine}`, 0o600);
    }
    const beforeStart = async () => {
      if (configured.separation) await writeAgentLink({ system, paths, config: { separation: configured.separation } });
      if (configured.separation && !existing?.separation) {
        if (existing) await system.systemctl(['stop', APP_UNIT]);
        migration = await migrateAccounts({ root, system, accounts, envFile: paths.envFile, sharing: projectSharing({ root, system, accounts }), trustedBotWorktrees, say });
        docker = await setupAgentDocker({ root, system, agent: accounts.agent, say });
        if (docker.status === 'ready') configured.separation.docker = true;
        docker.frontDoor = await setupFrontDoorDocker({ root, system, front: accounts.front, say });
        if (docker.frontDoor.status === 'ready') configured.separation.frontDocker = true;
      }
      await prepareRequestDir(system, paths, accounts.front);
    };
    const result = await deploy({ system, root, paths, config: configured, previousConfig: existing, owner, accounts, toolchain, tarball: source.tarball, version: source.version, beforeStart, say });
    await linkCommand(paths, say);
    const installed: typeof result & { readonly config: HostConfig; migration?: typeof migration; docker?: typeof docker } = { ...result, config: configured };
    if (migration) installed.migration = migration;
    if (docker) installed.docker = docker;
    return installed;
  } finally { await source.cleanup(); }
}

async function consumeRequest(paths: HostLayout, say: (message: string) => void) {
  const entry = await fs.lstat(paths.requestFile).catch(() => null);
  if (!entry) return;
  if (entry.isDirectory()) await fs.rmdir(paths.requestFile).catch(() => say(`${paths.live.requestFile} is a directory that is not empty; remove it to ask for updates again.`));
  else await fs.unlink(paths.requestFile);
}
export async function update({ root = '/', system = createSystem(), say = () => {}, tarball = null, version = null }: PackageOptions) {
  await prepare(system);
  const paths = layout(root);
  await consumeRequest(paths, say);
  const config = await readHostConfig(paths.configFile);
  if (!config) fail('not_installed', 'OpenChamber is not installed on this host');
  const current = await linkedVersion(paths, 'current');
  const owner = await system.account(config.owner);
  const toolchain = await trustedToolchain(system, owner, root);
  const release = tarball ? null : await system.findRelease({ repo: config.repo });
  if (release && current && compareVersions(release.version, current) <= 0) { say(`OpenChamber ${current} is up to date.`); return { version: current, updated: false }; }
  if (release && release.version === config['skipVersion']) { say(`OpenChamber ${release.version} was rolled back on this host, so ${current} stays.`); return { version: current, updated: false, skipped: release.version }; }
  await requireOwnUnits(paths);
  const accounts = await ensureAccounts({ system, root, config, say });
  const source = await obtainPackage({ system, paths, config, tarball, version, release });
  try {
    const beforeStart = async () => { if (config.separation) await writeAgentLink({ system, paths, config: { separation: config.separation } }); };
    const result = await deploy({ system, root, paths, config, previousConfig: config, owner, accounts, toolchain, tarball: source.tarball, version: source.version, beforeStart, say });
    await linkCommand(paths, say);
    return { ...result, updated: true };
  } finally { await source.cleanup(); }
}
async function removeRequestDir(system: Pick<HostSystem, 'chown'>, paths: HostLayout) {
  if (!await exists(paths.requestDir)) return;
  await system.chown(paths.requestDir, 0, 0);
  await fs.chmod(paths.requestDir, 0o700);
  for (const entry of await fs.readdir(paths.requestDir, { withFileTypes: true })) {
    const full = path.join(paths.requestDir, entry.name);
    await (entry.isDirectory() ? fs.rmdir(full) : fs.unlink(full)).catch(() => {});
  }
  await fs.rmdir(paths.requestDir).catch(() => {});
  await fs.rmdir(path.dirname(paths.requestDir)).catch(() => {});
}
export async function uninstall({ root = '/', system = createSystem(), say = () => {}, purge = false, purgeAccounts = false }: HostOptions & { readonly purge?: boolean; readonly purgeAccounts?: boolean }) {
  if (!system.isRoot()) fail('root_required', 'Run this as root');
  if (purgeAccounts && !purge) fail('purge_required', '--purge-accounts also requires --purge');
  const paths = layout(root);
  const config = await readHostConfig(paths.configFile);
  await requireOwnUnits(paths);
  for (const name of [UPDATER_TIMER, UPDATER_PATH, UPDATER_UNIT, APP_UNIT, AGENT_UNIT, HOSTD_UNIT, HOSTD_SOCKET]) await system.systemctl(['disable', '--now', name]).catch(() => {});
  if (config?.['protectedMcp'] !== false) await system.protectedMcp.uninstall({ root, engineUser: config?.separation?.agent ?? config?.owner ?? null, adminUser: config?.separation?.frontDoor, purgeState: purge }).catch((error) => say(`The protected MCP service was not removed: ${isRecord(error) ? error['message'] : undefined}`));
  for (const name of ALL_UNITS) await fs.rm(paths.unit(name), { force: true });
  await system.systemctl(['daemon-reload']).catch(() => {});
  const binTarget = await fs.readlink(paths.binLink).catch(() => null);
  if (['build/bin/cli.js', 'bin/cli.js'].some((entry) => path.join(paths.live.app, entry) === binTarget)) await fs.rm(paths.binLink, { force: true });
  await fs.rm(paths.wrapper, { force: true });
  await fs.rm(paths.installDir, { recursive: true, force: true });
  await removeRequestDir(system, paths);
  await fs.rm(paths.cacheDir, { recursive: true, force: true });
  await fs.rm(paths.configFile, { force: true });
  if (purge) for (const file of [paths.envFile, paths.agentEnv, paths.agentLink]) await fs.rm(file, { force: true });
  if (purge && purgeAccounts && config?.separation) {
    for (const name of [config.separation.agent, config.separation.frontDoor]) await system.run('userdel', ['--remove', name]);
  }
  say('Removed OpenChamber. Account homes remain unless --purge --purge-accounts was given.');
  return { purged: purge };
}
export async function status({ root = '/', system = createSystem() }: HostOptions) {
  const paths = layout(root);
  const config = await readHostConfig(paths.configFile).catch(() => null);
  if (!config) return { installed: false };
  const units: Record<string, string> = {};
  for (const name of [APP_UNIT, UPDATER_TIMER, UPDATER_PATH, HOSTD_SOCKET, HOSTD_UNIT, ...(config.separation ? [AGENT_UNIT] : [])]) units[name] = await system.isActive(name);
  return { installed: true, config, current: await linkedVersion(paths, 'current'), previous: await linkedVersion(paths, 'previous'), units };
}
