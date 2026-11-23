import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { getWorktrees } from '../git/service.js';
import { resolveRepositoryIdentity } from '../source-control/repository-identity.js';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { botMigrationPathSchema, sameBotMigrationPath } from '../spaces/transfer-bundle.js';
import { requiredFailureProperty } from '../spaces/failure.js';
import { botGit, createBotCheckoutGit } from './production-git.js';
import { adoptionOf, fail, ownerFields, ownerSchema, reservationsSchema } from './production-worktree-contracts.js';
import type { CheckoutLocation, CheckoutOwner, CheckoutIdentityRequest, MigrationRequest, Reservation, Reservations } from './production-worktree-contracts.js';

export const statId = (stat: Stats) => `${stat.dev}:${stat.ino}`;
const repositoryId = async (directory: string) => {
  const identity = await resolveRepositoryIdentity(directory);
  return identity.supported ? identity.repositoryId : undefined;
};
export const publicationOwner = (record: CheckoutOwner) => Object.fromEntries(Object.entries(record)
  .filter(([key, value]) => Object.hasOwn(ownerFields, key) && value !== undefined));
export const reservedFor = (registry: Reservations, { botId, itemId }: Pick<CheckoutOwner, 'botId' | 'itemId'>) => registry.reservations.find((entry) => entry.owner.botId === botId && entry.owner.itemId === itemId);
export const exists = async (name: string) => {
  try { await fs.lstat(name); return true; } catch (error) { if (requiredFailureProperty(error, 'code') === 'ENOENT') return false; throw error; }
};
export const clean = async (record: CheckoutOwner, includeIgnored = false) => {
  const { run } = await createBotCheckoutGit(record.directory);
  if ((await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(includeIgnored ? ['--ignored=matching'] : [])])).length) fail('BOT_WORKTREE_DIRTY');
};

