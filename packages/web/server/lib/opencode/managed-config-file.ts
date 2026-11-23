import { appendManagedCommand, appendManagedPermissions, appendManagedPolicies, appendManagedPlugin, appendManagedSkills } from './managed-plugin-config.js';
import { managedPermissionRules } from '../agent-tool/runtime.js';
import { isSharingAvailable } from '../share-pages/relay-client.js';
import { materializeSessionTitlePlugin } from './session-title-plugin.js';
import { materializeLocalMcpPlugin } from './mcp-local-plugin.js';
export { retireClaudePlugin } from './retired-plugins.js';
import { collectSkillEntriesFromRoots, createExternalPluginBridgeRuntime, registerExternalPluginBridgeRoutes } from './external-plugin-bridge.js';
import { EXTENSION_AUTHORING_COMMAND, materializeAuthoringSkill } from '../guests/agent-context.js';
import type { OpenCodePluginDelivery } from '../guests/opencode-plugin.js';
import type { Application } from '../shared/http-contracts.js';
import type { createAgentToolRuntime } from '../agent-tool/runtime.js';
import type { LimitFailoverConfigurationInput } from '../limit-failover/policy.js';

export interface ManagedConfigSettings extends LimitFailoverConfigurationInput {
  agentControlToolEnabled?: unknown;
  agentScheduleToolEnabled?: unknown;
  agentWebToolEnabled?: unknown;
  agentMemoryToolEnabled?: unknown;
  agentKnowledgeToolEnabled?: unknown;
  agentNotifyToolEnabled?: unknown;
  agentRenderToolEnabled?: unknown;
  agentImageToolEnabled?: unknown;
  agentSecretToolEnabled?: unknown;
  agentUsageToolEnabled?: unknown;
  agentTerminalToolEnabled?: unknown;
  agentWorkflowToolEnabled?: unknown;
}

export interface ManagedConfigDependencies {
  fsPromises: typeof import('node:fs/promises');
  path: typeof import('node:path');
  dataDir: string;
  instanceDir: string;
  env?: NodeJS.ProcessEnv;
  agentToolRuntime?: Pick<ReturnType<typeof createAgentToolRuntime>, 'materializePlugin' | 'createChildEnv'> & Partial<Pick<ReturnType<typeof createAgentToolRuntime>, 'ensureBridgeCredentials'>> | null;
  limitFailoverRuntime?: { materializePlugin: () => Promise<string> } | null;
  readSettings: () => ManagedConfigSettings | null | Promise<ManagedConfigSettings | null>;
  listExtensionSkillDirectories?: () => Promise<string[]>;
  listExtensionPluginDirectories?: () => Promise<string[]>;
  openchamberVersion?: string;
  readPluginDenials?: () => Array<{ action: string; resource: string; effect: string }>;
  isBotToolAvailable?: () => boolean;
  getOpenCodePluginDelivery?: () => OpenCodePluginDelivery;
}

interface ManagedConfigFile {
  plugins: string[];
  skills: string[];
  commands: Record<string, Awaited<ReturnType<typeof materializeAuthoringSkill>>['command']>;
  permissions?: ReturnType<typeof managedPermissionRules>;
  policies?: Parameters<typeof appendManagedPolicies>[1];
}

export const MANAGED_CONFIG_FILE_NAME = 'opencode.managed.json';

const DISABLED_BUILTIN_PLUGINS = ['-opencode.browser'];

const BUILTIN_IMAGE_PLUGIN = '-opencode.tool.image-generate';
const BUILTIN_AUTOMATION_PLUGIN = '-opencode.tool.automation';

