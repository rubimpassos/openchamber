import { z } from 'zod';
import { providerGrantOf, type SpaceEntry } from './spaces/spaces-api';

/** The OpenChamber server owns execution and persistence. The UI only projects it. */
export const fixLoopConfigSchema = z.object({
  maxIterations: z.number().int().min(1).max(50),
  tokenBudget: z.number().int().positive().nullable(),
  triggers: z.enum(['both', 'ci', 'review']),
  ignoreSelf: z.boolean(),
  ignoreBots: z.boolean(),
  allowAuthors: z.array(z.string()),
  blockAuthors: z.array(z.string()),
  mentionOnly: z.boolean(),
  mentionText: z.string(),
  pushMode: z.enum(['auto', 'approval']),
});

export type FixLoopConfig = z.infer<typeof fixLoopConfigSchema>;

export const DEFAULT_PR_FIX_LOOP_CONFIG: FixLoopConfig = {
  maxIterations: 10,
  tokenBudget: null,
  triggers: 'both',
  ignoreSelf: true,
  ignoreBots: true,
  allowAuthors: [],
  blockAuthors: [],
  mentionOnly: false,
  mentionText: '@openchamber',
  pushMode: 'auto',
};

export const fixLoopWorkerModelSchema = z.object({
  providerID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  modelID: z.string().min(1).max(256),
  variant: z.string().min(1).max(128).optional(),
}).strict();

export const fixLoopWorkerSchema = z.object({
  id: z.uuid(),
  spaceId: z.string().regex(/^[0-9a-f]{12}$/),
  parentSessionId: z.string().regex(/^ses_[A-Za-z0-9]+$/),
  directory: z.string().min(1),
  model: fixLoopWorkerModelSchema,
  sessionId: z.string().regex(/^ses_[A-Za-z0-9]+$/).nullable(),
  spacePath: z.string().min(1).nullable(),
}).strict();

export type FixLoopWorker = z.infer<typeof fixLoopWorkerSchema>;
export type FixLoopWorkerModel = z.infer<typeof fixLoopWorkerModelSchema>;

/** Reviewed model-only protocols of the protected Spaces profile. The host rechecks every grant. */
export const APPROVAL_WORKER_PROVIDERS = ['openai', 'anthropic', 'github-copilot'];

export const isFixLoopWorkerReady = (
  worker: FixLoopWorker | null,
  entry: SpaceEntry | undefined,
  target: { readonly sessionId: string; readonly directory: string },
): boolean => {
  if (!worker || worker.parentSessionId !== target.sessionId || worker.directory !== target.directory
    || !entry || entry.id !== worker.spaceId || entry.purpose !== 'pr-fix-loop-approval'
    || entry.approvalModel?.providerID !== worker.model.providerID || entry.approvalModel?.modelID !== worker.model.modelID
    || entry.state !== 'running' || entry.damage !== null || entry.access !== 'granted'
    || entry.network?.mode !== 'allowlist' || entry.network.domains.length !== 0
    || !APPROVAL_WORKER_PROVIDERS.includes(worker.model.providerID)) return false;
  const grant = providerGrantOf(entry.grants, worker.model.providerID);
  return Boolean(grant && (grant.kind === 'model' || grant.kind === 'login') && !entry.needsAccess.includes(grant.id));
};

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const coordinateSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/).refine((value) => value !== '.' && value !== '..');
export const fixLoopApprovalSchema = z.object({
  id: z.uuid(),
  commit: commitSchema,
  localRef: z.string().regex(/^refs\/heads\/openchamber-approval\/[0-9a-f-]{36}$/),
  repositoryId: z.string().min(1),
  destination: z.object({
    headRepo: z.object({ id: z.string().min(1), owner: coordinateSchema, repo: coordinateSchema }).strict(),
    ref: z.string().startsWith('refs/heads/').min('refs/heads/'.length + 1),
    expectedHead: commitSchema,
  }).strict(),
  createdAt: z.number().nonnegative(),
  changedPaths: z.number().int().nonnegative(),
  changedBytes: z.number().nonnegative(),
}).strict().refine((receipt) => receipt.localRef === `refs/heads/openchamber-approval/${receipt.id}`);