export function createCheckoutOwner(dataDir: string) {
  const root = path.join(dataDir, 'bot-worktrees');
  const location = ({ project, item }: CheckoutLocation) => {
    const key = createHash('sha256').update(`${project.id}\0${item.id}`).digest('hex');
    return { file: path.join(root, `${key}.json`), directory: path.join(root, key) };
  };
  const read = async (request: CheckoutLocation): Promise<CheckoutOwner | null> => {
    try { return ownerSchema.parse(JSON.parse(await fs.readFile(location(request).file, 'utf8'))); }
    catch (error) { if (requiredFailureProperty(error, 'code') === 'ENOENT') return null; throw error; }
  };
  const requireRecord = async (request: CheckoutLocation) => {
    const record = await read(request);
    if (!record) fail('BOT_WORKTREE_OWNERSHIP');
    return record;
  };
  const saveJson = async (file: string, value: CheckoutOwner | Reservations) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  };
  const save = (request: CheckoutLocation, record: CheckoutOwner) => saveJson(location(request).file, ownerSchema.parse(record));
  const locked = async <Result>(request: CheckoutLocation, operation: () => Promise<Result>): Promise<Result> => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return withSourceControlFileLock(`${location(request).file}.lock`, operation, { waitMs: 10_000 });
  };
  const reservationsFile = (repositoryId: string) => path.join(root, `${createHash('sha256').update(repositoryId).digest('hex')}.publications.json`);
  const repositoryLocked = async <Result>(repositoryId: string, operation: () => Promise<Result>): Promise<Result> => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return withSourceControlFileLock(`${reservationsFile(repositoryId)}.lock`, operation, { waitMs: 10_000 });
  };
  const readReservations = async (repositoryId: string): Promise<Reservations> => {
    let registry;
    try { registry = reservationsSchema.parse(JSON.parse(await fs.readFile(reservationsFile(repositoryId), 'utf8'))); }
    catch (error) {
      if (requiredFailureProperty(error, 'code') === 'ENOENT') return { version: 1, repositoryId, reservations: [] };
      throw error;
    }
    if (registry.repositoryId !== repositoryId) fail('BOT_PUBLICATION_OWNERSHIP');
    return registry;
  };
  const validateDirectory = (request: MigrationRequest, record: CheckoutOwner) => {
    if (request.trustedMigrationPath !== undefined) {
      const captured = botMigrationPathSchema.safeParse(request.trustedMigrationPath);
      if (!captured.success) fail('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH');
      const expected = botMigrationPathSchema.safeParse(Object.fromEntries(Object.entries(record).filter(([key]) => Object.hasOwn(captured.data, key))));
      if (!expected.success || !sameBotMigrationPath(captured.data, expected.data)) fail('BOT_MIGRATION_PATH_AUTHORITY_MISMATCH');
    }
    if (record.directory !== location({ project: { id: record.projectId }, item: { id: record.itemId } }).directory
      && request.trustedMigrationPath === undefined) fail('BOT_MIGRATION_PATH_AUTHORITY_REQUIRED');
  };
  const validateReservation = (record: CheckoutOwner | null, reservation: Reservation | undefined, request: MigrationRequest = {}) => {
    if (!record || !reservation || JSON.stringify(publicationOwner(record)) !== JSON.stringify(reservation.owner)
      || record.branch !== `bot/${record.itemId}` || !record.gitDirectory || !record.gitIdentity || !record.directoryIdentity) fail('BOT_PUBLICATION_OWNERSHIP');
    validateDirectory(request, record);
    return { record, reservation };
  };
  const validateRecord = async (request: CheckoutIdentityRequest, record: CheckoutOwner) => {
    if (!record || record.projectId !== request.project.id || record.itemId !== request.item.id || record.botId !== request.bot.id
      || request.item.botId && request.item.botId !== request.bot.id
      || record.branch !== `bot/${request.item.id}`
      || record.projectPath !== await fs.realpath(request.project.path)
      || await repositoryId(request.project.path) !== record.repositoryId
      || request.item.worktree && request.item.worktree !== record.directory
      || request.item.branch && request.item.branch !== record.branch
      || request.item.publicationBranch !== undefined && request.item.publicationBranch !== record.publicationBranch
      || request.key && request.key !== record.key) fail('BOT_WORKTREE_OWNERSHIP');
    validateDirectory(request, record);
  };
  const verifyCheckout = async (request: CheckoutIdentityRequest, record: CheckoutOwner) => {
    await validateRecord(request, record);
    const stat = await fs.lstat(record.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || statId(stat) !== record.directoryIdentity
      || await fs.realpath(record.directory) !== record.directory) fail('BOT_WORKTREE_OWNERSHIP');
    const gitDirectory = (await botGit(record.directory, ['rev-parse', '--absolute-git-dir'])).trim();
    const head = (await botGit(record.directory, ['rev-parse', '--symbolic-full-name', 'HEAD'])).trim();
    const detachedAdoption = record.state === 'adopting' && head === 'HEAD'
      && (await botGit(record.directory, ['rev-parse', 'HEAD'])).trim() === adoptionOf(record).resultSha;
    if (gitDirectory !== record.gitDirectory || statId(await fs.stat(gitDirectory)) !== record.gitIdentity
      || await repositoryId(record.directory) !== record.repositoryId
      || head !== `refs/heads/${record.branch}` && !detachedAdoption) fail('BOT_WORKTREE_OWNERSHIP');
    const topology = await getWorktrees(request.project.path);
    if (!topology.some((entry) => path.resolve(entry.path) === record.directory && (entry.branch === record.branch || detachedAdoption && !entry.branch))
      || topology.some((entry) => entry.branch === record.branch && path.resolve(entry.path) !== record.directory)) fail('BOT_WORKTREE_OWNERSHIP');
  };
  const removalFinished = async (request: CheckoutIdentityRequest, record: CheckoutOwner) => {
    await validateRecord(request, record);
    const topology = await getWorktrees(request.project.path);
    if (await exists(record.directory) || topology.some((entry) => path.resolve(entry.path) === record.directory)) return false;
    if (topology.some((entry) => entry.branch === record.branch)) fail('BOT_WORKTREE_OWNERSHIP');
    const refs = (await botGit(request.project.path, ['for-each-ref', '--format=%(objectname)', `refs/heads/${record.branch}`])).trim();
    if (refs) {
      if (refs !== record.removeHead) fail('BOT_WORKTREE_BRANCH_CHANGED');
      await botGit(request.project.path, ['update-ref', '-d', `refs/heads/${record.branch}`, refs]);
    }
    await save(request, { ...record, state: 'removed' });
    return true;
  };
  return { root, location, read, requireRecord, saveJson, save, locked, reservationsFile, repositoryLocked,
    readReservations, validateReservation, validateRecord, verifyCheckout, removalFinished };
}
export type CheckoutOwnerStore = ReturnType<typeof createCheckoutOwner>;
