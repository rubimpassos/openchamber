import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from './accounts.js';
import type { HostAccount } from './accounts.js';
import { hasCode, isRecord } from './host-inputs.js';
import type { JsonObject } from './host-inputs.js';
import type { HostLayout, HostToolchain } from './host-paths.js';
import type { HostSystem } from './host-support.js';
import { isBoolean, isString } from '../shared/guards.js';
import { installPackage, pruneVersions } from './host-package.js';
import { exists, linkedVersion, PACKAGE_SUBDIR, replaceSymlink, requireTrusted, writeConfig, writeRootFile } from './host-support.js';
import { agentUnit, AGENT_UNIT, ALL_UNITS, appUnit, APP_UNIT, hostdUnits, HOSTD_SOCKET, HOSTD_UNIT, MANAGED_MARKER, ownerPath, updaterUnits, UPDATER_PATH, UPDATER_TIMER } from './host-units.js';

type HostDeploymentConfig = JsonObject & Parameters<typeof appUnit>[0]['config'];
type DeploySystem = Pick<HostSystem, 'trustedOwners' | 'npm' | 'chown' | 'installOpenCode' | 'health' | 'agentHealth' | 'sleep' | 'systemctl' | 'protectedMcp'>;
type ProtectedMcpOptions = {
  readonly system: Pick<HostSystem, 'protectedMcp'>;
  readonly root: string;
  readonly paths: HostLayout;
  readonly config: JsonObject;
  readonly owner: Pick<HostAccount, 'name'>;
  readonly appDir: string;
  readonly version: string | null;
  readonly say: (message: string) => void;
};
type DeployOptions = Omit<ProtectedMcpOptions, 'system' | 'owner' | 'appDir' | 'version' | 'config'> & {
  readonly config: HostDeploymentConfig;
  readonly system: DeploySystem;
  readonly owner: HostAccount;
  readonly accounts: { readonly front: HostAccount; readonly agent: HostAccount };
  readonly toolchain: HostToolchain;
  readonly tarball: string;
  readonly version: string;
  readonly previousConfig: HostDeploymentConfig | null;
  readonly beforeStart?: () => Promise<void>;
};

export async function requireOwnUnits(paths: HostLayout): Promise<void> {
  for (const name of ALL_UNITS) {
    const content = await fs.readFile(paths.unit(name), 'utf8').catch((error) => { if (hasCode(error, 'ENOENT')) return null; throw error; });
    if (content !== null && !content.startsWith(MANAGED_MARKER)) fail('unit_conflict', `${paths.unit(name)} was not written by this installer. Move its settings into a drop-in or remove it, then run this again`);
  }
}

export async function installProtectedMcpFrom({ system, root, paths, config, owner, appDir, version, say }: ProtectedMcpOptions) {
  if (!config['protectedMcp']) return { status: 'disabled' } as const;
  try {
    const separation = isRecord(config['separation']) ? config['separation'] : null;
    const app = path.join(paths.installDir, appDir, PACKAGE_SUBDIR);
    const source = path.join(app, await exists(path.join(app, 'build/server')) ? 'build/server' : 'server');
    const agent = separation?.['agent'];
    const frontDoor = separation?.['frontDoor'];
    const acceptUnprotected = config['acceptUnprotected'];
    if (config['separation'] && (!isString(agent) || !isString(frontDoor))) {
      fail('invalid_host_config', 'The protected MCP service requires both separated accounts');
    }
    const result = await system.protectedMcp.install({
      root, source, version,
      engineUser: isString(agent) ? agent : owner.name,
      adminUser: isString(frontDoor) ? frontDoor : undefined,
      engineUnit: config['separation'] ? AGENT_UNIT : APP_UNIT,
      acceptUnprotected: isBoolean(acceptUnprotected) ? acceptUnprotected : undefined, say,
    });
    say(`Protected MCP service ${version} is running; boundary status ${result.preflight.status}.`);
    return { status: 'installed', boundary: result.preflight.status } as const;
  } catch (error) {
    const failure = isRecord(error) ? error : {};
    say(`The protected MCP service ${version} was not installed: ${failure['message']}`);
    return { status: 'failed', code: failure['code'] ?? 'failed', message: failure['message'] } as const;
  }
}

