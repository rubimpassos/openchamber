import crypto from 'node:crypto';
import { createTransferSession } from '../spaces/code-transfer.js';
import { parseGitHubRemoteUrl } from '../github/repo/index.js';
import { approvalError, commitSchema, destinationOf, sameDestination } from './approval-contract.js';
import type { PublicationOptions, LoopIdentity, HeadSnapshot, PendingPublication, PublicationAuthority } from './contracts.js';
import type { CodeOutSummary } from '../spaces/code-out-contracts.js';
import { publicationAuthoritySchema } from './stored-state.js';

/** Host-owned publication. The receipt, object and destination never come from a worker response. */
export function createApprovalPublication({ dataDir, git, gitServices, captureRef = null }: PublicationOptions) {
  const capture = async (loop: LoopIdentity, snapshot: HeadSnapshot): Promise<PublicationAuthority> => {
    const destination = destinationOf(snapshot);
    const read = await gitServices().readBinding(loop.directory);
    if (read.repository.repositoryId !== loop.readContext?.repositoryId) throw approvalError('The local repository changed.');
    if (read.revision !== loop.readContext.bindingRevision) throw approvalError('The repository binding changed. Prepare a new loop with its current authority.');
    const remote = read.repository.remotes.find((candidate) => {
      const parsed = parseGitHubRemoteUrl(candidate.push.displayUrl);
      return parsed && parsed.owner.toLowerCase() === destination.headRepo.owner.toLowerCase()
        && parsed.repo.toLowerCase() === destination.headRepo.repo.toLowerCase()
        && read.binding?.remotes.some((grant) => grant.name === candidate.name && grant.readiness === 'ready' && grant.mode === 'managed');
    });
    if (!remote) {
      throw approvalError('Configure an exact managed Git push destination for the PR head repository before activation.');
    }
    return {
      repositoryId: read.repository.repositoryId, bindingRevision: read.revision,
      configRevision: read.repository.configRevision,
      remote: { name: remote.name, endpoint: remote.push }, transportMode: 'managed',
    };
  };
  return {
    validate: capture,
    async capture(loop: LoopIdentity, snapshot: HeadSnapshot, exported: CodeOutSummary): Promise<PendingPublication> {
      const authority = await capture(loop, snapshot);
      const commit = commitSchema.parse(exported.result);
      const destination = destinationOf(snapshot);
      if (exported.unmerged.count || exported.nestedRepositories.count) throw approvalError('Resolve conflicts and nested repositories before exporting an approval result.');
      const id = crypto.randomUUID();
      const localRef = `refs/heads/openchamber-approval/${id}`;
      if (captureRef) await captureRef({ directory: loop.directory, commit, expectedHead: destination.expectedHead, localRef });
      else {
        if (!git) throw approvalError('Local approval publication Git is unavailable.');
        const { withHostGit } = createTransferSession({ git, temporaryDirectory: dataDir, name: 'approval publication' });
        await withHostGit('approval_capture_failed', async (g) => {
          if ((await g.run(loop.directory, ['merge-base', '--is-ancestor', destination.expectedHead, commit])).code !== 0) {
            throw approvalError('The exported commit does not descend from the PR head.');
          }
          await g.output(loop.directory, ['update-ref', localRef, commit, '0'.repeat(40)]);
        });
      }
      return {
        receipt: { id, localRef, commit, repositoryId: authority.repositoryId, destination,
          createdAt: Date.now(), changedPaths: exported.changedPaths, changedBytes: exported.changedBytes },
        authority,
      };
    },
    async publish(loop: LoopIdentity, pending: PendingPublication, snapshot: HeadSnapshot) {
      const { receipt } = pending;
      const current = destinationOf(snapshot);
      if (snapshot.state !== 'open' || !sameDestination(receipt.destination, current)
        || current.expectedHead !== receipt.destination.expectedHead) throw approvalError('The PR head or destination changed. The receipt cannot be published.');
      // Exact authority is revalidated by the network executor immediately before its one push.
      const authority = publicationAuthoritySchema.parse(pending.authority);
      return gitServices().publish({ ...authority, directory: loop.directory,
        operation: 'push', sourceRef: receipt.localRef, destinationRef: receipt.destination.ref,
        forceWithLease: { expectedRemoteSha: receipt.destination.expectedHead },
      }, receipt.commit);
    },
  };
}
