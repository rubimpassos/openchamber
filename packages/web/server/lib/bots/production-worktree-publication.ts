import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { branch as branchSchema, providerResult, sha, text } from './services/contracts.js';
import { requiredFailureProperty } from '../spaces/failure.js';
import { botMigrationPathSchema } from '../spaces/transfer-bundle.js';
import { botGit, fetchBotCommit } from './production-git.js';
import { fail, ownerSchema, reservationsSchema } from './production-worktree-contracts.js';
import { publicationOwner, reservedFor } from './production-worktree-owner.js';
import type { CheckoutContext, CheckoutRequest } from './production-worktree-contracts.js';
import type { CheckoutOwnerStore } from './production-worktree-owner.js';
import type { ResolvedBotCredential } from './services/credentials.js';
import type { BotOperationTarget } from './services/contracts.js';

type Credential = ResolvedBotCredential<'github'>;
type Target = BotOperationTarget<'git.push'>;
export function remoteHead(credential: Credential, target: Target, name: string): Promise<string>;
export function remoteHead(credential: Credential, target: Target, name: string, missing: boolean): Promise<string | null>;
export async function remoteHead(credential: Credential, target: Target, name: string, missing = false) {
  try {
    const value = providerResult(z.object({ ref: text, object: z.object({ sha }) }).safeParse(await credential.request({
      path: `/repos/${target.owner}/${target.repo}/git/ref/heads/${encodeURIComponent(name)}` })));
    if (value.ref !== `refs/heads/${name}`) fail('BOT_GIT_REMOTE_CHANGED');
    return value.object.sha;
  } catch (error) {
    if (missing && requiredFailureProperty(error, 'code') === 'BOT_SERVICE_REJECTED' && requiredFailureProperty(error, 'status') === 404) return null;
    throw error;
  }
}
export const defaultBranch = async (credential: Credential, target: Target) => providerResult(z.object({ default_branch: branchSchema }).safeParse(
  await credential.request({ path: `/repos/${target.owner}/${target.repo}` }))).default_branch;
export const requireObject = async (request: CheckoutRequest, remote: { readonly credential: Credential; readonly target: Target }, commit: string) => {
  try { await botGit(request.project.path, ['cat-file', '-e', `${commit}^{commit}`]); }
  catch { await fetchBotCommit({ directory: request.project.path, ...remote, commit }); }
};

export function createCheckoutPublication(context: CheckoutContext, owner: CheckoutOwnerStore, readItem: (projectId: string, itemId: string) => Promise<CheckoutRequest['item'] | null | undefined>) {
  const { root, locked, read, requireRecord, save, saveJson, repositoryLocked, reservationsFile,
    readReservations, validateRecord, validateReservation, verifyCheckout } = owner;
  return {
    async bindPublication(request: CheckoutRequest & { readonly branch: string }) {
      const publicationBranch = branchSchema.parse(request.branch);
      return locked(request, async () => {
        const record = await requireRecord(request);
        return repositoryLocked(record.repositoryId, async () => {
          await verifyCheckout(request, record);
          if (record.state !== 'ready') fail('BOT_WORKTREE_CREATE_UNSETTLED');
          const { binding, credential } = await context.github(request);
          if (binding.target.repositoryId !== record.repositoryId) fail('BOT_WORKTREE_OWNERSHIP');
          if (binding.identityId !== record.identityId || binding.identityRevision !== record.identityRevision) fail('BOT_IDENTITY_CHANGED');
          const item = await readItem(request.project.id, request.item.id);
          if (!item) fail('BOT_WORKTREE_OWNERSHIP');
          await validateRecord({ ...request, item }, record);
          if (record.publicationBranch === undefined && [item, request.item].some((value) => value.pr || !value.effects || value.effects.some((effect) => effect.kind === 'git.push' || effect.kind.startsWith('pr.')))) {
            fail('BOT_PUBLICATION_ALREADY_STARTED');
          }
          const registry = await readReservations(record.repositoryId);
          const previous = reservedFor(registry, record);
          if (record.publicationBranch !== undefined && record.publicationBranch !== publicationBranch
            || previous && previous.publicationBranch !== publicationBranch) fail('BOT_PUBLICATION_IMMUTABLE');
          if (previous) {
            validateReservation(record, previous, request);
          } else {
            if (record.publicationBranch !== undefined) fail('BOT_PUBLICATION_OWNERSHIP');
            if (registry.reservations.some((entry) => entry.publicationBranch === publicationBranch)) fail('BOT_PUBLICATION_RESERVED');
            if (publicationBranch === record.baseBranch || publicationBranch === await defaultBranch(credential, binding.target)) fail('BOT_PUBLICATION_BASE');
            if (await remoteHead(credential, binding.target, publicationBranch, true) !== null) fail('BOT_PUBLICATION_REMOTE_EXISTS');
            await saveJson(reservationsFile(record.repositoryId), reservationsSchema.parse({ ...registry,
              reservations: [...registry.reservations, { publicationBranch, owner: publicationOwner(record) }] }));
          }
          if (record.publicationBranch === undefined) await save(request, { ...record, publicationBranch });
          return { publicationBranch };
        });
      });
    },
    async readPublication<Input>(input: Input) {
      const query = z.object({ repositoryId: text, botId: text, itemId: text, trustedMigrationPath: botMigrationPathSchema.optional() }).strict().parse(input);
      const reservation = await repositoryLocked(query.repositoryId, async () => {
        const entry = reservedFor(await readReservations(query.repositoryId), query);
        if (entry) return entry;
        for (const name of await fs.readdir(root)) {
          if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
          const record = ownerSchema.parse(JSON.parse(await fs.readFile(path.join(root, name), 'utf8')));
          if (record.repositoryId === query.repositoryId && record.botId === query.botId && record.itemId === query.itemId
            && record.publicationBranch !== undefined) fail('BOT_PUBLICATION_OWNERSHIP');
        }
        return null;
      });
      if (!reservation) return null;
      const request = { project: { id: reservation.owner.projectId }, item: { id: reservation.owner.itemId }, trustedMigrationPath: query.trustedMigrationPath };
      return locked(request, () => repositoryLocked(query.repositoryId, async () => {
        const currentReservation = reservedFor(await readReservations(query.repositoryId), query);
        const checked = validateReservation(await read(request), currentReservation, request);
        const { record, reservation: current } = checked;
        if (record.publicationBranch !== current.publicationBranch || !['ready', 'removing', 'removed'].includes(record.state)) fail('BOT_PUBLICATION_OWNERSHIP');
        return { publicationBranch: record.publicationBranch, localBranch: record.branch, directory: record.directory,
          identityId: record.identityId, identityRevision: record.identityRevision };
      }));
    },
  };
}
