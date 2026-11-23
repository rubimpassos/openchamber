import { afterEach, expect, test } from 'bun:test';
import { createBotServiceContext } from './service-context.js';
import { productionFixture } from './production.test-support.js';
import { botGit } from './production-git.js';

let fixture;
afterEach(async () => { await fixture?.close(); fixture = null; });

test('service context resolves the chosen account and rejects ambiguous or absent identities', async () => {
  const f = fixture = await productionFixture();
  const request = { ...f.request, service: 'github', operation: 'pr.open' };
  const context = await f.context.serviceContext(request);
  expect(context.github.identityId).toBe((await f.identities.list())[0].id);
  expect(context.github.target).toMatchObject({ owner: 'acme', repo: 'app' });
  await f.identities.create({ kind: 'github-account', accountId: 'selected-account', credentialRevision: 1, label: 'Duplicate' });
  await expect(f.context.serviceContext(request)).rejects.toMatchObject({ code: 'BOT_IDENTITY_REQUIRED' });
});

test('Jira done status comes from the configured transition, and Discord needs captured server routing', async () => {
  const f = fixture = await productionFixture();
  const identity = await f.identities.create({ kind: 'jira-service', site: 'https://acme.atlassian.net', email: 'bot@example.test', apiToken: 'fixture-token', label: 'Jira' });
  const reads = [];
  const context = createBotServiceContext({ identities: f.identities, services: { read: async (request) => {
    reads.push(request);
    return [{ id: '5', to: { id: '9' } }];
  } } });
  const bot = { ...f.bot, identity: { jira: { identityId: identity.id } }, jira: { doneTransition: '5' } };
  const result = await context.serviceContext({ ...f.request, bot, item: { ...f.item, source: { kind: 'jira', id: 'ACME-42' } }, service: 'jira', operation: 'jira.transition' });
  expect(result.jira).toEqual({ identityId: identity.id, identityRevision: 1, target: { issueKey: 'ACME-42', projectKey: 'ACME' }, expectedStatusId: '9' });
  expect(reads[0].operation).toBe('jira.transitions');
  await expect(context.serviceContext({ ...f.request, bot: { identity: { discord: { identityId: 'missing' } } }, service: 'discord', operation: 'discord.send' }))
    .rejects.toMatchObject({ code: 'BOT_DISCORD_DESTINATION_REQUIRED' });
});

test('requested GitHub and ordinary Jira contexts ignore unrelated Discord routing and done transitions', async () => {
  const f = fixture = await productionFixture();
  const identity = await f.identities.create({ kind: 'jira-service', site: 'https://acme.atlassian.net', email: 'bot@example.test', apiToken: 'fixture-token', label: 'Jira' });
  let transitionReads = 0;
  let discordResolutions = 0;
  const context = createBotServiceContext({ identities: f.identities,
    fetchImpl: async () => new Response(JSON.stringify({ id: 42, login: 'selected-bot' }), { headers: { 'content-type': 'application/json' } }),
    services: { read: async () => { transitionReads++; return []; } },
    resolveDiscordTarget: async () => { discordResolutions++; throw Object.assign(new Error('Ambiguous Discord target'), { code: 'BOT_DISCORD_DESTINATION_AMBIGUOUS' }); },
  });
  const request = { ...f.request, bot: { ...f.bot,
    identity: { ...f.bot.identity, jira: { identityId: identity.id }, discord: { identityId: 'unavailable-discord' } },
    jira: { doneTransition: '5' },
  }, item: { ...f.item, source: { kind: 'jira', id: 'ACME-42' } } };
  const github = await context.serviceContext({ ...request, service: 'github', operation: 'pr.open' });
  expect(Object.keys(github)).toEqual(['github']);
  expect(github.github.target).toMatchObject({ owner: 'acme', repo: 'app' });
  for (const operation of ['jira.issue', 'jira.comments', 'jira.comment']) {
    const result = await context.serviceContext({ ...request, service: 'jira', operation });
    expect(result).toEqual({ jira: { identityId: identity.id, identityRevision: 1, target: { issueKey: 'ACME-42', projectKey: 'ACME' } } });
  }
  expect(transitionReads).toBe(0);
  expect(discordResolutions).toBe(0);
  await expect(context.serviceContext({ ...request, service: 'jira', operation: 'jira.transition' })).rejects.toMatchObject({ code: 'BOT_JIRA_TRANSITION_UNAVAILABLE' });
  expect(transitionReads).toBe(1);
  await expect(context.serviceContext({ ...request, service: 'github', operation: 'jira.transition' })).rejects.toThrow();
});

