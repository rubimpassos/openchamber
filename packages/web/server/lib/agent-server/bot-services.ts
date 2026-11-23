import { z } from 'zod';
import { isFunction, isPrimitiveString } from '../shared/guards.js';
import { createOwnerBotGateway } from './bot-owner-gateway.js';
import { readBoundedBody } from './agent-upstream.js';
import { createBotOwnerScope } from './bot-owner-scope.js';
import { publicBinding, selectIdentity } from './bot-owner-bindings.js';
import { checkedBotServiceReply, parseBotServiceInput } from './bot-service-codec.js';
import type { BotServiceInput, BotServiceOperation, BotServiceReply, BotEffectInput } from './bot-service-contract.js';
import type { AgentBotServicesOptions, BotUpstream, CallOptions, EffectOperation, EffectOptions,
  GatewayOptions, PreparedRequest, Project, ReadRequest, ScopeLookup, ScopedEffect, SessionEntry, SessionExtra, SessionOperation,
  StageExtra, StageOperation, StageRequest, StageSessionEntry, WatchAuthority, WatchFeedbackInput, WatchInput, WatchReference } from './bot-services.types.js';
import type { BotDefinition } from '../bots/config.js';
import type { GitHubRequest, ServiceContext } from '../bots/service-context.js';
import type { BotServices, BotServiceReadValue } from '../bots/services.js';
import type { JiraCommentPage } from '../bots/services/jira.js';
import type { createProductionBotWorktrees } from '../bots/production-worktrees.js';
import type { createBotQuestionBlame } from '../bots/questions-blame.js';
import type { AdoptionRequest } from '../bots/production-worktree-contracts.js';
import type { createBotHostTools } from '../bots/host-tools.js';
import { BOT_SERVICE_BYTES, BOT_SERVICE_INPUT_BYTES, BOT_SERVICE_ROUTE, BOT_SERVICE_TIMEOUT_MS,
  assertBotEffectInput, botBoundaryError, botReplySchema, botRequestAssociation, botScopeSchema, botWatchAuthoritySchema } from './bot-service-contract.js';

const errorReply = z.object({ code: z.string().regex(/^(?:BOT_[A-Z0-9_]+|SOURCE_CONTROL_[A-Z0-9_]+|agent_[a-z0-9_]+|enterprise_mode)$/).max(200),
  state: z.enum(['needs-you', 'outcome-unknown', 'failed', 'refused']).optional() });
const same = <Left, Right>(left: Left, right: Right) => JSON.stringify(left) === JSON.stringify(right);
const errorCode = z.object({ code: z.unknown().optional() });

