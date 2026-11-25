import { z } from 'zod';
import { botDefinitionSchema } from '../config.js';
import { botItemSourceSchema } from '../schema.js';
import { operations, effectSchema } from '../services/contracts.js';
import { parseBotStageOutput } from '../prompts.js';
import type { BotStageReport } from '../prompts.js';
import type { evaluateRepositoryPolicy, readRepositoryPolicy } from '../repository-policy.js';
import { admissionSchema, checkoutSchema, projectSchema, questionAnswerSchema, snapshotSchema, stageInterruptionSchema, pendingToolSchema } from './input-contracts.js';
import type { createBotExecutionStore } from '../execution-store.js';
import type { BotStageSelectionInput } from '../stage-sessions.js';
import { conversationCaptureSchema, conversationSelectionSchema } from '../conversation-contract.js';

const jsonRecord = z.record(z.string(), z.json());
const stage = z.enum(['investigation', 'fixing', 'judge']);
const feedbackSchema = z.object({ eventId: z.string(), text: z.string() });
const repositoryContextSchema = z.object({ branch: z.string(), rules: z.array(z.object({ type: z.string() }).catchall(z.json())), sourceIssue: z.json().optional() });
const investigationSchema = z.json().transform((value) => parseBotStageOutput('investigation', JSON.stringify(value)));
const fixingSchema = z.json().transform((value) => parseBotStageOutput('fixing', JSON.stringify(value)));
const contextSchema = z.object({ repositoryRules: repositoryContextSchema.optional(), investigation: investigationSchema.optional(),
  snapshot: snapshotSchema.optional(), policy: z.object({ policyFingerprint: z.string() }).passthrough().optional() });
const tokensSchema = z.object({ total: z.number(), byStage: z.object({ investigation: z.number(), fixing: z.number(), judge: z.number() }), byDay: z.record(z.string(), z.number()) });
export const runSchema = z.object({ stage, projectId: z.string(), itemId: z.string(), directory: z.string(), bot: botDefinitionSchema,
  selection: z.json().optional(), prompt: z.string().optional(), dispatchedAt: z.number(), afterIdleId: z.string().nullable().optional(),
  tokenBaseline: tokensSchema.optional(), context: contextSchema.optional() });
export const executionRunSchema = runSchema.required({ prompt: true });
const outcomeSchema = z.object({ state: z.literal('completed'), text: z.string(), tokens: z.number().optional(), output: z.json() }).passthrough();
const questionInputSchema = z.object({ eventId: z.string(), questions: z.array(z.string()), people: z.array(z.string()), requestedRole: z.string().optional(),
  resumeState: z.enum(['investigating', 'fixing', 'judging']) });
const questionSchema = z.object({ input: questionInputSchema }).catchall(z.json());
const bindingSchema = z.object({ identityId: z.string(), identityRevision: z.number(), target: z.json() });
export const dataSchema = z.object({
  conversationCapture: conversationCaptureSchema.optional(),
  conversationSends: z.record(z.string(), z.object({ digest: z.string(), selection: conversationSelectionSchema, at: z.number() })).optional(),
  round: z.number().optional(), runs: z.record(z.string(), runSchema).optional(), outcomes: z.record(z.string(), outcomeSchema).optional(),
  checkout: checkoutSchema.optional(), snapshot: snapshotSchema.optional(), investigation: investigationSchema.optional(), fixing: fixingSchema.optional(),
  admission: admissionSchema.optional(), pendingTool: pendingToolSchema.nullable().optional(), pendingQuestion: z.string().nullable().optional(),
  questionAnswer: questionAnswerSchema.nullable().optional(), questions: z.record(z.string(), questionSchema).optional(),
  interruptedStage: stageInterruptionSchema.nullable().optional(), resumeState: z.enum(['queued', 'investigating', 'waiting-answer', 'fixing', 'proving', 'judging', 'in-review', 'merging', 'closing', 'done', 'needs-you', 'failed', 'stopped']).optional(),
  stopRequested: z.boolean().optional(), critical: z.boolean().optional(), feedback: z.record(z.string(), feedbackSchema).optional(),
  feedbackQuestions: z.record(z.string(), z.string().nullable()).optional(), delivered: z.record(z.string(), z.boolean()).optional(),
  destinations: z.object({ github: bindingSchema.optional(), jira: bindingSchema.optional(), discord: bindingSchema.optional() }).optional(),
  serviceResults: jsonRecord.optional(), mergedObservation: z.json().optional(),
}).passthrough();

