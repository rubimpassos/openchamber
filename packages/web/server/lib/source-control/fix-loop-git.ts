import { createHttpsCredentialReference } from '../git/credential-resolver.js';
import { createHash } from 'node:crypto';
import type { createNetworkOperations } from '../git/network-operations.js';
import type { HeadSnapshot, LoopIdentity } from '../pr-fix-loop/contracts.js';
import type { TransportCredential } from './provider-contract.js';
import type { registerSourceControlRoutes } from './routes.js';

const pullRemoteName = ({ owner, repo, number }: Pick<LoopIdentity, 'owner' | 'repo' | 'number'>) => `openchamber-fix-${createHash('sha256')
  .update(`${owner}/${repo}#${number}`.toLowerCase()).digest('hex').slice(0, 16)}`;

type SourceControlRoutes = ReturnType<typeof registerSourceControlRoutes>;
type NetworkOperations = ReturnType<typeof createNetworkOperations>;

export const createFixLoopGitServices = ({ bindings, network, resolveAccount }: {
  readonly bindings: Pick<SourceControlRoutes, 'get' | 'applyFixLoopReviewOperation' | 'readFixLoopPull' | 'resolveChangeRequestSource'>;
  readonly network: Pick<NetworkOperations, 'publishApprovedCommit' | 'transferContributorHead'>;
  readonly resolveAccount: (source: { provider: string; instance: string; accountId: string }) => Promise<Pick<TransportCredential, 'status' | 'credentialId' | 'credentialRevision' | 'providerUserId'> | null>;
}) => ({
  readBinding: bindings.get,
  publish: network.publishApprovedCommit,
  applyReviewOperation: bindings.applyFixLoopReviewOperation,
  admit: bindings.readFixLoopPull,
  fetchHead: async (loop: LoopIdentity, snapshot: Pick<HeadSnapshot, 'headSha'>) => {
    const sourceRequest = { context: loop.readContext,
      project: { id: `${loop.owner}/${loop.repo}`, owner: loop.owner, name: loop.repo },
      number: loop.number, expectedHeadSha: snapshot.headSha,
      requestedRemoteName: loop.id ? `openchamber-fix-${loop.id.replace('fixloop_', '')}` : pullRemoteName(loop) };
    const source = await bindings.resolveChangeRequestSource(sourceRequest);
    const account = await resolveAccount(source.context);
    if (!account || account.status !== 'valid') throw new Error('PR approval fetch credential is unavailable');
    const credentialId = createHttpsCredentialReference({ provider: source.context.provider, instance: source.context.instance,
      credentialId: account.credentialId, credentialRevision: account.credentialRevision, providerUserId: account.providerUserId });
    const result = await network.transferContributorHead({ directory: loop.directory, sourceRequest: { ...sourceRequest, context: source.context }, source, credentialId,
      destinationRef: `refs/remotes/${source.requestedRemoteName}/head` });
    if (result.state !== 'succeeded') throw new Error('The exact PR head could not be fetched');
  },
});
