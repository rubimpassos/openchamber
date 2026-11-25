import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { createBotItem, TERMINAL_ITEM_STATES } from './schema.js';
import { createBotExecutionStore } from './execution-store.js';
import { createBotEffects } from './effects.js';
import { approveRepositoryPolicy, readRepositoryPolicy } from './repository-policy.js';
import { botTaskFor } from './events.js';
import { botPresets } from './presets.js';
import { sourceCandidateSchema } from './prompts.js';
import { text } from './runtime/input-contracts.js';
import { createRuntimeItemState } from './runtime/item-state.js';
import { runtimeError as error } from './runtime/errors.js';
import { createRuntimeProjectOwner } from './runtime/project-owner.js';
import { createRuntimeJournal } from './runtime/journal.js';
import { hasSourceControlStringCode as hasSourceControlErrorCode } from '../source-control/input-guards.js';
import type { BotItem, BotItemState } from './schema.js';
import type { RuntimeOptions, RuntimeBot } from './runtime/contracts.js';
import type { RuntimeContext } from './runtime/context.js';
import { readBotsConfig } from './config.js';
import { createRuntimePublication } from './runtime/publication.js';
import { createRuntimeShared } from './runtime/shared.js';
import { createRuntimeServiceEffects } from './runtime/service-effects.js';
import { createRuntimeStageRunner } from './runtime/stages.js';
import { createRuntimeMergeAdmission } from './runtime/merge-admission.js';
import { createRuntimeCheckout } from './runtime/checkout.js';
import { createRuntimeFeedback } from './runtime/feedback.js';
import { createRuntimeControls } from './runtime/controls.js';
import { createRuntimeProgression } from './runtime/progression.js';
import { createRuntimeTools } from './runtime/tools.js';
import { createRuntimeConversations } from './runtime/conversations.js';
import type { ConversationMessage } from './runtime/conversations.js';
import { createRuntimeItemDetail } from './runtime/item-detail.js';

const activeStates: ReadonlySet<BotItemState> = new Set(['investigating', 'fixing', 'proving', 'judging', 'merging', 'closing']);