test('GitHub reuses captured identity when the current selection changes', async () => {
  // Given a captured account binding and a subsequently selected app.
  const f = fixture = await productionFixture();
  const original = await f.context.github(f.request);
  await f.selectApp();

  // When the original binding is resolved again.
  const result = await f.context.github({ ...f.request, binding: original.binding });

  // Then it retains the account authority.
  expect(result.binding).toEqual(original.binding);
  expect(result.credential.username).toBe('selected-bot');
});

test('GitHub refuses captured authority when the repository destination changes', async () => {
  // Given a binding captured before the remote changed.
  const f = fixture = await productionFixture();
  const original = await f.context.github(f.request);
  await botGit(f.directory, ['remote', 'set-url', 'origin', 'https://github.com/acme/other.git']);

  // When the captured binding is resolved, then the destination change refuses.
  await expect(f.context.github({ ...f.request, binding: original.binding }))
    .rejects.toMatchObject({ code: 'BOT_DESTINATION_CHANGED' });
});

test('GitHub author uses the selected app provider identity', async () => {
  // Given an explicitly selected app.
  const f = fixture = await productionFixture();
  await f.selectApp();

  // When author attribution is resolved.
  const author = await f.context.author(f.request);

  // Then the provider bot ID and login supply the noreply address.
  expect(author).toEqual({ name: 'selected-app[bot]', email: '43+selected-app[bot]@users.noreply.github.com' });
});

test('Discord routing receives the original project, bot and item objects', async () => {
  // Given a selected app and server-owned destination resolver.
  const f = fixture = await productionFixture();
  const identity = await f.identities.create({ kind: 'discord-app', applicationId: '123456', botToken: 'fixture-token', label: 'Discord' });
  const bot = { ...f.bot, identity: { discord: { identityId: identity.id } } };
  const requests = [];
  const context = createBotServiceContext({ identities: f.identities, services: f.services,
    resolveDiscordTarget: async (request) => { requests.push(request); return { guildId: '123456', channelId: '234567' }; } });

  // When the Discord binding is requested.
  const result = await context.serviceContext({ ...f.request, bot, service: 'discord', operation: 'discord.send' });

  // Then routing keeps request object identity and returns the captured destination.
  expect(requests[0].project).toBe(f.project);
  expect(requests[0].bot).toBe(bot);
  expect(requests[0].item).toBe(f.item);
  expect(result).toEqual({ discord: { identityId: identity.id, identityRevision: 1, target: { guildId: '123456', channelId: '234567' } } });
});

test.each([false, true])('repository selection with multiple alternatives = %s', async (multiple) => {
  // Given GitHub remotes without an origin.
  const f = fixture = await productionFixture();
  await botGit(f.directory, ['remote', 'rename', 'origin', 'upstream']);
  if (multiple) await botGit(f.directory, ['remote', 'add', 'secondary', 'https://github.com/acme/other.git']);

  // When repository authority is resolved.
  const result = f.context.repository(f.project);

  // Then only a sole candidate supplies authority.
  if (multiple) await expect(result).rejects.toMatchObject({ code: 'BOT_REPOSITORY_AMBIGUOUS' });
  else expect(await result).toMatchObject({ remote: 'upstream', target: { owner: 'acme', repo: 'app' } });
});