/**
 * The managed OpenCode config layer.
 *
 * OpenCode 2 watches every config source it reads, including the file named by
 * the `OPENCODE_CONFIG` environment variable, and reloads its plugin list when
 * that file changes. Writing OpenChamber's own plugin entries into a file we
 * own therefore makes toggling a managed tool take effect in the running
 * process — where `OPENCODE_CONFIG_CONTENT` (an environment variable) could
 * only ever change across a restart.
 *
 * The file is OpenChamber-owned and holds `plugins`: the built-in plugins
 * OpenChamber disables, then its own plugin directories; `policies`: the
 * `integration.use` denials for the plugins switched off in OpenChamber; and
 * `permissions` its tools need, such as the workflow answer tool denied
 * everywhere but in the sessions that allow it. OpenCode appends every layer's
 * permissions to each agent, so ours add to the user's rules and replace none.
 * `skills` lists our extension-writing skill and the folders active extensions
 * ship, and `commands` the command that starts extension work. It sits above
 * the user's global `opencode.json` and below their project config, so it never
 * shadows a project-level choice. The plugin folders active extensions ship
 * come after OpenChamber's own plugins: OpenCode loads in list order, so an
 * extension never shadows a managed tool.
 *
 * When the user's own environment already sets `OPENCODE_CONFIG`, that file is
 * theirs: OpenChamber does not hijack it and falls back to merging its plugins
 * into `OPENCODE_CONFIG_CONTENT`, which keeps the old restart requirement for
 * managed-tool toggles.
 *
 * @param {object} dependencies
 * @param {typeof import('node:fs/promises')} dependencies.fsPromises
 * @param {typeof import('node:path')} dependencies.path
 * @param {string} dependencies.dataDir the persistent OpenChamber data directory; the
 *   project-local MCP plugin reads the entries stored there by every server
 * @param {string} dependencies.instanceDir this server's own directory (`instance-dir.js`),
 *   which holds the config file and this process's plugins
 * @param {NodeJS.ProcessEnv} [dependencies.env] environment the managed child inherits
 * @param {object|null} [dependencies.agentToolRuntime]
 * @param {object|null} [dependencies.limitFailoverRuntime] `../limit-failover/runtime.js`; its plugin calls back through the agent tool's address
 * @param {() => Promise<object|null>} dependencies.readSettings
 * @param {() => Promise<string[]>} [dependencies.listExtensionSkillDirectories] skill folders of active extensions
 * @param {() => Promise<string[]>} [dependencies.listExtensionPluginDirectories] OpenCode plugin folders of active extensions
 * @param {string} [dependencies.openchamberVersion] the running app, which the extension-writing skill pins its SDK to
 * @param {() => { action: string, resource: string, effect: string }[]} [dependencies.readPluginDenials] the plugins switched off in OpenChamber
 */
