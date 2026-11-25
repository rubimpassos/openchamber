import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BotServiceEffect, BotServiceErrorState } from '../bots/services/contracts.js';
import { botDefinitionSchema } from '../bots/config.js';
import { botEffectSchema, botItemSchema, botItemSourceSchema, botItemStateSchema } from '../bots/schema.js';
import { branch, discordTarget, effectSchema, githubTarget, jiraTarget, opaqueId, operations, requestSchema,
  revision, sha, snowflake, text } from '../bots/services/contracts.js';
import { projectDirectorySchema } from './fix-loop-contract.js';
import { checkContextsSchema, failedChecksReplySchema, feedbackReplySchema } from './fix-loop-feedback-contract.js';
import { repositoryPolicyFilesSchema } from '../bots/repository-policy.js';
import { botMigrationPathSchema } from '../spaces/transfer-bundle.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { BOT_CONVERSATION_OPERATIONS } from './bot-conversation-service-contract.js';
import { BOT_PROVIDER_READS, botPublicIdentitySchema, identityDefinition, binding, githubBinding, botContextReplySchema, commitMap, receipts,
  botGatewayCursorSchema, botDiscordFrameSchema } from './bot-provider-contract.js';
export { BOT_PROVIDER_READS, botPublicIdentitySchema, botGatewayUrlSchema, botGatewayReadySchema, botGatewayMessageSchema,
  botDiscordFrameSchema, botGatewayCursorSchema } from './bot-provider-contract.js';

export const BOT_SERVICE_ROUTE = '/api/openchamber/bot-services';
export const BOT_SERVICE_INPUT_BYTES = 4 * 1024 * 1024;
export const BOT_SERVICE_BYTES = 4 * 1024 * 1024;
export const BOT_SERVICE_TIMEOUT_MS = 30_000;
export const botBoundaryError = (code: string, status = 502, state: BotServiceErrorState = 'needs-you') => Object.assign(new Error(code), { code, status, state });
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const body = z.string().max(200_000);
const file = z.string().min(1).max(4096).refine((value) => !value.startsWith('/') && !value.includes('\\')
  && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  && value.split('/').every((part) => part !== '..' && part !== ''));
const policyFileSchema = z.string().regex(/^(?:\.agents\/areas\/[^/]+\.md|\.openchamber\/people\.json)$/).max(4096);
const botProjectSchema = z.object({ id: text, path: projectDirectorySchema });
const botStageSchema = z.enum(['investigation', 'fixing', 'judge']);
export const botSessionIdSchema = z.string().regex(/^ses_[A-Za-z0-9]{1,128}$/);
const botSelectionSchema = z.object({ providerID: text, modelID: text, variant: text.optional(), agent: text.optional() });
const itemProjection = z.object({ id: opaqueId, botId: opaqueId, source: botItemSourceSchema,
  title: body.optional(), state: botItemStateSchema.optional(), worktree: projectDirectorySchema.optional(),
  conversation: z.object({ sessionId: botSessionIdSchema, directory: projectDirectorySchema, createdAt: count }).strict().optional(),
  branch: branch.optional(), publicationBranch: branch.optional(), sessions: z.object({ investigation: botSessionIdSchema.optional(),
    fixing: botSessionIdSchema.optional(), judge: botSessionIdSchema.optional() }).default({}),
  pr: z.object({ number: revision, url: z.string().max(4096), headSha: sha, baseSha: sha.optional() }).optional(),
  effects: z.array(botEffectSchema.options[0].pick({ kind: true }).extend({ key: opaqueId,
    state: z.enum(['prepared', 'dispatching', 'succeeded', 'refused', 'outcome-unknown']) }).pick({ key: true, kind: true, state: true }).strip()).max(10_000).default([]) });
export const botScopeSchema = z.object({ project: botProjectSchema, bot: botDefinitionSchema,
  item: itemProjection, checkoutKey: opaqueId.optional(), trustedMigrationPath: botMigrationPathSchema.optional() }).strict()
  .refine((value) => value.bot.id === value.item.botId && (!value.trustedMigrationPath
    || value.trustedMigrationPath.projectId === value.project.id && value.trustedMigrationPath.itemId === value.item.id
      && (!value.item.worktree || value.item.worktree === value.trustedMigrationPath.directory)));
