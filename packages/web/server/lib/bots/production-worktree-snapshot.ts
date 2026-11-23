import { z } from 'zod';
import { providerResult, sha } from './services/contracts.js';
import { botGit } from './production-git.js';
import { fail } from './production-worktree-contracts.js';
import type { CheckoutContext, CheckoutRequest, CheckoutSnapshot } from './production-worktree-contracts.js';
import { clean } from './production-worktree-owner.js';
import type { CheckoutOwnerStore } from './production-worktree-owner.js';
import { defaultBranch, remoteHead, requireObject } from './production-worktree-publication.js';

const changesOf = (raw: string): CheckoutSnapshot['changes'] => {
  const fields = raw.split('\0');
  const result: CheckoutSnapshot['changes'] = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++];
    const first = fields[index++];
    if (!first || status === undefined || !/^[ACDMRTUXB][0-9]*$/.test(status)) fail('BOT_GIT_DIFF_INVALID');
    if (/^[RC]/.test(status)) {
      const next = fields[index++];
      if (!next) fail('BOT_GIT_DIFF_INVALID');
      result.push({ oldPath: first, newPath: next });
    } else {
      const change: CheckoutSnapshot['changes'][number] = {};
      if (status !== 'A') change.oldPath = first;
      if (status !== 'D') change.newPath = first;
      result.push(change);
    }
  }
  return result;
};
const testPath = (name: string) => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|\/)[^/]+[._](?:test|spec)\.[^/]+$/.test(name);

