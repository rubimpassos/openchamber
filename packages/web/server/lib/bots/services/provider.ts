import { assertBotWriteAllowed } from '../../enterprise-mode.js';
import { createCredentialResolver } from './credentials.js';
import { createGitHubAdapter } from './github.js';
import { createJiraAdapter } from './jira.js';
import { createDiscordAdapter } from './discord.js';
import { publishBotGit } from './git.js';
import { BotServiceError } from './contracts.js';
import type { EnterprisePolicyOptions } from '../../enterprise-mode.js';
import type { BotGitPublishOptions } from './git.js';
import type { BotParsedPayload } from './effects.js';

export type DispatchCallbacks = {
  readonly beforeAdmission?: (() => void | Promise<void>) | undefined;
  readonly beforeDispatch?: (() => void | Promise<void>) | undefined;
};
type ProviderCallbacks = Pick<DispatchCallbacks, 'beforeAdmission'> & {
  readonly beforeQuestionWrite?: (() => void | Promise<void>) | undefined;
  readonly ownedBranch?: string | undefined;
};
export type BotGitOverrides = Pick<BotGitPublishOptions, 'readSnapshot' | 'resolveRepository' | 'pushProcess'>;
export function createBotProviderResolver({ resolve, policyOptions, git }: {
  readonly resolve: ReturnType<typeof createCredentialResolver>;
  readonly policyOptions: EnterprisePolicyOptions | undefined;
  readonly git: BotGitOverrides;
}) {
  return async (payload: BotParsedPayload, identity: { readonly identityId: string; readonly identityRevision: number }, callbacks: ProviderCallbacks = {}) => {
    switch (payload.service) {
    case 'github': {
      const credential = await resolve({ ...identity, service: payload.service, target: payload.target });
      const provider = createGitHubAdapter(credential, payload.target, {
        beforeAdmission: callbacks.beforeAdmission, ownedBranch: callbacks.ownedBranch,
        publishGit: (input) => publishBotGit({ ...input, policyOptions, ...git }),
      });
      return { service: payload.service, payload, credential, provider,
        destination: { operation: payload.operation, target: payload.target, authority: credential.authority },
        perform: async () => {
          const result = await provider.perform(...payload.call);
          if (!('sourceHeadSha' in result)) return result;
          const { commitMap, ...receipt } = result;
          return commitMap === undefined ? receipt : { ...receipt, commitMap: [...commitMap] };
        },
        reconcile: () => provider.reconcile(...payload.call) };
    }
    case 'jira': {
      const credential = await resolve({ ...identity, service: payload.service, target: payload.target });
      const provider = createJiraAdapter(credential, payload.target, callbacks);
      return { service: payload.service, payload, credential, provider,
        destination: { operation: payload.operation, target: payload.target, authority: credential.authority },
        perform: () => provider.perform(...payload.call), reconcile: () => provider.reconcile(...payload.call) };
    }
    case 'discord': {
      const credential = await resolve({ ...identity, service: payload.service, target: payload.target });
      const provider = createDiscordAdapter(credential, payload.target, callbacks);
      return { service: payload.service, payload, credential, provider,
        destination: { operation: payload.operation, target: payload.target, authority: credential.authority },
        perform: () => provider.perform(...payload.call), reconcile: () => provider.reconcile() };
    }
    default: payload satisfies never; throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This bot provider is unsupported.', 'failed', 400);
    }
  };
}
export type BotResolvedProvider = Awaited<ReturnType<ReturnType<typeof createBotProviderResolver>>>;

export async function preflightProvider(context: BotResolvedProvider, options: {
  readonly hasMutation: () => Promise<boolean>;
  readonly policyOptions: EnterprisePolicyOptions | undefined;
}) {
  let origin = context.credential.authority.origin;
  let resource;
  switch (context.service) {
  case 'github': {
    const { payload, provider } = context;
    if (payload.operation === 'pr.auto-merge' && !await options.hasMutation()) {
      const pull = await provider.read('github.pull', { number: payload.input.number });
      if (pull.state !== 'open') throw new BotServiceError('BOT_GITHUB_PULL_CLOSED', 'The bot pull request is closed.');
      if (payload.input.mode === 'auto-merge' && !(await provider.read('github.rules', { branch: pull.base })).autoMergeAllowed) {
        throw new BotServiceError('BOT_GITHUB_AUTO_MERGE_DISABLED', 'Allow auto-merge in the repository settings, or merge this pull request yourself.');
      }
    }
    if (payload.operation === 'git.push') {
      const rules = await provider.read('github.rules', { branch: payload.input.base });
      const destinationRules = payload.input.localBranch === undefined ? [] : await provider.read('github.branch-rules', { branch: payload.input.branch });
      origin = rules.requiredSignatures || destinationRules.some((rule) => rule.type === 'required_signatures') ? 'https://api.github.com' : 'https://github.com';
    }
    resource = `${payload.target.owner}/${payload.target.repo}`;
    break;
  }
  case 'jira': resource = context.payload.target.projectKey; break;
  case 'discord': resource = `${context.payload.target.guildId}/${context.payload.target.channelId}`; break;
  default: context satisfies never; throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This bot provider is unsupported.', 'failed', 400);
  }
  try { assertBotWriteAllowed({ service: context.service, origin, resource }, options.policyOptions); }
  catch { throw new BotServiceError('enterprise_mode', 'Enterprise mode refuses this bot destination.', 'needs-you', 403); }
}
