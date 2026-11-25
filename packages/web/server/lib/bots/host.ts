import { z } from 'zod';
import { createBotsConfig } from './config.js';
import { createBotStore } from './store.js';
import { BotServiceError } from './services.js';
import { createProductionBotPullRequests } from './production-pull-requests.js';
import { createBotIsolatedStages } from './isolated-stages.js';
import { readBotSpaceOptions } from './space-options.js';
import { createBotDiscovery } from './discovery.js';
import { createBotProviderRuntime } from './provider-runtime.js';
import { createBotSources } from './sources.js';
import { createBotNotices } from './notices.js';
import { createBotAttention } from './attention.js';
import { createBotScheduler } from './scheduler.js';
import { createBotEvents } from './events.js';
import { createBotsRuntime } from './runtime.js';
import { createBotHostSessions } from './host-sessions.js';
import { createBotConversationSessions } from './conversation-sessions.js';
import { createBotConversationHttpGuard } from './conversation-http.js';
import { createHostArtifacts } from './host-artifacts.js';
import { assertBotLeadAction } from '../session-lead/bot-guidance.js';
import { registerBotRoutes } from './routes.js';
import { createBotHostApi } from './host-api.js';
import { createBotExecutionStore } from './execution-store.js';
import { createBotPlacement } from './placement.js';
import { createBotQuestions } from './questions.js';
import { createBotHostTools } from './host-tools.js';
import { parseRepositoryPolicyFiles, readRepositoryPolicy } from './repository-policy.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { createTokenSnapshotReader } from '../pr-fix-loop/token-usage.js';
import { createHostAuthority } from './host-authority.js';
import { createHostOwners } from './host-owners.js';
import { createHostCheckouts } from './host-checkouts.js';
import { createHostStages } from './host-stages.js';
import { createHostLifecycle } from './host-lifecycle.js';
import { createHostPayloadProcessor } from './host-events.js';
import { failureCode, discoveryPending } from './host-failures.js';
import type { HostOptions, ReportHostAttention } from './host-contracts.js';
import type { RuntimeOptions } from './runtime/contracts.js';
import type { BotAuthority, Loop } from '../pr-fix-loop/contracts.js';
import type { Suggestion } from '../suggested-tasks/store.js';
import type { Application } from '../shared/http-contracts.js';
import type { createBotIdentityStore } from './identities.js';

export { createBotChildServer } from './host-child.js';

