import { botBoundaryError, botScopeSchema } from './bot-service-contract.js';
import { readTrustedBotMigrationPaths } from '../bots/production-worktrees.js';
import type { AgentBotServicesOptions, BotServiceOwners, Scope, ScopeLookup, StageSessionEntry, StageRequest, WatchAuthority } from './bot-services.types.js';
import type { ConversationTarget } from '../bots/conversation-contract.js';

const same = <Left, Right>(left: Left, right: Right) => JSON.stringify(left) === JSON.stringify(right);

export function createBotOwnerScope(options: AgentBotServicesOptions) {
  let { dataDir, resolveProject, listProjects, readItem, readBot, listItems } = options;
  const { resolveScope } = options;
  const projectFor = async (id: string) => {
    if (!resolveProject) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    const project = await resolveProject(id);
    if (!project || project.id !== id) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    return project;
  };
  const identityProject = async () => {
    const project = (await listProjects?.())?.[0];
    if (!project) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    return projectFor(project.id);
  };
  const trustedMigrationFor = async (projectId: string, itemId: string, directory?: string) => {
    if (!dataDir) throw botBoundaryError('BOT_EXECUTION_OWNER_REQUIRED', 409);
    const captured = (await readTrustedBotMigrationPaths({ dataDir })).find((entry) => entry.projectId === projectId && entry.itemId === itemId);
    if (captured && directory && captured.directory !== directory) throw botBoundaryError('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH', 409);
    return captured;
  };
  const scopedMigration = async <Input>(raw: Input): Promise<Scope> => {
    const scope = botScopeSchema.parse(raw);
    const trustedMigrationPath = await trustedMigrationFor(scope.project.id, scope.item.id, scope.item.worktree);
    if (scope.trustedMigrationPath && !same(scope.trustedMigrationPath, trustedMigrationPath)) throw botBoundaryError('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH', 409);
    const { trustedMigrationPath: _ignored, ...retained } = scope;
    const captured: Scope = retained;
    if (trustedMigrationPath) captured.trustedMigrationPath = trustedMigrationPath;
    return captured;
  };
  const scopeFor = async (input: ScopeLookup, { allowMissingBot = false } = {}) => {
    if (input.scope) return scopedMigration(input.scope);
    if (input.project && input.bot && input.item) {
      const current = await readItem?.(input.project.id, input.item.id);
      if (current && (current.id !== input.item.id || current.botId !== input.bot.id)) throw botBoundaryError('BOT_EXECUTION_SCOPE_MISMATCH', 409);
      const item = { ...current, ...input.item };
      if (current) item.effects = current.effects;
      return scopedMigration({ project: input.project, bot: input.bot, item,
        checkoutKey: input.checkoutKey ?? `${input.item.id}:worktree` });
    }
    const explicit = await resolveScope?.(input);
    if (explicit) return scopedMigration(explicit);
    const botId = input.botId ?? input.bot?.id ?? input.item?.botId;
    const itemId = input.itemId ?? input.item?.id;
    if (!itemId || !readItem) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    const projects = input.projectId ? [await projectFor(input.projectId)] : await listProjects?.();
    let found: Scope | null = null;
    for (const project of projects ?? []) {
      const item: ScopeLookup['item'] = input.item ?? await readItem(project.id, itemId) ?? undefined;
      if (!item || item.id !== itemId || !item.botId || botId && item.botId !== botId) continue;
      const bot = input.bot ?? await readBot?.(project.id, item.botId)
        ?? (allowMissingBot ? { id: item.botId, name: 'Bot', mission: 'Read captured Bot execution.' } : null);
      if (!bot) continue;
      if (found) throw botBoundaryError('BOT_EXECUTION_SCOPE_AMBIGUOUS', 409);
      found = botScopeSchema.parse({ project, bot, item, checkoutKey: `${itemId}:worktree` });
    }
    if (!found) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    return scopedMigration(found);
  };
  const entryScope = async (entry: StageSessionEntry) => {
    if (entry.scope || entry.project && entry.bot && entry.item) return scopeFor(entry);
    if (!entry.projectId || !entry.itemId || !entry.botId) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    const project = await projectFor(entry.projectId);
    const item = await readItem?.(entry.projectId, entry.itemId);
    if (item && (item.id !== entry.itemId || item.botId !== entry.botId || item.worktree !== entry.directory)) throw botBoundaryError('BOT_EXECUTION_SCOPE_MISMATCH', 409);
    let captured: NonNullable<ScopeLookup['item']> | undefined = item ?? undefined;
    if (!captured) {
      if (!entry.stage || !entry.sessionId) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
      captured = { id: entry.itemId, botId: entry.botId, source: { kind: 'manual', id: entry.itemId }, worktree: entry.directory,
        branch: `bot/${entry.itemId}`, sessions: { [entry.stage]: entry.sessionId } };
    }
    return scopedMigration({ project, bot: { id: entry.botId, name: 'Bot', mission: 'Execute the captured Bot stage.' },
      item: captured, checkoutKey: `${entry.itemId}:worktree` });
  };
  const stageScope = async (request: StageRequest) => {
    const project = request.project ?? await projectFor(request.projectId);
    const stored = await readItem?.(project.id, request.itemId);
    if (stored) return scopeFor({ project, bot: request.bot, item: stored });
    if (!request.itemId.startsWith('discovery_') || request.directory !== project.path) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    return scopedMigration({ project, bot: request.bot,
      item: { id: request.itemId, botId: request.bot.id, source: { kind: 'investigation', id: request.itemId }, sessions: {} } });
  };
  const directoryScope = async (directory: string) => {
    const matches: ScopeLookup[] = [];
    for (const project of await listProjects?.() ?? []) {
      if (project.path === directory) matches.push({ project, bot: { id: 'knowledge', name: 'Bot', mission: 'Collect registered project knowledge.' },
        item: { id: 'knowledge', botId: 'knowledge', source: { kind: 'manual', id: 'knowledge' } } });
      for (const item of await listItems?.(project.id) ?? []) if (item.worktree === directory) matches.push({ project, item, bot: await readBot?.(project.id, item.botId)
        ?? { id: item.botId, name: 'Bot', mission: 'Collect captured checkout knowledge.' }, checkoutKey: `${item.id}:worktree` });
    }
    if (matches.length !== 1) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    return scopedMigration(matches[0]);
  };
  const watchMigration = async (authority: WatchAuthority) => {
    const item = await readItem?.(authority.project.id, authority.itemId);
    if (!item || item.botId !== authority.botId || !item.worktree) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
    return { authority, expectedDirectory: item.worktree,
      trustedMigrationPath: await trustedMigrationFor(authority.project.id, authority.itemId, item.worktree) };
  };
  const bindOwner = (owners: BotServiceOwners) => {
    dataDir = owners.dataDir;
    resolveProject = owners.resolveProject; listProjects = owners.listProjects;
    readItem = async (projectId, itemId) => (await owners.store.read(projectId)).items.find((item) => item.id === itemId)
      ?? (await owners.store.readArchive(projectId)).find((item) => item.id === itemId) ?? null;
    readBot = async (projectId, botId) => (await owners.config.read(projectId)).definitions.find((bot) => bot.id === botId) ?? null;
    listItems = async (projectId) => (await owners.store.read(projectId)).items;
  };
  const conversationTarget = async (target: ConversationTarget, creating = false) => {
    const project = await projectFor(target.project.id);
    const item = await readItem?.(project.id, target.itemId);
    if (!item || item.botId !== target.botId || project.path !== target.project.path
      || target.conversation.directory !== project.path || (!creating || item.conversation) && !same(item.conversation, target.conversation)) {
      throw botBoundaryError('BOT_CONVERSATION_SCOPE_MISMATCH', 409);
    }
    return target;
  };
  return { projectFor, identityProject, scopeFor, entryScope, stageScope, directoryScope, watchMigration, bindOwner, conversationTarget,
    projectAt: async (directory: string) => {
      if (!listProjects) throw new TypeError('listProjects is not a function');
      return (await listProjects()).find((project) => project.path === directory);
    } };
}