const authoritySchema = z.object({ service: z.enum(['github', 'jira', 'discord']), identityId: z.string(), identityRevision: z.number() }).catchall(z.json());
const preparedFields = effectSchema.omit({ authority: true, operation: true, target: true }).extend({ authority: authoritySchema });
const preparedSchema = z.discriminatedUnion('operation', [
  preparedFields.extend({ operation: z.literal('git.push'), target: operations['git.push'].target }).catchall(z.json()),
  preparedFields.extend({ operation: z.literal('pr.open'), target: operations['pr.open'].target }).catchall(z.json()),
  preparedFields.extend({ operation: z.literal('pr.comment'), target: operations['pr.comment'].target }).catchall(z.json()),
  preparedFields.extend({ operation: z.literal('pr.auto-merge'), target: operations['pr.auto-merge'].target }).catchall(z.json()),
  preparedFields.extend({ operation: z.literal('pr.disable-auto-merge'), target: operations['pr.disable-auto-merge'].target }).catchall(z.json()),
  preparedFields.extend({ operation: z.literal('pr.dequeue'), target: operations['pr.dequeue'].target }).catchall(z.json()),
  preparedFields.extend({ operation: z.literal('jira.comment'), target: operations['jira.comment'].target }).catchall(z.json()),
  preparedFields.extend({ operation: z.literal('jira.transition'), target: operations['jira.transition'].target }).catchall(z.json()),
  preparedFields.extend({ operation: z.literal('discord.send'), target: operations['discord.send'].target }).catchall(z.json()),
  preparedFields.extend({ operation: z.literal('jira.question'), target: operations['jira.question'].target }).catchall(z.json()),
  preparedFields.extend({ operation: z.literal('discord.question'), target: operations['discord.question'].target }).catchall(z.json()),
]);
export const serviceRequestSchema = z.object({ prepared: preparedSchema, input: z.json(), authorization: admissionSchema.optional() }).catchall(z.json());
export const checkoutRequestSchema = z.object({ project: projectSchema, bot: botDefinitionSchema,
  item: z.object({ id: z.string(), botId: z.string(), source: botItemSourceSchema }), key: z.string() });
export const cleanupRequestSchema = z.object({ project: projectSchema, bot: z.object({ id: z.string() }).passthrough(),
  item: z.object({ id: z.string(), worktree: z.string().optional(), branch: z.string().optional() }), checkout: checkoutSchema });

export const cloneRun = (run: Omit<z.output<typeof runSchema>, 'context' | 'selection'> & { readonly selection?: BotStageSelectionInput; readonly context: {
  readonly repositoryRules?: { readonly branch: string; readonly rules: readonly { readonly type: string }[]; readonly sourceIssue?: unknown } | undefined;
  readonly investigation?: BotStageReport['investigation'] | undefined;
  readonly snapshot?: z.output<typeof snapshotSchema> | undefined;
  readonly policy?: (ReturnType<typeof evaluateRepositoryPolicy> & Pick<Awaited<ReturnType<typeof readRepositoryPolicy>>, 'people'>) | undefined;
} }) => runSchema.parse(JSON.parse(JSON.stringify(run)));
export const createRuntimeJournal = (journal: ReturnType<typeof createBotExecutionStore>) => ({
  async read(projectId: string, itemId: string) {
    const entry = await journal.read(projectId, itemId);
    return { ...entry, capturedRuns: jsonRecord.parse(entry.data.runs ?? {}), data: dataSchema.parse(entry.data) };
  },
  saveData(projectId: string, itemId: string, patch: Partial<z.output<typeof dataSchema>>) {
    const data = jsonRecord.parse(JSON.parse(JSON.stringify(patch)));
    return journal.update(projectId, itemId, (entry) => ({ ...entry, data: { ...entry.data, ...data } }));
  },
  saveRun(projectId: string, itemId: string, runId: string, run: z.output<typeof runSchema>) {
    const captured = z.json().parse(JSON.parse(JSON.stringify(run)));
    return journal.update(projectId, itemId, (entry) => ({ ...entry, data: { ...entry.data,
      runs: { ...jsonRecord.parse(entry.data.runs ?? {}), [runId]: captured },
    } }));
  },
});
