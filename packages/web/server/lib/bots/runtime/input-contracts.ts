import { z } from 'zod';
import { operations } from '../services/contracts.js';

export const text = z.string().min(1).max(100_000);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const projectSchema = z.object({ id: text, path: text });
export const checkoutSchema = z.object({ directory: text, branch: text, baseBranch: text, baseSha: sha }).strict();
export const snapshotSchema = z.object({
  baseSha: sha, headSha: sha, baseBranch: text, remoteSha: sha.nullable(), diff: z.string(),
  changes: z.array(z.object({ oldPath: text.nullable().optional(), newPath: text.nullable().optional() }).strict()),
  testSha: sha.optional(), fixSha: sha.optional(), testFiles: z.array(text).optional(),
}).strict();
export const prStatusSchema = z.object({ headSha: sha, baseSha: sha, merged: z.boolean(), approved: z.boolean(), mergeMode: z.enum(['auto-merge', 'queue']) }).strict();
const bindingSchema = z.object({ identityId: text, identityRevision: z.number().int().positive(), target: z.json(), expectedStatusId: z.string().regex(/^[1-9][0-9]*$/).optional() }).strict();
export const contextSchema = z.object({ github: bindingSchema.optional(), jira: bindingSchema.optional(), discord: bindingSchema.optional() }).strict();
const admissionFields = { key: text, number: z.number().int().positive(), branch: text, round: z.number().int().nonnegative(), headSha: sha, baseSha: sha,
  policyFingerprint: text, mode: z.enum(['auto-merge', 'queue']), binding: bindingSchema };
export const admissionSchema = z.discriminatedUnion('state', [
  z.object({ ...admissionFields, state: z.literal('active') }).strict(),
  z.object({ ...admissionFields, state: z.literal('revoking'), action: z.enum(['judge', 'stop', 'disabled']) }).strict(),
  z.object({ ...admissionFields, state: z.enum(['revoked', 'merged']) }).strict(),
]);
export const authorizationSchema = z.object({ number: z.number().int().positive(), headSha: sha, baseSha: sha,
  autoMerge: z.boolean(), queued: z.boolean(), merged: z.boolean() }).strict();
export const toolOperations = ['git.push', 'pr.open', 'pr.comment', 'jira.comment', 'jira.transition', 'discord.send'] as const;
export const pendingToolSchema = z.discriminatedUnion('operation', [
  z.object({ key: text, operation: z.literal('git.push'), input: operations['git.push'].input }).strict(),
  z.object({ key: text, operation: z.literal('pr.open'), input: operations['pr.open'].input }).strict(),
  z.object({ key: text, operation: z.literal('pr.comment'), input: operations['pr.comment'].input }).strict(),
  z.object({ key: text, operation: z.literal('jira.comment'), input: operations['jira.comment'].input }).strict(),
  z.object({ key: text, operation: z.literal('jira.transition'), input: operations['jira.transition'].input }).strict(),
  z.object({ key: text, operation: z.literal('discord.send'), input: operations['discord.send'].input }).strict(),
]);
export const questionAnswerSchema = z.object({ key: text, resumeState: z.enum(['investigating', 'fixing', 'judging']), round: z.number().int().nonnegative() }).strict();
export const stageInterruptionSchema = z.object({ runId: z.string().regex(/^(investigation|fixing|judge):[0-9]+$/), sessionId: text }).strict();

export type RuntimeProject = z.output<typeof projectSchema>;
export type RuntimeCheckout = z.output<typeof checkoutSchema>;
export type RuntimeSnapshot = z.output<typeof snapshotSchema>;
export type RuntimeServiceContext = z.output<typeof contextSchema>;
export type RuntimeAdmission = z.output<typeof admissionSchema>;
export type RuntimeAuthorization = z.output<typeof authorizationSchema>;
export type RuntimePullRequestStatus = z.output<typeof prStatusSchema>;
export type RuntimePendingTool = z.output<typeof pendingToolSchema>;
export type RuntimeQuestionAnswer = z.output<typeof questionAnswerSchema>;
export type RuntimeStageInterruption = z.output<typeof stageInterruptionSchema>;