const botCheckoutSchema = z.object({ directory: projectDirectorySchema, branch, baseBranch: branch, baseSha: sha });
const botSnapshotSchema = z.object({ baseSha: sha, headSha: sha, baseBranch: branch, remoteSha: sha.nullable(),
  changes: z.array(z.object({ oldPath: file.optional(), newPath: file.optional() }).refine((value) => value.oldPath || value.newPath)).max(100_000),
  diff: z.string().max(3 * 1024 * 1024), testSha: sha.optional(), fixSha: sha.optional(), testFiles: z.array(file).max(2000).optional() });
const publication = z.object({ sourceHeadSha: sha, headSha: sha, commitMap });
const publicationReply = z.object({ publicationBranch: branch, localBranch: branch, directory: projectDirectorySchema,
  identityId: opaqueId, identityRevision: revision }).nullable();
const success = z.object({ ok: z.literal(true) });
const scoped = z.object({ scope: botScopeSchema }).strict();
const keyed = scoped.extend({ key: opaqueId }).strict();
const unknownOutcome = z.object({ state: z.literal('outcome-unknown') });
const stageReceipt = z.object({ id: botSessionIdSchema, sessionId: botSessionIdSchema });
export const botStageRequestSchema = z.object({ projectId: text, itemId: opaqueId, bot: botDefinitionSchema,
  stage: botStageSchema, directory: projectDirectorySchema, selection: botSelectionSchema,
  prompt: body, dispatchedAt: count, afterIdleId: text.nullable().optional(), sessionId: botSessionIdSchema.optional() });
const stageInput = scoped.extend({ request: botStageRequestSchema }).strict();
const sessionInput = scoped.extend({ sessionId: botSessionIdSchema }).strict();
const stageOutcome = z.discriminatedUnion('state', [
  z.object({ state: z.literal('completed'), text: z.string().max(100_000), errorMessage: body.optional(), tokens: count }),
  z.object({ state: z.enum(['error', 'cancelled']), text: z.string().max(100_000), errorMessage: body.optional(), tokens: count.optional() }),
]);
const botProofReplySchema = z.object({ status: z.enum(['passed', 'failed', 'inconclusive']), testSha: sha, fixSha: sha,
  command: z.string().max(4096), args: z.array(z.string().max(20_000)).max(1000),
  testExitCode: z.number().int().nullable(), fixExitCode: z.number().int().nullable(), reason: body.optional() });
export const botWatchAuthoritySchema = z.object({ project: botProjectSchema, botId: opaqueId, itemId: opaqueId,
  identityId: opaqueId, identityRevision: revision, target: githubTarget, publicationBranch: branch.optional() }).strict();
const watch = z.object({ authority: botWatchAuthoritySchema, number: revision, branch,
  headSha: sha.optional(), expectedDirectory: projectDirectorySchema, trustedMigrationPath: botMigrationPathSchema.optional() }).strict();
const providerReadNames = Object.keys(BOT_PROVIDER_READS).filter((key): key is keyof typeof BOT_PROVIDER_READS => Object.hasOwn(BOT_PROVIDER_READS, key));
const operationNames = Object.keys(operations).filter((key): key is keyof typeof operations => Object.hasOwn(operations, key));
function nonempty<Schema>([first, ...rest]: readonly Schema[]): [Schema, ...Schema[]] {
  if (first === undefined) throw new TypeError('Bot operation schemas must be nonempty');
  return [first, ...rest];
}
const botReadRequestSchema = z.discriminatedUnion('operation', nonempty(providerReadNames.map((operation) => {
  const contract = BOT_PROVIDER_READS[operation];
  const inputSchema: z.ZodType<z.output<typeof contract.input>> = contract.input;
  return (
  z.object({ operation: z.literal(operation), identityId: opaqueId, identityRevision: revision, target: contract.target,
    input: inputSchema.default({}) }).strict());
})));
const botPrepareRequestSchema = z.discriminatedUnion('operation', nonempty(operationNames.map((operation) =>
  requestSchema.extend({ operation: z.literal(operation), target: operations[operation].target, input: operations[operation].input }).strict())));
