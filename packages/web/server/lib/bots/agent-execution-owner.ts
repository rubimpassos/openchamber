import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isFunction, isPrimitiveString } from '../shared/guards.js';
import { createBotIdentityStore } from './identities.js';
import { createBotServices } from './services.js';
import { createBotServiceContext } from './service-context.js';
import { createProductionBotWorktrees } from './production-worktrees.js';
import { createProductionBotPullRequests } from './production-pull-requests.js';
import { createBotStageSessions } from './stage-sessions.js';
import { createBotProofRunner } from './proof.js';
import { createBotQuestionBlame } from './questions-blame.js';
import { createBotIsolatedToolInbox } from './isolated-tools.js';
import { createBotAgentGatewayTransport } from './agent-gateway-transport.js';
import { createBotAdapterState } from './adapter-state.js';
import { createBotConversationSessions } from './conversation-sessions.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { createTokenSnapshotReader } from '../pr-fix-loop/token-usage.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { registeredTransferDirectory } from '../agent-server/space-transfer-routes.js';
import { createBotArtifactExecution } from './artifacts-execution.js';
import { artifactBindingSchema } from './artifacts-contract.js';
import { botBoundaryError, botPublicIdentitySchema, botStageRequestSchema, botScopeSchema, botSessionIdSchema } from '../agent-server/bot-service-contract.js';
import type { BotServiceInput } from '../agent-server/bot-service-contract.js';
import type { BotService } from './services/contracts.js';
import type { CheckoutScope, ExecutionCheckoutRequest, ExecutionDependencies, ExecutionScope, ExecutionStageRecord, ExecutionStageRequest } from './agent-execution.types.js';

export const fail: (code?: string) => never = (code = 'BOT_EXECUTION_SCOPE_MISMATCH') => { throw botBoundaryError(code, 409); };
export const same = <Left, Right>(left: Left, right: Right) => JSON.stringify(left) === JSON.stringify(right);
const stageRecordSchema = z.object({ scope: botScopeSchema, request: botStageRequestSchema, digest: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['allocating', 'created', 'dispatching', 'dispatched']), sessionId: botSessionIdSchema.optional() }).strict();
const sessionInfo = z.object({ id: botSessionIdSchema, location: z.object({ directory: z.string() }),
  time: z.object({ archived: z.number().nullish() }).optional(), metadata: z.object({ openchamber: z.object({
    automation: z.object({ source: z.literal('bot'), projectId: z.string(), botId: z.string(), itemId: z.string(),
      stage: z.enum(['investigation', 'fixing', 'judge']) }) }) }) });
const tailPage = z.object({ data: z.array(z.object({ type: z.string(),
  time: z.object({ completed: z.number().nullish(), created: z.number().optional() }).optional() })).max(100) });