export function createAgentBotServices(upstream: BotUpstream, options: AgentBotServicesOptions = {}) {
  const owner = createBotOwnerScope(options);
  const { projectFor, identityProject, scopeFor, entryScope, stageScope, directoryScope, watchMigration } = owner;
  if (!isFunction(upstream?.request)) throw new TypeError('Bot services require an authenticated agent upstream');
  const call = async <Operation extends BotServiceOperation, Value>(operation: Operation, value: Value, { signal }: CallOptions = {}): Promise<BotServiceReply<Operation>> => {
    const captured = parseBotServiceInput(operation, value);
    const association = botRequestAssociation(operation, captured);
    const body = JSON.stringify(captured);
    if (Buffer.byteLength(body) > BOT_SERVICE_INPUT_BYTES) throw botBoundaryError('BOT_EXECUTION_REQUEST_TOO_LARGE', 400, 'failed');
    let response;
    try {
      response = await upstream.request({ path: `${BOT_SERVICE_ROUTE}/${operation}`, method: 'POST', body, signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        timeoutMs: ['proof', 'worktree-create', 'worktree-inspect', 'worktree-adopt-isolated', 'worktree-accept-published',
          'worktree-remove', 'service-execute', 'pull-failed-checks'].includes(operation) ? 600_000 : BOT_SERVICE_TIMEOUT_MS });
      let raw: unknown;
      try { raw = JSON.parse(await readBoundedBody(response, BOT_SERVICE_BYTES)); }
      catch (error) { throw botBoundaryError(errorCode.safeParse(error).data?.code === 'agent_response_too_large' ? 'BOT_EXECUTION_RESPONSE_TOO_LARGE' : 'BOT_EXECUTION_INVALID_RESPONSE'); }
      if (response.statusCode !== 200) {
        const failure = errorReply.safeParse(raw);
        throw botBoundaryError(failure.success ? failure.data.code : 'BOT_EXECUTION_FAILED',
          response.statusCode >= 400 && response.statusCode <= 599 ? response.statusCode : 502, failure.success ? failure.data.state : undefined);
      }
      const reply = botReplySchema(operation).safeParse(raw);
      if (!reply.success || !same(reply.data.association, association)) throw botBoundaryError('BOT_EXECUTION_INVALID_RESPONSE');
      return checkedBotServiceReply(operation, captured, reply.data.result);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (errorReply.safeParse(error).success) throw error;
      throw botBoundaryError('BOT_EXECUTION_FAILED');
    }
  };
  const inventoryFor = async (project?: Project) => call('identity-list', { project: project ?? await identityProject() });
  const sessionCall = async <Operation extends SessionOperation>(operation: Operation, entry: StageSessionEntry, extra: SessionExtra = {}) => call(operation, { scope: await entryScope(entry), sessionId: entry.sessionId, ...extra });
  const stageCall = async <Operation extends StageOperation>(operation: Operation, request: StageRequest, extra: StageExtra = {}) => call(operation, { scope: await stageScope(request), request, ...extra });
  const effectCall = async <Operation extends EffectOperation>(operation: Operation, effect: ScopedEffect, input: BotEffectInput, options?: EffectOptions) => {
    const captured = structuredClone({ effect, input });
    assertBotEffectInput(captured.effect, captured.input);
    const scope = await scopeFor({ ...captured.effect, scope: options?.scope ?? effect.scope });
    const { scope: _scope, ...descriptor } = captured.effect;
    return call(operation, { scope, operation: descriptor.operation, effect: descriptor, input: captured.input });
  };
  const hostSessions = {
    readSession: (entry: SessionEntry) => sessionCall('session', entry),
    isWorking: (entry: SessionEntry) => sessionCall('activity', entry),
    readTokens: (entry: SessionEntry, options: { readonly since?: number | undefined } = {}) => sessionCall('tokens', entry, { since: options.since }),
    syncKnowledge: (entry: SessionEntry, options: { readonly includeMemorySaveRule?: boolean | undefined } = {}) => sessionCall('knowledge-sync', entry, { includeMemorySaveRule: options.includeMemorySaveRule !== false }),
    deliverNotice: (entry: SessionEntry & { readonly notice: Record<string, unknown>; readonly id: string; readonly text: string; readonly description?: string | undefined }) => sessionCall('synthetic-deliver', entry, { eventId: entry.notice.eventId, messageId: entry.id,
      text: entry.text, description: entry.description ?? entry.text }),
    pullTools: (entry: SessionEntry) => sessionCall('tools-pull', entry),
    settleTool: (entry: SessionEntry, settlement: Parameters<Parameters<typeof createBotHostTools>[0]['execution']['settleTool']>[1]) => sessionCall('tools-settle', entry, { settlement }),
  };
  const watchAuthority = (value: WatchReference | undefined) => botWatchAuthoritySchema.parse(value && ('botAuthority' in value ? value.botAuthority : 'authority' in value ? value.authority : value));
  const selectedWatchAuthority = (input: WatchInput) => {
    const authority = watchAuthority(input.octokit ?? input.authority);
    if (input.owner && input.owner.toLowerCase() !== authority.target.owner.toLowerCase()
      || input.repo && input.repo.toLowerCase() !== authority.target.repo.toLowerCase()) throw botBoundaryError('BOT_GITHUB_PULL_CHANGED', 409);
    return authority;
  };
  const watchInput = (input: WatchFeedbackInput) => {
    const authority = selectedWatchAuthority(input);
    return { authority, number: input.number, branch: input.branch ?? authority.publicationBranch ?? `bot/${authority.itemId}`, headSha: input.headSha };
  };
  const botWatch = {
    getOctokit: async (authority: WatchReference) => {
      const captured = structuredClone(watchAuthority(authority)); await watchMigration(captured);
      return { botAuthority: captured };
    },
    readFeedback: async (input: WatchFeedbackInput) => {
      const captured = watchInput(input);
      return call('pull-feedback', { ...captured, ...await watchMigration(captured.authority), mentionText: input.mentionText });
    },
    readAuthorPermission: async (input: WatchInput & { readonly username: string }) => (await call('pull-author-permission', {
      ...await watchMigration(selectedWatchAuthority(input)), username: input.username })).permitted,
    readFailedChecks: async (input: WatchInput & { readonly contexts: readonly unknown[] }) => call('pull-failed-checks', { ...await watchMigration(selectedWatchAuthority(input)), contexts: input.contexts }),
    authorizeApp: async (authority: WatchReference, author: BotServiceInput<'pull-review-app'>['author'], selectedApprovedApp?: BotServiceInput<'pull-review-app'>['selectedApprovedApp']) => (await call('pull-review-app', {
      ...await watchMigration(watchAuthority(authority)), author, selectedApprovedApp })).authorized,
  };
  const worktrees = {
    create: async (request: ScopeLookup & { readonly key?: string | undefined }) => call('worktree-create', { scope: await scopeFor(request), key: request.key }),
    reconcile: async (request: ScopeLookup & { readonly key?: string | undefined; readonly item: NonNullable<ScopeLookup['item']>; readonly operation?: string | undefined }) => call('worktree-reconcile', { scope: await scopeFor(request), key: request.key ?? `${request.item.id}:worktree`, operation: request.operation === 'remove' ? 'remove' : 'create' }),
    inspect: async (request: ScopeLookup) => call('worktree-inspect', { scope: await scopeFor(request) }),
    bindPublication: async (request: ScopeLookup & Pick<BotServiceInput<'worktree-bind-publication'>, 'branch'>) => call('worktree-bind-publication', { scope: await scopeFor(request), branch: request.branch }),
    readPublication: async (request: ScopeLookup & Pick<BotServiceInput<'worktree-read-publication'>, 'repositoryId'>) => call('worktree-read-publication', { scope: await scopeFor(request, { allowMissingBot: true }), repositoryId: request.repositoryId }),
    adoptIsolated: async (request: ScopeLookup & Pick<AdoptionRequest, 'resultSha' | 'spaceId'>) => call('worktree-adopt-isolated', { scope: await scopeFor(request), resultSha: request.resultSha, spaceId: request.spaceId }),
    acceptPublished: async (request: ScopeLookup & Pick<Parameters<ReturnType<typeof createProductionBotWorktrees>['acceptPublished']>[0], 'snapshot' | 'result'>) => call('worktree-accept-published', { scope: await scopeFor(request), snapshot: request.snapshot, result: request.result }),
    remove: async (request: ScopeLookup & Pick<BotServiceInput<'worktree-remove'>, 'key' | 'checkout'>) => call('worktree-remove', { scope: await scopeFor(request), key: request.key, checkout: request.checkout }),
    sameTree: async (request: ScopeLookup & Pick<BotServiceInput<'worktree-same-tree'>, 'left' | 'right'>) => (await call('worktree-same-tree', { scope: await scopeFor(request), left: request.left, right: request.right })).same,
  };
  function read(request: ReadRequest & { readonly operation: 'jira.comments' }): Promise<JiraCommentPage>;
  function read(request: ReadRequest): Promise<BotServiceReadValue>;
  async function read(request: ReadRequest): Promise<BotServiceReadValue> {
    const scope = await scopeFor(request); const { scope: _scope, ...value } = request;
    return (await call('service-read', { scope, request: value })).value;
  }
  const services: BotServices = {
    prepare: async (request: PreparedRequest) => {
      const scope = await scopeFor(request); const { scope: _scope, ...value } = request;
      const identity = (await inventoryFor(scope.project)).find((entry) => entry.id === request.identityId && entry.revision === request.identityRevision);
      if (!identity) throw botBoundaryError('BOT_IDENTITY_CHANGED', 409);
      const result = await call('service-prepare', { scope, request: value });
      const credentialId = identity.kind === 'github-account' ? identity.accountId : identity.id;
      const credentialRevision = identity.kind === 'github-account' ? identity.credentialRevision : identity.revision;
      if (result.authority.credentialId !== credentialId || result.authority.credentialRevision !== credentialRevision) throw botBoundaryError('BOT_EXECUTION_UNRELATED_REPLY');
      return result;
    },
    read,
    preflight: (effect: ScopedEffect, input: BotEffectInput, options?: EffectOptions) => effectCall('service-preflight', effect, input, options),
    async execute(effect: ScopedEffect, input: BotEffectInput, options: EffectOptions = {}) {
      const captured = structuredClone({ effect, input });
      assertBotEffectInput(captured.effect, captured.input);
      const scope = await scopeFor({ ...captured.effect, scope: options.scope ?? effect.scope });
      const { scope: _scope, ...descriptor } = captured.effect;
      const wire = { scope, operation: descriptor.operation, effect: descriptor, input: captured.input };
      await call('service-preflight', wire);
      await options.beforeAdmission?.();
      await options.beforeDispatch?.();
      return call('service-execute', wire);
    },
    reconcile: (effect: ScopedEffect, input: BotEffectInput, options?: EffectOptions) => effectCall('service-reconcile', effect, input, options).then((reply) => {
      if ('operation' in reply) { const { operation: _operation, ...result } = reply; return result; }
      return reply;
    }),
  };
  const context = {
    repository: (project: Project): Promise<BotServiceReply<'repository'>> => call('repository', { project }),
    async serviceContext(request: ScopeLookup & Pick<BotServiceInput<'context'>, 'service' | 'operation' | 'target'>): Promise<ServiceContext> {
      const scope = await scopeFor(request);
      const expectedIdentity = selectIdentity(await inventoryFor(scope.project), scope.bot, request.service);
      let expectedTarget;
      if (expectedIdentity) {
        if (request.service === 'github') expectedTarget = (await context.repository(scope.project)).target;
        if (request.service === 'jira' && scope.item.source.kind === 'jira') expectedTarget = {
          issueKey: scope.item.source.id, projectKey: scope.item.source.id.replace(/-[1-9][0-9]*$/, '') };
        if (request.service === 'discord') expectedTarget = request.target ?? (scope.bot.discord.channels.length === 1 ? scope.bot.discord.channels[0] : undefined);
      }
      const result = await call('context', { scope, service: request.service, operation: request.operation, target: request.target,
        expectedIdentity, expectedTarget });
      switch (request.service) {
        case 'github': return result.github ? { github: publicBinding(result.github) } : {};
        case 'jira': return result.jira ? { jira: publicBinding(result.jira) } : {};
        case 'discord': return result.discord ? { discord: publicBinding(result.discord) } : {};
        default: request.service satisfies never; throw botBoundaryError('BOT_SERVICE_UNSUPPORTED');
      }
    },
    async github(request: GitHubRequest) {
      const inventory = await inventoryFor(request.project);
      const binding = request.binding;
      const expectedIdentity = binding ? inventory.find((entry) => entry.id === binding.identityId && entry.revision === binding.identityRevision)
        : request.bot ? selectIdentity(inventory, request.bot, 'github') : null;
      if (!expectedIdentity) throw botBoundaryError('BOT_IDENTITY_REQUIRED', 409);
      const expectedTarget = request.binding?.target ?? (await context.repository(request.project)).target;
      const result = await call('github-binding', { project: request.project, bot: request.bot, binding: request.binding, expectedIdentity, expectedTarget });
      return { binding: publicBinding(result.binding) };
    },
    async identityFor(bot: BotDefinition, service: BotServiceInput<'context'>['service']) {
      const identity = selectIdentity(await inventoryFor(), bot, service);
      if (!identity) throw botBoundaryError('BOT_IDENTITY_REQUIRED', 409);
      return { identityId: identity.id, identityRevision: identity.revision };
    },
  };
  const readPullStatus = async (request: ScopeLookup & { readonly authority?: WatchAuthority | null }) => {
    const scope = await scopeFor(request);
    let authority = request.authority;
    if (authority === null || authority === undefined) {
      authority = { project: scope.project, botId: scope.bot.id, itemId: scope.item.id,
        ...(await context.github({ project: scope.project, bot: scope.bot })).binding };
      if (scope.item.publicationBranch) authority.publicationBranch = scope.item.publicationBranch;
    }
    return call('pull-status', { scope, authority });
  };
  return {
    bindOwner: owner.bindOwner,
    identities: { list: () => inventoryFor(), create: async <Definition>(definition: Definition) => call('identity-create', { project: await identityProject(), definition }),
      update: async <Definition>(id: string, expectedRevision: number, definition: Definition) => call('identity-update', { project: await identityProject(), id, expectedRevision, definition }),
      remove: async (id: string, expectedRevision: number) => call('identity-remove', { project: await identityProject(), id, expectedRevision }) },
    context, worktrees, services, hostSessions, botWatch,
    createGateway(input: GatewayOptions) {
      if (!input.project || !input.bot) throw botBoundaryError('BOT_EXECUTION_SCOPE_REQUIRED', 409);
      const scope = botScopeSchema.parse({ project: input.project, bot: input.bot,
        item: { id: `discovery_gateway_${input.bot.id}`, botId: input.bot.id, source: { kind: 'investigation', id: 'discord-gateway' } } });
      return createOwnerBotGateway({ ...input, call, scope });
    },
    stages: {
      select: async (projectId: string, bot: BotDefinition, stage: keyof BotDefinition['models']) => bot.models[stage].useDefaults
        ? call('defaults', { project: await projectFor(projectId) }) : structuredClone(bot.models[stage]),
      async create(request: StageRequest, onCreated: (result: BotServiceReply<'stage-create'>) => Promise<void>) { const result = await stageCall('stage-create', request); await onCreated(result); return result; },
      dispatch: (request: StageRequest) => stageCall('stage-dispatch', request),
      outcome: (request: StageRequest) => stageCall('stage-outcome', request),
      reconcile: (kind: BotServiceInput<'stage-reconcile'>['kind'], request: StageRequest, sessionId?: string) => stageCall('stage-reconcile', request, { kind, sessionId }),
      stop: async (request: StageSessionEntry) => sessionCall('stage-stop', { ...request, botId: request.bot?.id ?? request.botId }),
      resume: async (request: StageSessionEntry) => sessionCall('stage-resume', { ...request, botId: request.bot?.id ?? request.botId }),
    },
    readSessionDefaults: async (projectId: string) => call('defaults', { project: await projectFor(projectId) }),
    sessionKnowledgeRuntime: {
      collect: async (request: string | ScopeLookup) => call('knowledge', { scope: isPrimitiveString(request) ? await directoryScope(request) : await scopeFor(request) }),
      sync: hostSessions.syncKnowledge,
    },
    readSession: async (request: ScopeLookup & { readonly sessionId: string }) => call('session', { scope: await scopeFor(request), sessionId: request.sessionId }),
    readTokens: hostSessions.readTokens, isWorking: hostSessions.isWorking,
    async runProof(input: ScopeLookup & { readonly directory: string; readonly command: string; readonly args: string[]; readonly testSha: string; readonly fixSha: string }, { signal }: CallOptions = {}) {
      const scope = await scopeFor(input);
      if (input.command !== scope.bot.proof?.command || !same(input.args, scope.bot.proof.args) || input.directory !== scope.item.worktree) {
        throw botBoundaryError('BOT_EXECUTION_PROOF_MISMATCH', 409);
      }
      try { return await call('proof', { scope, testSha: input.testSha, fixSha: input.fixSha }, { signal }); }
      catch (error) {
        if (!signal?.aborted) throw error;
        return { status: 'inconclusive' as const, testSha: input.testSha, fixSha: input.fixSha, command: input.command, args: input.args,
          testExitCode: null, fixExitCode: null, reason: 'Proof was interrupted.' };
      }
    },
    readPolicyFiles: async (project: Project | string, { files = [] }: { readonly files?: readonly string[] } = {}) => call('policy-files', { project: isPrimitiveString(project)
      ? await owner.projectAt(project) : project, files }),
    blame: async (request: ScopeLookup & Pick<Parameters<ReturnType<typeof createBotQuestionBlame>>[0], 'snapshot'>) => call('blame', { scope: await scopeFor(request), snapshot: request.snapshot }),
    readPullStatus,
    pullRequests: { readStatus: readPullStatus,
      getOctokit: botWatch.getOctokit, authorizeApp: botWatch.authorizeApp },
    readFeedback: botWatch.readFeedback, readAuthorPermission: botWatch.readAuthorPermission, readFailedChecks: botWatch.readFailedChecks,
    tools: { pull: hostSessions.pullTools, settle: hostSessions.settleTool },
    deliverSynthetic: hostSessions.deliverNotice,
  };
}
