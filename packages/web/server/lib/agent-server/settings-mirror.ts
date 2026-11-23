import { isPermissionMode } from '../permission-auto-accept/modes.js';
import { isBoolean, isRecord, isString } from '../shared/guards.js';
import type { createAgentUpstream } from './agent-upstream.js';

// Additions require an explicit review of both the key and its nested shape.
export const AGENT_SETTINGS_MIRROR_VERSION = 1;
const BOOLEAN_KEYS_V1 = Object.freeze([
  'messageSearchEnabled', 'messageSearchReasoningEnabled',
  'agentControlToolEnabled', 'agentScheduleToolEnabled', 'agentWebToolEnabled', 'agentNotifyToolEnabled',
  'agentRenderToolEnabled', 'agentImageToolEnabled', 'agentSecretToolEnabled', 'agentToolsCodeMode',
  'agentMemoryToolEnabled', 'agentMemoryDreamingEnabled', 'agentKnowledgeToolEnabled', 'agentWorkflowToolEnabled', 'agentUsageToolEnabled',
  'autoDeleteEnabled', 'sessionRetentionOnlyArchived', 'sessionRetentionIncludeInWork', 'mergedWorktreeCleanupEnabled', 'worktreeArchiveOnDoneEnabled',
  'autoCreateWorktree', 'allowPromptingSubagentSessions', 'queueModeEnabled', 'smallModelUseDefault',
  'sessionRecapEnabled', 'sessionSuggestionEnabled', 'sessionWorkEnabled', 'sessionReviewOfferEnabled',
  'sessionGoalEnabled', 'sessionGoalDefaultBudgetEnabled', 'responseStyleEnabled',
] as const);
const STRING_KEYS_V1 = Object.freeze([
  'locale', 'lastDirectory', 'activeProjectId', 'opencodeBinary', 'permissionDefaultMode', 'browserProvider', 'agentImageModel',
  'sessionRetentionAction', 'terminalShell', 'defaultGitIdentityId', 'githubClientId', 'githubScopes', 'gitlabClientId',
  'defaultModel', 'defaultVariant', 'defaultAgent', 'smallModelOverride', 'smallModelVariant',
  'agentMemoryDreamingModel', 'agentMemoryDreamingVariant',
  'walkthroughModelOverride', 'walkthroughModelVariant', 'fallbackModel', 'fallbackVariant', 'zenModel',
  'lastSelectedModel', 'sessionGoalChecker', 'prStackConflictMode', 'globalBehaviorPrompt',
  'responseStylePreset', 'responseStyleCustomInstructions', 'inputHistoryScope', 'followUpBehavior',
] as const);
const NUMBER_KEYS_V1 = Object.freeze([
  'autoDeleteAfterDays', 'sessionGoalMaxAutoTurns', 'sessionGoalDefaultBudget', 'inputHistoryLimit', 'liveBrowserTabLimit',
] as const);
const STRING_ARRAY_KEYS_V1 = Object.freeze([
  'accountSwitchProviders', 'terminalLoginShells', 'favoriteAgents', 'recentAgents', 'providerOrder',
] as const);
// These are wire values the agent's sanitizer accepts as a clear or reset.
// Model clears either become an own undefined property after sanitization
// or stay empty strings, as dreaming requires. Both replace the stale value.
const CLEAR_VALUES_V1 = Object.freeze({
  ...Object.fromEntries([
    'lastDirectory', 'opencodeBinary', 'defaultGitIdentityId', 'defaultModel', 'defaultVariant', 'defaultAgent',
    'smallModelOverride', 'smallModelVariant', 'walkthroughModelOverride', 'walkthroughModelVariant',
    'agentMemoryDreamingModel', 'agentMemoryDreamingVariant',
    'fallbackModel', 'fallbackVariant', 'zenModel', 'globalBehaviorPrompt', 'responseStyleCustomInstructions',
  ].map((key) => [key, ''])),
  ...Object.fromEntries([...STRING_ARRAY_KEYS_V1, 'projects', 'serverBrowserOpenChamberOrigins'].map((key) => [key, Object.freeze([])])),
  permissionDefaultMode: 'ask',
  prFixLoopDefaults: Object.freeze({}),
});
export const AGENT_SETTINGS_MIRROR_KEYS_V1 = Object.freeze([
  ...BOOLEAN_KEYS_V1, ...STRING_KEYS_V1, ...NUMBER_KEYS_V1, ...STRING_ARRAY_KEYS_V1,
  'projects', 'lastUsedEfforts', 'prFixLoopDefaults', 'serverBrowserOpenChamberOrigins',
]);

// The host installer imports this module from the unpacked package, before its dependencies exist:
// Node built-ins and this package's own files only.
const httpOrigins = (origins: unknown): string[] => {
  const valid = Array.isArray(origins) && origins.length <= 256 && origins.every((origin) => {
    try {
      if (!isString(origin)) return false;
      const url = new URL(origin);
      return ['http:', 'https:'].includes(url.protocol) && url.origin === origin;
    } catch {
      return false;
    }
  });
  if (!valid) throw new Error('front_door_origins_invalid');
  return [...origins];
};
const pickFields = <Key extends string, Value>(source: Readonly<Record<string, unknown>>, keys: readonly Key[], accepts: (value: unknown) => value is Value): Partial<Record<Key, Value>> => {
  const picked: Partial<Record<Key, Value>> = {};
  for (const key of keys) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (accepts(value)) picked[key] = value;
  }
  return picked;
};
const strings = (value: readonly unknown[]) => value.filter(isString);
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);

