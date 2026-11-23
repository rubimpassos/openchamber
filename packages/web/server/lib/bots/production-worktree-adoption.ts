import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sha } from './services/contracts.js';
import { botGit, createBotCheckoutGit } from './production-git.js';
import { parseSnapshotMetadata, sameBotMigrationPath, sameTransferSource, transferCaps } from '../spaces/transfer-bundle.js';
import { requiredFailureProperty } from '../spaces/failure.js';
import { adoptionOf, associationSchema, fail, sourceOfRecord } from './production-worktree-contracts.js';
import type { AdoptionRequest, CheckoutOptions, CheckoutOwner, MigrationRequest } from './production-worktree-contracts.js';
import { clean } from './production-worktree-owner.js';
import type { CheckoutOwnerStore } from './production-worktree-owner.js';

const requireAncestor = async (directory: string, ancestor: string, descendant: string) => {
  let found;
  try { found = (await botGit(directory, ['merge-base', ancestor, descendant])).trim(); }
  catch { fail('BOT_ISOLATED_ANCESTRY'); }
  if (found !== ancestor) fail('BOT_ISOLATED_ANCESTRY');
};
const adoptionState = async (record: CheckoutOwner) => {
  const { run } = await createBotCheckoutGit(record.directory);
  if ((await run(['ls-files', '-v', '-z'])).split('\0').filter(Boolean).some((entry) => !entry.startsWith('H '))) fail('BOT_ISOLATED_INDEX_FLAGS');
  if ((await run(['diff-files', '--name-only', '-z', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--'])).length
    || (await run(['ls-files', '--others', '-z'])).length) fail('BOT_ISOLATED_ADOPTION_UNSETTLED');
  return { headSha: sha.parse((await run(['rev-parse', 'HEAD'])).trim()),
    treeSha: sha.parse((await run(['write-tree'])).trim()) };
};

export function createCheckoutAdoption({ dataDir, context }: Pick<CheckoutOptions, 'dataDir' | 'context'>,
  owner: CheckoutOwnerStore, advanceCheckout: NonNullable<CheckoutOptions['advanceCheckout']>) {
  const { locked, requireRecord, verifyCheckout, save } = owner;
  const verifyAssociation = async (record: CheckoutOwner, association: z.output<typeof associationSchema>,
    result: { readonly resultSha: string; readonly trustedMigrationPath: MigrationRequest['trustedMigrationPath'] }) => {
    const { resultSha, trustedMigrationPath } = result;
    if (!sameTransferSource(sourceOfRecord(record), association.source)) fail('BOT_ISOLATED_SOURCE_MISMATCH');
    let handle;
    try { handle = await fs.open(path.join(dataDir, 'space-transfer', `${association.spaceId}.json`), 'r'); }
    catch (error) {
      if (requiredFailureProperty(error, 'code') === 'ENOENT') fail('BOT_ISOLATED_RESULT_NOT_PROMOTED');
      throw error;
    }
    let metadata;
    try {
      const limit = transferCaps().metadataBytes;
      if ((await handle.stat()).size > limit) fail('BOT_ISOLATED_SOURCE_MISMATCH');
      const bytes = Buffer.alloc(limit + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > limit) fail('BOT_ISOLATED_SOURCE_MISMATCH');
      metadata = parseSnapshotMetadata(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')), association.spaceId);
    } finally { await handle.close(); }
    const resultRef = `refs/openchamber/spaces/${association.spaceId}/result`;
    if (Boolean(metadata.trustedMigrationPath) !== Boolean(trustedMigrationPath)
      || trustedMigrationPath && !sameBotMigrationPath(metadata.trustedMigrationPath, trustedMigrationPath)) fail('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH');
    if (!metadata.source || !sameTransferSource(metadata.source, association.source) || metadata.directory !== record.directory
      || (await botGit(record.directory, ['for-each-ref', '--format=%(objectname)', metadata.ref])).trim() !== metadata.start
      || (await botGit(record.directory, ['for-each-ref', '--format=%(objectname)', resultRef])).trim() !== resultSha) fail('BOT_ISOLATED_RESULT_NOT_PROMOTED');
    return resultRef;
  };
  return async (request: AdoptionRequest) => {
    const resultSha = sha.parse(request.resultSha);
    const suppliedAssociation = request.association === undefined ? undefined : associationSchema.parse(request.association);
    const spaceId = request.spaceId === undefined ? undefined : z.string().regex(/^[a-f0-9]{12}$/).parse(request.spaceId);
    return locked(request, async () => {
      let record = await requireRecord(request);
      await verifyCheckout(request, record);
      const association = spaceId ? { spaceId, source: sourceOfRecord(record) } : suppliedAssociation;
      if (suppliedAssociation && association && JSON.stringify(suppliedAssociation) !== JSON.stringify(association)) fail('BOT_ISOLATED_SOURCE_MISMATCH');
      if (!request.bot.isolated) fail('BOT_ISOLATION_REQUIRED');
      if (!['ready', 'adopting'].includes(record.state)) fail('BOT_WORKTREE_CREATE_UNSETTLED');
      if (record.adoption?.association && (!association || JSON.stringify(record.adoption.association) !== JSON.stringify(association))) fail('BOT_ISOLATED_SOURCE_MISMATCH');
      const associatedRef = association && await verifyAssociation(record, association, { resultSha, trustedMigrationPath: request.trustedMigrationPath });
      const { binding } = await context.github(request);
      if (binding.identityId !== record.identityId || binding.identityRevision !== record.identityRevision) fail('BOT_IDENTITY_CHANGED');
      if ((await botGit(record.directory, ['cat-file', '-t', resultSha])).trim() !== 'commit') fail('BOT_ISOLATED_RESULT_INVALID');
      await requireAncestor(record.directory, record.baseSha, resultSha);
      if (record.state === 'ready') {
        await clean(record, true);
        const refs = (await botGit(record.directory, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/openchamber/spaces/'])).trim().split(/\r?\n/);
        const resultRef = associatedRef ?? refs.find((entry) => /^refs\/openchamber\/spaces\/[a-f0-9]{12}\/result [a-f0-9]{40}$/.test(entry) && entry.endsWith(` ${resultSha}`))?.split(' ')[0];
        if (!resultRef) fail('BOT_ISOLATED_RESULT_NOT_PROMOTED');
        const fromSha = sha.parse((await botGit(record.directory, ['rev-parse', 'HEAD'])).trim());
        await requireAncestor(record.directory, fromSha, resultSha);
        if (fromSha === resultSha) {
          await adoptionState(record);
          return { headSha: resultSha };
        }
        const adoption: NonNullable<CheckoutOwner['adoption']> = { fromSha, resultSha, resultRef };
        if (association) adoption.association = association;
        record = { ...record, state: 'adopting', adoption };
        await save(request, record);
      } else if (adoptionOf(record).resultSha !== resultSha) fail('BOT_ISOLATED_ADOPTION_PENDING');
      const { fromSha } = adoptionOf(record);
      await requireAncestor(record.directory, fromSha, resultSha);
      const fromTree = (await botGit(record.directory, ['rev-parse', `${fromSha}^{tree}`])).trim();
      const resultTree = (await botGit(record.directory, ['rev-parse', `${resultSha}^{tree}`])).trim();
      let observed = await adoptionState(record);
      if (observed.headSha === fromSha && observed.treeSha === fromTree) {
        await verifyCheckout(request, record);
        await advanceCheckout({ directory: record.directory, fromSha, resultSha });
        observed = await adoptionState(record);
      }
      if (observed.treeSha !== resultTree || ![fromSha, resultSha].includes(observed.headSha)) fail('BOT_ISOLATED_ADOPTION_UNSETTLED');
      await verifyCheckout(request, record);
      const branchHead = (await botGit(record.directory, ['rev-parse', `refs/heads/${record.branch}`])).trim();
      if (![fromSha, resultSha].includes(branchHead)) fail('BOT_ISOLATED_ADOPTION_UNSETTLED');
      if (branchHead === fromSha) await botGit(record.directory, ['update-ref', `refs/heads/${record.branch}`, resultSha, fromSha]);
      await botGit(record.directory, ['symbolic-ref', 'HEAD', `refs/heads/${record.branch}`]);
      await clean(record, true);
      if ((await botGit(record.directory, ['rev-parse', 'HEAD'])).trim() !== resultSha) fail('BOT_GIT_HEAD_CHANGED');
      const { adoption: _adoption, ...ready } = record;
      await save(request, { ...ready, state: 'ready' });
      return { headSha: resultSha };
    });
  };
}