async function ensureOpenCode({ system, root, owner, toolchain, app, say }: Pick<DeployOptions, 'system' | 'root' | 'owner' | 'toolchain' | 'say'> & { readonly app: string }): Promise<void> {
  for (const directory of ownerPath(owner)) if (await fs.access(path.join(root, directory, 'opencode'), fs.constants.X_OK).then(() => true, () => false)) return;
  say(`${owner.name} has no OpenCode; installing it in ${owner.home}/.opencode/bin.`);
  try { await system.installOpenCode(owner, toolchain.node, app); }
  catch (error) { const failure = isRecord(error) ? error : {}; fail('opencode_install_failed', `OpenCode could not be installed for ${owner.name}: ${failure['message']}. Install it as ${owner.name} (https://opencode.ai) and run this again`); }
}
async function waitForVersion(system: DeploySystem, config: HostDeploymentConfig, version: string, paths: HostLayout): Promise<boolean> {
  const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
  const token = config.separation ? /^OPENCHAMBER_UI_PASSWORD=([A-Za-z0-9_-]{43})$/m.exec(await fs.readFile(paths.agentEnv, 'utf8'))?.[1] : null;
  for (let waited = 0; waited < 90_000; waited += 1000) {
    const body = await system.health(`http://${host.includes(':') ? `[${host}]` : host}:${config.port}/health`).catch(() => null);
    if (isRecord(body) && body['openchamberVersion'] === version) {
      if (!config.separation) return true;
      const agent = token ? await system.agentHealth(`http://127.0.0.1:${config.separation.agentPort}`, token).catch(() => null) : null;
      if (isRecord(agent) && agent['openchamberVersion'] === version) return true;
    }
    await system.sleep(1000);
  }
  return false;
}

