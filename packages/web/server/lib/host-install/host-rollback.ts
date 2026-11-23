import fs from 'node:fs/promises';
import path from 'node:path';
import { isNumber, isString } from '../shared/guards.js';
import { fail } from './accounts.js';
import { writeAgentLink } from './agent-link.js';
import { installProtectedMcpFrom, requireOwnUnits } from './host-deploy.js';
import { hasCode, isRecord } from './host-inputs.js';
import type { JsonObject, JsonValue } from './host-inputs.js';
import type { HostSystem } from './host-support.js';
import { ALL_UNITS, AGENT_UNIT, APP_UNIT, HOSTD_SOCKET, HOSTD_UNIT, UPDATER_TIMER, UPDATER_UNIT } from './host-units.js';
import { createSystem, layout, linkCommand, linkedVersion, prepare, readJson, replaceSymlink, writeConfig, writeRootFile } from './host-support.js';

type DeploymentSnapshot = {
  readonly directory: string;
  readonly config: JsonValue | undefined;
  readonly units: JsonObject;
};
type RollbackOptions = {
  readonly root?: string;
  readonly system?: Pick<HostSystem, 'isRoot' | 'hasSystemd' | 'account' | 'chown' | 'systemctl' | 'protectedMcp'>;
  readonly say?: (message: string) => void;
};

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return isRecord(value);
}

function isDeploymentSnapshot(value: JsonValue): value is DeploymentSnapshot & JsonObject {
  return isJsonObject(value) && isString(value['directory']) && isJsonObject(value['units']);
}

export async function rollback({ root = '/', system = createSystem(), say = () => {} }: RollbackOptions) {
  await prepare(system);
  const paths = layout(root);
  await requireOwnUnits(paths);
  const previousDir = await fs.readlink(path.join(paths.installDir, 'previous')).catch(() => null);
  if (!previousDir) fail('no_previous_version', 'There is no earlier version to go back to');
  const config = await readJson(paths.configFile);
  if (!config) fail('not_installed', 'OpenChamber is not installed on this host');
  const leaving = await linkedVersion(paths, 'current');
  const currentDir = await fs.readlink(path.join(paths.installDir, 'current'));
  const units: Record<string, string | null> = {};
  for (const name of ALL_UNITS) units[name] = await fs.readFile(paths.unit(name), 'utf8').catch((error) => { if (hasCode(error, 'ENOENT')) return null; throw error; });
  const current = { directory: currentDir, config, units };
  const stored = await readJson(paths.previousDeployment);
  if (stored && (!isRecord(stored) || stored['directory'] !== previousDir)) fail('previous_deployment_mismatch', 'The previous package does not match its saved deployment');
  if (stored !== null && !isDeploymentSnapshot(stored)) fail('invalid_previous_deployment', 'The saved previous deployment is invalid');
  if (!stored && isJsonObject(config) && config['separation']) fail('previous_deployment_missing', 'No previous account-mode snapshot is available; reinstall a verified separated release');
  const previous = stored ?? { directory: previousDir, config, units };
  const updaterCommand = /^ExecStart=(.+)$/m.exec(String(units[UPDATER_UNIT] ?? previous.units[UPDATER_UNIT] ?? ''))?.[1];
  const previousVersion = await linkedVersion(paths, 'previous');
  const activate = async (snapshot: DeploymentSnapshot, heldVersion: JsonValue | undefined, version: string | null): Promise<void> => {
    await replaceSymlink(path.join(paths.installDir, 'current'), snapshot.directory);
    const { skipVersion: _hold, ...restoredConfig } = isJsonObject(snapshot.config) ? snapshot.config : {};
    const restored = heldVersion === undefined ? restoredConfig : { ...restoredConfig, skipVersion: heldVersion };
    for (const name of ALL_UNITS) {
      const content = snapshot.units[name];
      if (content == null) {
        await system.systemctl(['disable', name]).catch(() => {});
        await fs.rm(paths.unit(name), { force: true });
      }
      else {
        if (!isString(content)) fail('invalid_previous_deployment', `The saved unit ${name} is invalid`);
        await writeRootFile(system, paths.unit(name), name === UPDATER_UNIT && updaterCommand ? content.replace(/^ExecStart=.*$/m, `ExecStart=${updaterCommand}`) : content);
      }
    }
    const separation = restored['separation'];
    if (separation) {
      if (!isJsonObject(separation) || !isNumber(separation['agentPort'])) fail('invalid_host_config', 'The restored agent port is invalid');
      await writeAgentLink({ system, paths, config: { separation: { agentPort: separation['agentPort'] } } });
    }
    await writeConfig(system, paths, restored);
    const ownerName = restored['owner'];
    if (!isString(ownerName)) fail('invalid_host_config', 'The restored owner is invalid');
    const owner = await system.account(ownerName);
    let front = owner;
    if (separation) {
      const frontDoor = isJsonObject(separation) ? separation['frontDoor'] : undefined;
      if (!isString(frontDoor)) fail('invalid_host_config', 'The restored front-door account is invalid');
      front = await system.account(frontDoor);
    }
    await system.chown(paths.requestDir, front.uid, front.gid);
    await linkCommand(paths, say);
    await system.systemctl(['daemon-reload']);
    await installProtectedMcpFrom({ system, root, paths, config: restored, owner, appDir: snapshot.directory, version, say });
    if (snapshot.units[HOSTD_SOCKET]) {
      await system.systemctl(['enable', HOSTD_SOCKET]);
      await system.systemctl(['start', HOSTD_SOCKET]);
    }
    if (separation) {
      await system.systemctl(['enable', AGENT_UNIT]);
      await system.systemctl(['restart', AGENT_UNIT]);
    }
    if (snapshot.units[UPDATER_TIMER]) await system.systemctl([restored['autoUpdate'] ? 'enable' : 'disable', '--now', UPDATER_TIMER]);
    await system.systemctl(['restart', APP_UNIT]);
  };
  for (const unit of [APP_UNIT, AGENT_UNIT, HOSTD_UNIT, HOSTD_SOCKET]) if (units[unit]) await system.systemctl(['stop', unit]);
  try {
    await activate(previous, leaving, previousVersion);
    await replaceSymlink(path.join(paths.installDir, 'previous'), currentDir);
    await writeRootFile(system, paths.previousDeployment, `${JSON.stringify(current, null, 2)}\n`, 0o600);
  } catch (error) {
    await activate(current, isJsonObject(config) ? config['skipVersion'] : undefined, leaving);
    await replaceSymlink(path.join(paths.installDir, 'previous'), previousDir);
    throw error;
  }
  say(`OpenChamber ${previousVersion} runs again; automatic updates skip ${leaving}.`);
  return { version: previousVersion, skipped: leaving };
}
