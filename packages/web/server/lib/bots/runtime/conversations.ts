import { createHash } from 'node:crypto';
import { z } from 'zod';
import { botInputDigest } from '../effects.js';
import { conversationCaptureSchema, conversationSelectionSchema, conversationNativeSchema } from '../conversation-contract.js';
import type { BotConversationExecution, ConversationTarget } from '../conversation-contract.js';
import { TERMINAL_ITEM_STATES } from '../schema.js';
import { runtimeError as error } from './errors.js';
import type { RuntimeContext } from './context.js';
import type { createRuntimeShared } from './shared.js';

export type ConversationMessage = {
  readonly sessionId: string; readonly directory?: string | undefined;
  readonly operationId: string; readonly payload: unknown; readonly text?: string | undefined;
  readonly selection?: unknown;
};
export function createRuntimeConversations(context: RuntimeContext, execution: BotConversationExecution, shared: ReturnType<typeof createRuntimeShared>) {
  const { config, store, journal, itemFor, mutate, ownProject, sessionIndex, now, stages, listProjects } = context;
  const { projectFor, checkBudgets, needsYou } = shared;
  const usageBudget = async (...args: Parameters<typeof checkBudgets>) => {
    const code = await checkBudgets(...args);
    return code === 'BOT_PENDING_HUMAN_LIMIT' ? null : code;
  };
  const targetFor = async (projectId: string, itemId: string): Promise<ConversationTarget> => {
    const item = await itemFor(projectId, itemId);
    if (!item.conversation) throw error('BOT_CONVERSATION_REQUIRED');
    return { project: await projectFor(projectId), botId: item.botId, itemId, conversation: item.conversation };
  };
  const ensureOwned = async (projectId: string, itemId: string) => {
    const item = await itemFor(projectId, itemId);
    const saved = await journal.read(projectId, itemId);
    let capture = saved.data.conversationCapture;
    if (!capture) {
      if (item.conversation) throw error('BOT_CONVERSATION_CAPTURE_MISSING');
      const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId);
      if (!bot) throw error('BOT_DEFINITION_REQUIRED');
      const project = await projectFor(projectId);
      capture = conversationCaptureSchema.parse({ project, botId: item.botId, itemId, bot,
        conversation: { sessionId: `ses_${createHash('sha256').update(JSON.stringify([projectId, item.botId, itemId, 'conversation'])).digest('hex').slice(0, 32)}`,
          directory: project.path, createdAt: now() },
        selection: conversationSelectionSchema.parse(await stages.select(projectId, bot, 'investigation')), title: `${bot.name}: ${item.title}` });
      await journal.saveData(projectId, itemId, { conversationCapture: capture });
    }
    const conversation = await execution.ensure(capture);
    if (!item.conversation) await mutate(projectId, itemId, (current) => ({ ...current, conversation }));
    sessionIndex.set(conversation.sessionId, { projectId, itemId, role: 'conversation' });
    const total = await execution.tokens(await targetFor(projectId, itemId));
    if (total === null) throw error('BOT_TOKEN_USAGE_UNAVAILABLE');
    await recordUsage(projectId, itemId, total);
    return conversation;
  };
  const ensure = async (projectId: string, itemId: string) => {
    await projectFor(projectId);
    const active = (await store.read(projectId)).items.find((entry) => entry.id === itemId);
    if (!active) {
      const retained = (await store.readArchive(projectId)).find((entry) => entry.id === itemId);
      if (!retained?.conversation) throw error('BOT_CONVERSATION_REQUIRED', 404);
      return { conversation: retained.conversation };
    }
    if (TERMINAL_ITEM_STATES.includes(active.state)) {
      if (!active.conversation) throw error('BOT_CONVERSATION_REQUIRED', 404);
      return { conversation: active.conversation };
    }
    return { conversation: await ownProject(projectId, () => ensureOwned(projectId, itemId)) };
  };
  const assertAdmission = async (input: ConversationMessage) => {
    const target = sessionIndex.get(input.sessionId);
    if (target?.role !== 'conversation') return null;
    const item = await itemFor(target.projectId, target.itemId);
    if (item.conversation?.sessionId !== input.sessionId) return null;
    if (input.directory !== undefined && input.directory !== item.conversation.directory) throw error('BOT_CONVERSATION_SCOPE_MISMATCH');
    const data = (await journal.read(target.projectId, target.itemId)).data;
    if (TERMINAL_ITEM_STATES.includes(item.state) || data.stopRequested) throw error('BOT_CONVERSATION_STOPPED');
    const bot = (await config.read(target.projectId)).definitions.find((entry) => entry.id === item.botId);
    if (!bot?.enabled) throw error('BOT_NOT_ENABLED');
    const budget = await usageBudget(target.projectId, bot, (await store.read(target.projectId)).items, item);
    if (budget) throw error(budget);
    return { ...target, item, data };
  };
  const admitMessage = async (input: ConversationMessage, beforeSend: (target: { readonly projectId: string; readonly itemId: string }, feedback: { readonly eventId: string; readonly text: string }) => Promise<void>) => {
    const found = sessionIndex.get(input.sessionId);
    if (found?.role !== 'conversation') return;
    await ownProject(found.projectId, async () => {
      const observed = await execution.tokens(await targetFor(found.projectId, found.itemId));
      if (observed === null) throw error('BOT_TOKEN_USAGE_UNAVAILABLE');
      await recordUsage(found.projectId, found.itemId, observed);
      const admitted = await assertAdmission(input);
      if (!admitted) return;
      const { projectId, itemId, data } = admitted;
      const operationId = z.string().min(1).max(512).parse(input.operationId);
      const target = await targetFor(projectId, itemId);
      const current = await execution.read(target);
      if (current.archived) throw error('BOT_CONVERSATION_ARCHIVED');
      const previous = data.conversationSends?.[operationId];
      const requested = input.selection === undefined ? undefined : conversationSelectionSchema.parse(input.selection);
      const selection = requested ? (current.selection.agent ? { agent: current.selection.agent, ...requested } : requested)
        : previous?.selection ?? current.selection;
      const digest = botInputDigest({ payload: z.json().parse(input.payload), selection });
      if (previous && previous.digest !== digest) throw error('BOT_CONVERSATION_MESSAGE_CHANGED');
      if (!previous) await journal.saveData(projectId, itemId, { conversationSends: {
        ...data.conversationSends, [operationId]: { digest, selection, at: now() },
      } });
      if (input.text?.trim()) await beforeSend({ projectId, itemId }, { eventId: `conversation:${operationId}`, text: input.text });
      await execution.prepare(target);
      await assertAdmission(input);
    });
  };
  const deliveredProgress = new Map<string, string>();
  const progress = async (projectId: string, itemId: string) => {
    const item = await itemFor(projectId, itemId);
    if (!item.conversation) return;
    const saved = await journal.read(projectId, itemId);
    const snapshot = { item: { id: item.id, botId: item.botId, source: item.source, title: item.title, description: item.description },
      mission: saved.data.conversationCapture?.bot.mission, state: item.state, wait: item.wait, questionKey: saved.data.pendingQuestion ?? null,
      evidence: item.evidence, proof: item.proof, judgment: item.judgment, pr: item.pr,
      sessions: item.sessions, reports: saved.data.outcomes ?? {} };
    const serialized = JSON.stringify(snapshot);
    const digest = botInputDigest(snapshot);
    const key = JSON.stringify([projectId, itemId]);
    if (deliveredProgress.get(key) === digest) return;
    const target = await targetFor(projectId, itemId);
    const chunks: string[] = [];
    for (let offset = 0; offset < serialized.length;) {
      let end = Math.min(serialized.length, offset + 160_000);
      const last = serialized.charCodeAt(end - 1);
      if (end < serialized.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      chunks.push(serialized.slice(offset, end));
      offset = end;
    }
    for (const [page, chunk] of chunks.entries()) {
      await execution.notice(target, { eventId: `conversation:progress:${digest}:${page}`,
        text: `Authoritative Bot coordinator state ${digest}, part ${page + 1}/${chunks.length}:\n${chunk}`,
        resume: false });
    }
    deliveredProgress.set(key, digest);
  };
  const account = async (projectId: string, itemId: string, total: number) => {
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(total);
    const previous = await itemFor(projectId, itemId);
    if (total <= previous.tokens.conversation) return previous;
    const day = new Date(now()).toISOString().slice(0, 10);
    return mutate(projectId, itemId, (current) => {
      const usage = Math.max(current.tokens.conversation, total);
      const delta = usage - current.tokens.conversation;
      return { ...current, tokens: { ...current.tokens, conversation: usage, total: current.tokens.total + delta,
        byDay: { ...current.tokens.byDay, [day]: (current.tokens.byDay[day] ?? 0) + delta } } };
    });
  };
  const stop = async (projectId: string, itemId: string) => {
    const item = await itemFor(projectId, itemId);
    if (!item.conversation) return;
    const target = await targetFor(projectId, itemId);
    await execution.stop(target);
    const total = await execution.tokens(target);
    if (total === null) throw error('BOT_TOKEN_USAGE_UNAVAILABLE');
    await account(projectId, itemId, total);
  };
  const recordUsage = async (projectId: string, itemId: string, total: number) => {
    const item = await account(projectId, itemId, total);
    const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId);
    if (bot) {
      const budget = await usageBudget(projectId, bot, (await store.read(projectId)).items, item);
      if (budget && item.state === 'queued') await stop(projectId, itemId);
      else if (budget) {
        const stage = item.state === 'investigating' ? 'investigation' : item.state === 'fixing' ? 'fixing' : item.state === 'judging' ? 'judge' : null;
        const saved = await journal.read(projectId, itemId);
        const run = Object.entries(saved.data.runs ?? {}).findLast(([, run]) => run.stage === stage);
        const worker = stage ? item.sessions[stage] : undefined;
        if (worker && run) await journal.saveData(projectId, itemId, { interruptedStage: { runId: run[0], sessionId: worker } });
        await needsYou(projectId, itemId, budget);
        const stops = [stop(projectId, itemId)];
        if (worker && item.worktree) stops.unshift(stages.stop({ bot, sessionId: worker, directory: item.worktree }).then(() => {}));
        const failure = (await Promise.allSettled(stops)).find((entry) => entry.status === 'rejected');
        if (failure) throw failure.reason;
      }
    }
    return item.tokens;
  };
  let indexReady: Promise<void> | undefined;
  const isSession = async (sessionId: string) => {
    indexReady ??= (async () => {
      for (const project of await listProjects()) for (const item of [...(await store.read(project.id)).items, ...await store.readArchive(project.id)]) {
        if (item.conversation) sessionIndex.set(item.conversation.sessionId, { projectId: project.id, itemId: item.id, role: 'conversation' });
      }
    })().catch((failure) => { indexReady = undefined; throw failure; });
    await indexReady;
    return sessionIndex.get(sessionId)?.role === 'conversation';
  };
  return { ensure, ensureOwned, targetFor, assertAdmission, admitMessage, progress, stop, recordUsage, isSession,
    dispatchNative: async (input: ConversationMessage & { readonly operation: 'prompt' | 'command' | 'synthetic' | 'model' | 'agent' },
      beforeSend: Parameters<typeof admitMessage>[1], admissionId?: string) => {
      const found = sessionIndex.get(input.sessionId);
      if (found?.role !== 'conversation') throw error('BOT_CONVERSATION_REQUIRED');
      const body = z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(input.payload)));
      const inference = input.operation === 'prompt' || input.operation === 'command' || input.operation === 'synthetic' && body.resume !== false;
      if (inference && admissionId === undefined) await admitMessage(input, beforeSend);
      return ownProject(found.projectId, async () => {
        await assertAdmission(input);
        const target = await targetFor(found.projectId, found.itemId);
        const data = (await journal.read(found.projectId, found.itemId)).data;
        const admitted = data.conversationSends?.[admissionId ?? input.operationId];
        if (admissionId !== undefined && !admitted) throw error('BOT_CONVERSATION_ADMISSION_REQUIRED');
        const selection = admitted?.selection ?? (await execution.read(target)).selection;
        return execution.dispatch(target, conversationNativeSchema.parse({
          operationId: input.operationId, operation: input.operation, body, selection,
        }));
      });
    },
    tokens: async (projectId: string, itemId: string) => execution.tokens(await targetFor(projectId, itemId)) };
}
