import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fail } from './host-inputs.js';
import { isRecord, isPrimitiveString } from '../shared/guards.js';
import { checkoutOwnerKeys, readCheckout, readPublicationRegistry } from './migration-records.js';
import { grantRetainedBotAccess } from './bot-migration-access.js';
import type { AccessReport, BotWorktreeMapping, ChangedAccess } from './bot-migration-access.types.js';
import { copyEntry, entries, isMigrationObject, parseMigrationRecord, readOwned, writeSplitJson } from './migration-copy.js';
import type { MigrationContext } from './migration-types.js';

const isChangedAccess = (entry: unknown): entry is ChangedAccess => isRecord(entry)
  && isPrimitiveString(entry['path']) && (entry['access'] === 'traverse' || entry['access'] === 'tree');
const hasAccessReport = (error: unknown): error is { readonly botAccess: AccessReport } => isRecord(error) && isRecord(error['botAccess'])
  && isPrimitiveString(error['botAccess']['status']) && ['planned', 'granted', 'partial', 'refused'].includes(error['botAccess']['status'])
  && Array.isArray(error['botAccess']['trees']) && error['botAccess']['trees'].every(isPrimitiveString)
  && Array.isArray(error['botAccess']['changed']) && error['botAccess']['changed'].every(isChangedAccess)
  && (error['botAccess']['failed'] === undefined || isPrimitiveString(error['botAccess']['failed']));

export async function retainBotWorktrees(context: MigrationContext) {
  const { source, botRoot, frontData, agentData, agent, owner, system, manifest, dryRun, root, trustedBotWorktrees } = context;
  const directory = path.join(source, 'bot-worktrees');
  const retained: BotWorktreeMapping[] = [];
  const live: BotWorktreeMapping[] = [];
  const owners = new Map<string, ReturnType<typeof readCheckout>>();
  const registries: ReturnType<typeof readPublicationRegistry>[] = [];
  const files: { readonly name: string; readonly file: string }[] = [];
  for (const name of await entries(directory)) {
    if (!name.endsWith('.json') || name === 'migration-paths.json') continue;
    const file = path.join(directory, name);
    const text = await readOwned(file, owner);
    if (text === null) fail('migration_bots_malformed', 'Unreadable bot worktree descriptor');
    const parsed = parseMigrationRecord(text);
    files.push({ name, file });
    if (isMigrationObject(parsed) && Object.hasOwn(parsed, 'reservations')) {
      const record = readPublicationRegistry(parsed);
      if (new Set(record.reservations.map((entry) => entry.publicationBranch)).size !== record.reservations.length
        || new Set(record.reservations.map((entry) => `${entry.owner.botId}\0${entry.owner.itemId}`)).size !== record.reservations.length) {
        fail('migration_bots_conflict', 'Conflicting bot publication authority');
      }
      registries.push(record);
      continue;
    }
    const record = readCheckout(parsed);
    if (record.branch !== `bot/${record.itemId}`) fail('migration_bots_malformed', 'Invalid bot checkout authority');
    const key = `${record.projectId}\0${record.itemId}`;
    if (owners.has(key)) fail('migration_bots_conflict', 'Duplicate bot checkout ownership');
    owners.set(key, record);
    const { projectId, itemId, directory: checkoutDirectory, directoryIdentity, gitDirectory, gitIdentity } = record;
    if (!directoryIdentity || !gitDirectory || !gitIdentity) fail('migration_bots_path_authority_required', 'Existing bot checkouts require an explicit trusted path mapping');
    const captured = { projectId, itemId, directory: checkoutDirectory, directoryIdentity, gitDirectory, gitIdentity };
    if (!trustedBotWorktrees.some((entry) => isDeepStrictEqual(entry, captured))) fail('migration_bots_path_authority_required', 'Existing bot checkouts require an explicit trusted path mapping');
    if (record.state !== 'removed') {
      for (const [location, identity] of [[captured.directory, captured.directoryIdentity], [captured.gitDirectory, captured.gitIdentity]] as const) {
        if (!path.isAbsolute(location)) fail('migration_bots_malformed', 'Invalid bot worktree path');
        const physical = path.join(root, location);
        const stats = await fs.lstat(physical, { bigint: true });
        if (!stats.isDirectory() || stats.isSymbolicLink() || await fs.realpath(physical) !== physical
          || `${stats.dev}:${stats.ino}` !== identity) fail('migration_bots_path_changed', 'An existing bot checkout changed identity');
      }
      live.push(captured);
    }
    retained.push(captured);
  }
  for (const registry of registries) for (const reservation of registry.reservations) {
    const retainedOwner = owners.get(`${reservation.owner.projectId}\0${reservation.owner.itemId}`);
    const captured = retainedOwner && Object.fromEntries(Object.entries(retainedOwner)
      .filter(([key, value]) => checkoutOwnerKeys.includes(key) && value !== undefined));
    if (!retainedOwner || registry.repositoryId !== retainedOwner.repositoryId || !isDeepStrictEqual(captured, reservation.owner)
      || reservation.publicationBranch !== (retainedOwner.publicationBranch ?? retainedOwner.branch)) fail('migration_bots_conflict', 'Conflicting bot publication ownership');
  }
  try {
    manifest.botWorktreeAccess = await grantRetainedBotAccess({ root, botRoot, entries: live, human: owner, agent, run: system.runResult, dryRun });
  } catch (error) {
    manifest.botWorktreeAccess = hasAccessReport(error) ? error.botAccess : { status: 'refused', changed: [] };
    throw error;
  }
  for (const { name, file } of files) await copyEntry(context, { source: file, target: path.join(agentData, 'bot-worktrees', name), account: 'agent', kind: 'agent', strict: true });
  if (retained.length) await writeSplitJson(context, { source: directory, target: path.join(agentData, 'bot-worktrees/migration-paths.json'),
    value: { version: 1, entries: retained }, account: 'agent', kind: 'agent' });
  if (retained.length) await writeSplitJson(context, { source: directory, target: path.join(frontData, 'bots/migration-paths.json'),
    value: { version: 1, entries: retained }, account: 'front', kind: 'front-door' });
  manifest.botWorktrees = retained;
}
