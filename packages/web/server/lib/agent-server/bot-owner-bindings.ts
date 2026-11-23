import { botBoundaryError } from './bot-service-contract.js';
import type { BotServiceInput, BotServiceReply } from './bot-service-contract.js';
import type { BotDefinition } from '../bots/config.js';

export function selectIdentity(inventory: BotServiceReply<'identity-list'>, bot: BotDefinition, service: BotServiceInput<'context'>['service']) {
  const selected = bot.identity?.[service];
  if (!selected) return null;
  const matches = service === 'github' && 'kind' in selected && selected.kind === 'account'
    ? inventory.filter((entry) => entry.kind === 'github-account' && entry.accountId === selected.accountId)
    : inventory.filter((entry) => 'identityId' in selected && entry.id === selected.identityId);
  const match = matches[0];
  if (matches.length !== 1 || !match || !match.kind.startsWith(`${service}-`)
    || service === 'github' && ('kind' in selected && selected.kind === 'app') !== (match.kind === 'github-app')) throw botBoundaryError('BOT_IDENTITY_REQUIRED', 409);
  return match;
}

type OwnerBinding<Target> = { identityId: string; identityRevision: number; target: Target; expectedStatusId?: string };
export function publicBinding<Target>({ identityId, identityRevision, target, expectedStatusId }: {
  readonly identityId: string; readonly identityRevision: number; readonly target: Target; readonly expectedStatusId?: string | undefined;
}) {
  const binding: OwnerBinding<Target> = { identityId, identityRevision, target };
  if (expectedStatusId !== undefined) binding.expectedStatusId = expectedStatusId;
  return binding;
}
