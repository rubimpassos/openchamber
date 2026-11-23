import type { ProviderMutationContext, ProviderSession, ResolvedMutationTarget } from '../source-control/provider-contract.js';
import type { MutationRecord } from '../source-control/mutation-storage.js';

export type ResolveInput = {
  readonly session: ProviderSession;
  readonly context: ProviderMutationContext;
  readonly kind: string;
  readonly input: { readonly remote?: string; readonly headRemote?: string };
  readonly replayOf?: MutationRecord & { readonly target: ResolvedMutationTarget };
};
