import type { GitAPI, PullStack, RestackRun, SourceControlAPI, SourceControlReadContext } from '@/lib/api/types';
import {
  BoundGitNetworkOperationError, buildBoundBranchPushRequest, GitOperationResultError,
  isGitOperationUnresolved, runBoundGitNetworkOperation, type GitOperationRead,
} from '@/lib/boundGitNetworkOperation';
import { restackPublicationPlan } from './restackState';

/** Publishes only changed branches. A rejected lease leaves local commits and other successes intact. */
export async function publishRestack(input: {
  readonly run: RestackRun;
  readonly stack: PullStack;
  readonly context: SourceControlReadContext;
  readonly heads?: ReadonlyMap<string, string>;
  readonly alreadyPushed: ReadonlySet<string>;
}, dependencies: {
  readonly sourceControl: SourceControlAPI;
  readonly git: GitAPI;
  readonly isCurrent: () => boolean;
  readonly onOperation: (read: GitOperationRead) => void;
}) {
  const { run, stack, context, heads, alreadyPushed } = input;
  const { sourceControl, git, isCurrent, onOperation } = dependencies;
  const plan = restackPublicationPlan(run, stack, heads);
  const pushed: string[] = [];
  const failures: Array<{ branch: string; error: string | null }> = plan.blocked.map((branch) => ({ branch, error: null }));
  const bindingRead = await sourceControl.repositoryBinding(run.directory);
  if (!isCurrent()) throw new BoundGitNetworkOperationError('stale-runtime');
  if (bindingRead.repository.repositoryId !== context.repositoryId || bindingRead.revision !== context.bindingRevision) {
    throw new BoundGitNetworkOperationError('binding-needs-attention');
  }
  const remaining = plan.publish.filter((entry) => !alreadyPushed.has(entry.branch));
  for (const [index, entry] of remaining.entries()) {
    if (!isCurrent()) break;
    try {
      const pushRequest = buildBoundBranchPushRequest({
        bindingRead, directory: run.directory, branch: entry.branch, remoteName: run.remote,
        destinationRef: `refs/heads/${entry.branch}`, forceWithLease: { expectedRemoteSha: entry.expectedRemoteSha },
      });
      await runBoundGitNetworkOperation({ action: 'push', directory: run.directory, remoteName: run.remote, pushRequest, sourceControl, git, onOperation });
      pushed.push(entry.branch);
    } catch (error) {
      failures.push({ branch: entry.branch, error: error instanceof Error ? error.message : String(error) });
      if (error instanceof GitOperationResultError && isGitOperationUnresolved(error.read)) {
        failures.push(...remaining.slice(index + 1).map((pending) => ({ branch: pending.branch, error: error.message })));
        break;
      }
    }
  }
  return { pushed, failures };
}
