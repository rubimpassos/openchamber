import { expect, expectTypeOf, it } from 'vitest';
import { createGitHubAdapter } from './github.js';
import { BotServiceError } from './contracts.js';
import type { BotOperationInput } from './contracts.js';
import type { BotGitPublishOptions } from './git.js';
import type { ProviderRequest } from './http.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const target = { repositoryId: 'repo-one', owner: 'acme', repo: 'example' };
const adapter = (request: BotGitPublishOptions['credential']['request']) => createGitHubAdapter({
  definition: { kind: 'github-account', label: 'Fixture', accountId: 'account-one', credentialRevision: 1 },
  gitToken: 'synthetic-token', assertCurrent: async () => {}, request,
}, target, { ownedBranch: 'bot/item-one', publishGit: async () => ({ headSha: HEAD, sourceHeadSha: HEAD }) });
const pull = { number: 17, node_id: 'pull-node', state: 'open',
  head: { sha: HEAD, ref: 'bot/item-one', repo: { full_name: 'acme/example' } },
  base: { ref: 'main', repo: { full_name: 'acme/example' } } };
const authorization = (active: boolean) => ({ data: { node: { id: 'pull-node', number: 17,
  headRefName: 'bot/item-one', baseRefName: 'main', headRefOid: HEAD, baseRefOid: BASE, merged: false,
  headRepository: { nameWithOwner: 'acme/example' }, baseRepository: { nameWithOwner: 'acme/example' },
  autoMergeRequest: active ? { enabledAt: 'now' } : null, mergeQueueEntry: active ? { id: 'queue-entry' } : null,
} } });

it.each(['pr.disable-auto-merge', 'pr.dequeue'] as const)('confirms %s after revocation when the current head is read', async (operation: 'pr.disable-auto-merge' | 'pr.dequeue') => {
  // Given an active authorization on the exact owned PR.
  let active = true;
  const writes: ProviderRequest[] = [];
  const provider = adapter(async (request) => {
    if (request.path !== '/graphql') return pull;
    if (!request.readOnly) { writes.push(request); active = false; return { data: {} }; }
    return authorization(active);
  });
  // When revoking, the captured operation carries no stale head constraint.
  const receipt = await provider.perform(operation, { number: 17, branch: 'bot/item-one' });
  // Then the receipt confirms the observed head and one exact node mutation.
  expect(receipt).toEqual({ number: 17, headSha: HEAD, merged: false });
  expect(writes).toHaveLength(1);
  expect(writes[0]?.body).toMatchObject({ variables: { id: 'pull-node' } });
});

it.each(['pr.disable-auto-merge', 'pr.dequeue'] as const)('keeps %s unknown without resending when authorization remains active', async (operation: 'pr.disable-auto-merge' | 'pr.dequeue') => {
  // Given an active authorization during read-only recovery.
  const writes: ProviderRequest[] = [];
  const provider = adapter(async (request) => {
    if (request.path !== '/graphql') return pull;
    if (!request.readOnly) writes.push(request);
    return authorization(true);
  });
  // When reconciling the original operation.
  const receipt = await provider.reconcile(operation, { number: 17, branch: 'bot/item-one' });
  // Then active authorization remains unknown and no mutation is dispatched.
  expect(receipt).toEqual({ state: 'outcome-unknown' });
  expect(writes).toEqual([]);
});

it('returns an absent branch only when GitHub authoritatively reports it missing', async () => {
  // Given the credential transport's classified 404.
  const provider = adapter(async () => { throw new BotServiceError('BOT_SERVICE_REJECTED', 'Missing', 'needs-you', 404); });
  // When reading a publication branch that may not exist yet.
  const result = await provider.read('github.branch', { branch: 'bot/item-one' });
  // Then absence is authoritative.
  expect(result).toEqual({ headSha: null });
});

it('propagates denied branch reads without treating them as absence', async () => {
  // Given a provider permission refusal.
  const denied = new BotServiceError('BOT_SERVICE_AUTH_REQUIRED', 'Denied', 'needs-you', 403);
  const provider = adapter(async () => { throw denied; });
  // When reading the branch.
  const result = provider.read('github.branch', { branch: 'bot/item-one' });
  // Then a failed read stays a failure.
  await expect(result).rejects.toBe(denied);
});

it('pairs dispatch inputs with their operation at the composition boundary', () => {
  // Given the adapter contract consumed by services.js.
  type Provider = ReturnType<typeof createGitHubAdapter>;
  // When checking a mismatched operation/input pair and the publication input.
  type WrongCall = ['pr.comment', BotOperationInput<'pr.open'>];
  // Then the former is rejected and publication retains the registry shape.
  expectTypeOf<WrongCall>().not.toExtend<Parameters<Provider['perform']>>();
  expectTypeOf<BotGitPublishOptions['input']>().toEqualTypeOf<BotOperationInput<'git.push'>>();
});
