import { createPrivateKey, sign } from 'node:crypto';
import { z } from 'zod';
import { BotServiceError, jiraOrigin, providerResult as parse, revision, snowflake, text } from './contracts.js';
import { createJiraOAuthRequest } from './jira-oauth.js';
import type { BotIdentityDefinition, createBotIdentityStore } from '../identities.js';
import type { BotOperationTarget, BotService, BotServiceAuthority } from './contracts.js';
import type { JiraOAuthHttp, ProviderHttp, ProviderRequest } from './http.js';

export type CredentialResolverOptions = {
  readonly identities: Pick<ReturnType<typeof createBotIdentityStore>, 'resolve' | 'readGitHubAccount'>;
  readonly http: ProviderHttp;
  readonly jiraOAuthHttp?: JiraOAuthHttp | undefined;
  readonly now?: () => number;
};
type CredentialTargets = {
  readonly github: BotOperationTarget<'git.push'>;
  readonly jira: { readonly projectKey?: string; readonly issueKey?: string };
  readonly discord: Pick<BotOperationTarget<'discord.send'>, 'guildId' | 'channelId' | 'recipientId'>;
};
export type CredentialResolverInput<Service extends BotService = BotService> = {
  readonly [Key in Service]: {
    readonly identityId: string;
    readonly identityRevision: number;
    readonly service: Key;
    readonly target: CredentialTargets[Key];
  };
}[Service];
export type ResolvedBotCredential<Service extends BotService = BotService> = {
  readonly authority: BotServiceAuthority & { readonly service: Service };
  readonly definition: Extract<BotIdentityDefinition, { readonly kind: `${Service}-${string}` }>;
  readonly username: Service extends 'github' ? string : undefined;
  readonly gitToken: Service extends 'github' ? string : undefined;
  readonly assertCurrent: () => Promise<void>;
  readonly request: (input: ProviderRequest) => ReturnType<ProviderHttp>;
};

const githubUser = z.object({ id: revision, login: text });
const tokenSchema = z.object({ token: text, expires_at: z.string().datetime(),
  repositories: z.array(z.object({ full_name: text })).optional() });
const unavailable = () => new BotServiceError('BOT_IDENTITY_UNAVAILABLE', 'Reconnect or select the exact bot identity.');

