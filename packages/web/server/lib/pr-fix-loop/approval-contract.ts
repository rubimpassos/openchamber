import { z } from 'zod';

export const approvalError = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });
export const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const coordinate = z.string().regex(/^[A-Za-z0-9_.-]+$/).refine((value) => value !== '.' && value !== '..');
export const headRepositorySchema = z.object({ id: z.string().min(1), owner: coordinate, repo: coordinate }).strict();
const branchSchema = z.string().min(1).max(1024).refine((value) => !value.startsWith('-') && !value.endsWith('.')
  && value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'))
  && !/[\s~^:?*[\\]/.test(value) && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  && !value.includes('..') && !value.includes('@{'));
export const workerModelSchema = z.object({
  providerID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  modelID: z.string().min(1).max(256),
  variant: z.string().min(1).max(128).optional(),
}).strict();
export const workerSchema = z.object({
  id: z.string().uuid(), spaceId: z.string().regex(/^[0-9a-f]{12}$/),
  parentSessionId: z.string().regex(/^ses_[A-Za-z0-9]+$/), directory: z.string().min(1),
  model: workerModelSchema, sessionId: z.string().regex(/^ses_[A-Za-z0-9]+$/).nullable(),
  spacePath: z.string().min(1).nullable(),
}).strict();
const destinationSchema = z.object({
  headRepo: headRepositorySchema,
  ref: branchSchema.transform((branch) => `refs/heads/${branch}`),
  expectedHead: commitSchema,
});
const headSnapshotSchema = z.object({ headRepo: z.unknown(), branch: z.unknown(), headSha: z.unknown() });
export const destinationOf = (snapshot: unknown) => {
  const input = headSnapshotSchema.safeParse(snapshot);
  const parsed = destinationSchema.safeParse(input.success
    ? { headRepo: input.data.headRepo, ref: input.data.branch, expectedHead: input.data.headSha } : null);
  if (!parsed.success) throw approvalError('GitHub did not provide a publishable PR head repository, ref and commit.');
  return parsed.data;
};
export const sameDestination = (left: Destination, right: Destination) => left.ref === right.ref
  && left.headRepo.id === right.headRepo.id
  && left.headRepo.owner.toLowerCase() === right.headRepo.owner.toLowerCase()
  && left.headRepo.repo.toLowerCase() === right.headRepo.repo.toLowerCase();
export const receiptSchema = z.object({
  id: z.string().uuid(), commit: commitSchema, localRef: z.string().regex(/^refs\/heads\/openchamber-approval\/[0-9a-f-]{36}$/),
  repositoryId: z.string().min(1),
  destination: z.object({ headRepo: headRepositorySchema, ref: z.string().startsWith('refs/heads/'), expectedHead: commitSchema }).strict(),
  createdAt: z.number().nonnegative(), changedPaths: z.number().int().nonnegative(), changedBytes: z.number().nonnegative(),
}).strict();

export type WorkerModel = z.infer<typeof workerModelSchema>;
export type Worker = z.infer<typeof workerSchema>;
export type Destination = z.infer<typeof destinationSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