export type FixLoopApproval = z.infer<typeof fixLoopApprovalSchema>;

const reviewBodySchema = z.string().min(1).max(4_000).refine((body) => body.trim().length > 0);
const reviewActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thread'), id: z.string().min(1).max(256), body: reviewBodySchema, resolve: z.boolean() }).strict(),
  z.object({ kind: z.literal('review'), id: z.number().int().positive(), body: reviewBodySchema }).strict(),
  z.object({ kind: z.literal('comment'), id: z.number().int().positive(), body: reviewBodySchema }).strict(),
]).readonly();
const reviewSchema = z.object({
  state: z.enum(['awaitingPublication', 'pending', 'blocked', 'complete']),
  actions: z.array(reviewActionSchema).max(200).readonly(),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().max(400),
  lastError: z.string().nullable(),
}).strict().refine((review) => review.completed <= review.total)
  .refine((review) => review.total === review.actions.reduce((total, action) => total + (action.kind === 'thread' && action.resolve ? 2 : 1), 0))
  .refine((review) => new Set(review.actions.map((action) => `${action.kind}:${action.id}`)).size === review.actions.length).readonly();

export const fixLoopSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  directory: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  branch: z.string().min(1),
  status: z.enum(['watching', 'working', 'waitingForPush', 'ready', 'stopped', 'closed', 'limitReached', 'budgetReached', 'error']),
  statusReason: z.string().nullable(),
  config: fixLoopConfigSchema,
  iterations: z.number().int().nonnegative(),
  tokensUsed: z.number().nonnegative(),
  ci: z.object({ state: z.enum(['success', 'failure', 'pending', 'unknown']), headSha: z.string() }).nullable(),
  unresolvedThreads: z.number().int().nonnegative().nullable(),
  changesRequested: z.boolean().nullable(),
  // Only omission is compatible with legacy records. Malformed authority must fail parsing.
  worker: fixLoopWorkerSchema.nullable().default(null),
  pendingApproval: fixLoopApprovalSchema.nullable().default(null),
  review: reviewSchema.nullable().default(null),
  lastCheckedAt: z.number().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).refine((loop) => loop.config.pushMode === 'approval' || (loop.worker === null && loop.pendingApproval === null))
  .refine((loop) => loop.worker === null || (loop.worker.parentSessionId === loop.sessionId && loop.worker.directory === loop.directory));

export type FixLoop = z.infer<typeof fixLoopSchema>;

const reviewLocksConfig = { awaitingPublication: false, pending: true, blocked: true, complete: false } as const;
export const isFixLoopConfigLocked = (loop: Pick<FixLoop, 'pendingApproval' | 'review'>): boolean => (
  loop.pendingApproval !== null || (loop.review !== null && reviewLocksConfig[loop.review.state])
);

export const prFixLoopUpdatedEventSchema = z.object({
  type: z.literal('openchamber:pr-fix-loop.updated'),
  properties: z.union([
    z.object({ loop: fixLoopSchema }),
    z.object({ id: z.string().min(1), removed: z.literal(true) }),
  ]),
});

export type PrFixLoopUpdatedEvent = z.infer<typeof prFixLoopUpdatedEventSchema>;

export const isFixLoopActive = (loop: Pick<FixLoop, 'status'>): boolean => (
  loop.status === 'watching' || loop.status === 'working' || loop.status === 'waitingForPush'
);

export type FixLoopPull = Pick<FixLoop, 'owner' | 'repo' | 'number'>;

export const isFixLoopForPull = (loop: FixLoop, pull: FixLoopPull, sessionId: string | null): boolean => (
  loop.sessionId === sessionId && loop.number === pull.number
  && loop.owner.toLowerCase() === pull.owner.toLowerCase()
  && loop.repo.toLowerCase() === pull.repo.toLowerCase()
);

export const parseFixLoopAuthors = (value: string): string[] => [...new Set(
  value.split(/[,\s]+/).map((login) => login.replace(/^@/, '').trim()).filter(Boolean),
)];