export function createCredentialResolver({ identities, http, jiraOAuthHttp, now = Date.now }: CredentialResolverOptions) {
  function resolve(input: CredentialResolverInput<'github'>): Promise<ResolvedBotCredential<'github'>>;
  function resolve(input: CredentialResolverInput<'jira'>): Promise<ResolvedBotCredential<'jira'>>;
  function resolve(input: CredentialResolverInput<'discord'>): Promise<ResolvedBotCredential<'discord'>>;
  function resolve(input: CredentialResolverInput): Promise<ResolvedBotCredential>;
  async function resolve({ identityId, identityRevision, service, target }: CredentialResolverInput): Promise<ResolvedBotCredential> {
    const identity = await identities.resolve(identityId, identityRevision);
    const definition = identity.definition;
    if (!definition.kind.startsWith(`${service}-`)) throw unavailable();
    const beforeWrite = async () => {
      await identities.resolve(identityId, identityRevision);
      if (definition.kind === 'github-account') {
        const current = await identities.readGitHubAccount(definition.accountId, definition.credentialRevision);
        if (!current || current.credentialId !== definition.accountId
          || current.credentialRevision !== definition.credentialRevision) throw unavailable();
      }
    };
    let origin;
    let authorization: string | undefined;
    let providerAccountId;
    let credentialId = identityId;
    let credentialRevision = identityRevision;
    let username;
    let gitToken;
    let request: ResolvedBotCredential['request'] | undefined;
    const resource = service === 'github' ? `${target.owner}/${target.repo}`
      : service === 'jira' ? target.projectKey ?? 'jira.search' : `${target.guildId}/${target.channelId}`;
    const repository = service === 'github' ? target.repo : undefined;
    switch (definition.kind) {
    case 'github-account': {
      const account = await identities.readGitHubAccount(definition.accountId, definition.credentialRevision);
      if (!account || account.credentialId !== definition.accountId
        || account.credentialRevision !== definition.credentialRevision
        || account.status !== 'valid' || !account.accessToken) throw unavailable();
      origin = 'https://api.github.com';
      authorization = `Bearer ${account.accessToken}`;
      const user = parse(githubUser.safeParse(await http({ service, origin, resource, path: '/user', authorization })));
      providerAccountId = `github.com#${user.id}`;
      if (account.providerUserId !== providerAccountId) throw unavailable();
      credentialId = account.credentialId;
      credentialRevision = account.credentialRevision;
      username = user.login;
      gitToken = account.accessToken;
      break;
    }
    case 'github-app': {
      origin = 'https://api.github.com';
      const seconds = Math.floor(now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: definition.appId })).toString('base64url');
      let signature;
      try { signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPrivateKey(definition.privateKey)).toString('base64url'); }
      catch { throw unavailable(); }
      const jwt = `Bearer ${header}.${payload}.${signature}`;
      const app = parse(z.object({ id: revision, slug: z.string().regex(/^[A-Za-z0-9_-]+$/) }).safeParse(
        await http({ service, origin, resource, path: '/app', authorization: jwt })));
      if (String(app.id) !== definition.appId) throw unavailable();
      const installation = parse(z.object({ id: revision, app_id: revision, suspended_at: z.string().nullable() }).safeParse(
        await http({ service, origin, resource, path: `/app/installations/${definition.installationId}`, authorization: jwt })));
      if (String(installation.id) !== definition.installationId || String(installation.app_id) !== definition.appId
        || installation.suspended_at !== null) throw unavailable();
      const token = parse(tokenSchema.safeParse(await http({ service, origin, resource,
        path: `/app/installations/${definition.installationId}/access_tokens`, method: 'POST', authorization: jwt,
        body: { repositories: [repository], permissions: { contents: 'write', pull_requests: 'write', issues: 'write', administration: 'read' } }, beforeWrite,
      })));
      if (Date.parse(token.expires_at) <= now() + 30_000
        || token.repositories && (token.repositories.length !== 1
           || token.repositories[0]?.full_name.toLowerCase() !== resource.toLowerCase())) throw unavailable();
      authorization = `Bearer ${token.token}`;
      gitToken = token.token;
      const bot = parse(githubUser.extend({ type: z.literal('Bot') }).safeParse(await http({
        service, origin, resource, path: `/users/${encodeURIComponent(`${app.slug}[bot]`)}`, authorization,
      })));
      if (bot.login.toLowerCase() !== `${app.slug}[bot]`.toLowerCase()) throw unavailable();
      providerAccountId = `github.com#${bot.id}`;
      username = bot.login;
      break;
    }
    case 'jira-account':
    case 'jira-service':
    case 'jira-oauth': {
      origin = jiraOrigin(definition.site);
      if (definition.kind === 'jira-oauth') request = await createJiraOAuthRequest({ definition, http: jiraOAuthHttp, resource, assertCurrent: beforeWrite, now });
      else authorization = `Basic ${Buffer.from(`${definition.email}:${definition.apiToken}`).toString('base64')}`;
      const user = parse(z.object({ accountId: text, active: z.literal(true) }).safeParse(
        await (request ? request({ path: '/rest/api/3/myself' }) : http({ service, origin, resource, path: '/rest/api/3/myself', authorization }))));
      providerAccountId = user.accountId;
      if (providerAccountId === 'unknown') throw unavailable();
      break;
    }
    case 'discord-app': {
      origin = 'https://discord.com';
      authorization = `Bot ${definition.botToken}`;
      const app = parse(z.object({ id: snowflake, bot: z.object({ id: snowflake, bot: z.literal(true) }) }).safeParse(
        await http({ service, origin, resource, path: '/api/v10/oauth2/applications/@me', authorization })));
      if (app.id !== definition.applicationId) throw unavailable();
      providerAccountId = app.bot.id;
      break;
    }
    default: {
      definition satisfies never;
      throw unavailable();
    }
    }
    const authority = { identityId, identityRevision, service, origin, credentialId, credentialRevision, providerAccountId };
    return {
      authority, definition, username, gitToken, assertCurrent: beforeWrite,
      request: request ?? ((input) => http({ ...input, service, origin, resource, authorization,
        beforeWrite: async () => { await input.beforeWrite?.(); await beforeWrite(); } })),
    };
  }
  return resolve;
}