export function createBotsHost<NotifyResult>({ dataDir, projectsDir, projectConfigRuntime, scheduledTasksRuntime,
  listProjects, resolveProject, sessionService, readOnlySessionService, clientFor,
  permissionAutoAcceptRuntime, sessionKnowledgeRuntime: localKnowledge, readSessionDefaults: localDefaults,
  buildOpenCodeUrl, getOpenCodeAuthHeaders, getSpacesHost, getSpaceArchive, messageQueueRuntime,
  notificationCenter, notify, broadcast, getFixLoopRuntime, disposeInstance,
  reviewApps = [], logger = console, fetchImpl, policyOptions, executionServices = null, withWatchAdmission, updateMetadata, readArtifactPage }: HostOptions<NotifyResult>) {
  const config = createBotsConfig({ projectConfigRuntime });
  const store = createBotStore({ projectsDirPath: projectsDir });
  executionServices?.bindOwner({ dataDir, resolveProject, listProjects, store, config });
  const sessionKnowledgeRuntime = executionServices?.sessionKnowledgeRuntime ?? localKnowledge;
  if (!sessionKnowledgeRuntime) throw new TypeError('Bot session knowledge requires its execution owner');
  const readSessionDefaults = executionServices?.readSessionDefaults ?? localDefaults;
  const readPolicy: typeof readRepositoryPolicy = executionServices ? async (directory, approvals = {}) => parseRepositoryPolicyFiles(
    await executionServices.readPolicyFiles(directory, { files: Object.keys(approvals) }), approvals) : readRepositoryPolicy;
  const events = createBotEvents();
  const attention = createBotAttention({ center: notificationCenter, notify });
  const activity = executionServices ? null : createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders });
  const readTokens = executionServices ? null : createTokenSnapshotReader({ buildOpenCodeUrl, getOpenCodeAuthHeaders });
  const conversations = executionServices ? executionServices.conversations : (() => {
    if (!activity || !readTokens || !localKnowledge) throw new TypeError('Local Bot conversation owners are unavailable');
    return createBotConversationSessions({ dataDir, clientFor, activity, readTokens, knowledge: localKnowledge });
  })();
  if (!conversations) throw new TypeError('Bot conversations require their selected execution owner');
  const handleTool = async (request: Parameters<ReturnType<typeof createBotsRuntime>['handleTool']>[0]) => z.json().parse(await api.handleTool(request));
  const readToolOutcome = async (request: Parameters<ReturnType<typeof createBotsRuntime>['readToolOutcome']>[0]) => {
    const outcome = await runtime.readToolOutcome(request);
    switch (outcome.state) {
    case 'succeeded': return { state: 'succeeded' as const, result: z.json().parse(outcome.result) };
    case 'outcome-unknown': return outcome;
    }
  };
  const isolated = createBotIsolatedStages({ dataDir, getSpacesHost, resolveProject, sessionKnowledgeRuntime,
    separated: Boolean(executionServices), resolveSpaceOptions: ({ bot, selection }) => readBotSpaceOptions(bot.space, selection),
    handleTool, readToolOutcome, collectArtifacts: (sessionId) => artifacts.collect(sessionId) });
  const journal = createBotExecutionStore({ store });
  const placement = createBotPlacement({ dataDir, journal, isolated, getSpaceArchive });
  const artifacts = createHostArtifacts({ dataDir, store, journal, placement, isolated, listProjects, resolveProject, clientFor, updateMetadata, readArtifactPage, executionServices, broadcast,
    activity, dispatchConversationNative: (input, admissionId) => runtime.dispatchConversationNative(input, admissionId) });
  const assertStarted = () => lifecycle.assertStarted();
  const sessions = createBotHostSessions({ dataDir, isolated, clientFor, hostQueue: messageQueueRuntime,
    conversations, resolveProject,
    hostExecution: executionServices?.hostSessions, resolvePlacement: placement.resolve,
    readHostTokens: readTokens, assertDispatch: (input) => { assertStarted(); return notices.assertDispatch(input); }, broadcast, sessionKnowledgeRuntime,
    isSessionArchived: (sessionId) => {
      if (!sessionService) throw new TypeError('Bot host session archive is unavailable');
      return sessionService.sessionArchive.isArchived(sessionId);
    } });
  const authority = createHostAuthority({ store, config, listProjects, journal, readPolicy });
  const owners = createHostOwners({ dataDir, store, authority, execution: executionServices, fetchImpl, policyOptions, disposeInstance,
    resolveDiscordTarget: (request) => providers.resolveDiscordTarget(request) });
  const { services, context, identities } = owners;
  const productionWorktrees = owners.worktrees;
  const { worktrees, proof } = createHostCheckouts({ dataDir, store, resolveProject, isolated, placement, productionWorktrees,
    remoteSameTree: executionServices ? (request) => executionServices.worktrees.sameTree(request) : null, collectArtifacts: artifacts.beforeRemove });
  const stages = createHostStages({ sessionService, readOnlySessionService, clientFor, permissionAutoAcceptRuntime,
    sessionKnowledgeRuntime: localKnowledge, readSessionDefaults, isolated, placement, sessions, execution: executionServices, activity, readTokens });
  const reportAttention: ReportHostAttention = async ({ projectId, botId, itemId, occurrence, reason }) => {
    if (!projectId) return;
    if (itemId) return runtime.reportAttention({ projectId, itemId, reason });
    const definitions = (await config.read(projectId)).definitions.filter((bot) => bot.enabled && (!botId || bot.id === botId));
    for (const bot of definitions) {
      const item = await runtime.admit(projectId, bot.id, { source: { kind: 'investigation', id: `attention:${bot.id}:${occurrence ?? 'provider'}` },
        title: bot.name, description: reason, evidence: [] });
      await runtime.reportAttention({ projectId, itemId: item.id, reason });
    }
  };
  const runScheduled: ReturnType<typeof createBotsRuntime>['runScheduled'] = async (projectId, botId, occurrence) => {
    assertStarted();
    try { return await runtime.runScheduled(projectId, botId, occurrence); }
    catch (error) {
      if (!discoveryPending.safeParse(error).success) await reportAttention({ projectId, botId, occurrence, reason: failureCode.parse(error) });
      throw error;
    }
  };
  const discovery = createBotDiscovery({ dataDir, stages, onReady: async ({ projectId, botId, occurrence }) => {
    try { await runScheduled(projectId, botId, occurrence); }
    catch (error) { if (!discoveryPending.safeParse(error).success) throw error; }
  }, onAttention: reportAttention });
  const sources = { ...createBotSources({ services, resolveJiraContext: (request) => providers.resolveJiraContext(request), discover: discovery.discover }), usage: discovery.usage };
  const notices = createBotNotices({ store, config, readSession: sessions.readSession, queueFor: sessions.queueFor });
  const hostTools = executionServices ? createBotHostTools({ dataDir, execution: executionServices.hostSessions, handleTool, readToolOutcome }) : null;
  const pullOptions = { services, getFixLoopRuntime, reviewApps, withWatchAdmission, resolvePublication: productionWorktrees.readPublication,
    receiveFeedback: (projectId: string, itemId: string, event: Parameters<ReturnType<typeof createBotsRuntime>['receiveFeedback']>[2]) => runtime.receiveFeedback(projectId, itemId, event) };
  const { pullRequests, botWatch: productionBotWatch } = owners.kind === 'separated'
    ? createProductionBotPullRequests({ ...pullOptions, context: owners.context, execution: owners.execution.pullRequests })
    : createProductionBotPullRequests({ ...pullOptions, context: owners.context });
  const botWatch = { ...productionBotWatch, getOctokit: async (input: Parameters<typeof productionBotWatch.getOctokit>[0]) => {
    events.publish({ type: 'bot.wake', projectId: input.project.id }); return productionBotWatch.getOctokit(input);
  } };
  const scheduler = createBotScheduler({ projectConfigRuntime, scheduledTasksRuntime });
  const questionOptions = { config, store, worktrees, services, attention, events, readPolicy };
  const questions = owners.kind === 'separated'
    ? createBotQuestions({ ...questionOptions, context: owners.context, readBlame: owners.execution.blame })
    : createBotQuestions({ ...questionOptions, context: owners.context });
  const runProof: RuntimeOptions['runProof'] = async (input, options) => {
    const session = input.item.sessions.fixing ? sessions.get(input.item.sessions.fixing) : undefined;
    if (!session || session.itemId !== input.item.id || session.botId !== input.item.botId) {
      throw new BotServiceError('BOT_PLACEMENT_MISMATCH', 'The proof requires its recorded correction session.');
    }
    const recorded = await placement.read({ projectId: session.projectId, itemId: input.item.id });
    if (!recorded || recorded.botId !== input.item.botId || recorded.hostDirectory !== input.directory) {
      throw new BotServiceError('BOT_PLACEMENT_MISMATCH', 'The proof must use its recorded execution placement.');
    }
    if (executionServices && !recorded.isolated) {
      const bot = (await config.read(session.projectId)).definitions.find((entry) => entry.id === input.item.botId);
      if (!bot) throw new BotServiceError('BOT_NOT_ENABLED', 'The captured bot definition is unavailable.');
      return executionServices.runProof({ ...input, project: await resolveProject(session.projectId), bot: { ...bot, isolated: recorded.isolated } }, options);
    }
    return proof.run({ ...input, isolated: recorded.isolated }, options);
  };
  const runtime: ReturnType<typeof createBotsRuntime> = createBotsRuntime({ config, store, resolveProject, listProjects, stages, conversations, worktrees, services,
    serviceContext: context.serviceContext, runProof, pullRequests, sources, attention, notices, scheduler, events, questions, readPolicy });
  const admitConversationMessage: typeof runtime.admitConversationMessage = async (input) => {
    if (executionServices && !await runtime.isConversationSession(input.sessionId)) throw new BotServiceError('BOT_CONVERSATION_SCOPE_MISMATCH', 'The owner queue requires a recorded Bot conversation.');
    if (await runtime.isConversationSession(input.sessionId)) assertStarted();
    return runtime.admitConversationMessage(input);
  };
  sessionService?.setDispatchAdmission?.(admitConversationMessage);
  messageQueueRuntime?.setDispatchAdmission(admitConversationMessage);
  messageQueueRuntime?.setNativeDispatch(async ({ admissionId, ...input }) => {
    if (!await runtime.isConversationSession(input.sessionId)) return undefined;
    assertStarted();
    return runtime.dispatchConversationNative(input, admissionId);
  });
  const conversationGuard = createBotConversationHttpGuard({ runtime, assertStarted, queue: messageQueueRuntime });
  const providerOptions = { dataDir, config, store, identities, services, runtime, listProjects, resolveProject,
    serviceContext: context.serviceContext, onNeedsYou: reportAttention, readPolicy };
  const providers: ReturnType<typeof createBotProviderRuntime> = owners.kind === 'separated'
    ? createBotProviderRuntime({ ...providerOptions, identities: owners.identities, createGateway: owners.execution.createGateway })
    : createBotProviderRuntime({ ...providerOptions, identities: owners.identities });
  const refreshIndex = async (projectId: string) => {
    const settings = await config.read(projectId);
    for (const item of (await store.read(projectId)).items) {
      const bot = settings.definitions.find((entry) => entry.id === item.botId);
      await sessions.trackItem(projectId, item, bot);
    }
  };
  const release = events.subscribe((event) => {
    if (event.projectId) broadcast({ type: 'openchamber:bots-changed', properties: { projectId: event.projectId } });
    if ('item' in event && event.item) lifecycle.observe((async () => {
      await refreshIndex(event.projectId);
      if (event.item.conversation) await runtime.syncConversationProgress(event.projectId, event.item.id);
      if (event.item.conversation && artifacts.hasPendingDelivery(event.item.conversation.sessionId)) await artifacts.collect(event.item.conversation.sessionId);
    })());
  });
  const lifecycle = createHostLifecycle({ runtime, isolated, sessions, providers, discovery, hostTools, artifacts, listProjects, refreshIndex, reportAttention, release, logger });
  const processPayload = createHostPayloadProcessor({ lifecycle, runtime, sessions, isolated, discovery, hostTools, artifacts, reportAttention });
  const api = createBotHostApi({ runtime, placement, sessions, providers, discovery, runScheduled,
    assertStarted, refreshIndex, broadcast, reportAttention, failureCode: (error) => failureCode.parse(error) });
  type Identities = ReturnType<typeof createBotIdentityStore>;
  const publicIdentities = { list: identities.list,
    create: async (...args: Parameters<Identities['create']>) => { const result = await identities.create(...args); await providers.reconfigure(); return result; },
    update: async (...args: Parameters<Identities['update']>) => { const result = await identities.update(...args); await providers.reconfigure(); return result; },
    remove: async (...args: Parameters<Identities['remove']>) => { const result = await identities.remove(...args); await providers.reconfigure(); return result; },
  };
  return {
    artifacts, isConversationSession: runtime.isConversationSession,
    reconnect: (spaceId?: string) => { if (lifecycle.started && !lifecycle.stopping) lifecycle.observe(artifacts.recover(spaceId)); },
    conversationGuard, admitConversationMessage,
    assertConversationControlTarget: async (action: string, sessionId: string | undefined) => {
      if (sessionId && await runtime.isConversationSession(sessionId)) assertBotLeadAction(action);
    },
    conversationQueueSnapshot: async () => {
      if (!messageQueueRuntime) throw new BotServiceError('BOT_CONVERSATION_QUEUE_UNAVAILABLE', 'The conversation queue owner is unavailable.');
      await messageQueueRuntime.load();
      const snapshot = messageQueueRuntime.snapshot();
      const owned = await Promise.all(snapshot.sessions.map(async (session) =>
        await runtime.isConversationSession(session.sessionId) ? session : null));
      return { revision: snapshot.revision, sessions: owned.filter((session) => session !== null) };
    },
    runtime: api, botWatch, assertDispatch: (input: Parameters<typeof notices.assertDispatch>[0]) => { assertStarted(); return notices.assertDispatch(input); }, handleTool: api.handleTool,
    processPayload: (...args: Parameters<typeof processPayload>) => lifecycle.observe(processPayload(...args)),
    isSessionWorking: (sessionId: string) => sessions.isWorking(sessionId), readTokenSnapshot: sessions.tokenSnapshot, queueForSession: sessions.queueForSession,
    onPullRequestSettled(loop: Pick<Loop, 'status' | 'statusReason' | 'number' | 'sessionId'> & { readonly botAuthority: BotAuthority }) {
      if (lifecycle.stopping) return;
      const captured = loop.botAuthority;
      lifecycle.observe((async () => {
        const item = (await store.read(captured.project.id)).items.find((entry) => entry.id === captured.itemId);
        if (!item || item.botId !== captured.botId || item.sessions.fixing !== loop.sessionId || item.pr?.number !== loop.number) return;
        if (loop.status === 'closed' && loop.statusReason === 'merged' || loop.status === 'watching' || loop.status === 'ready') await runtime.pump(captured.project.id);
        else await runtime.reportAttention({ projectId: captured.project.id, itemId: item.id, reason: loop.status === 'closed' ? 'BOT_PULL_REQUEST_CLOSED' : 'BOT_PULL_REQUEST_WATCH_STOPPED' });
      })());
    },
    registerRoutes: (app: Application) => {
      app.use(conversationGuard);
      artifacts.registerRoutes(app);
      app.use('/api/openchamber/bots/isolated-tools', (_req, res) => res.status(403).json({ code: 'BOT_ISOLATED_CHILD_REQUIRED' }));
      registerBotRoutes(app, { botsRuntime: api, identities: publicIdentities });
    },
    async runScheduled(...args: Parameters<typeof runScheduled>) {
      try { return await runScheduled(...args); }
      catch (error) { const pending = discoveryPending.safeParse(error); if (pending.success) return { items: [], skipped: false, pending: pending.data.pending }; throw error; }
    },
    async deliverSuggestion({ projectId, botId, suggestion }: { readonly projectId: string; readonly botId: string; readonly suggestion: Suggestion }) {
      assertStarted();
      const files = suggestion.files.map((file) => `${file.path}${file.startLine ? `:${file.startLine}${file.endLine ? `-${file.endLine}` : ''}` : ''}`);
      const description = [suggestion.body, files.length ? `Files:\n${files.join('\n')}` : ''].filter(Boolean).join('\n\n');
      const item = await runtime.admit(projectId, botId, { source: { kind: 'suggestion', id: suggestion.id }, title: suggestion.title, description, evidence: suggestion.evidence ?? [] });
      await runtime.pump(projectId); return { itemId: item.id };
    },
    start: lifecycle.start, stop: lifecycle.stop,
  };
}
