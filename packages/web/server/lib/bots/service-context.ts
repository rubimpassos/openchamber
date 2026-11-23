import { z } from 'zod';
import { resolvePrivateRepositoryIdentity } from '../source-control/repository-identity.js';
import { parseGitHubRemoteUrl } from '../github/repo/index.js';
import { createCredentialResolver } from './services/credentials.js';
import { createJiraOAuthHttp, createProviderHttp } from './services/http.js';
import { BotServiceError, discordTarget, githubTarget, jiraTarget, operations, providerResult, text } from './services/contracts.js';
import type { BotDefinition } from './config.js';
import type { BotItem } from './schema.js';
import type { createBotIdentityStore } from './identities.js';
import type { BotOperation, BotService } from './services/contracts.js';
import type { CredentialResolverInput, ResolvedBotCredential } from './services/credentials.js';
import type { ProviderHttpOptions } from './services/http.js';
import type { BotServiceReadResult } from './services.js';

const transitionsSchema = z.array(z.object({ id: text, to: z.object({ id: z.string().regex(/^[1-9][0-9]*$/) }) }));
type IdentityBinding = Pick<CredentialResolverInput, 'identityId' | 'identityRevision'>;
type ServiceBinding<Target> = IdentityBinding & { readonly target: Target };
export type GitHubBinding = ServiceBinding<z.output<typeof githubTarget>>;
export type ContextRequest = {
  readonly project: { readonly id: string; readonly path: string };
  readonly bot: BotDefinition;
  readonly item: Pick<BotItem, 'id' | 'botId' | 'source'>;
};
export type GitHubRequest = Pick<ContextRequest, 'project'> & (
  | { readonly bot: BotDefinition; readonly binding?: (IdentityBinding & { readonly target?: GitHubBinding['target'] }) | null }
  | { readonly bot?: never; readonly binding: IdentityBinding & { readonly target?: GitHubBinding['target'] } }
);
export type BotServiceContextOptions = Pick<ProviderHttpOptions, 'fetchImpl' | 'policyOptions'> & {
  readonly identities: Pick<ReturnType<typeof createBotIdentityStore>, 'resolve' | 'list' | 'readGitHubAccount'>;
  readonly services: { readonly read: (request: ServiceBinding<z.output<typeof jiraTarget>> & {
    readonly operation: 'jira.transitions';
  }) => Promise<BotServiceReadResult> };
  readonly resolveDiscordTarget?: ((request: ContextRequest) => z.input<typeof discordTarget> | Promise<z.input<typeof discordTarget>>) | undefined;
};
export type ServiceContext = {
  github?: GitHubBinding;
  jira?: ServiceBinding<z.output<typeof jiraTarget>> & { readonly expectedStatusId?: string };
  discord?: ServiceBinding<z.output<typeof discordTarget>>;
};
export type BotBindingContext = {
  readonly github: (request: GitHubRequest) => Promise<{ readonly binding: GitHubBinding }>;
  readonly serviceContext: (request: ContextRequest & { readonly service: BotService; readonly operation: string }) => Promise<ServiceContext>;
};
const operationContracts: Readonly<Partial<Record<string, (typeof operations)[BotOperation]>>> = operations;
function refuse(code: string): never { throw new BotServiceError(code, 'Repair the exact bot identity or service destination.'); }
const scopeSchema = z.object({ service: z.enum(['github', 'jira', 'discord']), operation: text })
  .refine(({ service, operation }) => operationContracts[operation]?.service === service || operation.startsWith(`${service}.`));