const effectRequest = (operation: keyof typeof operations) => effectSchema.extend({ operation: z.literal(operation), target: operations[operation].target }).strict();
const botEffectRequestSchema = z.discriminatedUnion('operation', nonempty(operationNames.map(effectRequest)));
const serviceEffectInput = z.discriminatedUnion('operation', nonempty(operationNames.map((operation) =>
  z.object({ scope: botScopeSchema, operation: z.literal(operation), effect: effectRequest(operation),
    input: operations[operation].input }).strict())));
const providerReadInput = scoped.extend({ request: botReadRequestSchema }).strict();
const providerReadReply = z.discriminatedUnion('operation', nonempty(providerReadNames.map((operation) =>
  z.object({ operation: z.literal(operation), value: BOT_PROVIDER_READS[operation].reply }))));
const serviceResult = z.discriminatedUnion('operation', nonempty(operationNames.map((operation) =>
  effectSchema.pick({ authority: true }).extend({ operation: z.literal(operation), status: z.literal('succeeded'),
    target: operations[operation].target, result: receipts[operation], replayed: z.boolean() })
    .pick({ operation: true, status: true, authority: true, target: true, result: true, replayed: true }).strip())));
const reconcileReply = z.union([unknownOutcome, z.object({ state: z.literal('refused'), code: text }),
  ...Object.entries(receipts).map(([operation, result]) => z.object({ state: z.literal('succeeded'), operation: z.literal(operation), result }))]);
const toolInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('item.report'), input: z.object({ evidence: z.array(z.object({ source: text, summary: body, url: z.string().max(4096).optional() })).max(100), critical: z.boolean().optional() }).strict() }),
  z.object({ action: z.literal('item.ask'), input: z.object({ operationId: opaqueId, question: body, people: z.array(text).max(20).optional(), requestedRole: text.optional() }).strict() }),
  ...['git.push', 'pr.open', 'pr.comment', 'jira.comment', 'jira.transition', 'discord.send'].map((action) =>
    z.object({ action: z.literal(action), input: z.object({ operationId: opaqueId, body: body.optional() }).strict() })),
]);
const botToolRequestSchema = z.intersection(z.object({ sessionId: botSessionIdSchema, callId: opaqueId }), toolInput);
const toolReceipt = z.object({ id: text, sha: sha.optional(), url: z.string().max(4096).optional(), sessionId: botSessionIdSchema.optional() }).strict();
const toolItem = botItemSchema.refine((item) => item.effects.length <= 10_000 && item.transitions.length <= 10_000
  && item.evidence.length <= 1000 && Object.keys(item.tokens.byDay).length <= 3660
  && (!item.wait || item.wait.people.length <= 1000)
  && (!item.judgment || item.judgment.reviewers.length <= 100 && item.judgment.questions.length <= 100)
  && (item.proof.status === 'absent' || item.proof.args.length <= 1000 && item.proof.args.every((argument) => argument.length <= 20_000)));
