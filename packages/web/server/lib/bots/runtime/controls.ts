import { z } from 'zod';
import { withSourceControlFileLock } from '../../source-control/file-lock.js';
import { hasSourceControlStringCode as hasSourceControlErrorCode } from '../../source-control/input-guards.js';
import { TERMINAL_ITEM_STATES } from '../schema.js';
import { pendingToolSchema, stageInterruptionSchema, text } from './input-contracts.js';
import { runtimeError as error } from './errors.js';
import type { BotEffect, BotItem } from '../schema.js';
import type { RuntimeBot } from './contracts.js';
import type { RuntimeContext, RuntimeDetailReader, RuntimePump } from './context.js';
import type { RuntimeProject } from './input-contracts.js';
import type { createRuntimeCheckout } from './checkout.js';
import type { createRuntimeFeedback } from './feedback.js';
import type { createRuntimeMergeAdmission } from './merge-admission.js';
import type { createRuntimeServiceEffects } from './service-effects.js';
import type { createRuntimeShared } from './shared.js';
import type { createRuntimeConversations } from './conversations.js';

export const createRuntimeControls = (
  { journal, itemFor, mutate, transition, now, effects, config, store, stages, pullRequests, questions, sessionIndex, activeProofs }: RuntimeContext,
  { shared: { needsYou, projectFor, checkBudgets }, external, checkout: { cleanup }, mergeAdmission: { requestRevocation, settleRevocation }, feedback: { refuseUnsentQuestion, finishQuestionAnswer }, conversations, pump, detail }: {
    readonly shared: ReturnType<typeof createRuntimeShared>;
    readonly external: ReturnType<typeof createRuntimeServiceEffects>;
    readonly checkout: ReturnType<typeof createRuntimeCheckout>;
    readonly mergeAdmission: ReturnType<typeof createRuntimeMergeAdmission>;
    readonly feedback: ReturnType<typeof createRuntimeFeedback>;
    readonly pump: RuntimePump;
    readonly detail: RuntimeDetailReader;
    readonly conversations: ReturnType<typeof createRuntimeConversations>;
  },
) => {
  const { saveData } = journal;
  const resume = async (projectId: string, itemId: string) => {
    await withSourceControlFileLock(`${store.filePathFor(projectId)}.owner.lock`, async () => {
      const item = await itemFor(projectId, itemId);
      const execution = await journal.read(projectId, itemId);
      if (item.state !== 'needs-you' && !(item.state === 'waiting-answer' && execution.data.pendingQuestion)) throw error('BOT_ITEM_NOT_WAITING');
      if (execution.data.stopRequested || execution.data.admission?.state === 'revoking') return;
      const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId);
      if (!bot?.enabled) throw error('BOT_NOT_ENABLED');
      const budget = await checkBudgets(projectId, bot, (await store.read(projectId)).items, item);
      if (budget) throw error(budget);
      if (execution.data.pendingQuestion) {
        await questions.retry({ project: await projectFor(projectId), bot, itemId });
        if (execution.data.questionAnswer) await finishQuestionAnswer(projectId, await projectFor(projectId), bot, itemId);
        return;
      }
      if (execution.data.questionAnswer) {
        await finishQuestionAnswer(projectId, await projectFor(projectId), bot, itemId, true);
        return;
      }
      const state = execution.data.resumeState;
      if (!state) throw error('BOT_RESUME_STATE_MISSING');
      if (execution.data.interruptedStage) {
        const interruption = stageInterruptionSchema.parse(execution.data.interruptedStage);
        const run = execution.data.runs?.[interruption.runId];
        if (!run || item.sessions[run.stage] !== interruption.sessionId) throw error('BOT_INTERRUPTED_STAGE_MISMATCH');
        const request = { ...run, sessionId: interruption.sessionId };
        await stages.resume(request);
        for (const suffix of ['create', 'prompt']) {
          const key = `${itemId}:${interruption.runId}:${suffix}`;
          const effect = item.effects.find((entry): entry is Extract<BotEffect, { state: 'dispatching' | 'outcome-unknown' }> & { kind: 'session.create' | 'session.prompt' } => entry.key === key && (entry.kind === 'session.create' || entry.kind === 'session.prompt') && (entry.state === 'dispatching' || entry.state === 'outcome-unknown'));
          if (effect && ['dispatching', 'outcome-unknown'].includes(effect.state)) await effects.recover({ projectId, itemId, key,
            reconcile: () => stages.reconcile(effect.kind, request, interruption.sessionId) });
        }
        await saveData(projectId, itemId, { round: (execution.data.round ?? 0) + (execution.data.outcomes?.[interruption.runId] ? 0 : 1), interruptedStage: null });
      } else {
        const stage = state === 'investigating' ? 'investigation' : state === 'judging' ? 'judge' : state === 'fixing' ? 'fixing' : undefined;
        const round = execution.data.round ?? 0;
        const runId = `${stage}:${round}`;
        const run = execution.data.runs?.[runId];
        const dispatched = ['create', 'prompt'].every((suffix) => item.effects.some((effect) =>
          effect.key === `${itemId}:${runId}:${suffix}` && effect.state === 'succeeded'));
        if (run && dispatched && !execution.data.outcomes?.[runId]
          && !item.effects.some((effect) => ['dispatching', 'outcome-unknown'].includes(effect.state))) {
          const outcome = await stages.outcome({ ...run, sessionId: text.parse(stage ? item.sessions[stage] : undefined) });
          if (outcome && outcome.state !== 'completed') await saveData(projectId, itemId, { round: round + 1 });
        }
      }
      if (execution.data.pendingTool) {
        const request = pendingToolSchema.parse(execution.data.pendingTool);
        try { await external(projectId, await projectFor(projectId), bot, item, request.key, request.operation, request.input); }
        catch (failure) { await needsYou(projectId, itemId, hasSourceControlErrorCode(failure) ? failure.code : 'BOT_OPERATION_FAILED'); return; }
      }
      await transition(projectId, itemId, state);
    }, { waitMs: 10_000 });
    await pump(projectId);
    return detail(projectId, itemId);
  };
  const finishStop = async (projectId: string, project: RuntimeProject, bot: RuntimeBot, item: BotItem) => {
    const itemId = item.id;
    const stops = await Promise.allSettled([
      ...Object.values(item.sessions).map((sessionId) => stages.stop({ bot, sessionId: text.parse(sessionId), directory: text.parse(item.worktree) })),
      conversations.stop(projectId, itemId),
    ]);
    const failure = stops.find((entry) => entry.status === 'rejected');
    if (failure) throw failure.reason;
    await pullRequests.stop({ project, bot, item });
    let current = await itemFor(projectId, itemId);
    const execution = await journal.read(projectId, itemId);
    if (execution.data.pendingTool) {
      const request = pendingToolSchema.parse(execution.data.pendingTool);
      const effect = current.effects.find((entry) => entry.key === request.key);
      if (!effect || effect.state === 'prepared') {
        if (effect) current = await mutate(projectId, itemId, (item) => ({ ...item, effects: item.effects.map((entry) => entry.key === request.key
          ? { ...entry, state: 'refused', code: 'BOT_STOP_REQUESTED', updatedAt: now() } : entry) }));
        await saveData(projectId, itemId, { pendingTool: null });
      }
    }
    if (execution.data.pendingQuestion) current = await refuseUnsentQuestion(projectId, itemId, execution.data.pendingQuestion, 'BOT_STOP_REQUESTED');
    if (current.effects.some((effect) => ['dispatching', 'outcome-unknown', 'prepared'].includes(effect.state)
      && (effect.key !== `${itemId}:cleanup` || effect.kind !== 'worktree.remove'))) throw error('BOT_STOP_HAS_UNSETTLED_EFFECTS');
    if (execution.data.pendingQuestion) await questions.answered({ projectId, itemId });
    if (current.worktree) await cleanup(projectId, project, bot, current);
    return { item: await transition(projectId, itemId, 'stopped') };
  };
  const stopItem = async (projectId: string, itemId: string) => {
    await projectFor(projectId);
    const initial = await itemFor(projectId, itemId);
    if (TERMINAL_ITEM_STATES.includes(initial.state)) return { item: initial };
    await saveData(projectId, itemId, { stopRequested: true });
    activeProofs.get(JSON.stringify([projectId, itemId]))?.abort();
    return withSourceControlFileLock(`${store.filePathFor(projectId)}.owner.lock`, async () => {
      const project = await projectFor(projectId);
      const item = await itemFor(projectId, itemId);
      if (TERMINAL_ITEM_STATES.includes(item.state)) return { item };
      const bot: RuntimeBot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId)
        ?? { id: item.botId, enabled: false };
      const admission = await requestRevocation(projectId, item, 'stop');
      await needsYou(projectId, itemId, 'BOT_STOP_REQUESTED');
      if (admission?.state === 'merged') {
        return { item: await needsYou(projectId, itemId, 'GitHub merged before revocation was confirmed') };
      }
      if (admission?.state === 'revoking' && !await settleRevocation(projectId, project, bot, item, admission)) return { item: await itemFor(projectId, itemId) };
      return finishStop(projectId, project, bot, await itemFor(projectId, itemId));
    }, { waitMs: 10_000 });
  };
  const onSessionEvent = async ({ sessionId, reason }: { readonly sessionId: string; readonly reason: string }) => {
    const target = sessionIndex.get(sessionId);
    if (!target) return;
    if (reason === 'idle') return pump(target.projectId);
    const item = await itemFor(target.projectId, target.itemId);
    if (item.conversation?.sessionId === sessionId) {
      if (reason === 'idle') return;
      return needsYou(target.projectId, target.itemId, reason);
    }
    const stage = item.state === 'investigating' ? 'investigation' : item.state === 'judging' ? 'judge' : 'fixing';
    if (item.sessions[stage] !== sessionId) return;
    return needsYou(target.projectId, target.itemId, reason);
  };

  const recordUsage = async ({ sessionId, total }: { readonly sessionId: string; readonly total: number }) => {
    z.number().int().nonnegative().parse(total);
    const target = sessionIndex.get(sessionId);
    if (!target) return;
    const { projectId, itemId } = target;
    const item = await itemFor(projectId, itemId);
    if (item.conversation?.sessionId === sessionId) return conversations.recordUsage(projectId, itemId, total);
    if (TERMINAL_ITEM_STATES.includes(item.state)) return;
    const execution = await journal.read(projectId, itemId);
    const stage = (['investigation', 'fixing', 'judge'] as const).find((key) => item.sessions[key] === sessionId);
    if (!stage) return;
    const runs = Object.entries(execution.data.runs ?? {}).filter(([key]) => key.startsWith(`${stage}:`));
    const latestRun = runs.at(-1);
    const run = latestRun?.[1];
    if (!run) return;
    const day = new Date(now()).toISOString().slice(0, 10);
    const updated = await mutate(projectId, itemId, (current) => {
      const stageTotal = Math.max(current.tokens.byStage[stage], z.number().parse(run.tokenBaseline?.byStage[stage]) + total);
      const delta = stageTotal - current.tokens.byStage[stage];
      return { ...current, tokens: { ...current.tokens, total: current.tokens.total + delta, byStage: { ...current.tokens.byStage, [stage]: stageTotal }, byDay: { ...current.tokens.byDay, [day]: (current.tokens.byDay[day] ?? 0) + delta } } };
    });
    const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId);
    if (!bot) return;
    const budget = await checkBudgets(projectId, bot, (await store.read(projectId)).items, updated);
    if (budget) {
      await saveData(projectId, itemId, { interruptedStage: stageInterruptionSchema.parse({ runId: latestRun?.[0], sessionId }) });
      await needsYou(projectId, itemId, budget);
      await conversations.stop(projectId, itemId);
      await stages.stop({ bot, sessionId, directory: text.parse(item.worktree) });
    }
    return updated.tokens;
  };

  return { resume, finishStop, stopItem, onSessionEvent, recordUsage };
};
