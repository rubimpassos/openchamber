import { z } from 'zod';
import { withSourceControlFileLock } from '../../source-control/file-lock.js';
import { TERMINAL_ITEM_STATES } from '../schema.js';
import { questionAnswerSchema, text } from './input-contracts.js';
import { runtimeError as error } from './errors.js';
import type { RuntimeBot } from './contracts.js';
import type { RuntimeContext, RuntimeDetailReader, RuntimePump } from './context.js';
import type { RuntimeProject } from './input-contracts.js';
import type { createRuntimeMergeAdmission } from './merge-admission.js';
import type { createRuntimeShared } from './shared.js';

export const createRuntimeFeedback = (
  { journal, itemFor, mutate, transition, now, config, store, notices, questions }: RuntimeContext,
  { shared: { needsYou, projectFor, checkBudgets }, mergeAdmission: { admissionFor, requestRevocation, settleRevocation }, pump, detail }: {
    readonly shared: ReturnType<typeof createRuntimeShared>;
    readonly mergeAdmission: ReturnType<typeof createRuntimeMergeAdmission>;
    readonly pump: RuntimePump;
    readonly detail: RuntimeDetailReader;
  },
) => {
  const { saveData } = journal;
  const deliverFeedback = async (projectId: string, itemId: string, raw: { readonly eventId: string; readonly text: string }) => {
    const feedback = z.object({ eventId: text, text }).strict().parse(raw);
    const item = await itemFor(projectId, itemId);
    if (TERMINAL_ITEM_STATES.includes(item.state)) return { ignored: true };
    const execution = await journal.read(projectId, itemId);
    if (Object.hasOwn(execution.data.delivered ?? {}, feedback.eventId)) return { duplicate: true };
    const feedbackQuestions = { ...execution.data.feedbackQuestions };
    if (!Object.hasOwn(feedbackQuestions, feedback.eventId)) feedbackQuestions[feedback.eventId] = execution.data.pendingQuestion ?? null;
    await saveData(projectId, itemId, { feedback: { ...execution.data.feedback, [feedback.eventId]: feedback }, feedbackQuestions });
    const admission = await admissionFor(projectId, item);
    if (admission?.state === 'active' || admission?.state === 'revoking') {
      const project = await projectFor(projectId);
      const bot: RuntimeBot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId) ?? { id: item.botId, enabled: false };
      const pendingRevocation = await requestRevocation(projectId, item, execution.data.stopRequested ? 'stop' : !bot.enabled ? 'disabled' : 'judge');
      if (pendingRevocation?.state !== 'revoking' || !await settleRevocation(projectId, project, bot, item, pendingRevocation)) throw error('BOT_REMOTE_AUTHORIZATION_UNCONFIRMED');
    }
    if (execution.data.stopRequested || (await admissionFor(projectId, item))?.state === 'merged') throw error('BOT_ADMISSION_REVOKED');
    if (!(await config.read(projectId)).definitions.some((bot) => bot.id === item.botId && bot.enabled)) throw error('BOT_NOT_ENABLED');
    await notices.deliver({ projectId, item, ...feedback });
    const latest = await journal.read(projectId, itemId);
    await saveData(projectId, itemId, { delivered: { ...latest.data.delivered, [feedback.eventId]: true } });
    return { delivered: true };
  };
  const receiveFeedback = (projectId: string, itemId: string, raw: { readonly eventId: string; readonly text: string }) => withSourceControlFileLock(`${store.filePathFor(projectId)}.owner.lock`, () => deliverFeedback(projectId, itemId, raw), { waitMs: 10_000 });
  const refuseUnsentQuestion = async (projectId: string, itemId: string, key: string, code: string) => {
    const item = await itemFor(projectId, itemId);
    if (!item.effects.some((effect) => effect.key === key && effect.state === 'prepared')) return item;
    return mutate(projectId, itemId, (current) => ({ ...current, effects: current.effects.map((effect) => effect.key === key && effect.state === 'prepared'
      ? { ...effect, state: 'refused', code, updatedAt: now() } : effect) }));
  };
  const finishQuestionAnswer = async (projectId: string, project: RuntimeProject, bot: RuntimeBot, itemId: string, explicitResume = false) => {
    const execution = await journal.read(projectId, itemId);
    const intent = questionAnswerSchema.parse(execution.data.questionAnswer);
    if (execution.data.pendingQuestion && execution.data.pendingQuestion !== intent.key) throw error('BOT_QUESTION_PENDING');
    await questions.answered({ projectId, itemId });
    const item = await itemFor(projectId, itemId);
    if ((item.state === 'needs-you' && !explicitResume) || !bot.enabled) return false;
    const budget = await checkBudgets(projectId, bot, (await store.read(projectId)).items, item);
    if (budget) { await needsYou(projectId, itemId, budget); return false; }
    if (intent.resumeState !== 'fixing') await saveData(projectId, itemId, { round: intent.round });
    if (item.state !== intent.resumeState) await transition(projectId, itemId, intent.resumeState);
    await saveData(projectId, itemId, { questionAnswer: null });
    return true;
  };
  const answer = async (projectId: string, itemId: string, input: { readonly eventId: string; readonly text: string }, { questionKey }: { readonly questionKey?: string } = {}) => {
    let progressed = false;
    await withSourceControlFileLock(`${store.filePathFor(projectId)}.owner.lock`, async () => {
      const item = await itemFor(projectId, itemId);
      const feedback = z.object({ eventId: text, text }).strict().parse(input);
      const previous = await journal.read(projectId, itemId);
      if (questionKey !== undefined && questionKey !== (previous.data.pendingQuestion ?? previous.data.questionAnswer?.key)) return;
      if (Object.hasOwn(previous.data.feedbackQuestions ?? {}, feedback.eventId)
        && previous.data.feedbackQuestions?.[feedback.eventId] !== (previous.data.pendingQuestion ?? previous.data.questionAnswer?.key ?? null)) return;
      if (previous.data.questionAnswer && !previous.data.pendingQuestion) {
        const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId);
        if (!bot) throw error('BOT_DEFINITION_REQUIRED');
        progressed = await finishQuestionAnswer(projectId, await projectFor(projectId), bot, itemId);
        return;
      }
      if (!['waiting-answer', 'needs-you'].includes(item.state)) {
        if (Object.hasOwn(previous.data.delivered ?? {}, feedback.eventId)) return;
        throw error('BOT_ITEM_NOT_WAITING');
      }
      await deliverFeedback(projectId, itemId, feedback);
      const execution = await journal.read(projectId, itemId);
      if (execution.data.pendingQuestion) {
        await refuseUnsentQuestion(projectId, itemId, execution.data.pendingQuestion, 'BOT_QUESTION_ANSWERED');
        const question = execution.data.questions?.[execution.data.pendingQuestion];
        if (!question) throw error('BOT_QUESTION_PENDING');
        await saveData(projectId, itemId, { questionAnswer: questionAnswerSchema.parse({ key: execution.data.pendingQuestion,
          resumeState: question.input.resumeState, round: (execution.data.round ?? 0) + (question.input.resumeState === 'fixing' ? 0 : 1) }) });
        const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId);
        if (!bot) throw error('BOT_DEFINITION_REQUIRED');
        progressed = await finishQuestionAnswer(projectId, await projectFor(projectId), bot, itemId);
        return;
      }
      if (item.state === 'needs-you') return;
      const target = execution.data.resumeState;
      if (target === 'judging' || target === 'investigating') await saveData(projectId, itemId, { round: (execution.data.round ?? 0) + 1 });
      await transition(projectId, itemId, target ?? 'fixing');
      progressed = true;
    }, { waitMs: 10_000 });
    if (progressed) await pump(projectId);
    return detail(projectId, itemId);
  };
  return { receiveFeedback, refuseUnsentQuestion, finishQuestionAnswer, answer };
};
