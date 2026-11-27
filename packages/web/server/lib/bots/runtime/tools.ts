import { z } from 'zod';
import { botInputDigest } from '../effects.js';
import { evidenceSchema } from '../prompts.js';
import { botPushInput } from '../publication.js';
import { hasSourceControlStringCode as hasSourceControlErrorCode } from '../../source-control/input-guards.js';
import { TERMINAL_ITEM_STATES } from '../schema.js';
import { contextSchema, pendingToolSchema, snapshotSchema, text, toolOperations } from './input-contracts.js';
import { serviceRequestSchema } from './journal.js';
import { requireCheckout } from './invariants.js';
import { runtimeError as error } from './errors.js';
import { mergeEvidence } from './shared.js';
import type { JsonValue } from '../../shared/json-values.js';
import type { RuntimeQuestionDraft, RuntimeToolCall } from './contracts.js';
import type { RuntimeContext, RuntimePump } from './context.js';
import type { createRuntimeCheckout } from './checkout.js';
import type { createRuntimeMergeAdmission } from './merge-admission.js';
import type { createRuntimePublication } from './publication.js';
import type { createRuntimeServiceEffects } from './service-effects.js';
import type { createRuntimeShared } from './shared.js';

export type RuntimeToolOutcome =
  | { readonly state: 'succeeded'; readonly result: JsonValue }
  | { readonly state: 'outcome-unknown' };

const parseToolInput = <Schema extends z.ZodType>(schema: Schema, input: JsonValue): z.output<Schema> => {
  const result = schema.safeParse(input);
  if (!result.success) throw Object.assign(error('BOT_TOOL_INPUT_INVALID', 400), { state: 'refused' });
  return result.data;
};

