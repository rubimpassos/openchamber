import { mergeStackBottom, readNativeStack, registerPullStack } from './pr-stacks.js';
import { invalidProviderPayload, matchesGitHubRepositoryUrl, requireGitHubPullRequest, requireProviderArray } from './mappers.js';
import type { Octokit, RestEndpointMethodTypes } from './contracts.js';
import type { ResolvedMutationTarget } from '../source-control/provider-contract.js';
import type { GitHubMutationInput } from './mutations.js';
import type { MutationResult } from '../source-control/mutation-storage.js';

type StackOctokit = Octokit & { readonly openChamberHost?: string };
type MergeTarget = { readonly number: number; readonly head: { readonly ref: string; readonly sha: unknown }; readonly base: { readonly ref: string } };
interface MergeRequest { readonly owner?: unknown; readonly repo?: unknown; readonly pull_number?: unknown; readonly sha?: unknown }
const hasRequestFields = (value: unknown): value is MergeRequest => value != null;
const canMarkPartial = (value: unknown): value is { sourceControlPartialMutation?: boolean } => value != null;

const changedTarget = () => Object.assign(new Error('GitHub pull request no longer matches the mutation target'), {
  code: 'SOURCE_CONTROL_MUTATION_TARGET_CHANGED', status: 409,
});
const matchesTarget = (target: ResolvedMutationTarget, pull: MergeTarget) => pull.number === target.number
  && pull.head.ref === target.head && pull.base.ref === target.base && pull.head.sha === target.headSha;

/** Native merges include lower layers; inferred stacks require bottom-up order. */
export async function requireMergeStackOrder({ octokit, project, pull }: {
  readonly octokit: Octokit; readonly project: { readonly owner: string; readonly name: string };
  readonly pull: { readonly number: number; readonly base: { readonly ref: string } };
}) {
  const response = await octokit.rest.pulls.list({
    owner: project.owner, repo: project.name, state: 'open', head: `${project.owner}:${pull.base.ref}`, per_page: 100,
  });
  const parents = requireProviderArray<RestEndpointMethodTypes['pulls']['list']['response']['data'][number]>(response?.data, 'GitHub returned an invalid parent pull request list');
  if (parents.length >= 100 || /rel="next"/.test(response.headers?.link ?? '')) {
    throw invalidProviderPayload('GitHub returned an incomplete parent pull request list');
  }
  let hasParent = false;
  for (const value of parents) {
    const parent = requireGitHubPullRequest(value, 'GitHub returned an invalid parent pull request');
    if (parent.state !== 'open' || parent.head.ref !== pull.base.ref || !parent.head.repo) {
      throw invalidProviderPayload('GitHub returned an invalid parent pull request');
    }
    if (parent.head.repo.owner.login.toLowerCase() === project.owner.toLowerCase()
      && parent.head.repo.name.toLowerCase() === project.name.toLowerCase()) {
      hasParent = true;
    }
  }
  if (!hasParent) return;
  const native = await readNativeStack(octokit, project.owner, project.name, pull.number);
  if (native === undefined) {
    throw Object.assign(new Error('GitHub native stack membership is unavailable'), {
      code: 'SOURCE_CONTROL_MUTATION_STACK_UNAVAILABLE', status: 503,
    });
  }
  if (native) return;
  throw Object.assign(new Error('Only the bottom pull request of an inferred stack can be merged'), {
    code: 'SOURCE_CONTROL_MUTATION_STACK_ORDER', status: 409,
  });
}

/** Pin the helpers' fresh snapshot and every merge dispatch to the admitted commit. */
export async function performStackMutation({ octokit, operation, input, target }: {
  readonly octokit: StackOctokit; readonly operation: string; readonly input: GitHubMutationInput;
  readonly target: ResolvedMutationTarget;
}): Promise<MutationResult> {
  const project = target.project;
  let mergeDispatched = false;
  const assertMergeTarget = (value: unknown) => {
    if (!hasRequestFields(value)) throw changedTarget();
    const request = value;
    if (request.owner !== project.owner || request.repo !== project.name
      || request.pull_number !== target.number || request.sha !== target.headSha) throw changedTarget();
    mergeDispatched = true;
  };
  const stackOctokit: StackOctokit = {
    ...octokit,
    request: Object.assign((route: Parameters<Octokit['request']>[0], request?: Parameters<Octokit['request']>[1]) => {
      if (route === 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async') assertMergeTarget(request);
      return octokit.request(route, request);
    }, octokit.request),
    rest: { ...octokit.rest, pulls: { ...octokit.rest.pulls,
      list: Object.assign(async (request: RestEndpointMethodTypes['pulls']['list']['parameters']) => {
        const response = await octokit.rest.pulls.list(request);
        if (request.state === 'open') {
          const current = requireProviderArray<RestEndpointMethodTypes['pulls']['list']['response']['data'][number]>(response?.data, 'GitHub returned an invalid pull request list')
            .find((pull) => pull.number === target.number);
          if (current) {
            const pull = requireGitHubPullRequest(current, 'GitHub returned an invalid pull request');
            const base = pull.base.repo;
            if (base?.owner?.login !== project.owner || base?.name !== project.name
              || !matchesGitHubRepositoryUrl(base.html_url, project.owner, project.name, octokit.openChamberHost || '')
              || !matchesTarget(target, pull)) throw changedTarget();
          }
        }
        return response;
      }, octokit.rest.pulls.list),
      merge: Object.assign(async (request: RestEndpointMethodTypes['pulls']['merge']['parameters']) => {
        assertMergeTarget(request);
        const response = await octokit.rest.pulls.merge(request);
        if (response?.data?.merged !== true) throw invalidProviderPayload('GitHub did not confirm the stack merge');
        return response;
      }, octokit.rest.pulls.merge),
    } },
  };
  const request = { octokit: stackOctokit, owner: project.owner, repo: project.name, number: target.number };
  try {
    switch (operation) {
      case 'stack-register': {
        const result = await registerPullStack(request);
        return { ok: true, registered: result.registered, nativeNumber: result.nativeNumber };
      }
      case 'stack-merge':
        return { ok: true, ...await mergeStackBottom({ ...request, method: input.method }) };
      default:
        throw new Error('Unsupported stack mutation');
    }
  } catch (error) {
    // A retarget refusal after a merge cannot make the composite write retryable.
    if (mergeDispatched) {
      if (!canMarkPartial(error)) throw new TypeError('Cannot set properties of null or undefined');
      error.sourceControlPartialMutation = true;
    }
    throw error;
  }
}
