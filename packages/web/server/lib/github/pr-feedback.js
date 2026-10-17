// What a PR fix loop reads from GitHub: one GraphQL document for the PR's
// state, head, CI contexts, review threads, reviews and conversation
// comments, and REST reads for the details of failed checks (steps,
// annotations, a bounded slice of the job log). Every read throws on failure;
// the loop keeps its last known state rather than reading a failure as green
// or as "no comments".

import { z } from 'zod';
import { summarizeCheckContexts } from './pr-summaries.js';
import { headRepositorySchema } from '../pr-fix-loop/approval-contract.js';

// Reject bounded reads with omitted pages. Only commits deliberately selects
// a subset: the latest commit must match the PR's reported head.
const completeConnection = (node) => z.object({
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

const author = (node) => ({
  login: String(node?.author?.login ?? 'ghost'),
  bot: node?.author?.__typename === 'Bot' || /\[bot\]$/i.test(String(node?.author?.login ?? '')),
});

const authorPermissionSchema = z.object({
  permission: z.enum(['admin', 'write', 'read', 'none']),
  user: z.object({ login: z.string().min(1) }).nullable(),
});

/** Uses the loop's exact read account. Unknown authority remains a failed read. */
export async function readFeedbackAuthorPermission({ octokit, owner, repo, username }) {
  const response = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
  const data = authorPermissionSchema.parse(response.data);
  if (data.permission !== 'admin' && data.permission !== 'write') return false;
  if (data.user?.login.toLowerCase() !== username.toLowerCase()) throw new Error('GitHub returned mismatched feedback author permission.');
  return true;
}

/** The PR as the loop needs it. Throws when GitHub did not answer it. */
export async function readPullFeedback({ octokit, owner, repo, number }) {
  const data = feedbackSchema.parse(await octokit.graphql(SNAPSHOT_QUERY, { owner, repo, number }));
  const pull = data.repository.pullRequest;
  const commit = pull.commits.nodes[0].commit;
  if (pull.number !== number || commit.oid !== pull.headRefOid) {
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
  };
}

const isFailed = (context) => (context.__typename === 'CheckRun'
  ? ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(context.conclusion)
  : ['FAILURE', 'ERROR'].includes(context.state));

const relevantLog = (text) => {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/, ''));
  const errorAt = lines.findIndex((line) => /##\[error\]|error|failed|✗|FAIL/i.test(line));
  const start = errorAt >= 0 ? Math.max(0, Math.min(errorAt - 10, lines.length - LOG_TAIL_LINES)) : Math.max(0, lines.length - LOG_TAIL_LINES);
  const slice = lines.slice(start, start + LOG_TAIL_LINES * 2).join('\n');
  return slice.length > LOG_CHARS ? slice.slice(slice.length - LOG_CHARS) : slice;
};

/**
 * The failed checks of a head with what explains them. A detail that cannot
 * be read is reported as missing on that check; other checks still come.
 */
export async function readFailedChecks({ octokit, owner, repo, contexts }) {
  const failed = contexts.filter(isFailed).slice(0, MAX_FAILED_RUNS);
  const results = [];
  for (const context of failed) {
    if (context.__typename !== 'CheckRun') {
      results.push({ name: context.context, url: context.targetUrl ?? null, summary: context.description ?? null, steps: [], annotations: [], log: null });
      continue;
    }
    const entry = { name: context.name, url: context.detailsUrl ?? null, summary: null, steps: [], annotations: [], log: null, missing: [] };
    const id = context.databaseId;
    try {
      const response = await octokit.rest.checks.listAnnotations({ owner, repo, check_run_id: id, per_page: MAX_ANNOTATIONS });
      entry.annotations = (Array.isArray(response?.data) ? response.data : []).map((annotation) => ({
        path: annotation.path ?? null,
        line: annotation.start_line ?? null,
        level: annotation.annotation_level ?? null,
        message: String(annotation.message ?? '').slice(0, 500),
      }));
    } catch {
      entry.missing.push('annotations');
    }
    // An Actions job id is its check run id; other apps have no job.
    if (context.checkSuite?.app?.slug === 'github-actions') {
      try {
        const job = (await octokit.rest.actions.getJobForWorkflowRun({ owner, repo, job_id: id }))?.data;
        entry.steps = (Array.isArray(job?.steps) ? job.steps : [])
          .filter((step) => step?.conclusion && step.conclusion !== 'success' && step.conclusion !== 'skipped')
          .map((step) => ({ name: String(step.name), conclusion: String(step.conclusion) }));
      } catch {
        entry.missing.push('steps');
      }
      try {
        const log = await octokit.rest.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id: id });
        entry.log = relevantLog(Buffer.isBuffer(log?.data) || log?.data instanceof ArrayBuffer ? Buffer.from(log.data).toString('utf8') : String(log?.data ?? ''));
      } catch {
        entry.missing.push('log');
      }
    }
    results.push(entry);
  }
  return results;
}
