import { z } from 'zod';
import { invalidProviderPayload } from './mappers.js';

const pullSchema = z.object({
  id: z.string().min(1),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  headRefOid: z.string(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  isInMergeQueue: z.boolean(),
  autoMergeRequest: z.object({ enabledAt: z.string(), mergeMethod: z.string() }).nullable(),
});

const METHODS = ['merge', 'squash', 'rebase'];
const lowerMethod = z.enum(['MERGE', 'SQUASH', 'REBASE']).transform((value) => value.toLowerCase());

const settingsSchema = z.object({
  repository: z.object({
    mergeCommitAllowed: z.boolean(),
    squashMergeAllowed: z.boolean(),
    rebaseMergeAllowed: z.boolean(),
    pullRequest: z.object({
      viewerCanMergeAsAdmin: z.boolean(),
      baseRef: z.object({ branchProtectionRule: z.object({ requiresLinearHistory: z.boolean() }).nullable() }).nullable(),
    }).nullable(),
  }).nullable(),
});

const rulesSchema = z.object({
  repository: z.object({
    pullRequest: z.object({
      isMergeQueueEnabled: z.boolean(),
      baseRef: z.object({
        rules: z.object({
          nodes: z.array(z.object({
            type: z.string(),
            parameters: z.object({
              allowedMergeMethods: z.array(lowerMethod).nullish(),
              mergeMethod: lowerMethod.nullish(),
            }).nullish(),
          }).nullable()),
        }).nullable(),
      }).nullable(),
    }).nullable(),
  }).nullable(),
});

/**
 * How the repository lets this PR land, as GitHub's own merge box decides it:
 * the methods the repository settings and the base branch's protection and
 * rulesets all allow (linear history drops merge commits), whether the base
 * branch has a merge queue and the method it merges with, and whether the
 * viewer may bypass the rules and merge now. Null for an issue or an unknown
 * number.
 *
 * The settings and the rulesets are two reads: a host or token that cannot
 * answer the newer rules still narrows the methods by the settings, and then
 * says nothing about a queue.
 */
export async function readMergeOptions(octokit, { owner, repo, number }) {
  const variables = { owner, repo, number };
  const [settingsData, rulesData] = await Promise.all([
    octokit.graphql(`query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
        pullRequest(number: $number) { viewerCanMergeAsAdmin baseRef { branchProtectionRule { requiresLinearHistory } } }
      }
    }`, variables),
    octokit.graphql(`query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          isMergeQueueEnabled
          baseRef {
            rules(first: 100) {
              nodes {
                type
                parameters {
                  ... on PullRequestParameters { allowedMergeMethods }
                  ... on MergeQueueParameters { mergeMethod }
                }
              }
            }
          }
        }
      }
    }`, variables).catch(() => null),
  ]);
  const settings = settingsSchema.safeParse(settingsData);
  if (!settings.success) throw invalidProviderPayload('GitHub returned invalid merge options');
  const repository = settings.data.repository;
  const pull = repository?.pullRequest;
  if (!repository || !pull) return null;
  const rulesPull = rulesData === null ? null : rulesSchema.safeParse(rulesData).data?.repository?.pullRequest ?? null;
  const rules = (rulesPull?.baseRef?.rules?.nodes ?? []).filter((rule) => rule !== null);
  const linear = pull.baseRef?.branchProtectionRule?.requiresLinearHistory === true
    || rules.some((rule) => rule.type === 'REQUIRED_LINEAR_HISTORY');
  const allowedByRepository = {
    merge: repository.mergeCommitAllowed && !linear, squash: repository.squashMergeAllowed, rebase: repository.rebaseMergeAllowed,
  };
  const methods = METHODS.filter((method) => allowedByRepository[method]
    && rules.every((rule) => rule.type !== 'PULL_REQUEST' || !rule.parameters?.allowedMergeMethods
      || rule.parameters.allowedMergeMethods.includes(method)));
  const queueRule = rules.find((rule) => rule.type === 'MERGE_QUEUE');
  return {
    methods,
    queue: rulesPull?.isMergeQueueEnabled || queueRule ? { method: queueRule?.parameters?.mergeMethod ?? null } : null,
    canBypass: pull.viewerCanMergeAsAdmin,
  };
}

/**
 * Join the base branch's merge queue once the PR's requirements pass, the way
 * GitHub's "Merge when ready" does: auto-merge on a queue branch enqueues the
 * PR, at once when it is already ready. The queue picks the merge method.
 */
export async function mergeWhenReadyInQueue(octokit, project, target) {
  const { pull, hasQueue } = await readWaitingMerge(octokit, project, target);
  if (pull.state === 'MERGED') return { merged: true };
  if (pull.isInMergeQueue) return { merged: false, outcome: 'queued' };
  if (pull.autoMergeRequest) return { merged: false, outcome: 'auto-merge' };
  // Nothing was written: a definite refusal, never an unknown outcome.
  if (!hasQueue) throw Object.assign(new Error('The base branch has no merge queue'), { code: 'SOURCE_CONTROL_MUTATION_REJECTED', status: 409 });
  const data = await octokit.graphql(`mutation($id: ID!, $sha: GitObjectID!) {
    enablePullRequestAutoMerge(input: { pullRequestId: $id, expectedHeadOid: $sha }) {
      pullRequest { isInMergeQueue autoMergeRequest { enabledAt } }
    }
  }`, { id: pull.id, sha: target.headSha });
  const result = data?.enablePullRequestAutoMerge?.pullRequest;
  if (result?.isInMergeQueue === true) return { merged: false, outcome: 'queued' };
  if (!result?.autoMergeRequest?.enabledAt) throw invalidProviderPayload('GitHub did not confirm merge when ready');
  return { merged: false, outcome: 'auto-merge' };
}

/** Read only after a refused merge, or to cancel/reconcile a waiting merge. */
export async function readWaitingMerge(octokit, project, target) {
  const data = await octokit.graphql(`query($owner: String!, $repo: String!, $number: Int!, $base: String!) {
    repository(owner: $owner, name: $repo) {
      mergeQueue(branch: $base) { id }
      pullRequest(number: $number) {
        id state headRefOid mergeable mergeStateStatus isInMergeQueue
        autoMergeRequest { enabledAt mergeMethod }
      }
    }
  }`, { owner: project.owner, repo: project.name, number: target.number, base: target.base });
  const parsed = z.object({ repository: z.object({ mergeQueue: z.object({ id: z.string() }).nullable(), pullRequest: pullSchema }) }).safeParse(data);
  if (!parsed.success) throw invalidProviderPayload('GitHub returned an invalid waiting merge state');
  return { pull: parsed.data.repository.pullRequest, hasQueue: parsed.data.repository.mergeQueue !== null };
}

/** Preserve bypass semantics: the ordinary merge is always attempted first. */
export async function enableMergeWhenReady(octokit, project, target, method) {
  let waiting;
  try { waiting = await readWaitingMerge(octokit, project, target); }
  catch { return null; }
  const { pull, hasQueue } = waiting;
  if (hasQueue || pull.state !== 'OPEN' || pull.headRefOid !== target.headSha
    || pull.mergeable === 'CONFLICTING' || !['BLOCKED', 'UNSTABLE'].includes(pull.mergeStateStatus)) return null;
  if (!pull.autoMergeRequest) {
    const data = await octokit.graphql(`mutation($id: ID!, $mergeMethod: PullRequestMergeMethod!, $sha: GitObjectID!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $mergeMethod, expectedHeadOid: $sha }) {
        pullRequest { autoMergeRequest { enabledAt } }
      }
    }`, { id: pull.id, mergeMethod: method.toUpperCase(), sha: target.headSha });
    if (!data?.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest?.enabledAt) {
      throw invalidProviderPayload('GitHub did not confirm auto-merge');
    }
  }
  return { merged: false, outcome: 'auto-merge' };
}

export async function cancelWaitingMerge(octokit, project, target) {
  let { pull } = await readWaitingMerge(octokit, project, target);
  if (pull.state === 'MERGED') return { merged: true };
  if (pull.isInMergeQueue) {
    const data = await octokit.graphql(`mutation($id: ID!) {
      dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { id } }
    }`, { id: pull.id });
    if (!Object.hasOwn(data ?? {}, 'dequeuePullRequest')) throw invalidProviderPayload('GitHub did not confirm dequeue');
    // Dequeue can also clear auto-merge. Re-read before issuing a disable
    // against a request that may no longer exist.
    ({ pull } = await readWaitingMerge(octokit, project, target));
    if (pull.state === 'MERGED') return { merged: true };
    if (pull.isInMergeQueue) throw invalidProviderPayload('GitHub did not confirm leaving the merge queue');
  }
  if (pull.autoMergeRequest) {
    const data = await octokit.graphql(`mutation($id: ID!) {
      disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { autoMergeRequest { enabledAt } } }
    }`, { id: pull.id });
    if (data?.disablePullRequestAutoMerge?.pullRequest?.autoMergeRequest !== null) {
      throw invalidProviderPayload('GitHub did not confirm disabling auto-merge');
    }
  }
  return { merged: false, outcome: 'cancelled' };
}