export function createCheckoutSnapshots(context: CheckoutContext, owner: CheckoutOwnerStore) {
  const { locked, requireRecord, verifyCheckout } = owner;
  return {
    async inspect(request: CheckoutRequest) {
      return locked(request, async () => {
        const record = await requireRecord(request);
        await verifyCheckout(request, record);
        if (record.state !== 'ready') fail('BOT_WORKTREE_CREATE_UNSETTLED');
        await clean(record);
        const { binding, credential } = await context.github(request);
        if (binding.target.repositoryId !== record.repositoryId) fail('BOT_WORKTREE_OWNERSHIP');
        if (binding.identityId !== record.identityId || binding.identityRevision !== record.identityRevision) fail('BOT_IDENTITY_CHANGED');
        const baseBranch = await defaultBranch(credential, binding.target);
        if (baseBranch !== record.baseBranch) fail('BOT_GIT_BASE_CHANGED');
        const baseSha = await remoteHead(credential, binding.target, baseBranch);
        await requireObject(request, { credential, target: binding.target }, baseSha);
        const headSha = sha.parse((await botGit(record.directory, ['rev-parse', 'HEAD'])).trim());
        const remoteSha = await remoteHead(credential, binding.target, record.publicationBranch ?? record.branch, true);
        const ancestor = sha.parse((await botGit(record.directory, ['merge-base', baseSha, headSha])).trim());
        const changes = changesOf(await botGit(record.directory, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', ancestor, headSha, '--']));
        const diff = await botGit(record.directory, ['diff', '--no-ext-diff', '--no-textconv', '--binary', ancestor, headSha, '--']);
        const result: CheckoutSnapshot = { baseSha, headSha, baseBranch, remoteSha, changes, diff };
        const commits = (await botGit(record.directory, ['rev-list', '--reverse', '--first-parent', `${ancestor}..${headSha}`])).trim().split(/\r?\n/).filter(Boolean);
        for (const testSha of commits.slice(0, -1).reverse()) {
          const parents = (await botGit(record.directory, ['rev-list', '--parents', '-n', '1', testSha])).trim().split(' ');
          const parent = parents[1];
          if (parents.length !== 2 || parent === undefined) continue;
          const changes = changesOf(await botGit(record.directory, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', parent, testSha, '--']));
          const files = changes.flatMap((entry) => entry.newPath ? [entry.newPath] : []);
          if (files.length && changes.flatMap((entry) => [entry.oldPath, entry.newPath].filter((name): name is string => Boolean(name))).every(testPath)) {
            if ((await botGit(record.directory, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', testSha, headSha, '--', ...files])).trim()) continue;
            result.testSha = testSha; result.fixSha = headSha; result.testFiles = files; break;
          }
        }
        await clean(record);
        await verifyCheckout(request, record);
        if ((await botGit(record.directory, ['rev-parse', 'HEAD'])).trim() !== headSha) fail('BOT_GIT_HEAD_CHANGED');
        return result;
      });
    },
    async acceptPublished(request: CheckoutRequest & { readonly snapshot: Pick<CheckoutSnapshot, 'headSha' | 'remoteSha' | 'baseSha'>; readonly result: unknown }) {
      return locked(request, async () => {
        const record = await requireRecord(request);
        await verifyCheckout(request, record);
        if (record.state !== 'ready') fail('BOT_WORKTREE_CREATE_UNSETTLED');
        await clean(record);
        const result = z.object({ sourceHeadSha: sha, headSha: sha,
          commitMap: z.array(z.object({ sourceSha: sha, publishedSha: sha }).strict()).min(1).max(100) }).strict().parse(request.result);
        const last = result.commitMap.at(-1);
        if (result.sourceHeadSha !== request.snapshot.headSha || last?.sourceSha !== result.sourceHeadSha
          || last.publishedSha !== result.headSha) fail('BOT_GIT_COMMIT_MAP_INVALID');
        const currentHead = (await botGit(record.directory, ['rev-parse', 'HEAD'])).trim();
        if (![result.sourceHeadSha, result.headSha].includes(currentHead)) fail('BOT_GIT_HEAD_CHANGED');
        const { binding, credential } = await context.github(request);
        if (binding.identityId !== record.identityId || binding.identityRevision !== record.identityRevision) fail('BOT_IDENTITY_CHANGED');
        if (credential.definition.kind !== 'github-app') fail('BOT_GITHUB_SIGNING_IDENTITY_REQUIRED');
        if (await remoteHead(credential, binding.target, record.publicationBranch ?? record.branch) !== result.headSha) fail('BOT_GIT_REMOTE_CHANGED');
        let sourceParent = request.snapshot.remoteSha ?? request.snapshot.baseSha;
        let publishedParent = sourceParent;
        for (const entry of result.commitMap) {
          const source = await botGit(record.directory, ['cat-file', 'commit', entry.sourceSha]);
          const boundary = source.indexOf('\n\n');
          const headers = source.slice(0, boundary).split('\n');
          const parents = headers.filter((line) => line.startsWith('parent '));
          const tree = headers.find((line) => line.startsWith('tree '))?.slice(5);
          if (parents.length !== 1 || parents[0] !== `parent ${sourceParent}`) fail('BOT_GIT_COMMIT_MAP_INVALID');
          const commit = providerResult(z.object({ sha, tree: z.object({ sha }), parents: z.array(z.object({ sha })), message: z.string(),
            verification: z.object({ verified: z.literal(true), payload: z.string().min(1), signature: z.string().min(1) }) }).safeParse(
          await credential.request({ path: `/repos/${binding.target.owner}/${binding.target.repo}/git/commits/${entry.publishedSha}` })));
          const payload = commit.verification.payload;
          const split = payload.indexOf('\n\n');
          const payloadHeaders = payload.slice(0, split).split('\n');
          if (commit.sha !== entry.publishedSha || commit.tree.sha !== tree || commit.parents.length !== 1
            || commit.parents[0]?.sha !== publishedParent || commit.message !== source.slice(boundary + 2).replace(/\n$/, '')
            || split < 0 || payloadHeaders.filter((line) => line.startsWith('parent ')).join() !== `parent ${publishedParent}`
            || payloadHeaders.filter((line) => line.startsWith('tree ')).join() !== `tree ${tree}`
            || payload.slice(split + 2) !== source.slice(boundary + 2)) fail('BOT_GIT_COMMIT_MAP_INVALID');
          const raw = `${payload.slice(0, split)}\ngpgsig ${commit.verification.signature.trimEnd().replace(/\n/g, '\n ')}${payload.slice(split)}`;
          const imported = (await botGit(record.directory, ['hash-object', '-t', 'commit', '-w', '--stdin'], raw)).trim();
          if (imported !== entry.publishedSha) fail('BOT_GIT_COMMIT_MAP_INVALID');
          sourceParent = entry.sourceSha; publishedParent = entry.publishedSha;
        }
        if (sourceParent !== result.sourceHeadSha) fail('BOT_GIT_COMMIT_MAP_INVALID');
        await clean(record);
        await verifyCheckout(request, record);
        if ((await botGit(record.directory, ['rev-parse', 'HEAD'])).trim() !== currentHead) fail('BOT_GIT_HEAD_CHANGED');
        if (currentHead !== result.headSha) await botGit(record.directory, ['update-ref', `refs/heads/${record.branch}`, result.headSha, result.sourceHeadSha]);
        return { headSha: result.headSha };
      });
    },
  };
}