export async function deploy({ system, root, paths, config, previousConfig, owner, accounts, toolchain, tarball, version, beforeStart = async () => {}, say }: DeployOptions) {
  const dirName = await installPackage({ system, paths, toolchain, root, tarball, version });
  const app = path.join(paths.live.installDir, dirName, PACKAGE_SUBDIR);
  for (const account of new Set([owner, accounts.front, accounts.agent])) await requireTrusted(system, account, path.join(paths.installDir, dirName, PACKAGE_SUBDIR, 'build/bin/cli.js'), 'installed_tree_untrusted');
  await ensureOpenCode({ system, root, owner: accounts.agent, toolchain, app, say });
  const currentLink = path.join(paths.installDir, 'current');
  const previousLink = path.join(paths.installDir, 'previous');
  const before = { current: await fs.readlink(currentLink).catch(() => null), previous: await fs.readlink(previousLink).catch(() => null) };
  const beforeVersion = await linkedVersion(paths, 'current');
  const savedUnits = new Map<string, string | null>();
  for (const name of ALL_UNITS) savedUnits.set(name, await fs.readFile(paths.unit(name), 'utf8').catch((error) => { if (hasCode(error, 'ENOENT')) return null; throw error; }));
  const savedEnv = new Map<string, string | null>();
  for (const file of [paths.agentEnv, paths.agentLink]) savedEnv.set(file, await fs.readFile(file, 'utf8').catch((error) => { if (hasCode(error, 'ENOENT')) return null; throw error; }));
  const goBack = async (reason: { readonly code: string; readonly message: string }): Promise<never> => {
    for (const name of [APP_UNIT, AGENT_UNIT, HOSTD_UNIT, HOSTD_SOCKET]) await system.systemctl(['stop', name]).catch(() => {});
    if (before.current) await replaceSymlink(currentLink, before.current); else await fs.rm(currentLink, { force: true });
    if (before.previous) await replaceSymlink(previousLink, before.previous); else await fs.rm(previousLink, { force: true });
    for (const [name, content] of savedUnits) {
      if (content === null) await fs.rm(paths.unit(name), { force: true });
      else await writeRootFile(system, paths.unit(name), content);
    }
    for (const [file, content] of savedEnv) {
      if (content === null) await fs.rm(file, { force: true });
      else await writeRootFile(system, file, content, 0o600);
    }
    await system.systemctl(['daemon-reload']);
    const restored = previousConfig ?? config;
    const requestOwner = restored.separation ? accounts.front : owner;
    await system.chown(paths.requestDir, requestOwner.uid, requestOwner.gid).catch(() => {});
    if (before.current) await installProtectedMcpFrom({ system, root, paths, config: restored, owner, appDir: before.current, version: beforeVersion, say });
    await writeConfig(system, paths, { ...restored, skipVersion: version });
    if (before.current) {
      if (restored.separation) await system.systemctl(['restart', AGENT_UNIT, HOSTD_SOCKET]);
      await system.systemctl(['restart', APP_UNIT]).catch(() => {});
    }
    fail(reason.code, before.current ? `${reason.message} OpenChamber ${beforeVersion} runs again, and automatic updates skip ${version}` : reason.message);
  };
  let protectedMcp;
  try {
    await beforeStart();
    if (before.current) await replaceSymlink(previousLink, before.current);
    await replaceSymlink(currentLink, dirName);
    const units = { [APP_UNIT]: appUnit({ config, owner, front: accounts.front, toolchain, live: paths.live }), ...updaterUnits({ toolchain, live: { ...paths.live, app } }), ...hostdUnits({ config, toolchain, live: paths.live }) };
    const unitFiles = config.separation ? { ...units, [AGENT_UNIT]: agentUnit({ config: { ...config, separation: config.separation, ownerUid: owner.uid }, agent: accounts.agent, toolchain, live: paths.live }) } : units;
    for (const [name, content] of Object.entries(unitFiles)) await writeRootFile(system, paths.unit(name), content);
    await writeRootFile(system, paths.wrapper, `#!/bin/sh\nentry=${paths.live.app}/build/server/lib/host-install/main.js\n[ -f "$entry" ] || entry=${paths.live.installDir}/previous/${PACKAGE_SUBDIR}/build/server/lib/host-install/main.js\n[ -f "$entry" ] || entry=${paths.live.app}/server/lib/host-install/main.js\nexec ${toolchain.node} "$entry" "$@"\n`, 0o755);
    await writeConfig(system, paths, config);
    await system.systemctl(['daemon-reload']);
    protectedMcp = await installProtectedMcpFrom({ system, root, paths, config, owner, appDir: dirName, version, say });
    await system.systemctl(['enable', APP_UNIT, UPDATER_PATH, HOSTD_SOCKET, ...(config.separation ? [AGENT_UNIT] : [])]);
    await system.systemctl([config['autoUpdate'] ? 'enable' : 'disable', '--now', UPDATER_TIMER]);
    await system.systemctl(['start', UPDATER_PATH]);
    await system.systemctl(['stop', HOSTD_UNIT, HOSTD_SOCKET]);
    await system.systemctl(['start', HOSTD_SOCKET]);
    if (config.separation) await system.systemctl(['restart', AGENT_UNIT]);
    await system.systemctl(['restart', APP_UNIT]);
  } catch (error) { const failure = isRecord(error) ? error : {}; await goBack({ code: isString(failure['code']) ? failure['code'] : 'deploy_failed', message: `Installing OpenChamber ${version} failed: ${failure['message']}.` }); }
  if (!await waitForVersion(system, config, version, paths)) await goBack({ code: 'not_started', message: `OpenChamber ${version} did not start with its agent; journalctl -u ${APP_UNIT} -u ${AGENT_UNIT} tells why.` });
  if (before.current) {
    try { await writeRootFile(system, paths.previousDeployment, `${JSON.stringify({ directory: before.current, config: previousConfig ?? config, units: Object.fromEntries(savedUnits) }, null, 2)}\n`, 0o600); }
    catch (error) { const failure = isRecord(error) ? error : {}; await goBack({ code: 'deployment_snapshot_failed', message: `The previous deployment could not be saved: ${failure['message']}.` }); }
  }
  say(`OpenChamber ${version} is running on ${config.host}:${config.port} as ${accounts.front.name}.`);
  await pruneVersions(paths);
  return { version, previous: beforeVersion, protectedMcp };
}