const toolQuestion = z.object({ version: z.literal(1), key: opaqueId, digest: text, since: count, code: text.nullable(),
  input: z.object({ eventId: text, questions: z.array(z.string().min(1).max(20_000)).min(1).max(20),
    people: z.array(text).max(20), requestedRole: text.optional(), resumeState: z.enum(['investigating', 'fixing', 'judging']) }).strict(),
  route: z.object({ service: z.enum(['jira', 'discord']), selection: z.enum(['owners', 'requested', 'role', 'blame']),
    baseSha: sha, headSha: sha, recipients: z.array(z.object({ personId: text, serviceId: text }).strict()).min(1).max(20),
    policyFingerprint: text, binding: z.object({ identityId: opaqueId, identityRevision: revision,
      target: z.union([jiraTarget, discordTarget]), expectedStatusId: text.optional() }).strict(),
    operation: z.enum(['jira.comment', 'discord.send', 'jira.question', 'discord.question']),
    input: z.union([operations['jira.question'].input, operations['discord.question'].input, operations['jira.comment'].input]),
    attribution: z.array(z.object({ sha, github: text, githubId: revision, committedAt: z.iso.datetime(), files: z.array(file).max(20) }).strict()).max(100),
  }).strict().nullable(),
}).strict();
const toolResult = z.union([
  z.object({ receipt: toolReceipt }).strict(),
  z.object({ item: toolItem, question: toolQuestion.optional(), receipt: toolReceipt.optional(), answered: z.boolean().optional() }).strict(),
]);
export const botToolReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: toolResult }),
  z.object({ ok: z.literal(false), error: z.object({ code: text, status: z.number().int().min(400).max(599),
    state: z.enum(['needs-you', 'outcome-unknown', 'failed', 'refused']) }) }),
]);
const toolRecord = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), request: botToolRequestSchema });
const memoryTitle = z.object({ title: z.string().max(4096), createdAt: count, updatedAt: count.optional() });
const knowledge = z.object({ notes: z.array(z.object({ body, createdAt: count })).max(256),
  plans: z.array(z.object({ id: text, title: text, body })).max(256),
  memory: z.object({ global: z.array(memoryTitle).max(2000), project: z.array(memoryTitle).max(2000), enabled: z.boolean(), complete: z.boolean() }),
  linking: z.boolean(), naming: z.boolean(), rendering: z.boolean(), secrets: z.boolean(), workflows: z.boolean(),
  directTools: z.boolean().optional(), readAloud: z.boolean(), checkout: z.object({ directory: projectDirectorySchema, branch: z.string().max(1024), placeholder: z.boolean() }).nullable() });
