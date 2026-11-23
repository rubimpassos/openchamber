import { z } from 'zod';
import { BotServiceError, providerResult, text, jiraTarget } from './contracts.js';
import type { BotOperationInput, BotOperationTarget, BotServiceAuthority } from './contracts.js';
import type { ResolvedBotCredential } from './credentials.js';

type JiraOperation = 'jira.comment' | 'jira.question' | 'jira.transition';
type JiraCall = { [Operation in JiraOperation]: [operation: Operation, input: BotOperationInput<Operation>] }[JiraOperation];
type JiraCredential = {
  readonly authority: Pick<BotServiceAuthority, 'providerAccountId'>;
  readonly request: ResolvedBotCredential<'jira'>['request'];
};
type AdfInline = { readonly type: 'text'; readonly text: string }
  | { readonly type: 'mention'; readonly attrs: { readonly id: string } };
type AdfDocument = { readonly version: 1; readonly type: 'doc';
  readonly content: { readonly type: 'paragraph'; readonly content: readonly AdfInline[] }[] };
export type JiraCommentPage = {
  readonly comments: readonly { readonly id: string; readonly authorId: string; readonly human: boolean; readonly body: string; readonly createdAt: string }[];
  readonly total: number;
  readonly nextStartAt: number | null;
};

const issue = z.object({ id: text, key: text, fields: z.object({
  project: z.object({ key: text }), status: z.object({ id: text, name: text }),
  summary: z.string(), description: z.unknown().optional(),
  issuetype: z.object({ id: text, name: text, subtask: z.boolean().optional() }).optional(),
}) });
type JiraIssue = Readonly<Pick<z.output<typeof issue>, 'id' | 'key'>
  & Pick<z.output<typeof issue>['fields'], 'summary' | 'status'>> & {
    readonly description: string;
    issueType?: z.output<typeof issue>['fields']['issuetype'];
  };
const comment = z.object({ id: text, author: z.object({ accountId: text, accountType: text.optional() }),
  body: z.unknown(), created: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  updated: text });
const transition = z.object({ id: text, name: text, to: z.object({ id: text, name: text }) });
const adfNode = z.object({ type: z.unknown().optional(), text: z.unknown().optional(), content: z.unknown().optional() });
const plainText = (value: unknown): string => {
  const parsed = adfNode.safeParse(value);
  if (!parsed.success) return '';
  const node = parsed.data;
  const text = z.string().safeParse(node.text);
  if (node.type === 'text' && text.success) return text.data;
  if (!Array.isArray(node.content)) return '';
  return node.content.map(plainText).join(node.type === 'doc' ? '\n' : '').slice(0, 60_000);
};
const adf = (body: string): AdfDocument => ({ version: 1, type: 'doc', content: body.split('\n').map((line) => ({
  type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [],
})) });

