import { z } from 'zod';

export type BotServiceErrorState = 'needs-you' | 'failed' | 'outcome-unknown' | 'refused';

export class BotServiceError extends Error {
  readonly code: string;
  readonly state: BotServiceErrorState;
  readonly status: number;

  constructor(code: string, message: string, state: BotServiceErrorState = 'needs-you', status = 409) {
    super(message);
    this.name = 'BotServiceError';
    this.code = code;
    this.state = state;
    this.status = status;
  }
}

export const parse = <Output>(result: z.ZodSafeParseResult<Output>): Output => {
  if (!result.success) throw new BotServiceError('BOT_SERVICE_INVALID_INPUT', 'Bot service input is invalid.', 'failed', 400);
  return result.data;
};

export const providerResult = <Output>(result: z.ZodSafeParseResult<Output>, written = false): Output => {
  if (!result.success) throw new BotServiceError('BOT_SERVICE_RESPONSE_INVALID', 'The provider returned an invalid response.',
    written ? 'outcome-unknown' : 'needs-you', 502);
  return result.data;
};

export const text = z.string().min(1).max(512).refine((value) => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
});
export const opaqueId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
export const revision = z.number().int().positive();
export const snowflake = z.string().regex(/^[1-9][0-9]{5,24}$/);
export const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const branch = z.string().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/)
  .refine((value) => !value.includes('..') && !value.includes('//')
    && !value.endsWith('/') && !value.endsWith('.')
    && value.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock')));
const body = z.string().min(1).max(60_000);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const questionFields = { body, policyFingerprint: fingerprint, recipients: z.array(z.object({ personId: text, serviceId: text }).strict()).min(1).max(20)
  .refine((people) => new Set(people.map((person) => person.personId)).size === people.length
    && new Set(people.map((person) => person.serviceId)).size === people.length, 'Question recipients must be distinct') };
const repositoryPart = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/)
  .refine((value) => value !== '.' && value !== '..' && !value.endsWith('.git'));
export const githubTarget = z.object({ repositoryId: opaqueId, owner: repositoryPart, repo: repositoryPart }).strict();
const jiraProjectKey = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const jiraTarget = z.object({
  projectKey: jiraProjectKey,
  issueKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]*$/),
}).strict().refine((value) => value.issueKey.startsWith(`${value.projectKey}-`));
export const discordTarget = z.object({
  guildId: z.union([snowflake, z.literal('dm')]), channelId: snowflake,
  recipientId: snowflake.optional(),
}).strict().refine((value) => value.guildId === 'dm' ? Boolean(value.recipientId) : !value.recipientId);

export const operations = {
  'git.push': { service: 'github', target: githubTarget, input: z.object({
    directory: text, branch, localBranch: branch.optional(), headSha: sha,
    baseSha: sha, expectedRemoteSha: sha.nullable(), base: branch,
  }).strict() },
  'pr.open': { service: 'github', target: githubTarget, input: z.object({
    branch, base: branch,
    headSha: sha, title: z.string().min(1).max(256), body, draft: z.boolean().default(false),
  }).strict() },
  'pr.comment': { service: 'github', target: githubTarget, input: z.object({
    number: revision, headSha: sha, body,
  }).strict() },
  'pr.auto-merge': { service: 'github', target: githubTarget, input: z.object({
    number: revision, headSha: sha, baseSha: sha.optional(), branch: branch.optional(),
    mode: z.enum(['auto-merge', 'queue']),
    mergeMethod: z.enum(['MERGE', 'SQUASH', 'REBASE']).default('SQUASH'),
  }).strict() },
  'pr.disable-auto-merge': { service: 'github', target: githubTarget, input: z.object({ number: revision, branch }).strict() },
  'pr.dequeue': { service: 'github', target: githubTarget, input: z.object({ number: revision, branch }).strict() },
  'jira.comment': { service: 'jira', target: jiraTarget, input: z.object({ body }).strict() },
  'jira.question': { service: 'jira', target: jiraTarget, input: z.object(questionFields).strict() },
  'jira.transition': { service: 'jira', target: jiraTarget, input: z.object({
    transitionId: z.string().regex(/^[1-9][0-9]*$/), expectedStatusId: z.string().regex(/^[1-9][0-9]*$/),
  }).strict() },
  'discord.send': { service: 'discord', target: discordTarget, input: z.object({
    body: z.string().min(1).max(2_000),
  }).strict() },
  'discord.question': { service: 'discord', target: discordTarget, input: z.object(questionFields).strict()
    .refine(({ recipients }) => recipients.every((person) => snowflake.safeParse(person.serviceId).success), 'Discord users need exact IDs')
    .refine(({ recipients, body }) => recipients.map((person) => `<@${person.serviceId}>`).join(' ').length + 2 + body.length <= 2_000,
      'Question and generated mentions exceed Discord message length') },
} as const;