const policyReply = repositoryPolicyFilesSchema;
const association = z.object({ operation: text, digest: z.string().regex(/^[a-f0-9]{64}$/) });
const author = z.object({ login: text, bot: z.boolean() });
const gatewayScope = scoped.extend({ connectionId: opaqueId }).strict();
const gatewayIdentity = { identityId: opaqueId, identityRevision: revision };
const projectInput = z.object({ project: botProjectSchema }).strict();
export const BOT_SERVICE_OPERATIONS = {
  ...BOT_CONVERSATION_OPERATIONS,
  'identity-list': { input: projectInput, reply: z.array(botPublicIdentitySchema).max(200) },
  'identity-create': { input: projectInput.extend({ definition: identityDefinition }).strict(), reply: botPublicIdentitySchema },
  'identity-update': { input: projectInput.extend({ id: opaqueId, expectedRevision: revision, definition: identityDefinition }).strict(), reply: botPublicIdentitySchema },
  'identity-remove': { input: projectInput.extend({ id: opaqueId, expectedRevision: revision }).strict(), reply: z.object({ removed: z.literal(true) }) },
  repository: { input: z.object({ project: botProjectSchema }).strict(), reply: z.object({ target: githubTarget, remote: text }) },
  'github-binding': { input: z.object({ project: botProjectSchema, bot: botDefinitionSchema.optional(), binding: binding(githubTarget).optional(),
    expectedIdentity: botPublicIdentitySchema, expectedTarget: githubTarget }).strict()
    .refine((value) => value.bot || value.binding), reply: z.object({ binding: githubBinding }) },
  context: { input: scoped.extend({ service: z.enum(['github', 'jira', 'discord']),
    operation: z.enum([...new Set([...Object.keys(operations), ...Object.keys(BOT_PROVIDER_READS), 'github.checkout'])]),
    expectedIdentity: botPublicIdentitySchema.nullable(), expectedTarget: z.union([githubTarget, jiraTarget, discordTarget]).optional(),
    target: discordTarget.optional() }).strict(), reply: botContextReplySchema },
  'policy-files': { input: z.object({ project: botProjectSchema, files: z.array(policyFileSchema).max(256) }).strict(), reply: policyReply },
  defaults: { input: z.object({ project: botProjectSchema }).strict(), reply: botSelectionSchema },
  knowledge: { input: scoped, reply: knowledge },
  'knowledge-sync': { input: sessionInput.extend({ includeMemorySaveRule: z.boolean() }).strict(), reply: success },
  'worktree-create': { input: keyed, reply: botCheckoutSchema },
  'worktree-reconcile': { input: keyed.extend({ operation: z.enum(['create', 'remove']) }).strict(), reply: z.union([unknownOutcome,
    z.object({ state: z.literal('succeeded'), result: z.union([botCheckoutSchema, z.object({ id: opaqueId })]) })]) },
  'worktree-inspect': { input: scoped, reply: botSnapshotSchema },
  'worktree-bind-publication': { input: scoped.extend({ branch }).strict(), reply: z.object({ publicationBranch: branch }) },
  'worktree-read-publication': { input: scoped.extend({ repositoryId: opaqueId }).strict(), reply: publicationReply },
  'worktree-adopt-isolated': { input: scoped.extend({ resultSha: sha, spaceId: z.string().regex(/^[a-f0-9]{12}$/) }).strict(), reply: z.object({ headSha: sha }) },
  'worktree-accept-published': { input: scoped.extend({ snapshot: botSnapshotSchema, result: publication }).strict(), reply: z.object({ headSha: sha }) },
  'worktree-remove': { input: scoped.extend({ key: opaqueId.optional(), checkout: botCheckoutSchema.optional() }).strict(), reply: z.object({ id: opaqueId }) },
  'worktree-same-tree': { input: scoped.extend({ left: sha, right: sha }).strict(), reply: z.object({ same: z.boolean() }) },
  'stage-create': { input: stageInput, reply: z.object({ sessionId: botSessionIdSchema, directory: projectDirectorySchema }) },
  'stage-dispatch': { input: stageInput, reply: stageReceipt },
  'stage-outcome': { input: stageInput, reply: stageOutcome.nullable() },
  'stage-reconcile': { input: stageInput.extend({ kind: z.enum(['session.create', 'session.prompt']), sessionId: botSessionIdSchema.optional() }).strict(),
    reply: z.union([unknownOutcome, z.object({ state: z.literal('succeeded'), result: stageReceipt })]) },
  'stage-stop': { input: sessionInput, reply: success },
  'stage-resume': { input: sessionInput, reply: success },
  session: { input: sessionInput, reply: z.object({ id: botSessionIdSchema, directory: projectDirectorySchema, isolated: z.literal(false),
    archived: z.boolean(), metadata: z.object({ openchamber: z.object({ automation: z.object({ source: z.literal('bot'), projectId: text,
      botId: opaqueId, itemId: opaqueId, stage: botStageSchema }) }) }) }) },
  tokens: { input: sessionInput.extend({ since: count.optional() }).strict(), reply: count.nullable() },
  activity: { input: sessionInput, reply: z.boolean().nullable() },
  proof: { input: scoped.extend({ testSha: sha, fixSha: sha }).strict(), reply: botProofReplySchema },
  'service-prepare': { input: scoped.extend({ request: botPrepareRequestSchema }).strict(), reply: botEffectRequestSchema },
  'service-read': { input: providerReadInput, reply: providerReadReply },
  'service-preflight': { input: serviceEffectInput, reply: success },
  'service-execute': { input: serviceEffectInput, reply: serviceResult },
  'service-reconcile': { input: serviceEffectInput, reply: reconcileReply },
  blame: { input: scoped.extend({ snapshot: botSnapshotSchema }).strict(), reply: z.array(z.object({ sha, github: text, githubId: revision,
    committedAt: text, files: z.array(file).max(20) })).max(100) },
  'pull-status': { input: scoped.extend({ authority: botWatchAuthoritySchema }).strict(), reply: z.object({ open: z.boolean(), status: z.object({ headSha: sha, baseSha: sha, merged: z.boolean(),
    approved: z.boolean(), mergeMode: z.enum(['queue', 'auto-merge']) }) }) },
  'pull-feedback': { input: watch.extend({ mentionText: z.string().min(1).max(100).optional() }).strict(), reply: feedbackReplySchema },
  'pull-author-permission': { input: watch.omit({ number: true, branch: true, headSha: true }).extend({ username: text }).strict(), reply: z.object({ permitted: z.boolean() }) },
  'pull-failed-checks': { input: watch.omit({ number: true, branch: true, headSha: true }).extend({ contexts: checkContextsSchema }).strict(), reply: failedChecksReplySchema },
  'pull-review-app': { input: z.object({ authority: botWatchAuthoritySchema, author,
    selectedApprovedApp: z.object({ slug: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), appId: revision }).optional(),
    expectedDirectory: projectDirectorySchema, trustedMigrationPath: botMigrationPathSchema.optional() }).strict(), reply: z.object({ authorized: z.boolean() }) },
  'tools-pull': { input: sessionInput, reply: z.object({ requests: z.array(toolRecord).max(100) }) },
  'tools-settle': { input: sessionInput.extend({ settlement: toolRecord.extend({ reply: botToolReplySchema }) }).strict(), reply: z.object({ settled: z.literal(true) }) },
  'synthetic-deliver': { input: sessionInput.extend({ eventId: opaqueId, messageId: z.string().regex(/^msg_[A-Za-z0-9]{8,64}$/),
    text: body.refine((value) => value.trim().length > 0), description: body.optional() }).strict(), reply: z.object({ messageId: text, sessionId: botSessionIdSchema }) },
  'gateway-open': { input: gatewayScope.extend({ ...gatewayIdentity, cursor: botGatewayCursorSchema.nullable() }).strict(),
    reply: z.object({ connectionId: opaqueId, botUserId: snowflake, applicationId: snowflake }) },
  'gateway-pull': { input: gatewayScope.extend({ after: count, observed: count.optional() }).strict()
    .refine((value) => value.observed === undefined || value.observed >= value.after), reply: z.object({ connectionId: opaqueId,
    frames: z.array(z.object({ id: count, frame: botDiscordFrameSchema })).max(16), state: z.enum(['connecting', 'open', 'closed']),
    closeCode: count.nullable(), errorCode: text.optional() }) },
  'gateway-send': { input: gatewayScope.extend({ frame: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('identify') }).strict(),
    z.object({ kind: z.literal('resume'), sessionId: text, sequence: count }).strict(),
    z.object({ kind: z.literal('heartbeat'), sequence: count.nullable() }).strict(),
  ]) }).strict(), reply: success },
  'gateway-close': { input: gatewayScope, reply: success },
};

