import type { createFixLoopRuntime } from '../pr-fix-loop/runtime.js';
import type { LoopIdentity } from '../pr-fix-loop/contracts.js';
import type { ProviderReadContext } from './provider-contract.js';

export type FixLoopRouteRuntime = Pick<ReturnType<typeof createFixLoopRuntime>, 'create' | 'prepareWorker'
  | 'list' | 'listPreparedWorkers' | 'forgetPreparedWorker' | 'update' | 'stopLoop' | 'refresh' | 'resume' | 'approve' | 'remove'>;

export interface FixLoopPullRequest {
  readonly context: ProviderReadContext;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export interface FixLoopReviewRequest {
  readonly loop: Pick<LoopIdentity, 'readContext' | 'owner' | 'repo' | 'number'>;
  readonly receipt: { readonly commit: string; readonly destination: { readonly ref: string } };
  readonly operation: { readonly idempotencyKey: string } & (
    { readonly kind: 'thread-reply'; readonly threadId: string; readonly body: string }
    | { readonly kind: 'thread-resolve'; readonly threadId: string }
    | { readonly kind: 'comment'; readonly body: string }
  );
  readonly replayOnly?: boolean;
}