export function createBotServiceContext({ identities, services, fetchImpl, policyOptions, resolveDiscordTarget }: BotServiceContextOptions) {
  if (!identities?.resolve || !identities?.list || !services?.read) throw new TypeError('Bot context requires identities and services');
  const resolve = createCredentialResolver({ identities, http: createProviderHttp({ fetchImpl, policyOptions }),
    jiraOAuthHttp: createJiraOAuthHttp({ fetchImpl, policyOptions }) });
  const identityFor = async (selection: NonNullable<BotDefinition['identity'][BotService]>, service: BotService): Promise<IdentityBinding> => {
    const inventory = await identities.list();
    const matches = service === 'github' && 'kind' in selection && selection.kind === 'account'
      ? inventory.filter((entry) => entry.kind === 'github-account' && entry.accountId === selection.accountId)
      : inventory.filter((entry) => 'identityId' in selection && entry.id === selection.identityId);
    const match = matches[0];
    if (matches.length !== 1 || !match) refuse('BOT_IDENTITY_REQUIRED');
    const identity = await identities.resolve(match.id, match.revision);
    if (!identity.definition.kind.startsWith(`${service}-`)
      || service === 'github' && ('kind' in selection && selection.kind === 'app') !== (identity.definition.kind === 'github-app')) refuse('BOT_IDENTITY_REQUIRED');
    return { identityId: identity.id, identityRevision: identity.revision };
  };
  const repository = async (project: ContextRequest['project']) => {
    const current = await resolvePrivateRepositoryIdentity(project.path);
    if (!current.supported || current.bare) refuse('BOT_REPOSITORY_REQUIRED');
    const candidates = current.remotes.flatMap((remote) => {
      const parsed = parseGitHubRemoteUrl(remote.fetch.rawUrl);
      if (!parsed || remote.fetch.rawUrl === undefined) return [];
      const normalized = remote.fetch.rawUrl.replace(/^git@github.com:/, 'https://github.com/').replace(/^ssh:\/\/git@github.com\//, 'https://github.com/');
      const url = new URL(normalized);
      if (url.username || url.password || url.search || url.hash || url.port
        || !['https:', 'ssh:'].includes(url.protocol)
        || url.pathname.replace(/\.git$/, '') !== `/${parsed.owner}/${parsed.repo}`) return [];
      return [{ remote: remote.name, ...githubTarget.parse({ repositoryId: current.repositoryId, owner: parsed.owner, repo: parsed.repo }) }];
    });
    const selected = candidates.find((entry) => entry.remote === 'origin') ?? (candidates.length === 1 ? candidates[0] : null);
    if (!selected) refuse('BOT_REPOSITORY_AMBIGUOUS');
    const { remote, ...target } = selected;
    return { target, remote };
  };
  const github = async ({ project, bot, binding }: GitHubRequest): Promise<{
    readonly binding: GitHubBinding; readonly credential: ResolvedBotCredential<'github'>;
  }> => {
    const { target } = await repository(project);
    const selected = binding ?? (bot?.identity?.github ? await identityFor(bot.identity.github, 'github') : null);
    if (!selected) refuse('BOT_IDENTITY_REQUIRED');
    if (binding?.target && JSON.stringify(binding.target) !== JSON.stringify(target)) refuse('BOT_DESTINATION_CHANGED');
    const credential = await resolve({ ...selected, service: 'github', target });
    return { binding: { identityId: selected.identityId, identityRevision: selected.identityRevision, target }, credential };
  };
  const author = async (request: GitHubRequest) => {
    const { credential } = await github(request);
    const id = credential.authority.providerAccountId.match(/^github\.com#([1-9][0-9]*)$/)?.[1];
    if (!id || !credential.username) refuse('BOT_GIT_AUTHOR_REQUIRED');
    return { name: credential.username, email: `${id}+${credential.username}@users.noreply.github.com` };
  };
  const serviceContext = async ({ project, bot, item, service, operation }: ContextRequest & {
    readonly service: BotService; readonly operation: string;
  }): Promise<ServiceContext> => {
    scopeSchema.parse({ service, operation });
    const result: ServiceContext = {};
    if (service === 'github' && bot.identity?.github) result.github = (await github({ project, bot })).binding;
    if (service === 'jira' && bot.identity?.jira && item.source.kind === 'jira') {
      const identity = await identityFor(bot.identity.jira, 'jira');
      const issueKey = item.source.id;
      const target = jiraTarget.parse({ issueKey, projectKey: issueKey.replace(/-[1-9][0-9]*$/, '') });
      result.jira = { ...identity, target };
      if (operation === 'jira.transition' && bot.jira?.doneTransition) {
        const transitions = await services.read({ ...identity, target, operation: 'jira.transitions' });
        const jira = bot.jira;
        const transition = providerResult(transitionsSchema.safeParse(transitions))
          .find((entry) => entry.id === jira.doneTransition);
        if (!transition) refuse('BOT_JIRA_TRANSITION_UNAVAILABLE');
        result.jira = { ...result.jira, expectedStatusId: transition.to.id };
      }
    }
    if (service === 'discord' && bot.identity?.discord) {
      if (!resolveDiscordTarget) refuse('BOT_DISCORD_DESTINATION_REQUIRED');
      result.discord = { ...await identityFor(bot.identity.discord, 'discord'), target: discordTarget.parse(await resolveDiscordTarget({ project, bot, item })) };
    }
    return result;
  };
  return Object.freeze({ serviceContext, github, repository, author });
}
