import { z } from 'zod';
import { BotServiceError, branch, parse, providerResult, revision, sha, text } from './contracts.js';
import { readGitHubBranchRules } from './branch-rules.js';
import type { BotOperationInput, BotOperationTarget } from './contracts.js';
import type { BotGitPublishOptions, BotGitPublication } from './git.js';

const graphqlEnvelope = z.object({ data: z.record(z.string(), z.json()), errors: z.array(z.json()).optional() });
type GitHubGraphQLData = z.output<typeof graphqlEnvelope>['data'];
type GitHubOperation = 'git.push' | 'pr.open' | 'pr.comment' | 'pr.auto-merge' | 'pr.disable-auto-merge' | 'pr.dequeue';
type GitHubCall = { [Operation in GitHubOperation]: [operation: Operation, input: BotOperationInput<Operation>] }[GitHubOperation];
type GitHubReadCall = [operation: 'github.authorization', input: BotOperationInput<'pr.dequeue'>]
  | [operation: 'github.rules' | 'github.branch-rules' | 'github.branch', input: { readonly branch: string }]
  | [operation: 'github.pull', input: { readonly number: number; readonly headSha?: string | undefined }];
type Revocation = { readonly state: 'outcome-unknown' } | { readonly state: 'succeeded'; readonly result: {
  readonly number: number; readonly headSha: string; readonly merged: boolean;
} };
type GitHubOptions = {
  readonly publishGit: (options: Omit<BotGitPublishOptions, 'policyOptions'> & {
    readonly graphql: (query: string, variables: Readonly<Record<string, string>>, write?: boolean) => Promise<GitHubGraphQLData>;
  }) => Promise<BotGitPublication>;
  readonly beforeAdmission?: (() => void | Promise<void>) | undefined;
  readonly ownedBranch?: string | undefined;
};

const gitRef = z.object({ ref: text, object: z.object({ sha }) });
const pullSchema = z.object({ number: revision, node_id: text, state: z.enum(['open', 'closed']),
  head: z.object({ sha, ref: branch, repo: z.object({ full_name: text }).nullable() }),
  base: z.object({ ref: branch, repo: z.object({ full_name: text }) }),
});

