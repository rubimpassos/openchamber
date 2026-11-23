import fs from 'node:fs/promises';
import { addDetachedWorktree, removeWorktree } from '../git/service.js';
import { configureBotWorktreeIdentity } from './services/git.js';
import { branch as branchSchema, sha } from './services/contracts.js';
import { advanceBotCheckout, botGit } from './production-git.js';
import { transferSourceSchema } from '../spaces/transfer-bundle.js';
import { checkoutOf, fail, ownerSchema } from './production-worktree-contracts.js';
import type { Checkout, CheckoutIdentityRequest, CheckoutOptions, CheckoutRequest, MigrationRequest } from './production-worktree-contracts.js';
import { clean, createCheckoutOwner, exists, statId } from './production-worktree-owner.js';
import { createCheckoutAdoption } from './production-worktree-adoption.js';
import { createCheckoutPublication, defaultBranch, remoteHead, requireObject } from './production-worktree-publication.js';
import { createCheckoutSnapshots } from './production-worktree-snapshot.js';
export { botMigrationPathSchema, readTrustedBotMigrationPaths } from '../spaces/transfer-bundle.js';

export function createProductionBotWorktrees({ dataDir, context, readItem, disposeInstance, advanceCheckout = advanceBotCheckout }: CheckoutOptions) {
  if (!dataDir || !context?.github || !context?.author || !readItem) throw new TypeError('Bot worktrees require dataDir, context and readItem');
  const owner = createCheckoutOwner(dataDir);
  const { location, read, requireRecord, save, locked, validateRecord, verifyCheckout, removalFinished } = owner;
  return Object.freeze({
    async resolveTransferSource<Input>(input: Input, { trustedMigrationPath }: MigrationRequest = {}) {
      const source = transferSourceSchema.parse(input);
      if (source.kind !== 'bot-checkout') fail('BOT_WORKTREE_OWNERSHIP');
      const item = await readItem(source.projectId, source.itemId);
      if (!item || item.id !== source.itemId || item.botId !== source.botId || source.checkoutKey !== `${source.itemId}:worktree`) fail('BOT_WORKTREE_OWNERSHIP');
      const request = { project: { id: source.projectId, path: source.projectDirectory }, bot: { id: source.botId }, item, key: source.checkoutKey, trustedMigrationPath };
      return locked(request, async () => {
        const record = await requireRecord(request);
        await verifyCheckout(request, record);
        if (record.state !== 'ready') fail('BOT_WORKTREE_CREATE_UNSETTLED');
        return record.directory;
      });
    },
    ...createCheckoutPublication(context, owner, readItem),
    adoptIsolated: createCheckoutAdoption({ dataDir, context }, owner, advanceCheckout),
    async create(request: CheckoutRequest) {
      return locked(request, async () => {
        const previous = await read(request);
        if (previous) {
          await validateRecord(request, previous);
          if (previous.state !== 'ready') fail('BOT_WORKTREE_CREATE_UNSETTLED');
          await verifyCheckout(request, previous);
          return checkoutOf(previous);
        }
        if (request.trustedMigrationPath !== undefined) fail('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH');
        const branch = branchSchema.parse(`bot/${request.item.id}`);
        if (request.item.botId !== request.bot.id) fail('BOT_WORKTREE_OWNERSHIP');
        const { binding, credential } = await context.github(request);
        const baseBranch = await defaultBranch(credential, binding.target);
        const baseSha = await remoteHead(credential, binding.target, baseBranch);
        await requireObject(request, { credential, target: binding.target }, baseSha);
        const directory = location(request).directory;
        if (await exists(directory) || (await botGit(request.project.path, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`])).trim()) fail('BOT_WORKTREE_UNOWNED');
        const record = ownerSchema.parse({ version: 1, projectId: request.project.id, projectPath: await fs.realpath(request.project.path),
          itemId: request.item.id, botId: request.bot.id, repositoryId: binding.target.repositoryId, key: request.key,
          identityId: binding.identityId, identityRevision: binding.identityRevision,
          directory, branch, baseBranch, baseSha, state: 'preparing' });
        await save(request, record);
        await addDetachedWorktree(request.project.path, directory, baseSha);
        record.gitDirectory = (await botGit(directory, ['rev-parse', '--absolute-git-dir'])).trim();
        record.gitIdentity = statId(await fs.stat(record.gitDirectory));
        record.directoryIdentity = statId(await fs.lstat(directory));
        await save(request, record);
        await botGit(directory, ['update-ref', `refs/heads/${branch}`, baseSha, '0'.repeat(40)]);
        await botGit(directory, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
        await configureBotWorktreeIdentity({ directory, ...await context.author({ ...request, binding }) });
        record.state = 'ready';
        await verifyCheckout(request, record);
        await save(request, record);
        return checkoutOf(record);
      });
    },
    async reconcile(request: CheckoutIdentityRequest & { readonly operation?: string }) {
      return locked(request, async () => {
        const record = await read(request);
        if (!record) return { state: 'outcome-unknown' as const };
        await validateRecord(request, record);
        if (request.operation === 'remove') {
          if (['removing', 'removed'].includes(record.state) && await removalFinished(request, record)) return { state: 'succeeded' as const, result: { id: request.item.id } };
          return { state: 'outcome-unknown' as const };
        }
        if (record.state !== 'ready') return { state: 'outcome-unknown' as const };
        await verifyCheckout(request, record);
        return { state: 'succeeded' as const, result: checkoutOf(record) };
      });
    },
    async remove(request: CheckoutIdentityRequest & { readonly checkout?: Checkout }) {
      return locked(request, async () => {
        const record = await requireRecord(request);
        await validateRecord(request, record);
        if (request.checkout && JSON.stringify(checkoutOf(record)) !== JSON.stringify(request.checkout)) fail('BOT_WORKTREE_OWNERSHIP');
        if (['removed', 'removing'].includes(record.state) && await removalFinished(request, record)) return { id: request.item.id };
        if (record.state !== 'ready' && record.state !== 'removing') fail('BOT_WORKTREE_CREATE_UNSETTLED');
        const item = await readItem(request.project.id, request.item.id);
        if (!item || item.id !== record.itemId || item.botId !== record.botId || item.worktree !== record.directory
          || item.branch !== record.branch || !item.effects || item.effects.some((effect) => ['prepared', 'dispatching', 'outcome-unknown'].includes(effect.state)
            && !(effect.kind === 'worktree.remove' && effect.key === `${item.id}:cleanup`))) fail('BOT_WORKTREE_UNSETTLED_EFFECTS');
        await verifyCheckout(request, record);
        await clean(record, true);
        const removeHead = sha.parse((await botGit(record.directory, ['rev-parse', 'HEAD'])).trim());
        await save(request, { ...record, state: 'removing', removeHead });
        await removeWorktree(request.project.path, { directory: record.directory, deleteLocalBranch: false, disposeInstance }, {
          verifyRemoval: async () => {
            await verifyCheckout(request, record);
            await clean(record, true);
            if ((await botGit(record.directory, ['rev-parse', 'HEAD'])).trim() !== removeHead) fail('BOT_WORKTREE_BRANCH_CHANGED');
          } });
        if (!await removalFinished(request, { ...record, state: 'removing', removeHead })) fail('BOT_WORKTREE_REMOVE_INCOMPLETE');
        return { id: request.item.id };
      });
    },
    ...createCheckoutSnapshots(context, owner),
  });
}
