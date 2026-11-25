import path from 'node:path';
import { z } from 'zod';
import { createBotAdapterState } from './adapter-state.js';
import { createBotProofRunner } from './proof.js';
import { BotServiceError } from './services.js';
import { botGit } from './production-git.js';
import type { HostIsolated, HostPlacement, HostWorktrees, TreeRequest } from './host-contracts.js';
import type { RuntimeOptions } from './runtime/contracts.js';
import type { AdoptionRequest } from './production-worktree-contracts.js';
import type { BotItem } from './schema.js';
type AdoptionDraft = { -readonly [Key in keyof AdoptionRequest]: AdoptionRequest[Key] };

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const publicationSchema = z.object({ sourceHeadSha: sha, headSha: sha,
  commitMap: z.array(z.object({ sourceSha: sha, publishedSha: sha }).strict()).min(1).max(100) }).strict();
type CheckoutOptions = Pick<RuntimeOptions, 'store' | 'resolveProject'> & {
  readonly dataDir: string; readonly isolated: HostIsolated; readonly placement: HostPlacement;
  readonly productionWorktrees: HostWorktrees;
  readonly remoteSameTree: ((request: TreeRequest & { readonly left: string; readonly right: string }) => Promise<boolean>) | null;
  readonly collectArtifacts?: (scope: { readonly projectId: string; readonly itemId: string }) => Promise<void>;
};

export function createHostCheckouts({ dataDir, isolated, placement, productionWorktrees, remoteSameTree, store, resolveProject, collectArtifacts }: CheckoutOptions) {
  const publications = createBotAdapterState({ dataDir, name: 'published-snapshots', schema: publicationSchema });
  const keyFor = ({ project, item }: { readonly project: { readonly id: string }; readonly item: { readonly id: string } }) => ({ projectId: project.id, itemId: item.id });
  const sameTree = async (request: TreeRequest, left: string, right: string) => {
    if (remoteSameTree) return remoteSameTree({ ...request, left, right });
    if (!request.item.worktree) throw new BotServiceError('BOT_PLACEMENT_MISMATCH', 'The recorded checkout is unavailable.');
    return (await botGit(request.item.worktree, ['rev-parse', `${left}^{tree}`])).trim()
      === (await botGit(request.item.worktree, ['rev-parse', `${right}^{tree}`])).trim();
  };
  const remove: HostWorktrees['remove'] = async (request) => {
    await collectArtifacts?.({ projectId: request.project.id, itemId: request.item.id });
    await isolated.remove(request);
    return productionWorktrees.remove(request);
  };
  const worktrees = { ...productionWorktrees, remove,
    reconcile: async (request: Parameters<HostWorktrees['reconcile']>[0]) => {
      if (request.operation === 'remove') await remove(request);
      return productionWorktrees.reconcile(request);
    },
    inspect: async (input: Parameters<HostWorktrees['inspect']>[0] & { readonly item: { readonly sessions?: BotItem['sessions'] } }) => {
      if (!input.item.worktree) throw new BotServiceError('BOT_PLACEMENT_MISMATCH', 'The recorded checkout is unavailable.');
      const recorded = await placement.resolve({ projectId: input.project.id, itemId: input.item.id,
        bot: input.bot, directory: input.item.worktree, sessions: input.item.sessions ?? {} });
      if (!recorded.isolated) return productionWorktrees.inspect(input);
      const request = { ...input, bot: { ...input.bot, isolated: true } };
      const exported = await isolated.exportSnapshot({ projectId: request.project.id, itemId: request.item.id });
      if (exported.repository !== request.item.worktree) throw new BotServiceError('BOT_ISOLATED_DIRECTORY_MISMATCH', 'The exported result belongs to another checkout.');
      const current = await productionWorktrees.inspect(request);
      if (current.headSha !== exported.resultSha && current.headSha === current.remoteSha
        && await sameTree(request, current.headSha, exported.resultSha)) return current;
      const adoption: AdoptionDraft = { ...request, resultSha: exported.resultSha };
      if (remoteSameTree) adoption.spaceId = (await isolated.bindingFor({ projectId: request.project.id, itemId: request.item.id })).spaceId;
      await productionWorktrees.adoptIsolated(adoption);
      return productionWorktrees.inspect(request);
    },
    acceptPublished: async (request: Parameters<HostWorktrees['acceptPublished']>[0]) => {
      await publications.own(keyFor(request), () => publications.write(keyFor(request), publicationSchema.parse(request.result)));
      return productionWorktrees.acceptPublished(request);
    },
  };
  const proof = createBotProofRunner({ root: path.join(dataDir, 'bots', 'proof'), executeIsolatedProof: async (input, options) => {
    const binding = await isolated.bindingFor(input);
    const published = await publications.read({ projectId: binding.projectId, itemId: binding.itemId });
    if (!published) return isolated.executeIsolatedProof(input, options);
    const map = async (commit: string) => {
      const source = published.commitMap.find((entry) => entry.publishedSha === commit)?.sourceSha ?? commit;
      const project = await resolveProject(binding.projectId);
      const item = (await store.read(binding.projectId)).items.find((entry) => entry.id === binding.itemId && entry.botId === binding.botId);
      if (!item || !await sameTree({ project, item }, source, commit)) throw new BotServiceError('BOT_GIT_COMMIT_MAP_INVALID', 'The published proof tree changed.');
      return source;
    };
    const result = await isolated.executeIsolatedProof({ ...input, testSha: await map(input.testSha), fixSha: await map(input.fixSha) }, options);
    return { ...result, testSha: input.testSha, fixSha: input.fixSha };
  } });
  return { worktrees, proof };
}
