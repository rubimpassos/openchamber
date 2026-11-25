import { z } from 'zod';
import { branch, discordTarget, githubTarget, jiraTarget, opaqueId, revision, sha, snowflake, text } from '../bots/services/contracts.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const empty = z.object({}).strict();
export const commitMap = z.array(z.object({ sourceSha: sha, publishedSha: sha })).min(1).max(100);
const identityKind = z.enum(['github-account', 'github-app', 'jira-account', 'jira-service', 'jira-oauth', 'discord-app']);
export const botPublicIdentitySchema = z.object({ id: opaqueId, revision, label: text, kind: identityKind, configured: z.literal(true),
  accountId: text.optional(), credentialRevision: revision.optional(), appId: text.optional(), installationId: text.optional(),
  site: text.optional(), email: z.string().max(320).optional(), cloudId: z.string().uuid().optional(),
  clientId: z.string().max(1024).optional(), applicationId: snowflake.optional() });
const secret = z.string().min(1).max(32_768);
export const identityDefinition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github-account'), label: text, accountId: text, credentialRevision: revision }).strict(),
  z.object({ kind: z.literal('github-app'), label: text, appId: text, installationId: text, privateKey: secret }).strict(),
  z.object({ kind: z.enum(['jira-account', 'jira-service']), label: text, site: text, email: z.string().email().max(320), apiToken: secret }).strict(),
  z.object({ kind: z.literal('jira-oauth'), label: text, site: text, cloudId: z.string().uuid(), clientId: z.string().max(1024), clientSecret: secret }).strict(),
  z.object({ kind: z.literal('discord-app'), label: text, applicationId: snowflake, botToken: secret }).strict(),
]);
export const binding = <Target extends z.ZodType>(target: Target) => z.object({ identityId: opaqueId, identityRevision: revision, target });
export const githubBinding = binding(githubTarget).extend({ accountId: text.optional(), credentialRevision: revision.optional() });
export const botContextReplySchema = z.object({ github: githubBinding.optional(),
  jira: binding(jiraTarget).extend({ expectedStatusId: text.optional() }).optional(), discord: binding(discordTarget).optional() });
const stateName = z.object({ id: text, name: text });
const issue = z.object({ id: text, key: text, summary: z.string().max(60_000), status: stateName,
  description: z.string().max(60_000), issueType: stateName.extend({ subtask: z.boolean().optional() }).optional() });
type BoundedJson = string | number | boolean | null | BoundedJson[] | { [key: string]: BoundedJson };
const boundedJson = (depth: number): z.ZodType<BoundedJson> => depth === 0 ? z.union([z.string().max(8192), z.number().finite(), z.boolean(), z.null()])
  : z.union([z.string().max(8192), z.number().finite(), z.boolean(), z.null(), z.array(boundedJson(depth - 1)).max(100),
    z.record(z.string().max(256), boundedJson(depth - 1)).refine((value) => Object.keys(value).length <= 100)]);
const rule = z.object({ type: text, parameters: z.record(z.string().max(256), boundedJson(3)).refine((value) => Object.keys(value).length <= 100).optional(),
  ruleset_id: revision.optional(), ruleset_source: text.optional(), ruleset_source_type: z.enum(['Repository', 'Organization', 'Enterprise']).optional(),
  ruleset_enforcement_mode: z.literal('active').optional() });