export const createRuntimeTools = (
  { journal, itemFor, mutate, config, attention, worktrees, serviceContext, questions, sessionIndex, ownProject, dirty }: RuntimeContext,
  { shared: { needsYou, projectFor }, external, publication, mergeAdmission: { admissionFor, requestRevocation, freshAdmission }, checkout: { publishPullRequest }, pump }: {
    readonly shared: ReturnType<typeof createRuntimeShared>;
    readonly external: ReturnType<typeof createRuntimeServiceEffects>;
    readonly publication: ReturnType<typeof createRuntimePublication>;
    readonly mergeAdmission: ReturnType<typeof createRuntimeMergeAdmission>;
    readonly checkout: ReturnType<typeof createRuntimeCheckout>;
    readonly pump: RuntimePump;
  },
) => {
  const { saveData } = journal;
  const handleTool = async ({ sessionId, action, input }: RuntimeToolCall) => {
    const target = sessionIndex.get(sessionId);
    if (!target) throw error('BOT_SESSION_REQUIRED', 403);
    const { projectId, itemId } = target;
    return ownProject(projectId, async () => {
      const item = await itemFor(projectId, itemId);
      if (item.sessions.fixing !== sessionId || TERMINAL_ITEM_STATES.includes(item.state)) throw error('BOT_FIXING_SESSION_REQUIRED', 403);
      const project = await projectFor(projectId);
      const bot = (await config.read(projectId)).definitions.find((entry) => entry.id === item.botId);
      if (!bot?.enabled) throw error('BOT_NOT_ENABLED');
      if (action === 'item.report') {
        const report = parseToolInput(z.object({ evidence: z.array(evidenceSchema), critical: z.boolean().default(false) }).strict(), input);
        const updated = await mutate(projectId, itemId, (current) => ({ ...current, evidence: mergeEvidence(current.evidence, report.evidence) }));
        if (report.critical) {
          await saveData(projectId, itemId, { critical: true });
          await attention.sync({ projectId, item: updated, critical: true });
        }
        return { item: updated };
      }
      if (action === 'item.ask') {
        if (item.state === 'needs-you') throw error('BOT_EFFECT_RESUME_REQUIRED');
        const question = parseToolInput(z.object({ operationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), question: text, people: z.array(text).default([]), requestedRole: z.string().trim().min(1).max(200).optional() }).strict(), input);
        const execution = await journal.read(projectId, itemId);
        if (execution.data.questionAnswer) throw error('BOT_QUESTION_ANSWER_PENDING');
        const eventId = `tool:${question.operationId}`;
        const captured = Object.values(execution.data.questions ?? {}).find((record) => record.input.eventId === eventId);
        const pending = execution.data.pendingQuestion ? execution.data.questions?.[execution.data.pendingQuestion] : undefined;
        const request: RuntimeQuestionDraft = { project, bot, itemId, eventId, questions: [question.question], people: question.people, resumeState: captured?.input.resumeState ?? pending?.input.resumeState ?? item.state };
        if (question.requestedRole) request.requestedRole = question.requestedRole;
        return questions.ask(request);
      }
      const operation = toolOperations.find((entry) => entry === action);
      if (!operation) throw error('BOT_ACTION_UNSUPPORTED', 400);
      const request = parseToolInput(z.object({ operationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
        body: ['pr.comment', 'jira.comment', 'discord.send'].includes(action) ? text : text.optional() }).strict(), input);
      const service = operation.startsWith('jira.') ? 'jira' : operation.startsWith('discord.') ? 'discord' : 'github';
      if (!bot.identity[service]) throw Object.assign(error('BOT_CONNECTOR_MISSING', 400), { state: 'refused',
        message: `This bot has no ${service === 'github' ? 'GitHub' : service === 'jira' ? 'Jira' : 'Discord'} connector, so it cannot ${action}. Continue without it; the coordinator delivers the result.` });
      const key = action === 'pr.open' ? `${itemId}:pr` : `${itemId}:tool:${request.operationId}`;
      const execution = await journal.read(projectId, itemId);
      const rawPrevious = execution.operations[key];
      const previous = rawPrevious ? serviceRequestSchema.parse(rawPrevious) : undefined;
      const pendingTool = execution.data.pendingTool ? pendingToolSchema.parse(execution.data.pendingTool) : null;
      const known = previous ? pendingToolSchema.parse({ key, operation: previous.prepared.operation, input: previous.input }) : pendingTool?.key === key ? pendingTool : null;
      if (known && (known.operation !== action || ['pr.comment', 'jira.comment', 'discord.send'].includes(action) && ('body' in known.input ? known.input.body : undefined) !== request.body)) throw error('BOT_EFFECT_INPUT_CHANGED');
      const effect = item.effects.find((entry) => entry.key === key);
      const canSend = !effect || effect.state === 'prepared';
      if (canSend && (pendingTool && pendingTool.key !== key
        || item.effects.some((entry) => entry.key !== key && ['dispatching', 'outcome-unknown'].includes(entry.state)))) throw error('BOT_EFFECT_UNSETTLED');
      if (canSend && (pendingTool || item.state === 'needs-you')) throw error('BOT_EFFECT_RESUME_REQUIRED');
      const admission = await admissionFor(projectId, item);
      if (execution.data.stopRequested || admission?.state === 'revoking') throw error('BOT_ADMISSION_REVOKED');
      if (['git.push', 'pr.open'].includes(action) && admission?.state === 'active') {
        await requestRevocation(projectId, item, 'judge');
        dirty.add(projectId);
        throw error('BOT_ADMISSION_REVOKED');
      }
      try {
        const snapshot = known && action !== 'pr.open' ? null : snapshotSchema.parse(await worktrees.inspect({ project, bot, item }));
        if (action === 'git.push' && snapshot) publication.assertRemote(item, snapshot, key);
        let payload;
        if (known && action !== 'pr.open') payload = known.input;
        else if (action === 'git.push') { requireCheckout(item); if (!snapshot) throw error('BOT_JUDGMENT_REQUIRED'); payload = botPushInput(item, snapshot); }
        else if (action === 'pr.open') {
          if (!snapshot) throw error('BOT_JUDGMENT_REQUIRED');
          if (!await freshAdmission(projectId, project, bot, item)) throw error('BOT_JUDGMENT_REQUIRED');
          return { item: await publishPullRequest(projectId, project, bot, item, snapshot, true) };
        } else if (action === 'pr.comment') {
          if (!item.pr) throw error('BOT_PULL_REQUEST_REQUIRED');
          if (!snapshot) throw error('BOT_JUDGMENT_REQUIRED');
          payload = { number: item.pr.number, headSha: snapshot.headSha, body: text.parse(request.body) };
        } else if (action === 'jira.transition') {
          const binding = contextSchema.parse(await serviceContext({ project, bot, item, service: 'jira', operation: 'jira.transition' })).jira;
          if (!bot.jira?.doneTransition || !binding?.expectedStatusId || item.state !== 'closing') throw error('BOT_CLOSURE_REQUIRED');
          payload = { transitionId: bot.jira.doneTransition, expectedStatusId: binding.expectedStatusId };
        } else payload = { body: text.parse(request.body) };
        return { receipt: await external(projectId, project, bot, item, key, operation, payload, { tool: true }) };
      } catch (failure) {
        await needsYou(projectId, itemId, hasSourceControlErrorCode(failure) ? failure.code : 'BOT_OPERATION_FAILED');
        throw failure;
      }
    }, { waitMs: 10_000 }).finally(async () => { if (dirty.delete(projectId)) await pump(projectId); });
  };

  const readToolOutcome = async ({ sessionId, action, input }: RuntimeToolCall): Promise<RuntimeToolOutcome> => {
    const target = sessionIndex.get(sessionId);
    if (!target) return { state: 'outcome-unknown' };
    const item = await itemFor(target.projectId, target.itemId);
    if (item.sessions.fixing !== sessionId) return { state: 'outcome-unknown' };
    const execution = await journal.read(target.projectId, target.itemId);
    if (action === 'item.report') {
      const report = z.object({ evidence: z.array(evidenceSchema), critical: z.boolean().default(false) }).strict().parse(input);
      if (report.evidence.every((evidence) => item.evidence.some((known) => botInputDigest(known) === botInputDigest(evidence)))
        && (!report.critical || execution.data.critical)) return { state: 'succeeded', result: { item } };
      return { state: 'outcome-unknown' };
    }
    if (action === 'item.ask') {
      const question = z.object({ operationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), question: text,
        people: z.array(text).default([]), requestedRole: z.string().trim().min(1).max(200).optional() }).strict().parse(input);
      const captured = Object.values(execution.data.questions ?? {}).find((record) => record.input.eventId === `tool:${question.operationId}`);
      if (!captured || botInputDigest(captured.input.questions) !== botInputDigest([question.question])
        || botInputDigest(captured.input.people) !== botInputDigest(question.people)
        || captured.input.requestedRole !== question.requestedRole) return { state: 'outcome-unknown' };
      return { state: 'succeeded', result: { item, question: captured } };
    }
    if (!toolOperations.some((entry) => entry === action)) return { state: 'outcome-unknown' };
    const request = z.object({ operationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), body: text.optional() }).strict().parse(input);
    const key = action === 'pr.open' ? `${item.id}:pr` : `${item.id}:tool:${request.operationId}`;
    const rawDescriptor = execution.operations[key];
    const descriptor = rawDescriptor ? serviceRequestSchema.parse(rawDescriptor) : undefined;
    const effect = item.effects.find((entry) => entry.key === key);
    if (!descriptor || descriptor.prepared.operation !== action || effect?.state !== 'succeeded'
      || ['pr.comment', 'jira.comment', 'discord.send'].includes(action) && z.object({ body: z.string().optional() }).parse(descriptor.input).body !== request.body) return { state: 'outcome-unknown' };
    return { state: 'succeeded', result: action === 'pr.open' ? { item } : { receipt: effect.receipt } };
  };

  return { handleTool, readToolOutcome };
};
