import fs from 'node:fs/promises';
import { afterEach, expect, expectTypeOf, it } from 'vitest';
import { createBotIdentityStore } from '../identities.js';
import { createCredentialResolver } from './credentials.js';
import type { CredentialResolverInput, ResolvedBotCredential } from './credentials.js';
import { createProviderHttp } from './http.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const discord = { kind: 'discord-app', label: 'Synthetic bot', applicationId: '123456', botToken: 'synthetic-token' } as const;
const target = { guildId: 'dm', channelId: '000000' } as const;
const fixture = async () => {
  const dataDir = await fs.mkdtemp('/tmp/opencode/bot-credentials-');
  directories.push(dataDir);
  const identities = createBotIdentityStore({ dataDir, readGitHubAccount: async () => null });
  const identity = await identities.create(discord);
  const requests: string[] = [];
  const http = createProviderHttp({ fetchImpl: async (url) => {
    requests.push(url);
    return Response.json({ id: discord.applicationId, bot: { id: '654321', bot: true } });
  } });
  return { identities, identity, requests, resolve: createCredentialResolver({ identities, http }) };
};

it('returns the bound Discord identity when gateway discovery has no recipient', async () => {
  // Given a private synthetic identity and an in-memory provider boundary.
  const f = await fixture();
  // When the gateway resolves its selected identity.
  const credential = await f.resolve({ identityId: f.identity.id, identityRevision: 1, service: 'discord', target });
  // Then the credential exposes the exact application and provider bot account.
  expect(credential.authority).toMatchObject({ identityId: f.identity.id, identityRevision: 1,
    credentialId: f.identity.id, credentialRevision: 1, service: 'discord', origin: 'https://discord.com', providerAccountId: '654321' });
  expect(credential.definition).toEqual(discord);
  expectTypeOf(credential.definition.botToken).toEqualTypeOf<string>();
  expectTypeOf(credential.authority.service).toEqualTypeOf<'discord'>();
  expectTypeOf(credential.gitToken).toEqualTypeOf<undefined>();
  expectTypeOf<ResolvedBotCredential<'github'>['gitToken']>().toEqualTypeOf<string>();
  expectTypeOf<CredentialResolverInput<'github'>['target']>().toEqualTypeOf<{ repositoryId: string; owner: string; repo: string }>();
});

it('refuses a different service before contacting its provider', async () => {
  // Given an identity belonging to Discord.
  const f = await fixture();
  // When Jira tries to resolve that identity.
  await expect(f.resolve({ identityId: f.identity.id, identityRevision: 1, service: 'jira', target: {} }))
    .rejects.toMatchObject({ code: 'BOT_IDENTITY_UNAVAILABLE' });
  // Then no provider request has occurred.
  expect(f.requests).toEqual([]);
});

it('refuses a write when its caller rotates the identity during admission', async () => {
  // Given a resolved credential whose caller updates the identity before writing.
  const f = await fixture();
  const credential = await f.resolve({ identityId: f.identity.id, identityRevision: 1, service: 'discord', target });
  // When the request runs its admission callback before the resolver's current-identity check.
  await expect(credential.request({ path: '/api/v10/channels/000000/messages', method: 'POST',
    beforeWrite: async () => { await f.identities.update(f.identity.id, 1, { ...discord, botToken: 'rotated-synthetic-token' }); },
  })).rejects.toMatchObject({ code: 'BOT_IDENTITY_UNAVAILABLE' });
  // Then the provider received only the initial identity read.
  expect(f.requests).toEqual(['https://discord.com/api/v10/oauth2/applications/@me']);
});

it('keeps Jira Basic authentication and the search resource when the target is empty', async () => {
  // Given a synthetic Jira identity and a transport that captures the request.
  const f = await fixture();
  const identity = await f.identities.create({ kind: 'jira-service', label: 'Synthetic Jira',
    site: 'https://fixture.atlassian.net', email: 'bot@example.com', apiToken: 'synthetic-api-token' });
  const requests: Parameters<ReturnType<typeof createProviderHttp>>[0][] = [];
  const resolve = createCredentialResolver({ identities: f.identities, http: async (input) => {
    requests.push(input);
    return { accountId: 'synthetic-jira-user', active: true };
  } });
  // When search resolves the identity without an issue destination.
  const credential = await resolve({ identityId: identity.id, identityRevision: 1, service: 'jira', target: {} });
  // Then site/resource policy authority and Basic credentials remain unchanged.
  expect(credential.authority).toMatchObject({ service: 'jira', origin: 'https://fixture.atlassian.net', providerAccountId: 'synthetic-jira-user' });
  expect(requests).toMatchObject([{ service: 'jira', origin: 'https://fixture.atlassian.net', resource: 'jira.search',
    path: '/rest/api/3/myself', authorization: `Basic ${Buffer.from('bot@example.com:synthetic-api-token').toString('base64')}` }]);
});