export const createManagedConfigRuntime = ({
  fsPromises,
  path,
  dataDir,
  instanceDir,
  env = process.env,
  agentToolRuntime = null,
  limitFailoverRuntime = null,
  readSettings,
  listExtensionSkillDirectories = async () => [],
  listExtensionPluginDirectories = async () => [],
  openchamberVersion,
  readPluginDenials = () => [],
  isBotToolAvailable = () => false,
  getOpenCodePluginDelivery,
}: ManagedConfigDependencies) => {
  // Fail at construction: a missing directory otherwise only surfaces when the
  // managed OpenCode child is about to spawn, leaving the server up without it.
  for (const [name, value] of [['dataDir', dataDir], ['instanceDir', instanceDir]]) {
    if (!value || !path.isAbsolute(value)) {
      throw new TypeError(`createManagedConfigRuntime: ${name} must be an absolute path`);
    }
  }
  const filePath = path.join(instanceDir, MANAGED_CONFIG_FILE_NAME);
  const externalBridge = dataDir && getOpenCodePluginDelivery && agentToolRuntime?.ensureBridgeCredentials
    ? createExternalPluginBridgeRuntime({
      fsPromises,
      path,
      dataDir,
      readSettings,
      ensureCredentials: () => agentToolRuntime.ensureBridgeCredentials?.() ?? null,
      isExternalLocal: () => getOpenCodePluginDelivery() === 'none',
      collectSkillsAndCommands: async () => {
        const authoring = await materializeAuthoringSkill({ fsPromises, instanceDir, openchamberVersion });
        const skillRoots = [authoring.skillsRoot, ...await listExtensionSkillDirectories()];
        const skills = await collectSkillEntriesFromRoots(fsPromises, path, skillRoots);
        const commands = [{ name: EXTENSION_AUTHORING_COMMAND, description: authoring.command.description, template: authoring.command.template }];
        return { skills, commands };
      },
    })
    : null;

  const ownsConfigFile = () => (env.OPENCODE_CONFIG ?? '').trim().length === 0;

  const writeConfigFile = async ({ disabled, directories, extensionPlugins, permissions, policies, skills, commands }: Awaited<ReturnType<typeof materializeEnabledPlugins>>) => {
    await fsPromises.mkdir(instanceDir, { recursive: true });
    const config: ManagedConfigFile = { plugins: [...disabled, ...directories, ...extensionPlugins], skills, commands };
    if (policies.length > 0) config.policies = policies;
    if (permissions.length > 0) config.permissions = permissions;
    const text = `${JSON.stringify(config, null, 2)}\n`;
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fsPromises.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
      await fsPromises.rename(tmp, filePath);
    } catch (error) {
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  };

  const materializeEnabledPlugins = async () => {
    const settings = await Promise.resolve(readSettings()).catch(() => null);
    const includeControl = settings?.agentControlToolEnabled !== false;
    const includeSchedule = settings?.agentScheduleToolEnabled !== false;
    const includeWeb = settings?.agentWebToolEnabled !== false;
    const includeMemory = settings?.agentMemoryToolEnabled === true;
    const includeKnowledge = settings?.agentKnowledgeToolEnabled !== false;
    const includeNotify = settings?.agentNotifyToolEnabled === true;
    const includeRender = settings?.agentRenderToolEnabled !== false;
    const includeShare = includeRender && isSharingAvailable();
    const includeBot = isBotToolAvailable();
    const includeImage = settings?.agentImageToolEnabled === true;
    const includeSecret = settings?.agentSecretToolEnabled !== false;
    const includeUsage = settings?.agentUsageToolEnabled === true;
    const includeTerminal = settings?.agentTerminalToolEnabled === true;
    const includeWorkflow = settings?.agentWorkflowToolEnabled === true;

    const directories = [await materializeLocalMcpPlugin({ dataDir })];
    let permissions: ReturnType<typeof managedPermissionRules> = [];
    if (agentToolRuntime && (includeControl || includeSchedule || includeWeb || includeMemory || includeKnowledge || includeNotify || includeRender || includeImage || includeSecret || includeUsage || includeTerminal || includeWorkflow || includeBot)) {
      directories.push(await agentToolRuntime.materializePlugin({ includeControl, includeSchedule, includeWeb, includeMemory, includeKnowledge, includeNotify, includeRender, includeShare, includeImage, includeSecret, includeUsage, includeTerminal, includeWorkflow, includeBot }));
      permissions = managedPermissionRules({ includeWorkflow });
    }
    // Always: a limit that names its reset waits for it and retries, which has
    // to run even when account switching and the fallback model are both off.
    if (agentToolRuntime && limitFailoverRuntime) {
      directories.push(await limitFailoverRuntime.materializePlugin());
    }
    directories.push(await materializeSessionTitlePlugin({ fsPromises, path, instanceDir }));
    const disabled = [
      ...DISABLED_BUILTIN_PLUGINS,
      ...(includeImage ? [BUILTIN_IMAGE_PLUGIN] : []),
      ...(agentToolRuntime && includeSchedule ? [BUILTIN_AUTOMATION_PLUGIN] : []),
    ];
    const authoring = await materializeAuthoringSkill({ fsPromises, instanceDir, openchamberVersion });
    const skills = [authoring.skillsRoot, ...await listExtensionSkillDirectories()];
    const extensionPlugins = await listExtensionPluginDirectories();
    return { disabled, directories, extensionPlugins, permissions, policies: readPluginDenials(), skills, commands: { [EXTENSION_AUTHORING_COMMAND]: authoring.command } };
  };

  let writing: Promise<void> | null = null;
  let writeAgain = false;
  const writeLatestConfigFile = () => {
    if (writing) {
      writeAgain = true;
      return writing;
    }
    writing = (async () => {
      do {
        writeAgain = false;
        await writeConfigFile(await materializeEnabledPlugins());
      } while (writeAgain);
    })().finally(() => {
      writing = null;
    });
    return writing;
  };

  const buildManagedChildEnv = async () => {
    const childEnv = agentToolRuntime ? agentToolRuntime.createChildEnv() : {};
    if (ownsConfigFile()) {
      await writeLatestConfigFile();
      return { ...childEnv, OPENCODE_CONFIG: filePath };
    }
    const enabled = await materializeEnabledPlugins();
    let content = env.OPENCODE_CONFIG_CONTENT;
    for (const directory of [...enabled.disabled, ...enabled.directories, ...enabled.extensionPlugins]) {
      content = appendManagedPlugin(content, directory, 'managed plugin');
    }
    if (enabled.policies.length > 0) content = appendManagedPolicies(content, enabled.policies);
    if (enabled.permissions.length > 0) content = appendManagedPermissions(content, enabled.permissions);
    content = appendManagedSkills(content, enabled.skills);
    for (const [name, command] of Object.entries(enabled.commands)) content = appendManagedCommand(content, name, command);
    return { ...childEnv, OPENCODE_CONFIG_CONTENT: content };
  };

  const syncExternalBridge = async () => (externalBridge ? externalBridge.syncBridge() : { active: false });
  const cleanupExternalBridge = async () => { await externalBridge?.cleanupBridge(); };
  const registerExternalBridgeRoutes = (app: Application) => {
    if (!getOpenCodePluginDelivery) return;
    registerExternalPluginBridgeRoutes(app, {
      getBridge: () => externalBridge,
      getDelivery: getOpenCodePluginDelivery,
    });
  };

  const refreshManagedConfigFile = async () => {
    await externalBridge?.syncBridge().catch(() => {});
    if (!ownsConfigFile()) return { updated: false, reason: 'external-config' };
    await writeLatestConfigFile();
    return { updated: true };
  };

  return {
    filePath,
    ownsConfigFile,
    buildManagedChildEnv,
    refreshManagedConfigFile,
    syncExternalBridge,
    cleanupExternalBridge,
    registerExternalBridgeRoutes,
  };
};
