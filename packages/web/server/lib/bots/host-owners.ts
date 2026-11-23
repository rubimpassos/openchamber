import { createBotIdentityStore } from './identities.js';
import { createBotServices } from './services.js';
import { createBotServiceContext } from './service-context.js';
import { createProductionBotWorktrees } from './production-worktrees.js';
import type { HostExecution, HostOptions } from './host-contracts.js';
import type { createHostAuthority } from './host-authority.js';
import type { createBotProviderRuntime } from './provider-runtime.js';
import type { createBotStore } from './store.js';

type OwnersOptions = Pick<HostOptions, 'dataDir' | 'fetchImpl' | 'policyOptions' | 'disposeInstance'> & {
  readonly execution: HostExecution | null;
  readonly store: ReturnType<typeof createBotStore>;
  readonly authority: ReturnType<typeof createHostAuthority>;
  readonly resolveDiscordTarget: ReturnType<typeof createBotProviderRuntime>['resolveDiscordTarget'];
};
export function createHostOwners({ dataDir, fetchImpl, policyOptions, disposeInstance, execution, store, authority, resolveDiscordTarget }: OwnersOptions) {
  if (execution) {
    const services = authority.guardServices(execution.services);
    const context: HostExecution['context'] = { ...execution.context,
      serviceContext: async (request) => request.service === 'discord'
        ? { discord: { ...(await execution.context.identityFor(request.bot, 'discord')), target: await resolveDiscordTarget(request) } }
        : execution.context.serviceContext(request),
    };
    return { kind: 'separated' as const, services, context, identities: execution.identities, worktrees: execution.worktrees, execution };
  }
  const identities = createBotIdentityStore({ dataDir });
  const services = createBotServices({ dataDir, identities, fetchImpl, policyOptions,
    resolvePublication: (request) => worktrees.readPublication(request),
    resolveQuestionAuthority: authority.resolveQuestionAuthority, approvedDiscordPeople: authority.approvedDiscordPeople });
  const context = createBotServiceContext({ identities, services, fetchImpl, policyOptions, resolveDiscordTarget });
  const worktrees = createProductionBotWorktrees({ dataDir, context, disposeInstance,
    readItem: async (projectId, itemId) => (await store.read(projectId)).items.find((item) => item.id === itemId) });
  return { kind: 'local' as const, services, context, identities, worktrees, execution: null };
}
