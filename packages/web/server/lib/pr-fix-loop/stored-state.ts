import { z } from 'zod';
import { receiptSchema, workerSchema } from './approval-contract.js';
import { reviewActionSchema, reviewJobSchema, reviewTurnSchema } from './review-actions.js';

export const publicationAuthoritySchema = z.object({
  repositoryId: z.string(), bindingRevision: z.number(), configRevision: z.string(),
  remote: z.object({ name: z.string(), endpoint: z.object({ displayUrl: z.string(), fingerprint: z.string() }).passthrough() }),
  transportMode: z.literal('managed'),
});
const head = z.object({ state: z.enum(['open', 'closed', 'merged']), branch: z.string(), headSha: z.string(),
  headRepo: z.object({ id: z.string(), owner: z.string(), repo: z.string() }).nullable().optional() });
const destination = receiptSchema.shape.destination;
const internal = z.object({
  seen: z.array(z.string()), handled: z.array(z.string()).optional(), baselined: z.boolean().optional(),
  failures: z.number().optional(), workerFailures: z.number().optional(), readyAnnounced: z.boolean().optional(),
  feedbackTrustVersion: z.number().optional(), tokenBaseline: z.number().nullable().optional(),
  headSha: z.string().optional(), headFirstSeenAt: z.number().optional(), ciReportedSha: z.string().optional(),
  turnWindows: z.array(z.object({ start: z.number(), end: z.number().nullable() })).optional(),
  destination: destination.optional(), turnSnapshot: head.nullable().optional(),
  reviewTurn: reviewTurnSchema.nullable().optional(), reviewJob: reviewJobSchema.nullable().optional(),
  // The publication adapter rechecks its private authority before sending it to the network executor.
  publication: z.object({ receipt: receiptSchema, authority: z.unknown() }).nullable().optional(),
  publicationState: z.literal('publishing').nullable().optional(),
}).passthrough();
export const storedLoopSchema = z.object({
  id: z.string().min(1), sessionId: z.string().min(1), directory: z.string(),
  accountId: z.string().nullable().optional(), owner: z.string(), repo: z.string(), number: z.number(),
  url: z.string(), title: z.string(), branch: z.string(),
  status: z.enum(['watching', 'working', 'waitingForPush', 'ready', 'stopped', 'closed', 'limitReached', 'budgetReached', 'error']),
  statusReason: z.string().nullable(), config: z.unknown(),
  readContext: z.object({ directory: z.string(), repositoryId: z.string(), provider: z.string(), instance: z.string(),
    accountId: z.string(), bindingRevision: z.number(), primaryRemote: z.string(), linked: z.boolean() }).partial().passthrough().optional(),
  botAuthority: z.unknown().optional(),
  worker: workerSchema.nullable().optional(), pendingApproval: receiptSchema.nullable().optional(),
  review: z.object({ state: z.enum(['awaitingPublication', 'pending', 'blocked', 'complete']), actions: z.array(reviewActionSchema),
    completed: z.number(), total: z.number(), lastError: z.string().nullable() }).nullable().optional(),
  iterations: z.number(), totalIterations: z.number().optional(), tokensUsed: z.number(),
  ci: z.object({ state: z.enum(['success', 'failure', 'pending', 'unknown']), headSha: z.string() }).nullable(),
  unresolvedThreads: z.number().nullable(), changesRequested: z.boolean().nullable(),
  lastCheckedAt: z.number().nullable(), lastError: z.string().nullable(), createdAt: z.number(), updatedAt: z.number(), internal,
}).passthrough();
export const legacyStoredLoopSchema = storedLoopSchema.extend({
  url: z.string().default(''), title: z.string().default(''), branch: z.string().default(''),
  statusReason: z.string().nullable().default(null),
  iterations: z.number().default(0), tokensUsed: z.number().default(0),
  ci: storedLoopSchema.shape.ci.default(null),
  unresolvedThreads: z.number().nullable().default(null), changesRequested: z.boolean().nullable().default(null),
  lastCheckedAt: z.number().nullable().default(null), lastError: z.string().nullable().default(null),
  createdAt: z.number().default(0), updatedAt: z.number().default(0),
  internal: internal.extend({ seen: z.array(z.string()).default([]) }),
});
export const storedFileSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]),
  loops: z.array(z.unknown()), workers: z.array(z.unknown()).optional() });