export type BotOperation = keyof typeof operations;
export type BotService = typeof operations[BotOperation]['service'];
export type BotOperationInputWire<Operation extends BotOperation> = z.input<typeof operations[Operation]['input']>;
export type BotOperationInput<Operation extends BotOperation> = z.output<typeof operations[Operation]['input']>;
export type BotOperationTarget<Operation extends BotOperation> = z.output<typeof operations[Operation]['target']>;

export type BotOperationPayload<Operation extends BotOperation = BotOperation> = {
  readonly [Key in Operation]: {
    readonly operation: Key;
    readonly target: BotOperationTarget<Key>;
    readonly input: BotOperationInput<Key>;
  };
}[Operation];

export const questionAuthoritySchema = z.object({
  policy: z.object({ fingerprint, people: z.object({ status: z.literal('approved'),
    people: z.array(z.object({ id: text, jira: text.optional(), discord: text.optional() })) }) }),
  question: z.object({ key: opaqueId, route: z.object({ service: z.enum(['jira', 'discord']),
    operation: z.enum(['jira.question', 'discord.question']), policyFingerprint: fingerprint,
    recipients: questionFields.recipients, input: z.object(questionFields).strict(),
    binding: z.object({ identityId: opaqueId, identityRevision: revision, target: z.union([jiraTarget, discordTarget]) }),
  }) }),
});

const operationSchema = z.enum(Object.keys(operations).filter((key): key is BotOperation => Object.hasOwn(operations, key)));
export const requestSchema = z.object({
  key: opaqueId, operation: operationSchema, botId: opaqueId, itemId: opaqueId,
  identityId: opaqueId, identityRevision: revision,
  target: z.unknown(), input: z.unknown(),
}).strict();

export const botServiceAuthoritySchema = z.object({
  identityId: opaqueId, identityRevision: revision,
  credentialId: text, credentialRevision: revision, providerAccountId: text,
  service: z.enum(['github', 'jira', 'discord']), origin: z.url(),
}).strict();
export const effectSchema = z.object({
  key: opaqueId, operation: operationSchema, botId: opaqueId, itemId: opaqueId,
  publicationBranch: branch.optional(),
  authority: botServiceAuthoritySchema, target: z.unknown(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type BotServiceRequest = z.output<typeof requestSchema>;
export type BotServiceEffect = z.output<typeof effectSchema>;
export type BotServiceAuthority = z.output<typeof botServiceAuthoritySchema>;
export type BotQuestionAuthority = z.output<typeof questionAuthoritySchema>;
export type BotOperationRequest<Operation extends BotOperation = BotOperation> =
  Omit<BotServiceRequest, 'operation' | 'target' | 'input'> & BotOperationPayload<Operation>;

export function jiraOrigin(value: string): string {
  let url;
  try { url = new URL(value); } catch { throw new BotServiceError('BOT_SERVICE_ORIGIN_INVALID', 'A Jira Cloud site is required.', 'failed', 400); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || !/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(url.hostname)) {
    throw new BotServiceError('BOT_SERVICE_ORIGIN_INVALID', 'A Jira Cloud site is required.', 'failed', 400);
  }
  return url.origin;
}