export function createJiraAdapter(credential: JiraCredential, target: BotOperationTarget<'jira.comment'>,
  { beforeQuestionWrite }: { readonly beforeQuestionWrite?: (() => void | Promise<void>) | undefined } = {}) {
  const path = `/rest/api/3/issue/${encodeURIComponent(target.issueKey)}`;
  const readIssue = async () => {
    const result = providerResult(issue.safeParse(await credential.request({ path: `${path}?fields=project,status,summary,description,issuetype` })));
    if (result.key !== target.issueKey || result.fields.project.key !== target.projectKey) {
      throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The Jira issue no longer belongs to the selected project.');
    }
    const current: JiraIssue = { id: result.id, key: result.key, summary: result.fields.summary,
      status: result.fields.status, description: plainText(result.fields.description) };
    if (result.fields.issuetype) current.issueType = result.fields.issuetype;
    return current;
  };
  const readTransitions = async () => {
    return providerResult(z.object({ transitions: z.array(transition).max(200) }).safeParse(
      await credential.request({ path: `${path}/transitions` }))).transitions;
  };
  type ReadResult = JiraIssue | Awaited<ReturnType<typeof readTransitions>> | JiraCommentPage;
  type ReadInput = { readonly startAt?: number | undefined };
  function read(operation: 'jira.comments', input: ReadInput): Promise<JiraCommentPage>;
  function read(operation: string, input: ReadInput): Promise<ReadResult>;
  async function read(operation: string, input: ReadInput): Promise<ReadResult> {
    if (operation === 'jira.issue') return readIssue();
    if (operation === 'jira.transitions') { await readIssue(); return readTransitions(); }
    if (operation !== 'jira.comments') throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This Jira read is unsupported.', 'failed', 400);
    await readIssue();
    const startAt = input.startAt ?? 0;
    if (!Number.isSafeInteger(startAt) || startAt < 0) throw new BotServiceError('BOT_SERVICE_INVALID_INPUT', 'The Jira cursor is invalid.', 'failed', 400);
    const page = providerResult(z.object({ startAt: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
      comments: z.array(comment).max(100) }).safeParse(await credential.request({
      path: `${path}/comment?startAt=${startAt}&maxResults=100&orderBy=created`,
    })));
    if (page.startAt !== startAt || page.comments.length === 0 && startAt < page.total) {
      throw new BotServiceError('BOT_SERVICE_RESPONSE_INVALID', 'The Jira comment page is incomplete.');
    }
    return { comments: page.comments.map((entry) => ({ id: entry.id, authorId: entry.author.accountId,
      human: entry.author.accountType === 'atlassian' && entry.author.accountId !== credential.authority.providerAccountId,
      body: plainText(entry.body), createdAt: entry.created,
    })), total: page.total, nextStartAt: startAt + page.comments.length < page.total ? startAt + page.comments.length : null };
  }
  return {
    async perform(...[operation, input]: JiraCall) {
      const current = await readIssue();
      switch (operation) {
      case 'jira.comment':
      case 'jira.question': {
        const document = adf(input.body);
        switch (operation) {
        case 'jira.comment': break;
        case 'jira.question':
          if (!(beforeQuestionWrite instanceof Function)) throw new BotServiceError('BOT_QUESTION_AUTHORITY_REQUIRED', 'Question mentions require service authorization.');
          document.content.unshift({ type: 'paragraph', content: input.recipients.map((person) => ({ type: 'mention', attrs: { id: person.serviceId } })) });
          break;
        default: operation satisfies never;
        }
        const result = providerResult(z.object({ id: text }).safeParse(await credential.request({
          path: `${path}/comment`, method: 'POST', body: { body: document },
          beforeWrite: operation === 'jira.question' ? beforeQuestionWrite : undefined,
        })), true);
        return { commentId: result.id, issueKey: target.issueKey };
      }
      case 'jira.transition': {
      const available = await readTransitions();
      const selected = available.find((entry) => entry.id === input.transitionId);
      if (!selected || selected.to.id !== input.expectedStatusId) {
        throw new BotServiceError('BOT_JIRA_TRANSITION_UNAVAILABLE', 'Select a currently available Jira transition.');
      }
      await credential.request({ path: `${path}/transitions`, method: 'POST', body: { transition: { id: selected.id } } });
      return { issueKey: target.issueKey, previousStatusId: current.status.id, statusId: selected.to.id };
      }
      default: {
        operation satisfies never;
        throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This Jira operation is unsupported.', 'failed', 400);
      }
      }
    },
    async reconcile(...[operation, input]: JiraCall) {
      switch (operation) {
      case 'jira.comment':
      case 'jira.question': return { state: 'outcome-unknown' as const };
      case 'jira.transition': {
      const current = await readIssue();
      return current.status.id === input.expectedStatusId
        ? { state: 'succeeded' as const, result: { issueKey: target.issueKey, statusId: current.status.id } }
        : { state: 'outcome-unknown' as const };
      }
      default: {
        operation satisfies never;
        throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This Jira operation is unsupported.', 'failed', 400);
      }
      }
    },
    read,
  };
}

export async function searchJiraIssues(credential: Pick<JiraCredential, 'request'>, input: unknown) {
  const query = z.object({ jql: z.string().min(1).max(4_000), nextPageToken: text.optional(),
    maxResults: z.number().int().min(1).max(100).default(50) }).strict();
  const parsed = query.safeParse(input);
  if (!parsed.success) {
    throw new BotServiceError('BOT_SERVICE_INVALID_INPUT', 'The Jira search input is invalid.', 'failed', 400);
  }
  const params = new URLSearchParams({ jql: parsed.data.jql,
    maxResults: String(parsed.data.maxResults), fields: 'project,status,summary,description' });
  if (parsed.data.nextPageToken) params.set('nextPageToken', parsed.data.nextPageToken);
  const page = providerResult(z.object({ issues: z.array(issue).max(100), isLast: z.boolean().optional(), nextPageToken: text.optional() }).safeParse(
    await credential.request({ path: `/rest/api/3/search/jql?${params}` })));
  if (page.issues.some((entry) => !jiraTarget.safeParse({ projectKey: entry.fields.project.key, issueKey: entry.key }).success)
    || page.isLast === false && !page.nextPageToken) {
    throw new BotServiceError('BOT_SERVICE_RESPONSE_INVALID', 'The Jira search scope or cursor is invalid.');
  }
  return { issues: page.issues.map((entry) => ({ id: entry.id, key: entry.key, summary: entry.fields.summary,
    status: entry.fields.status, description: plainText(entry.fields.description) })), nextPageToken: page.isLast === true ? null : page.nextPageToken ?? null };
}