export function createBotExecutionOwner(deps: ExecutionDependencies) {
  const { agentServer, dataDir, readSettings, clientFor, sessionService = deps.openChamberSessionService, readOnlySessionService = sessionService,
    permissionAutoAcceptRuntime, sessionKnowledgeRuntime, readSessionDefaults, updateMetadata,
    buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl, policyOptions, disposeInstance, reviewApps = [] } = deps;
  if (agentServer !== true) throw new TypeError('Bot execution requires separated authenticated agent-server mode');
  if (!dataDir || !isFunction(readSettings)) throw new TypeError('Bot execution requires its private data directory and project registry');
  const identities = deps.identities ?? createBotIdentityStore({ dataDir });
  const serviceOptions = { dataDir, identities, fetchImpl, policyOptions, ownerAuthorityChecked: true,
    runtimeIdentity: deps.runtimeIdentity ?? { id: `bot-agent-${randomUUID()}`, platform: process.platform } };
  const createServices = deps.createServices ?? createBotServices;
  const contextServices = deps.services ?? createServices({ ...serviceOptions,
    resolvePublication: async () => fail('BOT_EXECUTION_SCOPE_REQUIRED') });
  const context = deps.context ?? createBotServiceContext({ identities, services: contextServices, fetchImpl, policyOptions });
  const activity = deps.activity ?? createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders });
  const readTokens = deps.readTokens ?? createTokenSnapshotReader({ buildOpenCodeUrl, getOpenCodeAuthHeaders });
  const conversations = createBotConversationSessions({ dataDir, clientFor, activity, readTokens, knowledge: sessionKnowledgeRuntime });
  const proof = deps.proof ?? createBotProofRunner({ root: path.join(dataDir, 'bots', 'proof') });
  const gateway = deps.gateway ?? createBotAgentGatewayTransport({ identities, fetchImpl, policyOptions });
  const blame = deps.blame ?? createBotQuestionBlame({ context });
  const runs = createBotAdapterState({ dataDir, name: 'agent-stage-executions', schema: stageRecordSchema });
  const inbox = deps.inbox ?? createBotIsolatedToolInbox({ dataDir, onPending: async ({ sessionId, requestId }) => {
    if (!updateMetadata) fail('BOT_EXECUTION_METADATA_UNAVAILABLE');
    await updateMetadata(sessionId, { openchamber: { botToolPending: requestId } });
  } });
  const worktreesFor = (scope: CheckoutScope & { readonly item: CheckoutScope['item'] & { readonly effects?: ExecutionScope['item']['effects'] } }) => deps.worktrees ?? createProductionBotWorktrees({ dataDir, context, disposeInstance,
    readItem: async (projectId, itemId) => projectId === scope.project.id && itemId === scope.item.id ? scope.item : null });
  const resolvePublicationFor = (scope: CheckoutScope) => async (query: { readonly botId: string; readonly itemId: string; readonly repositoryId: string }) => {
    if (query.botId !== scope.bot.id || query.itemId !== scope.item.id) fail('BOT_EXECUTION_SCOPE_MISMATCH');
    const request: typeof query & { trustedMigrationPath?: ExecutionScope['trustedMigrationPath'] } = { ...query };
    if (scope.trustedMigrationPath) request.trustedMigrationPath = scope.trustedMigrationPath;
    const result = await worktreesFor(scope).readPublication(request);
    if (result && scope.item.worktree && result.directory !== scope.item.worktree) fail('BOT_EXECUTION_CHECKOUT_MISMATCH');
    return result;
  };
  const servicesFor = (scope: CheckoutScope) => deps.services ?? createServices({ ...serviceOptions, resolvePublication: resolvePublicationFor(scope) });
  const prFor = (scope: CheckoutScope, selectedApps = reviewApps) => deps.pullRequests && selectedApps === reviewApps ? deps.pullRequests
    : (deps.createPullRequests ?? createProductionBotPullRequests)({ context, services: servicesFor(scope), reviewApps: selectedApps,
      resolvePublication: resolvePublicationFor(scope), getFixLoopRuntime: () => ({ createBotWatch: async () => null, stopBotWatch: async () => fail('BOT_EXECUTION_OWNER_REQUIRED') }),
      receiveFeedback: async () => fail('BOT_EXECUTION_OWNER_REQUIRED') });
  const unavailableStage = async () => fail('BOT_EXECUTION_HOST_STAGE_REQUIRED');
  const isolated = { create: unavailableStage, dispatch: unavailableStage, outcome: unavailableStage, reconcile: unavailableStage, stop: unavailableStage };
  const stageOwner = (stage: ExecutionStageRequest['stage']) => deps.stages ?? createBotStageSessions({ sessionService: {
    create: (...args) => {
      if (!sessionService) throw new TypeError('Bot execution requires a session service');
      return sessionService.create(...args);
    },
    send: (sessionId, payload) => {
      const service = stage === 'fixing' ? sessionService : readOnlySessionService;
      if (!service) throw new TypeError('Bot execution requires a session service');
      return service.send(sessionId, payload);
    },
  }, clientFor, permissionAutoAcceptRuntime, sessionKnowledgeRuntime, activityProbe: activity,
  readSessionDefaults, readTokenSnapshot: readTokens, isolated });
  const stageOwners = { investigation: stageOwner('investigation'), fixing: stageOwner('fixing'), judge: stageOwner('judge') };
  const registeredProject = async (project: ExecutionScope['project']) => {
    const settings = await readSettings();
    const directory = await registeredTransferDirectory(project.path, async () => settings);
    const projects = deps.listProjects ? await deps.listProjects() : settings.projects ?? [];
    const matches = projects.filter((entry) => entry.id === project.id);
    const match = matches[0];
    if (matches.length !== 1 || !match || await registeredTransferDirectory(match.path, async () => settings) !== directory) throw botBoundaryError('agent_project_unregistered', 403);
    return project;
  };
  const resolveArtifactBinding = async (sessionId: string) => {
    const conversation = await conversations.artifactBinding(sessionId);
    if (conversation) {
      await registeredProject({ id: conversation.projectId, path: conversation.directory });
      return conversation;
    }
    const recorded = (await runs.list()).find((record) => record.sessionId === sessionId);
    if (!recorded) return null;
    await registeredProject(recorded.scope.project);
    const { request, scope } = recorded;
    return artifactBindingSchema.parse({ projectId: scope.project.id, botId: scope.bot.id, itemId: scope.item.id,
      sessionId, directory: request.directory, producer: { role: 'stage', stage: request.stage } });
  };
  let artifactOptions: Parameters<typeof createBotArtifactExecution>[0] = { dataDir, privatePlacement: 'agent', resolveBinding: resolveArtifactBinding,
    stopProducer: async (binding) => {
      await clientFor(binding.directory).session.interrupt({ sessionID: binding.sessionId });
      const active = await activity.fetchActiveSessionStatuses();
      if (active === null || active[binding.sessionId]
        || await activity.hasWorkingDescendants(binding.sessionId, active) !== false) fail('BOT_ARTIFACT_PRODUCER_NOT_STOPPED');
    },
    readSession: (sessionID) => clientFor('').session.get({ sessionID }),
    updateMetadata: async (sessionId, patch) => {
      if (!updateMetadata) fail('BOT_EXECUTION_METADATA_UNAVAILABLE');
      await updateMetadata(sessionId, patch);
    } };
  if (deps.readArtifactPage) artifactOptions = { ...artifactOptions, readPage: deps.readArtifactPage };
  const artifacts = createBotArtifactExecution(artifactOptions);
  const trustRetainedCheckout = async <Scope extends CheckoutScope>(scope: Scope, allowMissingCheckout = false) => {
    if (scope.trustedMigrationPath && deps.trustMigrationPath) await deps.trustMigrationPath(scope.trustedMigrationPath, { allowMissingCheckout });
    return scope;
  };
  const registeredScope = async (scope: ExecutionScope, allowMissingCheckout: boolean) => trustRetainedCheckout({ ...scope, project: await registeredProject(scope.project) }, allowMissingCheckout);
  const requestFor = (scope: ExecutionScope) => {
    const request: ExecutionCheckoutRequest = { project: scope.project, bot: scope.bot, item: scope.item, key: scope.checkoutKey };
    if (scope.trustedMigrationPath) request.trustedMigrationPath = scope.trustedMigrationPath;
    return request;
  };
  const checkout = async (scope: CheckoutScope) => {
    if (!scope.checkoutKey || scope.checkoutKey !== `${scope.item.id}:worktree`) fail('BOT_EXECUTION_CHECKOUT_KEY_REQUIRED');
    const directory = await worktreesFor(scope).resolveTransferSource({ kind: 'bot-checkout', projectDirectory: scope.project.path,
      projectId: scope.project.id, botId: scope.bot.id, itemId: scope.item.id, checkoutKey: scope.checkoutKey }, { trustedMigrationPath: scope.trustedMigrationPath });
    if (!isPrimitiveString(directory) || scope.item.worktree && directory !== scope.item.worktree
      || scope.item.branch && scope.item.branch !== `bot/${scope.item.id}`) fail('BOT_EXECUTION_CHECKOUT_MISMATCH');
    return { directory, branch: `bot/${scope.item.id}` };
  };
  const stageDirectory = async (scope: ExecutionScope, request: ExecutionStageRequest) => {
    if (request.projectId !== scope.project.id || request.itemId !== scope.item.id || request.bot.id !== scope.bot.id
      || request.bot.isolated || !same(request.bot, scope.bot)) fail('BOT_EXECUTION_HOST_STAGE_REQUIRED');
    const directory = scope.item.id.startsWith('discovery_') ? scope.project.path : (await checkout(scope)).directory;
    if (request.directory !== directory && request.directory !== scope.project.path
      || !scope.item.id.startsWith('discovery_') && request.directory !== directory) fail('BOT_EXECUTION_CHECKOUT_MISMATCH');
    return directory;
  };
  const verifySession = async (scope: ExecutionScope, sessionId: string, expectedStage?: ExecutionStageRequest['stage']) => {
    const directory = scope.item.id.startsWith('discovery_') ? scope.project.path : (await checkout(scope)).directory;
    if (!scope.item.id.startsWith('discovery_') && !Object.values(scope.item.sessions).includes(sessionId)) fail('BOT_EXECUTION_SESSION_MISMATCH');
    const info = sessionInfo.parse(unwrapOpenCodeResponse(await clientFor(directory).session.get({ sessionID: sessionId })));
    const marker = info.metadata.openchamber.automation;
    if (info.id !== sessionId || info.location.directory !== directory || marker.projectId !== scope.project.id
      || marker.botId !== scope.bot.id || marker.itemId !== scope.item.id || expectedStage && marker.stage !== expectedStage) fail('BOT_EXECUTION_SESSION_MISMATCH');
    return { info, directory, marker };
  };
  const runIdentity = (scope: ExecutionScope, request: ExecutionStageRequest) => ({ projectId: scope.project.id, botId: scope.bot.id,
    itemId: scope.item.id, stage: request.stage, dispatchedAt: request.dispatchedAt });
  const runDigest = (request: ExecutionStageRequest) => { const { sessionId: _sessionId, ...capture } = request; return digestMutationInput(capture); };
  const assertRun: (record: ExecutionStageRecord | null, request: ExecutionStageRequest) => asserts record is ExecutionStageRecord = (record, request) => {
    if (!record || record.digest !== runDigest(request) || request.sessionId && record.sessionId !== request.sessionId) fail('BOT_EXECUTION_STAGE_CHANGED');
  };
  const verifySelectedService = async (scope: ExecutionScope, value: BotServiceInput<'service-prepare'>['request'] | BotServiceInput<'service-read'>['request'] | BotServiceInput<'service-execute'>['effect'], input: BotServiceInput<'service-execute'>['input'] | BotServiceInput<'service-read'>['request']['input']) => {
    const operation = value.operation;
    const service = operation.split('.')[0] === 'git' || operation.startsWith('pr.') ? 'github' : operation.split('.')[0];
    if ('botId' in value && value.botId !== undefined && (value.botId !== scope.bot.id || value.itemId !== scope.item.id)) fail();
    const authority = 'authority' in value ? value.authority : undefined;
    const identity = 'authority' in value ? value.authority : value;
    if (service !== 'github' && service !== 'jira' && service !== 'discord') fail('BOT_SERVICE_UNSUPPORTED');
    const selected = scope.bot.identity[service];
    if (!selected && !authority) fail('BOT_IDENTITY_REQUIRED');
    const inventory = await identities.list();
    const matches = authority ? inventory.filter((entry) => entry.id === identity.identityId)
      : service === 'github' && selected && 'kind' in selected && selected.kind === 'account'
      ? inventory.filter((entry) => entry.kind === 'github-account' && entry.accountId === selected.accountId)
      : inventory.filter((entry) => selected && 'identityId' in selected && entry.id === selected.identityId);
    const match = matches[0];
    if (matches.length !== 1 || !match || match.id !== identity.identityId || match.revision !== identity.identityRevision
      || !match.kind.startsWith(`${service}-`)
      || authority && (authority.credentialId !== (match.kind === 'github-account' ? match.accountId : match.id)
        || authority.credentialRevision !== (match.kind === 'github-account' ? match.credentialRevision : match.revision))) fail('BOT_IDENTITY_CHANGED');
    if (service === 'github') {
      if (!same((await context.repository(scope.project)).target, value.target)) fail('BOT_DESTINATION_CHANGED');
      if (operation === 'git.push' && (!input || !('directory' in input) || input.directory !== (await checkout(scope)).directory)) fail('BOT_EXECUTION_CHECKOUT_MISMATCH');
    }
    if (service === 'jira' && operation !== 'jira.search' && (scope.item.source.kind !== 'jira' || !('issueKey' in value.target) || value.target.issueKey !== scope.item.source.id)) fail('BOT_DESTINATION_CHANGED');
  };
  const watchScope = (authority: BotServiceInput<'pull-feedback'>['authority'], trustedMigrationPath?: ExecutionScope['trustedMigrationPath'], expectedDirectory?: string): CheckoutScope => {
    if (trustedMigrationPath && (trustedMigrationPath.projectId !== authority.project.id || trustedMigrationPath.itemId !== authority.itemId
      || expectedDirectory && trustedMigrationPath.directory !== expectedDirectory)) fail('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH');
    const item: CheckoutScope['item'] = { id: authority.itemId, botId: authority.botId };
    if (expectedDirectory) item.worktree = expectedDirectory;
    return { project: authority.project, bot: { id: authority.botId }, checkoutKey: `${authority.itemId}:worktree`, item, trustedMigrationPath };
  };
  const watchReader = async (authority: BotServiceInput<'pull-feedback'>['authority'], trustedMigrationPath?: ExecutionScope['trustedMigrationPath'], expectedDirectory?: string) => {
    await registeredProject(authority.project);
    const scope = await trustRetainedCheckout(watchScope(authority, trustedMigrationPath, expectedDirectory));
    await checkout(scope);
    return prFor(scope).botWatch.getOctokit(authority);
  };
  const expectedIdentity = async (expected: BotServiceInput<'context'>['expectedIdentity'] | undefined, bot: ExecutionScope['bot'] | undefined, service: BotService) => {
    if (!expected) { if (bot?.identity?.[service]) fail('BOT_IDENTITY_CHANGED'); return null; }
    const inventory = (await identities.list()).map((entry) => botPublicIdentitySchema.parse(entry));
    const selected = bot?.identity?.[service];
    const matches = bot ? service === 'github' && selected && 'kind' in selected && selected.kind === 'account'
      ? inventory.filter((entry) => entry.kind === 'github-account' && entry.accountId === selected.accountId)
      : inventory.filter((entry) => selected && 'identityId' in selected && entry.id === selected.identityId)
      : inventory.filter((entry) => entry.id === expected.id);
    const match = matches[0];
    if (matches.length !== 1 || !match || !same(match, expected) || !match.kind.startsWith(`${service}-`)
      || bot && service === 'github' && (selected && 'kind' in selected && selected.kind === 'app') !== (match.kind === 'github-app')) fail('BOT_IDENTITY_CHANGED');
    return match;
  };
  const isWorking = async (scope: ExecutionScope, sessionId: string) => {
    const { directory } = await verifySession(scope, sessionId);
    const statuses = await activity.fetchActiveSessionStatuses();
    if (statuses === null) return null;
    if (statuses[sessionId]) return true;
    const descendants = await activity.hasWorkingDescendants(sessionId, statuses);
    if (descendants !== false) return descendants;
    const tail = tailPage.safeParse(await clientFor(directory).message.list({ sessionID: sessionId, limit: 10, order: 'desc' }));
    if (!tail.success) return null;
    return tail.data.data[0]?.type === 'assistant' && tail.data.data[0].time?.completed == null;
  };
  return { deps, identities, context, activity, readTokens, conversations, artifacts, resolveArtifactBinding, proof, gateway, blame, runs, inbox, worktreesFor, resolvePublicationFor,
    servicesFor, prFor, stageOwners, registeredProject, registeredScope, trustRetainedCheckout, requestFor, checkout,
    stageDirectory, verifySession, runIdentity, runDigest, assertRun, verifySelectedService, watchScope, watchReader, expectedIdentity, isWorking, reviewApps };
}
