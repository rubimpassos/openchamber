import { expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { BotServiceError, branch, discordTarget, effectSchema, githubTarget, jiraOrigin, jiraTarget,
  operations, parse, providerResult, questionAuthoritySchema, requestSchema } from './contracts.js';
import type { BotOperation, BotOperationInput, BotOperationInputWire, BotOperationPayload, BotOperationRequest, BotOperationTarget,
  BotServiceRequest } from './contracts.js';
import { parseBotPayload } from './effects.js';
import type { BotParsedPayload } from './effects.js';
import type { BotPreparedEffect, BotServiceExecutionResult } from '../services.js';
import type { MutationResult } from '../../source-control/mutation-storage.js';

const headSha = 'a'.repeat(40);
const policyFingerprint = 'b'.repeat(64);
const github = { repositoryId: 'repo-1', owner: 'acme', repo: 'example' };
const jira = { projectKey: 'BUG', issueKey: 'BUG-1' };
const discord = { guildId: '111111', channelId: '222222' };
const question = { body: 'Which result?', policyFingerprint, recipients: [{ personId: 'owner', serviceId: '333333' }] };
const request = { key: 'key', operation: 'pr.open', botId: 'bot', itemId: 'item', identityId: 'identity', identityRevision: 1,
  target: github, input: { branch: 'bot/item', base: 'main', headSha, title: 'Fix', body: 'Details' } };

const dispatchCases = [
  ['git.push', github, { directory: '/owned', branch: 'bot/item', headSha, baseSha: headSha, expectedRemoteSha: null, base: 'main' }],
  ['pr.open', github, request.input],
  ['pr.comment', github, { number: 1, headSha, body: 'Details' }],
  ['pr.auto-merge', github, { number: 1, headSha, mode: 'queue' }],
  ['pr.disable-auto-merge', github, { number: 1, branch: 'bot/item' }],
  ['pr.dequeue', github, { number: 1, branch: 'bot/item' }],
  ['jira.comment', jira, { body: 'Details' }],
  ['jira.question', jira, question],
  ['jira.transition', jira, { transitionId: '2', expectedStatusId: '1' }],
  ['discord.send', discord, { body: 'Details' }],
  ['discord.question', discord, question],
] as const;
type DispatchCase = typeof dispatchCases[number];

it.each(dispatchCases)('parses the captured target and input when dispatching %s', (operation: DispatchCase[0], target: DispatchCase[1], input: DispatchCase[2]) => {
  // Given an operation-specific wire payload.
  // When the boundary parses it.
  const { target: parsedTarget, input: parsedInput } = parseBotPayload({ operation, target, input });
  // Then its operation is accepted and its target is preserved.
  expect(parse(requestSchema.safeParse({ ...request, operation, target, input })).operation).toBe(operation);
  expect(parsedTarget).toEqual(target);
  expect(parsedInput).toMatchObject(input);
});

it('applies defaults when historical admission and pull inputs omit them', () => {
  // Given wire inputs from before optional defaults were captured.
  const pull = request.input;
  const admission = { number: 1, headSha, mode: 'auto-merge' };
  // When parsed for dispatch.
  const result = { pull: parse(operations['pr.open'].input.safeParse(pull)), admission: parse(operations['pr.auto-merge'].input.safeParse(admission)) };
  // Then defaults are materialized without requiring legacy branch/base fields.
  expect(result.pull.draft).toBe(false);
  expect(result.admission).toEqual({ ...admission, mergeMethod: 'SQUASH' });
});

it.each(dispatchCases)('rejects extra input and target fields when dispatching %s', (operation: DispatchCase[0], target: DispatchCase[1], input: DispatchCase[2]) => {
  // Given extra fields at either strict boundary.
  const contract = operations[operation];
  const extra = { injected: true };
  // When parsing an invalid provider target or operation input.
  const results = [contract.target.safeParse({ ...target, ...extra }), contract.input.safeParse({ ...input, ...extra })];
  // Then both boundaries reject the payload.
  expect(results.every((result) => !result.success)).toBe(true);
});

it.each(['bot/../item', 'bot//item', 'bot/.item', 'bot/item.lock', 'bot/item.', 'bot/item/'])(
  'rejects an invalid branch when parsing %s', (value: string) => {
    // Given a malformed publication name, when parsed, then it is refused.
    expect(branch.safeParse(value).success).toBe(false);
  });

it.each([
  [githubTarget, { ...github, repo: 'example.git' }],
  [jiraTarget, { ...jira, issueKey: 'OTHER-1' }],
  [discordTarget, { ...discord, recipientId: '333333' }],
  [discordTarget, { ...discord, guildId: 'dm' }],
] as const)('rejects an inconsistent provider target when parsing %#', (schema: typeof githubTarget | typeof jiraTarget | typeof discordTarget, target: BotOperationTarget<BotOperation>) => {
  // Given an inconsistent destination, when parsed, then it is refused.
  expect(schema.safeParse(target).success).toBe(false);
});

it('accepts an exact recipient when parsing a Discord DM', () => {
  // Given a DM with an explicit recipient.
  const target = { ...discord, guildId: 'dm', recipientId: '333333' };
  // When parsed, then the recipient remains captured.
  expect(parse(discordTarget.safeParse(target))).toEqual(target);
});

it.each([
  { ...question, recipients: [] },
  { ...question, recipients: [question.recipients[0], question.recipients[0]] },
  { ...question, recipients: [{ personId: 'owner', serviceId: '333333' }, { personId: 'other', serviceId: '333333' }] },
  { ...question, recipients: [{ personId: 'owner', serviceId: '333333' }, { personId: 'owner', serviceId: '444444' }] },
  { ...question, recipients: [{ personId: 'owner', serviceId: 'not-a-snowflake' }] },
  { ...question, body: 'x'.repeat(1_990) },
])('rejects invalid recipients or oversized generated mentions when parsing a Discord question %#', (input: BotOperationInput<'discord.question'>) => {
  // Given an invalid selected-recipient payload, when parsed, then it is refused.
  expect(operations['discord.question'].input.safeParse(input).success).toBe(false);
});

it('preserves the mention-length boundary when parsing a Discord question', () => {
  // Given a 2,000-character message including its generated mention and separator.
  const input = { ...question, body: 'x'.repeat(2_000 - '<@333333>'.length - 2) };
  // When parsed, then the complete message fits exactly.
  expect(parse(operations['discord.question'].input.safeParse(input))).toEqual(input);
});

it('keeps the wire envelope opaque until operation-specific parsing', () => {
  // Given captured unknown target/input values and an authority with extra metadata.
  const envelope = { ...request, target: null, input: null };
  const authority = { policy: { fingerprint: policyFingerprint, people: { status: 'approved', people: [], extra: true } },
    question: { key: 'question', route: { service: 'jira', operation: 'jira.question', policyFingerprint,
      recipients: question.recipients, input: question, binding: { identityId: 'identity', identityRevision: 1, target: jira } } } };
  // When the envelope and question authority are parsed.
  const parsed = { envelope: parse(requestSchema.safeParse(envelope)), authority: parse(questionAuthoritySchema.safeParse(authority)) };
  // Then operation parsing is deferred and non-strict authority metadata is stripped.
  expect(parsed.envelope).toEqual(envelope);
  expect(parsed.authority.policy.people).toEqual({ status: 'approved', people: [] });
});

it.each(['unknown.operation', 'toString', '__proto__'])('rejects unsupported operation %s in captured envelopes', (operation: string) => {
  // Given a non-registry operation, when parsing an envelope, then it is refused.
  expect(requestSchema.safeParse({ ...request, operation }).success).toBe(false);
});

it('preserves effect authority and rejects extra captured fields', () => {
  // Given an effect with a captured authority.
  const effect = { key: 'key', operation: 'pr.open', botId: 'bot', itemId: 'item', target: github,
    authority: { identityId: 'identity', identityRevision: 1, credentialId: 'credential', credentialRevision: 1,
      providerAccountId: 'account', service: 'github', origin: 'https://api.github.com' }, inputDigest: policyFingerprint };
  // When parsing the durable effect.
  const parsed = parse(effectSchema.safeParse(effect));
  // Then captured wire values survive and the envelope remains strict.
  expect(parsed).toEqual(effect);
  expect(effectSchema.safeParse({ ...effect, extra: true }).success).toBe(false);
});

it.each([
  ['input', false, 'BOT_SERVICE_INVALID_INPUT', 'failed', 400],
  ['provider', false, 'BOT_SERVICE_RESPONSE_INVALID', 'needs-you', 502],
  ['provider', true, 'BOT_SERVICE_RESPONSE_INVALID', 'outcome-unknown', 502],
] as const)('classifies invalid %s data with written=%s', (source: 'input' | 'provider', written: boolean, code: string, state: string, status: number) => {
  // Given invalid data at a boundary.
  const schema = z.string();
  // When parsing it, then callers receive the existing typed error classification.
  const action = () => source === 'input' ? parse(schema.safeParse(null)) : providerResult(schema.safeParse(null), written);
  expect(action).toThrow(BotServiceError);
  expect(action).toThrow(expect.objectContaining({ code, state, status }));
});

it('returns transformed provider output when parsing succeeds', () => {
  // Given a provider schema with a transformation.
  const schema = z.string().transform((value) => value.length);
  // When parsing, then callers receive the output rather than the wire input.
  expect(providerResult(schema.safeParse('value'))).toBe(5);
});

it('preserves output inference and operation correlation when dispatching typed payloads', () => {
  // Given transformed/defaulted schemas and an operation-specific dispatch type.
  const schema = z.string().transform((value) => value.length);
  type Pull = Extract<BotOperationPayload, { operation: 'pr.open' }>;
  type Jira = Extract<BotOperationRequest, { operation: 'jira.transition' }>;
  // When parsing schema outputs or selecting a dispatch operation.
  const parsed = parse(schema.safeParse('value'));
  const response = providerResult(schema.safeParse('value'));
  // Then checked consumers retain transformed outputs, defaults, and correlated fields.
  expectTypeOf(parsed).toEqualTypeOf<number>();
  expectTypeOf(response).toEqualTypeOf<number>();
  expectTypeOf<BotOperationInputWire<'pr.open'>['draft']>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<BotOperationInput<'pr.open'>['draft']>().toEqualTypeOf<boolean>();
  expectTypeOf<Pull['input']>().toEqualTypeOf<BotOperationInput<'pr.open'>>();
  expectTypeOf<Pull['target']>().toEqualTypeOf<z.output<typeof githubTarget>>();
  expectTypeOf<Jira['input']>().toEqualTypeOf<{ transitionId: string; expectedStatusId: string }>();
  expectTypeOf<Jira['target']>().toEqualTypeOf<z.output<typeof jiraTarget>>();
  expectTypeOf<BotServiceRequest['operation']>().toEqualTypeOf<typeof dispatchCases[number][0]>();
  expectTypeOf(operations['pr.open'].service).toEqualTypeOf<'github'>();
  expectTypeOf<BotOperationPayload>().not.toExtend<{ operation: 'pr.open'; target: z.output<typeof jiraTarget> }>();
  const dispatch = parseBotPayload({ operation: 'jira.transition', target: jira, input: { transitionId: '2', expectedStatusId: '1' } });
  expectTypeOf(dispatch.call).toEqualTypeOf<readonly ['jira.transition', BotOperationInput<'jira.transition'>]>();
  expectTypeOf(dispatch.target).toEqualTypeOf<z.output<typeof jiraTarget>>();
  type GitHubEffect = Extract<BotPreparedEffect, { operation: 'git.push' | `pr.${string}` }>;
  type DiscordResult = Extract<BotServiceExecutionResult, { operation: 'discord.send' | 'discord.question' }>;
  type GitHubResult = Extract<BotServiceExecutionResult, { operation: 'git.push' | `pr.${string}` }>;
  expectTypeOf<GitHubEffect['authority']['service']>().toEqualTypeOf<'github'>();
  expectTypeOf<DiscordResult['result']>().toEqualTypeOf<{ messageId: string; channelId: string }>();
  expectTypeOf<readonly ['jira.transition', BotOperationInput<'jira.comment'>]>().not.toExtend<BotParsedPayload['call']>();
  expectTypeOf<GitHubResult['result']>().toEqualTypeOf<MutationResult | undefined>();
});

it.each(['http://acme.atlassian.net', 'https://acme.atlassian.net/path', 'https://user@acme.atlassian.net',
  'https://acme.atlassian.net?query=1', 'https://acme.atlassian.net#fragment', 'https://acme.atlassian.net:8443', 'not-a-url'])(
  'rejects a non-site Jira origin when parsing %s', (value: string) => {
    // Given an invalid site, when parsed, then it retains the failed/400 classification.
    expect(() => jiraOrigin(value)).toThrow(expect.objectContaining({ code: 'BOT_SERVICE_ORIGIN_INVALID', state: 'failed', status: 400 }));
  });

it('normalizes the Jira origin when parsing a valid Cloud site', () => {
  // Given a valid Cloud site, when parsed, then only its canonical origin remains.
  expect(jiraOrigin('https://ACME.atlassian.net/')).toBe('https://acme.atlassian.net');
});