export const BOT_PROVIDER_READS = {
  'github.branch': { target: githubTarget, input: z.object({ branch }).strict(), reply: z.object({ headSha: sha.nullable() }) },
  'github.rules': { target: githubTarget, input: z.object({ branch }).strict(), reply: z.object({ branch, headSha: sha,
    requiredSignatures: z.boolean(), mergeQueue: z.boolean(), autoMergeAllowed: z.boolean(), ruleTypes: z.array(text).max(100),
    legacyProtection: z.object({ requiresCommitSignatures: z.boolean(), requiresApprovingReviews: z.boolean(),
      requiredApprovingReviewCount: count.nullable(), requiresStatusChecks: z.boolean() }).nullable() }) },
  'github.branch-rules': { target: githubTarget, input: z.object({ branch }).strict(), reply: z.array(rule).max(1000) },
  'github.pull': { target: githubTarget, input: z.object({ number: revision, headSha: sha.optional() }).strict(),
    reply: z.object({ number: revision, head: branch, base: branch, headSha: sha, state: z.enum(['open', 'closed']) }) },
  'github.authorization': { target: githubTarget, input: z.object({ number: revision, branch }).strict(),
    reply: z.object({ number: revision, headSha: sha, baseSha: sha, merged: z.boolean(), autoMerge: z.boolean(), queued: z.boolean() }) },
  'jira.issue': { target: jiraTarget, input: empty, reply: issue },
  'jira.transitions': { target: jiraTarget, input: empty, reply: z.array(z.object({ id: text, name: text, to: stateName })).max(200) },
  'jira.comments': { target: jiraTarget, input: z.object({ startAt: count.optional() }).strict(), reply: z.object({
    comments: z.array(z.object({ id: text, authorId: text, human: z.boolean(), body: z.string().max(60_000), createdAt: text })).max(100),
    total: count, nextStartAt: count.nullable() }) },
  'jira.search': { target: empty, input: z.object({ jql: z.string().min(1).max(4000), nextPageToken: text.optional(),
    maxResults: z.number().int().min(1).max(100).default(50) }).strict(), reply: z.object({ issues: z.array(issue).max(100), nextPageToken: text.nullable() }) },
  'discord.channel': { target: discordTarget, input: empty, reply: z.object({ guildId: z.union([snowflake, z.literal('dm')]), channelId: snowflake }) },
};
export const receipts = {
  'git.push': z.object({ headSha: sha, sourceHeadSha: sha, commitMap: commitMap.optional() }),
  'pr.open': z.object({ number: revision, head: branch, base: branch, headSha: sha }),
  'pr.comment': z.object({ number: revision, headSha: sha, commented: z.literal(true), commentId: revision }),
  'pr.auto-merge': z.object({ number: revision, headSha: sha, status: z.enum(['enqueued', 'pending', 'merged']) }),
  'pr.disable-auto-merge': z.object({ number: revision, headSha: sha, merged: z.boolean() }),
  'pr.dequeue': z.object({ number: revision, headSha: sha, merged: z.boolean() }),
  'jira.comment': z.object({ commentId: text, issueKey: text }),
  'jira.question': z.object({ commentId: text, issueKey: text }),
  'jira.transition': z.object({ issueKey: text, previousStatusId: text.optional(), statusId: text }),
  'discord.send': z.object({ messageId: snowflake, channelId: snowflake }),
  'discord.question': z.object({ messageId: snowflake, channelId: snowflake }),
};
export const botGatewayUrlSchema = z.string().max(4096).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && !url.username && !url.password && !url.port && !url.hash && url.pathname === '/'
      && /^(?:gateway(?:-[a-z0-9-]+)?|[a-z0-9-]+\.gateway)\.discord\.gg$/.test(url.hostname)
      && [...url.searchParams.keys()].every((key) => ['v', 'encoding'].includes(key));
  } catch { return false; }
});
export const botGatewayReadySchema = z.object({ session_id: text, resume_gateway_url: botGatewayUrlSchema,
  user: z.object({ id: snowflake, bot: z.literal(true) }), application: z.object({ id: snowflake }) });
export const botGatewayMessageSchema = z.object({ id: snowflake, channel_id: snowflake, guild_id: snowflake.optional(),
  author: z.object({ id: snowflake, bot: z.boolean().optional() }), content: z.string().max(60_000),
  mentions: z.array(z.object({ id: snowflake })).max(100), message_reference: z.object({ message_id: snowflake.optional() }).optional() });
const gatewayFrameBase = { s: count.nullable().optional(), t: z.string().max(64).nullable().optional() };
export const botDiscordFrameSchema = z.union([
  z.object({ op: z.literal(0), s: count, t: z.literal('READY'), d: botGatewayReadySchema }),
  z.object({ op: z.literal(0), s: count, t: z.literal('MESSAGE_CREATE'), d: botGatewayMessageSchema }),
  z.object({ op: z.literal(0), s: count, t: z.string().max(64).refine((value) => !['READY', 'MESSAGE_CREATE'].includes(value)), d: z.null() }),
  z.object({ ...gatewayFrameBase, op: z.literal(10), d: z.object({ heartbeat_interval: z.number().int().min(100).max(120_000) }) }),
  z.object({ ...gatewayFrameBase, op: z.literal(1), d: count.nullable() }),
  z.object({ ...gatewayFrameBase, op: z.literal(7), d: z.null() }),
  z.object({ ...gatewayFrameBase, op: z.literal(9), d: z.boolean() }),
  z.object({ ...gatewayFrameBase, op: z.literal(11), d: z.null() }),
]);
export const botGatewayCursorSchema = z.object({ sessionId: text, sequence: count, resumeUrl: botGatewayUrlSchema });