type MirroredProject = Partial<Record<'id' | 'path' | 'label' | 'labelSource' | 'defaultAgent' | 'defaultModel' | 'defaultVariant', string>>
  & Partial<Record<'addedAt' | 'lastOpenedAt', number>>;
type MirroredFixLoopDefaults = Partial<Record<'watch' | 'ignoreSelf' | 'ignoreBots' | 'mentionOnly', boolean>>
  & Partial<Record<'maxIterations', number>> & { tokenBudget?: number | null }
  & Partial<Record<'triggers' | 'mentionText' | 'pushMode', string>>
  & Partial<Record<'allowAuthors' | 'blockAuthors', string[]>>;
// Mutable only while constructing the allowlisted wire snapshot.
export type AgentSettingsSnapshot = Partial<Record<(typeof BOOLEAN_KEYS_V1)[number], boolean>>
  & Partial<Record<(typeof STRING_KEYS_V1)[number], string>>
  & Partial<Record<(typeof NUMBER_KEYS_V1)[number], number>>
  & Partial<Record<(typeof STRING_ARRAY_KEYS_V1)[number], string[]>> & {
    projects?: MirroredProject[];
    lastUsedEfforts?: Record<string, string | null>;
    prFixLoopDefaults?: MirroredFixLoopDefaults;
    serverBrowserOpenChamberOrigins?: string[];
  };
export type SettingsMirrorOptions = {
  readonly upstream: Pick<ReturnType<typeof createAgentUpstream>, 'json'>;
  readonly ownOrigins?: (settings: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly logger?: Pick<Console, 'warn'>;
};

const projectOf = (value: unknown): MirroredProject[] => {
  if (!isRecord(value) || !isString(value.id) || !isString(value.path)) return [];
  return [{
    ...pickFields(value, ['id', 'path', 'label', 'labelSource', 'defaultAgent', 'defaultModel', 'defaultVariant'], isString),
    ...pickFields(value, ['addedAt', 'lastOpenedAt'], isFiniteNumber),
  }];
};

/** Reconstruct every object; neither raw project data nor unknown keys travel. */
export const pickAgentSettings = (settings: unknown): AgentSettingsSnapshot => {
  const source = isRecord(settings) ? settings : {};
  const picked: AgentSettingsSnapshot = {
    ...pickFields(source, BOOLEAN_KEYS_V1, isBoolean),
    ...pickFields(source, STRING_KEYS_V1, isString),
    ...pickFields(source, NUMBER_KEYS_V1, isFiniteNumber),
  };
  for (const key of STRING_ARRAY_KEYS_V1) {
    const value = source[key];
    if (Array.isArray(value)) picked[key] = strings(value);
  }
  if (Array.isArray(source.projects)) picked.projects = source.projects.flatMap(projectOf);
  if (!isPermissionMode(picked.permissionDefaultMode)) delete picked.permissionDefaultMode;
  if (isRecord(source.lastUsedEfforts)) {
    picked.lastUsedEfforts = Object.fromEntries(Object.entries(source.lastUsedEfforts)
      .flatMap(([key, effort]) => isString(effort) || effort === null ? [[key, effort]] : []));
  }
  if (isRecord(source.prFixLoopDefaults)) {
    const config = source.prFixLoopDefaults;
    picked.prFixLoopDefaults = {
      ...pickFields(config, ['watch', 'ignoreSelf', 'ignoreBots', 'mentionOnly'], isBoolean),
      ...pickFields(config, ['maxIterations', 'tokenBudget'], isFiniteNumber),
      ...pickFields(config, ['triggers', 'mentionText', 'pushMode'], isString),
    };
    if (config.tokenBudget === null) picked.prFixLoopDefaults.tokenBudget = null;
    for (const key of ['allowAuthors', 'blockAuthors'] as const) {
      const value = config[key];
      if (Array.isArray(value)) picked.prFixLoopDefaults[key] = strings(value);
    }
  }
  return picked;
};

/**
 * Call start(ownerSnapshot) during boot before accepting settings mutations. `ownOrigins(settings)`
 * answers the front door's own origins: the agent's Server Browser refuses to open them.
 */
export const createSettingsMirror = ({ upstream, ownOrigins = async () => [], logger = console }: SettingsMirrorOptions) => {
  let pending = Promise.resolve();
  const enqueue = (operation: () => Promise<void>) => {
    pending = pending.then(operation).catch(() => { logger.warn('agent_settings_mirror_failed'); });
    return pending;
  };
  const send = async (picked: AgentSettingsSnapshot) => {
    // The response is agent-controlled and can never update the owner's file.
    await upstream.json('/api/config/settings', {
      method: 'PUT', body: JSON.stringify(picked), headers: { 'content-type': 'application/json', 'x-openchamber-settings-mirror': String(AGENT_SETTINGS_MIRROR_VERSION) },
    });
  };
  const onSettingsWritten = (settings: unknown) => {
    const picked = { ...structuredClone(CLEAR_VALUES_V1), ...pickAgentSettings(settings) };
    const snapshot = structuredClone(isRecord(settings) ? settings : {});
    // An origin list that cannot be made is a failed mirror, never a mirror without the refusal.
    return enqueue(async () => send({ ...picked, serverBrowserOpenChamberOrigins: httpOrigins(await ownOrigins(snapshot)) }));
  };
  return { start: onSettingsWritten, onSettingsWritten, flush: () => pending };
};