export function createGitHubAdapter(credential: BotGitPublishOptions['credential'], target: BotOperationTarget<'git.push'>,
  { publishGit, beforeAdmission, ownedBranch }: GitHubOptions) {
  const repository = `${target.owner}/${target.repo}`;
  const root = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const matchesRepo = (value: string | undefined) => value?.toLowerCase() === repository.toLowerCase();
  const graphql = async (query: string, variables: Readonly<Record<string, string>>, write = false) => {
    const response = await credential.request({ path: '/graphql', method: 'POST', body: { query, variables }, readOnly: !write });
    const envelope = graphqlEnvelope.safeParse(response);
    if (!envelope.success || envelope.data.errors?.length) throw new BotServiceError('BOT_GITHUB_GRAPHQL_REJECTED',
      'GitHub could not authorize or complete the operation.', write ? 'outcome-unknown' : 'needs-you', 422);
    return envelope.data.data;
  };
  const readBranch = async (name: string, missingAllowed = false) => {
    parse(branch.safeParse(name));
    let result;
    try { result = providerResult(gitRef.safeParse(await credential.request({ path: `${root}/git/ref/heads/${encodeURIComponent(name)}` }))); }
    catch (error) {
      if (missingAllowed && error instanceof BotServiceError && error.code === 'BOT_SERVICE_REJECTED' && error.status === 404) return null;
      throw error;
    }
    if (result.ref !== `refs/heads/${name}`) throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'GitHub returned another branch.');
    return result.object.sha;
  };
  const readPull = async (number: number, headSha?: string) => {
    parse(revision.safeParse(number));
    const pull = providerResult(pullSchema.safeParse(await credential.request({ path: `${root}/pulls/${number}` })));
    if (pull.number !== number || !matchesRepo(pull.base.repo.full_name) || !matchesRepo(pull.head.repo?.full_name)
      || headSha && pull.head.sha !== headSha || ownedBranch && pull.head.ref !== ownedBranch) throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The GitHub pull request or its head changed.');
    return pull;
  };
  const readAuthorization = async (input: BotOperationInput<'pr.dequeue'>) => {
    const pull = await readPull(input.number);
    if (pull.head.ref !== input.branch) throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The owned GitHub branch changed.');
    const result = await graphql(`query BotAuthorization($id:ID!) { node(id:$id) { ... on PullRequest {
      id number headRefName baseRefName headRefOid baseRefOid merged
      headRepository { nameWithOwner } baseRepository { nameWithOwner }
      autoMergeRequest { enabledAt } mergeQueueEntry { id }
    } } }`, { id: pull.node_id });
    const node = providerResult(z.object({ id: text, number: revision, headRefName: branch, baseRefName: branch,
      headRefOid: sha, baseRefOid: sha, merged: z.boolean(),
      headRepository: z.object({ nameWithOwner: text }), baseRepository: z.object({ nameWithOwner: text }),
      autoMergeRequest: z.object({ enabledAt: text }).nullable(), mergeQueueEntry: z.object({ id: text }).nullable(),
    }).safeParse(result.node));
    if (node.id !== pull.node_id || node.number !== input.number || node.headRefName !== input.branch
      || node.baseRefName !== pull.base.ref || !matchesRepo(node.headRepository.nameWithOwner)
      || !matchesRepo(node.baseRepository.nameWithOwner)) throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The GitHub authorization target changed.');
    return { id: node.id, number: node.number, headSha: node.headRefOid, baseSha: node.baseRefOid,
      merged: node.merged, autoMerge: node.autoMergeRequest !== null, queued: node.mergeQueueEntry !== null };
  };
  const revoke = async (operation: 'pr.disable-auto-merge' | 'pr.dequeue', input: BotOperationInput<'pr.dequeue'>, readOnly: boolean): Promise<Revocation> => {
    let status = await readAuthorization(input);
    const field = operation === 'pr.disable-auto-merge' ? 'autoMerge' : 'queued';
    if (!status.merged && status[field] && !readOnly) {
      if (operation === 'pr.disable-auto-merge') await graphql(`mutation BotDisableAutoMerge($id:ID!) {
        disablePullRequestAutoMerge(input:{pullRequestId:$id}) { __typename }
      }`, { id: status.id }, true);
      else await graphql(`mutation BotDequeue($id:ID!) {
        dequeuePullRequest(input:{id:$id}) { __typename }
      }`, { id: status.id }, true);
      status = await readAuthorization(input);
    }
    if (!status.merged && status[field]) return { state: 'outcome-unknown' };
    return { state: 'succeeded', result: { number: input.number, headSha: status.headSha, merged: status.merged } };
  };
  const findPull = async (input: BotOperationInput<'pr.open'>) => {
    const query = new URLSearchParams({ state: 'all', head: `${target.owner}:${input.branch}`, base: input.base, per_page: '100' });
    const pulls = providerResult(z.array(pullSchema).max(100).safeParse(await credential.request({ path: `${root}/pulls?${query}` })));
    if (pulls.length === 100) throw new BotServiceError('BOT_GITHUB_RECONCILIATION_INCOMPLETE', 'The unique bot branch has too many pull requests to reconcile.');
    const matches = pulls.filter((pull) => matchesRepo(pull.head.repo?.full_name) && matchesRepo(pull.base.repo.full_name)
      && pull.head.ref === input.branch && pull.base.ref === input.base && pull.head.sha === input.headSha);
    if (matches.length > 1) throw new BotServiceError('BOT_GITHUB_BRANCH_REUSED', 'The bot branch has more than one matching pull request.');
    return matches[0] ?? null;
  };
  const pullReceipt = (pull: z.output<typeof pullSchema>) => ({ number: pull.number, head: pull.head.ref, base: pull.base.ref, headSha: pull.head.sha });
  const readRules = async (name: string) => {
    parse(branch.safeParse(name));
    const response = await graphql(`query BotBranchRules($owner:String!,$repo:String!,$ref:String!) {
      repository(owner:$owner,name:$repo) { autoMergeAllowed ref(qualifiedName:$ref) {
        target { ... on Commit { oid } }
        branchProtectionRule { requiresCommitSignatures requiresApprovingReviews requiredApprovingReviewCount requiresStatusChecks }
        rules(first:100) { pageInfo { hasNextPage } nodes { type } }
      } }
    }`, { owner: target.owner, repo: target.repo, ref: `refs/heads/${name}` });
    const repositoryRules = providerResult(z.object({ ref: z.unknown().optional(), autoMergeAllowed: z.unknown().optional() }).nullable().optional().safeParse(response.repository));
    const ref = providerResult(z.object({ target: z.object({ oid: sha }), branchProtectionRule: z.object({
      requiresCommitSignatures: z.boolean(), requiresApprovingReviews: z.boolean(),
      requiredApprovingReviewCount: z.number().int().nonnegative().nullable(), requiresStatusChecks: z.boolean(),
    }).nullable(), rules: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }),
      nodes: z.array(z.object({ type: text })).max(100) }) }).safeParse(repositoryRules?.ref));
    const autoMergeAllowed = providerResult(z.boolean().safeParse(repositoryRules?.autoMergeAllowed));
    if (ref.rules.pageInfo.hasNextPage) throw new BotServiceError('BOT_GITHUB_RULES_INCOMPLETE', 'The branch has more rules than one read returns.');
    const ruleTypes = ref.rules.nodes.map((rule) => rule.type.toLowerCase());
    return { branch: name, headSha: ref.target.oid, requiredSignatures: ref.branchProtectionRule?.requiresCommitSignatures === true
      || ruleTypes.includes('required_signatures'),
    mergeQueue: ruleTypes.includes('merge_queue'), autoMergeAllowed, legacyProtection: ref.branchProtectionRule, ruleTypes };
  };
  function read(operation: 'github.authorization', input: BotOperationInput<'pr.dequeue'>): Promise<Omit<Awaited<ReturnType<typeof readAuthorization>>, 'id'>>;
  function read(operation: 'github.rules', input: { readonly branch: string }): ReturnType<typeof readRules>;
  function read(operation: 'github.branch-rules', input: { readonly branch: string }): ReturnType<typeof readGitHubBranchRules>;
  function read(operation: 'github.branch', input: { readonly branch: string }): Promise<{ readonly headSha: string | null }>;
  function read(operation: 'github.pull', input: { readonly number: number; readonly headSha?: string | undefined }): Promise<ReturnType<typeof pullReceipt> & { readonly state: 'open' | 'closed' }>;
  function read(...call: GitHubReadCall): Promise<GitHubReadResult>;
  async function read(...[operation, input]: GitHubReadCall) {
    switch (operation) {
    case 'github.authorization': {
      const { id: _id, ...status } = await readAuthorization(input);
      return status;
    }
    case 'github.rules': return readRules(input.branch);
    case 'github.branch-rules': return readGitHubBranchRules(credential, target, input.branch);
    case 'github.branch': return { headSha: await readBranch(input.branch, true) };
    case 'github.pull': {
      const pull = await readPull(input.number, input.headSha);
      return { ...pullReceipt(pull), state: pull.state };
    }
    default: { operation satisfies never; throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This GitHub read is unsupported.', 'failed', 400); }
    }
  }
  type GitHubReadResult = Awaited<ReturnType<typeof readRules> | ReturnType<typeof readGitHubBranchRules>> | Omit<Awaited<ReturnType<typeof readAuthorization>>, 'id'>
    | { readonly headSha: string | null } | (ReturnType<typeof pullReceipt> & { readonly state: 'open' | 'closed' });
  return {
    async perform(...[operation, input]: GitHubCall) {
      switch (operation) {
      case 'pr.disable-auto-merge':
      case 'pr.dequeue': {
        const result = await revoke(operation, input, false);
        if (result.state !== 'succeeded') throw new BotServiceError('BOT_REMOTE_AUTHORIZATION_ACTIVE', 'Remote auto-merge may still be active.', 'outcome-unknown');
        return result.result;
      }
      case 'git.push': return publishGit({ credential, target, input, readBranch, readRules,
        readPublicationRules: (name) => readGitHubBranchRules(credential, target, name), graphql, root });
      case 'pr.open': {
        if (input.branch === input.base || await readBranch(input.branch) !== input.headSha) {
          throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The bot branch changed before the pull request was opened.');
        }
        await readBranch(input.base);
        const existing = await findPull(input);
        if (existing) return pullReceipt(existing);
        const pull = providerResult(pullSchema.safeParse(await credential.request({ path: `${root}/pulls`, method: 'POST',
          body: { head: input.branch, base: input.base, title: input.title, body: input.body, draft: input.draft },
        })), true);
        if (!matchesRepo(pull.head.repo?.full_name) || !matchesRepo(pull.base.repo.full_name)
          || pull.head.sha !== input.headSha || pull.head.ref !== input.branch || pull.base.ref !== input.base) {
          throw new BotServiceError('BOT_SERVICE_RESPONSE_INVALID', 'The GitHub pull request receipt changed its target.', 'outcome-unknown');
        }
        return pullReceipt(pull);
      }
      case 'pr.comment': {
        await readPull(input.number, input.headSha);
        const comment = providerResult(z.object({ id: revision }).safeParse(await credential.request({
          path: `${root}/issues/${input.number}/comments`, method: 'POST', body: { body: input.body },
        })), true);
        return { number: input.number, headSha: input.headSha, commented: true, commentId: comment.id };
      }
      case 'pr.auto-merge': {
      const pull = await readPull(input.number, input.headSha);
      if (pull.state !== 'open') throw new BotServiceError('BOT_GITHUB_PULL_CLOSED', 'The bot pull request is closed.');
      if (!input.baseSha || !input.branch || pull.head.ref !== input.branch) throw new BotServiceError('BOT_ADMISSION_TUPLE_REQUIRED', 'A fresh head, base and owned branch are required.');
      const rules = await readRules(pull.base.ref);
      if (rules.headSha !== input.baseSha) throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The GitHub base changed before admission.');
      if (input.mode === 'queue') {
        if (!rules.mergeQueue) throw new BotServiceError('BOT_GITHUB_QUEUE_REQUIRED', 'This branch has no GitHub merge queue.');
        await beforeAdmission?.();
        const result = await graphql(`mutation BotEnqueue($id:ID!,$head:GitObjectID!) {
          enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head,jump:false}) { mergeQueueEntry { id } }
        }`, { id: pull.node_id, head: input.headSha }, true);
        providerResult(z.object({ enqueuePullRequest: z.object({ mergeQueueEntry: z.object({ id: text }) }) }).safeParse(result), true);
         return { number: input.number, headSha: input.headSha, status: 'enqueued' as const };
      }
      if (rules.requiredSignatures && input.mergeMethod === 'REBASE') {
        throw new BotServiceError('BOT_GITHUB_SIGNED_REBASE_DENIED', 'GitHub rebase merging cannot preserve verified bot signatures.');
      }
      await beforeAdmission?.();
      const result = await graphql(`mutation BotAutoMerge($id:ID!,$head:GitObjectID!,$method:PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input:{pullRequestId:$id,expectedHeadOid:$head,mergeMethod:$method}) {
          pullRequest { headRefOid autoMergeRequest { enabledAt } }
        }
      }`, { id: pull.node_id, head: input.headSha, method: input.mergeMethod }, true);
      const enabled = providerResult(z.object({ enablePullRequestAutoMerge: z.object({ pullRequest: z.object({
        headRefOid: sha, autoMergeRequest: z.object({ enabledAt: text }),
      }) }) }).safeParse(result), true);
      if (enabled.enablePullRequestAutoMerge.pullRequest.headRefOid !== input.headSha) {
        throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The GitHub head changed during auto-merge admission.', 'outcome-unknown');
      }
      return { number: input.number, headSha: input.headSha, status: 'pending' as const };
      }
      default: { operation satisfies never; throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This GitHub operation is unsupported.', 'failed', 400); }
      }
    },
    async reconcile(...[operation, input]: GitHubCall) {
      switch (operation) {
      case 'pr.disable-auto-merge':
      case 'pr.dequeue': return revoke(operation, input, true);
      case 'pr.comment': return { state: 'outcome-unknown' as const };
      case 'git.push': {
        const head = await readBranch(input.branch, true);
         return head === input.headSha ? { state: 'succeeded' as const, result: { headSha: head, sourceHeadSha: input.headSha } }
           : { state: 'outcome-unknown' as const };
      }
      case 'pr.open': {
        const pull = await findPull(input);
         return pull ? { state: 'succeeded' as const, result: pullReceipt(pull) } : { state: 'outcome-unknown' as const };
      }
      case 'pr.auto-merge': {
      const pull = await readPull(input.number, input.headSha);
      const result = await graphql(`query BotQueuedPull($id:ID!) { node(id:$id) { ... on PullRequest {
        headRefOid mergeQueueEntry { id } autoMergeRequest { enabledAt } merged
      } } }`, { id: pull.node_id });
      const node = providerResult(z.object({ headRefOid: sha, merged: z.boolean(), mergeQueueEntry: z.object({ id: text }).nullable(),
        autoMergeRequest: z.object({ enabledAt: text }).nullable() }).safeParse(result.node));
      return node.headRefOid === input.headSha && (node.mergeQueueEntry || node.merged || input.mode === 'auto-merge' && node.autoMergeRequest)
         ? { state: 'succeeded' as const, result: { number: input.number, headSha: input.headSha,
           status: node.merged ? 'merged' as const : node.mergeQueueEntry ? 'enqueued' as const : 'pending' as const } }
        : { state: 'outcome-unknown' as const };
      }
      default: { operation satisfies never; throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This GitHub operation is unsupported.', 'failed', 400); }
      }
    },
    read,
  };
}
