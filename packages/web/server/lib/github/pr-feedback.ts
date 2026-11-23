import { z } from 'zod';
import { summarizeCheckContexts } from './pr-summaries.js';
import { headRepositorySchema } from '../pr-fix-loop/approval-contract.js';
import type { GitHubFeedbackReader } from './pr-feedback-reader.js';
import type { FailedCheck, FeedbackSnapshot } from '../pr-fix-loop/contracts.js';

const completeConnection = <Node extends z.ZodType>(node: Node) => z.object({
  nodes: z.array(node),
  pageInfo: z.object({ hasPreviousPage: z.literal(false), hasNextPage: z.literal(false) }),
});
const authorSchema = z.object({ __typename: z.string(), login: z.string() }).nullable();
const commentSchema = z.object({
  databaseId: z.number().nullable(), body: z.string(), url: z.string(),
  createdAt: z.string(), author: authorSchema,
});
const contextSchema = z.discriminatedUnion('__typename', [
  z.object({
    __typename: z.literal('CheckRun'), databaseId: z.number().nullable(), name: z.string(),
    status: z.string(), conclusion: z.string().nullable(), startedAt: z.string().nullable(),
    detailsUrl: z.string().nullable(),
    checkSuite: z.object({ app: z.object({ databaseId: z.number().nullable(), slug: z.string() }).nullable() }).nullable(),
  }),
  z.object({
    __typename: z.literal('StatusContext'), context: z.string(), state: z.string(),
    targetUrl: z.string().nullable(), description: z.string().nullable(),
  }),
]);
const feedbackSchema = z.object({
  errors: z.array(z.never()).optional(),
  viewer: z.object({ login: z.string().min(1) }),
  repository: z.object({ pullRequest: z.object({
    number: z.number().int(), title: z.string(), url: z.string(),
    state: z.enum(['OPEN', 'CLOSED', 'MERGED']), headRefName: z.string(),
    headRefOid: z.string().min(1), baseRefName: z.string(), reviewDecision: z.string().nullable(),
    headRepository: z.object({ id: z.string().min(1), name: z.string(), owner: z.object({ login: z.string() }) }).nullable(),
    reviews: completeConnection(z.object({
      databaseId: z.number().nullable(), state: z.string(), body: z.string(),
      submittedAt: z.string().nullable(), url: z.string(), author: authorSchema,
    })),
    reviewThreads: completeConnection(z.object({
      id: z.string(), isResolved: z.boolean(), isOutdated: z.boolean(),
      path: z.string(), line: z.number().nullable(), comments: completeConnection(commentSchema),
    })),
    comments: completeConnection(commentSchema),
    commits: z.object({ nodes: z.array(z.object({ commit: z.object({
      oid: z.string(), statusCheckRollup: z.object({ contexts: completeConnection(contextSchema) }).nullable(),
    }) })).length(1) }),
  }) }),
});