export const createBotsRuntime = ({ config, store, resolveProject, listProjects, stages, conversations: conversationExecution, worktrees, services, serviceContext, runProof, pullRequests, sources, attention, notices, questions, scheduler, events, readPolicy = readRepositoryPolicy, now = Date.now }: RuntimeOptions) => {
  const required = {
    'config.read': config?.read, 'config.update': config?.update,
    'store.read': store?.read, 'store.update': store?.update, 'store.archive': store?.archive, 'store.readArchive': store?.readArchive, 'store.filePathFor': store?.filePathFor,
    resolveProject, listProjects, serviceContext, runProof,
    'stages.select': stages?.select, 'stages.create': stages?.create, 'stages.dispatch': stages?.dispatch, 'stages.outcome': stages?.outcome, 'stages.reconcile': stages?.reconcile, 'stages.stop': stages?.stop, 'stages.resume': stages?.resume,
    'conversations.ensure': conversationExecution?.ensure, 'conversations.read': conversationExecution?.read,
    'conversations.prepare': conversationExecution?.prepare, 'conversations.notice': conversationExecution?.notice,
    'conversations.tokens': conversationExecution?.tokens, 'conversations.stop': conversationExecution?.stop,
    'conversations.dispatch': conversationExecution?.dispatch,
    'worktrees.create': worktrees?.create, 'worktrees.reconcile': worktrees?.reconcile, 'worktrees.remove': worktrees?.remove, 'worktrees.inspect': worktrees?.inspect, 'worktrees.acceptPublished': worktrees?.acceptPublished,
    'worktrees.bindPublication': worktrees?.bindPublication,
    'services.prepare': services?.prepare, 'services.execute': services?.execute, 'services.reconcile': services?.reconcile, 'services.read': services?.read,
    'pullRequests.ensureLoop': pullRequests?.ensureLoop, 'pullRequests.read': pullRequests?.read, 'pullRequests.stop': pullRequests?.stop,
    'sources.jira': sources?.jira, 'sources.investigate': sources?.investigate,
    'attention.sync': attention?.sync, 'notices.deliver': notices?.deliver,
    'questions.ask': questions?.ask, 'questions.retry': questions?.retry, 'questions.answered': questions?.answered,
    'scheduler.sync': scheduler?.sync, 'scheduler.remove': scheduler?.remove,
    'events.publish': events?.publish, 'events.subscribe': events?.subscribe,
  };
  for (const [name, value] of Object.entries(required)) if (!(value instanceof Function)) throw new TypeError(`${name} is required by the bot runtime`);
  const rawJournal = createBotExecutionStore({ store });
  const journal = createRuntimeJournal(rawJournal);
  const effects = createBotEffects({ store, journal: rawJournal, now });
  const pending = new Map<string, Promise<void>>();
  const dirty = new Set<string>();
  const activeProofs = new Map<string, AbortController>();
  let stopped = false;
  let releaseEvents: (() => void) | null = null;
  const context: RuntimeContext = Object.freeze({
    config, store, resolveProject, listProjects, stages, worktrees, services, serviceContext, runProof, pullRequests, sources, attention, notices, questions, events,
    readPolicy, now, journal, effects, ownProject: createRuntimeProjectOwner(store), ...createRuntimeItemState({ store, attention, events }),
    dirty, activeProofs, isStopped: () => stopped,
  });
  const { itemFor, sessionIndex, ownProject } = context;

  const shared = createRuntimeShared(context);
  const conversations = createRuntimeConversations(context, conversationExecution, shared);
  const { projectFor, needsYou, checkBudgets } = shared;
  const detail = createRuntimeItemDetail(context, rawJournal);
  const publication = createRuntimePublication({ worktrees, services, serviceContext, journal, mutate: context.mutate });
  const external = createRuntimeServiceEffects(context);
  const runStage = createRuntimeStageRunner(context, shared);
  const mergeAdmission = createRuntimeMergeAdmission(context, { external, shared });
  const { admissionFor } = mergeAdmission;
  const checkout = createRuntimeCheckout(context, { external, publication, mergeAdmission });
  const feedback = createRuntimeFeedback(context, { shared, mergeAdmission, pump, detail });
  const controls = createRuntimeControls(context, { shared, external, checkout, mergeAdmission, feedback, conversations, pump, detail });
  const advance = createRuntimeProgression(context, { shared, runStage, publication, mergeAdmission, checkout, feedback, controls });
  const { handleTool, readToolOutcome } = createRuntimeTools(context, { shared, external, publication, mergeAdmission, checkout, pump });
  const { receiveFeedback, answer } = feedback;
  const { resume, stopItem, onSessionEvent, recordUsage } = controls;

  function pump(projectId: string): Promise<void> {
    if (stopped) return Promise.resolve();
    const running = pending.get(projectId);
    if (running) { dirty.add(projectId); return running; }
    const operation = ownProject(projectId, async () => {
      const project = await projectFor(projectId);
      const settings = await config.read(projectId);
      let items = (await store.read(projectId)).items;
      let active = items.filter((item) => activeStates.has(item.state)).length;
      for (const candidate of items) {
        let initial = candidate;
        if (stopped) break;
        for (const sessionId of Object.values(initial.sessions)) sessionIndex.set(sessionId, { projectId, itemId: initial.id });
        if (initial.conversation) sessionIndex.set(initial.conversation.sessionId, { projectId, itemId: initial.id, role: 'conversation' });
        await attention.sync({ projectId, item: initial });
        if (TERMINAL_ITEM_STATES.includes(initial.state)) continue;
        const bot: RuntimeBot = settings.definitions.find((entry) => entry.id === initial.botId) ?? { id: initial.botId, enabled: false };
        let recovery = await journal.read(projectId, initial.id);
        if (!initial.conversation && bot.enabled && !recovery.data.stopRequested) {
          try { await conversations.ensureOwned(projectId, initial.id); }
          catch (failure) {
            if (initial.state !== 'needs-you') await needsYou(projectId, initial.id, hasSourceControlErrorCode(failure) ? failure.code : 'BOT_CONVERSATION_UNAVAILABLE');
            continue;
          }
          items = (await store.read(projectId)).items;
          initial = await itemFor(projectId, initial.id);
          active = items.filter((item) => activeStates.has(item.state)).length;
          recovery = await journal.read(projectId, initial.id);
        }
        const hasAdmission = initial.effects.some((effect) => effect.kind === 'pr.auto-merge') || recovery.data.admission;
        const pendingToolNeedsAttention = recovery.data.pendingTool && initial.state !== 'needs-you';
        const answeredQuestionNeedsRecovery = bot.enabled && recovery.data.questionAnswer && !recovery.data.pendingQuestion && initial.state !== 'needs-you';
        if (!hasAdmission && !recovery.data.stopRequested && !pendingToolNeedsAttention && !answeredQuestionNeedsRecovery && (['needs-you', 'waiting-answer'].includes(initial.state) || !bot.enabled)) continue;
        if (initial.state === 'queued' && active >= settings.concurrency) continue;
        const budget = bot.enabled && !recovery.data.stopRequested && recovery.data.admission?.state !== 'revoking'
          && ['queued', 'investigating', 'fixing', 'judging'].includes(initial.state) ? await checkBudgets(projectId, bot, items, initial) : null;
        if (budget) {
          if (initial.state !== 'queued') await needsYou(projectId, initial.id, budget);
          continue;
        }
        if (initial.state === 'queued') active += 1;
        try {
          let again = await advance(projectId, project, bot, initial);
          while (again && !stopped) again = await advance(projectId, project, bot, await itemFor(projectId, initial.id));
        }
        catch (failure) {
          const admission = await admissionFor(projectId, await itemFor(projectId, initial.id));
          if (admission?.state === 'revoking') dirty.add(projectId);
          await needsYou(projectId, initial.id, hasSourceControlErrorCode(failure) ? failure.code : 'BOT_OPERATION_FAILED');
        }
        const current = await itemFor(projectId, initial.id);
        if (activeStates.has(initial.state) || initial.state === 'queued') if (!activeStates.has(current.state)) active -= 1;
        items = (await store.read(projectId)).items;
      }
      await store.archive(projectId, { before: Math.max(0, now() - settings.retentionDays * 86_400_000) });
    }, { waitMs: 0 }).catch((failure) => {
      if (!hasSourceControlErrorCode(failure) || failure.code !== 'SOURCE_CONTROL_LOCK_BUSY') throw failure;
    }).finally(() => {
      pending.delete(projectId);
      if (dirty.delete(projectId) && !stopped) return pump(projectId);
    });
    pending.set(projectId, operation);
    return operation;
  }

  const admit = async (projectId: string, botId: string, raw: z.input<typeof sourceCandidateSchema>) => withSourceControlFileLock(`${store.filePathFor(projectId)}.owner.lock`, async () => {
    await projectFor(projectId);
    const settings = await config.read(projectId);
    const bot = settings.definitions.find((entry) => entry.id === botId);
    if (!bot?.enabled) throw error('BOT_NOT_ENABLED');
    const candidate = sourceCandidateSchema.parse(raw);
    const archived = await store.readArchive(projectId);
    const existingArchive = archived.find((entry) => entry.botId === botId && entry.source.kind === candidate.source.kind && entry.source.id === candidate.source.id);
    if (existingArchive) return existingArchive;
    const id = randomUUID();
    const snapshot = await store.update(projectId, (current) => {
      const existing = current.items.find((entry) => entry.botId === botId && entry.source.kind === candidate.source.kind && entry.source.id === candidate.source.id);
      if (existing) return { result: current };
      const item = createBotItem({ id, botId, source: candidate.source, title: candidate.title, description: candidate.description, now: now() });
      return { snapshot: { ...current, items: [...current.items, { ...item, evidence: candidate.evidence }] } };
    });
    const item = snapshot?.items.find((entry) => entry.id === id) ?? snapshot?.items.find((entry) => entry.botId === botId && entry.source.kind === candidate.source.kind && entry.source.id === candidate.source.id);
    if (!item) throw error('BOT_ITEM_NOT_FOUND', 404);
    await conversations.ensureOwned(projectId, item.id);
    const admitted = await itemFor(projectId, item.id);
    events.publish({ type: 'bot.item.changed', projectId, item: admitted });
    return admitted;
  }, { waitMs: 10_000 });
  const runScheduled = async (projectId: string, botId: string, occurrence: string) => {
    const project = await projectFor(projectId);
    const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === botId);
    if (!bot?.enabled) throw error('BOT_NOT_ENABLED');
    text.parse(occurrence);
    const budget = await checkBudgets(projectId, bot, (await store.read(projectId)).items, null);
    if (budget) throw error(budget);
    const results = bot.source.kind === 'manual' ? [] : await (bot.source.kind === 'jira'
      ? sources.jira({ project, bot, jql: bot.source.jql, maxItems: bot.source.maxItems })
      : sources.investigate({ project, bot, occurrence, maxItems: bot.source.maxItems }));
    const candidates = z.array(sourceCandidateSchema).parse(results);
    const items: BotItem[] = [];
    for (const candidate of candidates.slice(0, bot.source.kind === 'manual' ? 0 : bot.source.maxItems)) items.push(await admit(projectId, botId, candidate));
    await pump(projectId);
    return { items, skipped: candidates.length === 0 };
  };
  const saveConfig = async (projectId: string, input: Parameters<RuntimeOptions['config']['update']>[1]) => {
    await projectFor(projectId);
    const previous = await config.read(projectId);
    const updated = readBotsConfig(await config.update(projectId, input));
    if (!updated.ok) throw error('BOT_CONFIG_INVALID');
    const settings = updated.config;
    await scheduler.sync(projectId, settings.definitions.map(botTaskFor));
    for (const bot of previous.definitions) if (!settings.definitions.some((entry) => entry.id === bot.id)) await scheduler.remove(projectId, bot.id);
    await pump(projectId);
    return { config: settings };
  };

  return {
    admit, pump, runScheduled, detail, saveConfig, answer, resume, stopItem, receiveFeedback, onSessionEvent, handleTool, readToolOutcome, recordUsage,
    ensureConversation: conversations.ensure,
    syncConversationProgress: conversations.progress,
    assertConversationAdmission: conversations.assertAdmission,
    isConversationSession: conversations.isSession,
    stopConversationSession: async (sessionId: string) => {
      const target = sessionIndex.get(sessionId);
      if (target?.role !== 'conversation') throw error('BOT_CONVERSATION_REQUIRED');
      return stopItem(target.projectId, target.itemId);
    },
    admitConversationMessage: (input: ConversationMessage) => conversations.admitMessage(input,
      async (target, event) => { await feedback.receiveConversationFeedback(target.projectId, target.itemId, event); }),
    dispatchConversationNative: (input: Parameters<typeof conversations.dispatchNative>[0], admissionId?: string) =>
      conversations.dispatchNative(input, async (target, event) => { await feedback.receiveConversationFeedback(target.projectId, target.itemId, event); }, admissionId),
    reportAttention: ({ projectId, itemId, reason }: { readonly projectId: string; readonly itemId: string; readonly reason: string }) => needsYou(projectId, itemId, text.parse(reason)),
    async getProject(projectId: string) { await projectFor(projectId); return { config: await config.read(projectId), ...await store.read(projectId), presets: botPresets() }; },
    async getConfig(projectId: string) { await projectFor(projectId); return { config: await config.read(projectId), presets: botPresets() }; },
    async getItems(projectId: string) { await projectFor(projectId); return store.read(projectId); },
    async getArchive(projectId: string, month?: string) { await projectFor(projectId); return { items: await store.readArchive(projectId, month) }; },
    async getPolicy(projectId: string) { const project = await projectFor(projectId); return readPolicy(project.path, (await config.read(projectId)).approvals); },
    async approvePolicy(projectId: string, { file, fingerprint }: { readonly file: string; readonly fingerprint: string }) { const project = await projectFor(projectId); await approveRepositoryPolicy({ config, projectId, projectPath: project.path, file, fingerprint, readPolicy }); return { ok: true }; },
    async start() {
      stopped = false;
      releaseEvents ??= events.subscribe((event) => {
        if (event.type === 'bot.wake') void pump(event.projectId).catch((failure) => events.publish({ type: 'bot.runtime.error', projectId: event.projectId, code: hasSourceControlErrorCode(failure) ? failure.code : 'BOT_RECOVERY_FAILED' }));
      });
      const failures = [];
      for (const project of await listProjects()) {
        try {
          for (const item of await store.readArchive(project.id)) if (item.conversation) sessionIndex.set(item.conversation.sessionId, { projectId: project.id, itemId: item.id, role: 'conversation' });
          await scheduler.sync(project.id, (await config.read(project.id)).definitions.map(botTaskFor));
          await pump(project.id);
        } catch (failure) {
          const entry = { projectId: project.id, code: hasSourceControlErrorCode(failure) ? failure.code : 'BOT_RECOVERY_FAILED' };
          failures.push(entry);
          events.publish({ type: 'bot.runtime.error', ...entry });
        }
      }
      return { failures };
    },
    async stop() {
      stopped = true;
      releaseEvents?.(); releaseEvents = null;
      for (const controller of activeProofs.values()) controller.abort();
      await Promise.all([...pending.values()]);
    },
  };
};

export type BotsRuntime = ReturnType<typeof createBotsRuntime>;
