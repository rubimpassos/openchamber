import { z } from 'zod';
import type { SourceControlReadContext } from '@/lib/api/types';
import { runtimeFetch, type RuntimeFetchOptions } from '@/lib/runtime-fetch';
import { fixLoopSchema, fixLoopWorkerSchema, type FixLoop, type FixLoopConfig, type FixLoopPull, type FixLoopWorkerModel } from './prFixLoop';

const ROOT = '/api/source-control/github/pr/fix-loops';
const snapshotSchema = z.object({ loops: z.array(z.unknown()) }).transform(({ loops }, context) => {
  const accepted: FixLoop[] = [];
  const rejectedIds: string[] = [];
  const ids = new Set<string>();
  for (const raw of loops) {
    const parsed = fixLoopSchema.safeParse(raw);
    const identity = z.object({ id: z.string().min(1) }).safeParse(raw);
    if (!identity.success || ids.has(identity.data.id)) {
      context.addIssue({ code: 'custom', message: 'Fix-loop identities must be valid and unique.' });
      return z.NEVER;
    }
    ids.add(identity.data.id);
    if (parsed.success) accepted.push(parsed.data);
    else rejectedIds.push(identity.data.id);
  }
  return { loops: accepted, rejectedIds };
});
const loopResponseSchema = z.object({ loop: fixLoopSchema });
const workerResponseSchema = z.object({ worker: fixLoopWorkerSchema });
const errorSchema = z.object({ error: z.string(), code: z.string().optional() });

class PrFixLoopRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = 'PrFixLoopRequestError';
  }
}

export type PrFixLoopTarget = FixLoopPull & {
  readonly sessionId: string;
  readonly context: SourceControlReadContext;
};

export type CreatePrFixLoop = PrFixLoopTarget & (
  | { readonly config: Partial<FixLoopConfig> & { pushMode: 'approval' }; readonly workerId: string }
  | { readonly config: Partial<FixLoopConfig> & { pushMode?: 'auto' }; readonly workerId?: never }
);

type PreparePrFixLoopWorker = PrFixLoopTarget & {
  readonly name: string;
  readonly placeId: string;
  readonly model: FixLoopWorkerModel;
};

const request = async <T>(schema: z.ZodType<T>, path: string, options?: RuntimeFetchOptions): Promise<T> => {
  const response = await runtimeFetch(path, { ...options, signal: options?.signal ?? AbortSignal.timeout(15_000) });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = errorSchema.safeParse(payload);
    throw new PrFixLoopRequestError(response.status, error.success ? error.data.error : response.statusText, error.success ? error.data.code : undefined);
  }
  return schema.parse(payload);
};

const json = (method: 'POST' | 'PATCH', body?: { config: Partial<FixLoopConfig> } | { receiptId: string }): RuntimeFetchOptions => (body
  ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  : { method });

const queryOf = (context: SourceControlReadContext) => ({
  directory: context.directory, instance: context.instance, repositoryId: context.repositoryId,
  accountId: context.accountId, bindingRevision: context.bindingRevision, primaryRemote: context.primaryRemote,
});

export const prFixLoopApi = {
  async list() {
    return request(snapshotSchema, ROOT);
  },
  async create({ context, sessionId, owner, repo, number, config, workerId }: CreatePrFixLoop) {
    return (await request(loopResponseSchema, ROOT, {
      method: 'POST', query: queryOf(context),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, owner, repo, number, config, workerId }),
    })).loop;
  },
  async prepareWorker({ context, ...body }: PreparePrFixLoopWorker) {
    return (await request(workerResponseSchema, `${ROOT}/workers`, {
      method: 'POST', query: queryOf(context), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).worker;
  },
  async listWorkers(signal?: AbortSignal) {
    return (await request(z.object({ workers: z.array(fixLoopWorkerSchema) }), `${ROOT}/workers`, { signal })).workers;
  },
  async forgetWorker(id: string) {
    await request(z.object({ ok: z.literal(true) }), `${ROOT}/workers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  async update(id: string, config: Partial<FixLoopConfig>) {
    return (await request(loopResponseSchema, `${ROOT}/${encodeURIComponent(id)}`, json('PATCH', { config }))).loop;
  },
  async stop(id: string) {
    return (await request(loopResponseSchema, `${ROOT}/${encodeURIComponent(id)}/stop`, json('POST'))).loop;
  },
  async resume(id: string) {
    return (await request(loopResponseSchema, `${ROOT}/${encodeURIComponent(id)}/resume`, json('POST'))).loop;
  },
  async approve(id: string, receiptId: string) {
    return (await request(loopResponseSchema, `${ROOT}/${encodeURIComponent(id)}/approve`, json('POST', { receiptId }))).loop;
  },
  async dismiss(id: string) {
    await request(z.object({ ok: z.literal(true) }), `${ROOT}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};

export type PrFixLoopAPI = typeof prFixLoopApi;