export type BotServiceOperation = keyof typeof BOT_SERVICE_OPERATIONS;
export type BotServiceInput<Operation extends BotServiceOperation> = z.output<typeof BOT_SERVICE_OPERATIONS[Operation]['input']>;
export type BotServiceReply<Operation extends BotServiceOperation> = z.output<typeof BOT_SERVICE_OPERATIONS[Operation]['reply']>;
export const isBotServiceOperation = (operation: string): operation is BotServiceOperation => Object.hasOwn(BOT_SERVICE_OPERATIONS, operation);

export type BotEffectInput = z.input<(typeof operations)[keyof typeof operations]['input']>;

export const botRequestAssociation = <Operation extends BotServiceOperation>(operation: Operation, input: BotServiceInput<Operation>) => ({ operation,
  digest: createHash('sha256').update(JSON.stringify(input)).digest('hex') });
export const botReplySchema = <Operation extends BotServiceOperation>(operation: Operation) => z.object({ association, result: BOT_SERVICE_OPERATIONS[operation].reply });

type EffectDigestInput = Omit<BotServiceEffect, 'authority'> & {
  readonly authority: Pick<BotServiceEffect['authority'], 'service' | 'identityId' | 'identityRevision'>;
};
export function botEffectInputDigest(effect: EffectDigestInput, rawInput: BotEffectInput) {
  const contract = operations[effect.operation];
  const value = { key: effect.key, operation: effect.operation, botId: effect.botId, itemId: effect.itemId,
    authority: effect.authority, target: contract.target.parse(effect.target), input: contract.input.parse(rawInput) };
  return digestMutationInput(effect.publicationBranch === undefined ? value : { ...value, publicationBranch: effect.publicationBranch });
}

export function assertBotEffectInput(effect: EffectDigestInput, input: BotEffectInput) {
  if (!Object.hasOwn(operations, effect.operation) || operations[effect.operation].service !== effect.authority.service
    || effect.inputDigest !== botEffectInputDigest(effect, input)) {
    throw botBoundaryError('BOT_EFFECT_CHANGED', 409);
  }
}

export { assertBotServiceReply } from './bot-service-reply-contract.js';