const SNAPSHOT_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number title url state isDraft headRefName headRefOid baseRefName reviewDecision
      headRepository { id name owner { login } }
      reviews(last: 50) { pageInfo { hasPreviousPage hasNextPage } nodes { databaseId state body submittedAt url author { __typename login } } }
      reviewThreads(last: 100) {
        pageInfo { hasPreviousPage hasNextPage }
        nodes {
          id isResolved isOutdated path line
          comments(first: 30) { pageInfo { hasPreviousPage hasNextPage } nodes { databaseId body url createdAt path line author { __typename login } } }
        }
      }
      comments(last: 50) { pageInfo { hasPreviousPage hasNextPage } nodes { databaseId body url createdAt author { __typename login } } }
      commits(last: 1) {
        nodes { commit { oid committedDate statusCheckRollup { contexts(first: 100) { pageInfo { hasPreviousPage hasNextPage } nodes {
          __typename
          ... on CheckRun { databaseId name status conclusion startedAt detailsUrl checkSuite { app { databaseId slug } } }
          ... on StatusContext { context state targetUrl description }
        } } } } }
      }
    }
  }
}`;

const MAX_FAILED_RUNS = 5;
const MAX_ANNOTATIONS = 20;
const LOG_TAIL_LINES = 60;
const LOG_CHARS = 6_000;

const author = (node: { readonly author: z.infer<typeof authorSchema> }) => ({
  login: String(node?.author?.login ?? 'ghost'),
  bot: node?.author?.__typename === 'Bot' || /\[bot\]$/i.test(String(node?.author?.login ?? '')),
});

const authorPermissionSchema = z.object({
  permission: z.enum(['admin', 'write', 'read', 'none']),
  user: z.object({ login: z.string().min(1) }).nullable(),
});

type RepositoryQuery = { readonly octokit: GitHubFeedbackReader; readonly owner: string; readonly repo: string };

export async function readFeedbackAuthorPermission({ octokit, owner, repo, username }: RepositoryQuery & { readonly username: string }) {
  const response = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
  const data = authorPermissionSchema.parse(response.data);
  if (data.permission !== 'admin' && data.permission !== 'write') return false;
  if (data.user?.login.toLowerCase() !== username.toLowerCase()) throw new Error('GitHub returned mismatched feedback author permission.');
  return true;
}

export async function readPullFeedback({ octokit, owner, repo, number }: RepositoryQuery & { readonly number: number }) {
  const data = feedbackSchema.parse(await octokit.graphql(SNAPSHOT_QUERY, { owner, repo, number }));
  const pull = data.repository.pullRequest;
  const commit = pull.commits.nodes[0]?.commit;
  if (!commit || pull.number !== number || commit.oid !== pull.headRefOid) {
    throw new Error('GitHub did not return the pull request');
  }
  const contexts = commit.statusCheckRollup === null ? [] : commit.statusCheckRollup.contexts.nodes;
  return {
    viewer: data.viewer.login,
    state: pull.state === 'MERGED' ? 'merged' : pull.state === 'CLOSED' ? 'closed' : 'open',
    title: pull.title,
    url: pull.url,
    branch: pull.headRefName,
    base: pull.baseRefName,
    headSha: pull.headRefOid,
    headRepo: pull.headRepository === null ? null : headRepositorySchema.parse({
      id: pull.headRepository.id, owner: pull.headRepository.owner.login, repo: pull.headRepository.name,
    }),
    reviewDecision: pull.reviewDecision,
    ci: { ...summarizeCheckContexts(contexts), contexts },
    reviews: pull.reviews.nodes.map((review) => ({
      id: review.databaseId,
      state: review.state,
      body: review.body,
      url: review.url,
      createdAt: review.submittedAt,
      author: author(review),
    })),
    threads: pull.reviewThreads.nodes.map((thread) => ({
      id: thread.id,
      resolved: thread.isResolved,
      outdated: thread.isOutdated,
      path: thread.path,
      line: thread.line,
      comments: thread.comments.nodes.map((comment) => ({
        id: comment.databaseId,
        body: comment.body,
        url: comment.url,
        createdAt: comment.createdAt,
        author: author(comment),
      })),
    })),
    comments: pull.comments.nodes.map((comment) => ({
      id: comment.databaseId,
      body: comment.body,
      url: comment.url,
      createdAt: comment.createdAt,
      author: author(comment),
    })),
  } satisfies FeedbackSnapshot & { readonly base: string };
}

const isFailed = (context: z.infer<typeof contextSchema>) => (context.__typename === 'CheckRun'
  ? ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(context.conclusion ?? '')
  : ['FAILURE', 'ERROR'].includes(context.state));

const relevantLog = (text: string) => {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/, ''));
  const errorAt = lines.findIndex((line) => /##\[error\]|error|failed|✗|FAIL/i.test(line));
  const start = errorAt >= 0 ? Math.max(0, Math.min(errorAt - 10, lines.length - LOG_TAIL_LINES)) : Math.max(0, lines.length - LOG_TAIL_LINES);
  const slice = lines.slice(start, start + LOG_TAIL_LINES * 2).join('\n');
  return slice.length > LOG_CHARS ? slice.slice(slice.length - LOG_CHARS) : slice;
};

type MutableCheck = { -readonly [Key in keyof FailedCheck]: FailedCheck[Key] } & { missing: string[] };
const annotationSchema = z.object({
  path: z.string().nullish(), start_line: z.number().nullish(),
  annotation_level: z.string().nullish(), message: z.unknown(),
});
const jobStepsSchema = z.array(z.object({ name: z.string(), conclusion: z.string().nullish() }).nullable());
const jobSchema = z.object({ steps: z.unknown() }).nullish().catch(undefined);

export async function readFailedChecks({ octokit, owner, repo, contexts }: RepositoryQuery & { readonly contexts: readonly unknown[] }): Promise<FailedCheck[]> {
  const failed = z.array(contextSchema).parse(contexts).filter(isFailed).slice(0, MAX_FAILED_RUNS);
  const results: FailedCheck[] = [];
  for (const context of failed) {
    if (context.__typename !== 'CheckRun') {
      results.push({ name: context.context, url: context.targetUrl ?? null, summary: context.description ?? null, steps: [], annotations: [], log: null });
      continue;
    }
    const entry: MutableCheck = { name: context.name, url: context.detailsUrl ?? null, summary: null, steps: [], annotations: [], log: null, missing: [] };
    const id = context.databaseId;
    try {
      if (id === null) throw new Error('GitHub did not return a check run ID');
      const response = await octokit.rest.checks.listAnnotations({ owner, repo, check_run_id: id, per_page: MAX_ANNOTATIONS });
      entry.annotations = z.array(annotationSchema).parse(Array.isArray(response?.data) ? response.data : []).map((annotation) => ({
        path: annotation.path ?? null,
        line: annotation.start_line ?? null,
        level: annotation.annotation_level ?? null,
        message: String(annotation.message ?? '').slice(0, 500),
      }));
    } catch {
      entry.missing.push('annotations');
    }
    if (context.checkSuite?.app?.slug === 'github-actions') {
      try {
        if (id === null) throw new Error('GitHub did not return an Actions job ID');
        const job = (await octokit.rest.actions.getJobForWorkflowRun({ owner, repo, job_id: id }))?.data;
        const steps = jobSchema.parse(job)?.steps;
        entry.steps = jobStepsSchema.parse(Array.isArray(steps) ? steps : []).flatMap((step) => {
          if (!step?.conclusion || step.conclusion === 'success' || step.conclusion === 'skipped') return [];
          return [{ name: step.name, conclusion: step.conclusion }];
        });
      } catch {
        entry.missing.push('steps');
      }
      try {
        if (id === null) throw new Error('GitHub did not return an Actions job ID');
        const log = await octokit.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: id });
        const contents = log?.data;
        entry.log = relevantLog(Buffer.isBuffer(contents) ? contents.toString('utf8') : contents instanceof ArrayBuffer ? Buffer.from(contents).toString('utf8') : String(contents ?? ''));
      } catch {
        entry.missing.push('log');
      }
    }
    results.push(entry);
  }
  return results;
}
