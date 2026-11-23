import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { fail, hasCode } from './host-inputs.js';
import { isRecord } from '../shared/guards.js';
import { readBotItem } from './migration-records.js';
import type { CopyDestination, MigrationAccount, MigrationContext, MigrationFile, MigrationObject, MigrationSystem, MigrationValue, SplitDestination } from './migration-types.js';

export const AGENT_BOT_RECORDS = new Set(['bot-identities.json', 'source-control-mutations.json', 'source-control-audit.json']);
export const parseMigrationRecord = (text: string | null): MigrationValue => {
  try { return JSON.parse(text ?? 'null'); }
  catch { return fail('migration_bots_malformed', 'Invalid migration JSON record'); }
};
export const entries = async (directory: string) => {
  try { return await fs.readdir(directory); }
  catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
};
export const missing = (error: NodeJS.ErrnoException): null => { if (hasCode(error, 'ENOENT')) return null; throw error; };
export const isMigrationObject = (value: MigrationValue | undefined): value is MigrationObject => isRecord(value);

export async function requirePhysicalDirectory(root: string, directory: string) {
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('migration_destination_outside_root', 'The migration destination must stay inside its installation root');
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stats = await fs.lstat(current).catch(missing);
    if (stats && !stats.isDirectory()) fail('migration_destination_link', `Migration destination ancestor is not a physical directory: ${current}`);
  }
}

export async function ownTree(system: Pick<MigrationSystem, 'chown'>, directory: string, account: Pick<MigrationAccount, 'uid' | 'gid'>) {
  const stats = await fs.lstat(directory);
  if (stats.isSymbolicLink() || (!stats.isDirectory() && stats.nlink > 1)) return;
  await system.chown(directory, account.uid, account.gid);
  if (stats.isDirectory()) for (const name of await fs.readdir(directory)) await ownTree(system, path.join(directory, name), account);
}

async function openOwned(file: string, owner: Pick<MigrationAccount, 'uid'>) {
  let handle;
  try { handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (hasCode(error, 'ELOOP') || hasCode(error, 'ENOENT') || hasCode(error, 'ENXIO')) return null; throw error; }
  const stats = await handle.stat();
  if (stats.isFile() && stats.uid === owner.uid) return handle;
  await handle.close();
  return null;
}

export async function readOwned(file: string, owner: Pick<MigrationAccount, 'uid'>) {
  const real = await fs.realpath(file).catch(missing);
  const handle = real && await openOwned(real, owner);
  if (!handle) return null;
  try { return await handle.readFile('utf8'); } finally { await handle.close(); }
}

export async function readOptionalAuthority(file: string, owner: Pick<MigrationAccount, 'uid'>) {
  const exists = await fs.lstat(file).catch(missing);
  if (!exists) return null;
  const content = await readOwned(file, owner);
  if (content === null) fail('migration_bots_malformed', 'Unreadable Bots migration authority');
  return content;
}

export function readItemSnapshot(value: MigrationValue, message = 'Invalid queued Bot item snapshot') {
  if (!isMigrationObject(value) || value['version'] !== 1 || !Number.isSafeInteger(value['revision']) || Number(value['revision']) < 0 || !Array.isArray(value['items'])
    || new Set(value['items'].map((item: MigrationValue) => isMigrationObject(item) ? item['id'] : undefined)).size !== value['items'].length) fail('migration_bots_malformed', message);
  return value['items'].map((item: MigrationValue) => readBotItem(item));
}

export async function copyEntry(context: MigrationContext, destination: CopyDestination): Promise<void> {
  const { source, target, kind, filter, ancestors = [], strict = false } = destination;
  const { root, owner, system, manifest } = context;
  await requirePhysicalDirectory(root, path.dirname(target));
  const record: MigrationFile = { source, target, class: kind, status: 'planned' };
  manifest.files.push(record);
  const existing = await fs.lstat(target).catch(missing);
  const real = await fs.realpath(source);
  if (ancestors.includes(real)) { if (strict) fail('migration_bots_malformed', 'Cyclic Bots migration source'); record.status = 'cycle-skipped'; return; }
  const stats = await fs.stat(real);
  if (!stats.isDirectory() && !stats.isFile()) { if (strict) fail('migration_bots_malformed', 'Unsupported Bots migration source'); record.status = 'special-skipped'; return; }
  if (stats.uid !== owner.uid) { if (strict) fail('migration_bots_malformed', 'Unreadable Bots migration source'); record.status = 'foreign-skipped'; return; }
  if (strict && stats.isFile()) {
    const content = await readOwned(source, owner);
    if (/\.json$/.test(source)) {
      const parsed = parseMigrationRecord(content);
      if (!(isRecord(parsed) || Array.isArray(parsed) && AGENT_BOT_RECORDS.has(path.basename(source)))) fail('migration_bots_malformed', 'Invalid Bots migration record');
      if (path.basename(source) === 'bots.json') readItemSnapshot(parsed, 'Invalid Bots snapshot');
      if (path.basename(path.dirname(source)) === 'bot-executions'
        && (!isMigrationObject(parsed) || parsed['version'] !== 1 || !isMigrationObject(parsed['operations'])
          || !isMigrationObject(parsed['data']))) fail('migration_bots_malformed', 'Invalid Bot execution journal');
    }
    if (/\.jsonl$/.test(source)) for (const line of (content ?? '').split('\n').filter(Boolean)) {
      const parsed = parseMigrationRecord(line);
      readBotItem(isMigrationObject(parsed) ? parsed['item'] : undefined);
    }
    if (existing && (!existing.isFile() || await fs.readFile(target, 'utf8') !== content)) fail('migration_bots_conflict', `Conflicting Bots migration destination: ${target}`);
  }
  if (existing && !(existing.isDirectory() && stats.isDirectory())) { record.status = 'existing'; return; }
  if (existing) record.status = 'existing';
  else if (!context.dryRun) {
    const account = context[destination.account];
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await system.chown(path.dirname(target), account.uid, account.gid);
    if (stats.isDirectory()) await fs.mkdir(target, { mode: 0o700 });
    else {
      const handle = await openOwned(real, owner);
      if (!handle) { record.status = 'foreign-skipped'; return; }
      await pipeline(handle.createReadStream(), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    }
    await system.chown(target, account.uid, account.gid);
    await fs.chmod(target, stats.isDirectory() ? 0o700 : (stats.mode & 0o100 ? 0o700 : 0o600));
    record.status = 'copied';
  }
  if (stats.isDirectory()) for (const name of await fs.readdir(real)) {
    if (name.endsWith('.lock') || name.endsWith('.lock.guard')) continue;
    if (filter && !filter(name)) { manifest.files.push({ source: path.join(source, name), target: null, class: 'skipped', status: 'skipped' }); continue; }
    await copyEntry(context, { ...destination, source: path.join(real, name), target: path.join(target, name), ancestors: [...ancestors, real] });
  }
}

export async function writeSplitJson(context: MigrationContext, destination: SplitDestination, preflight = false) {
  const { source, target, value, kind } = destination;
  const { root, system, manifest } = context;
  await requirePhysicalDirectory(root, path.dirname(target));
  const record: MigrationFile = { source, target, class: kind, status: 'planned' };
  manifest.files.push(record);
  const existing = await fs.lstat(target).catch(missing);
  if (existing) {
    if (!existing.isFile() || !isDeepStrictEqual(parseMigrationRecord(await fs.readFile(target, 'utf8')), value)) {
      record.status = 'conflict';
      fail('migration_bots_conflict', `Conflicting Bots migration destination: ${target}`);
    }
    record.status = 'existing';
    return;
  }
  if (context.dryRun || preflight) return;
  const account = context[destination.account];
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await system.chown(path.dirname(target), account.uid, account.gid);
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await system.chown(target, account.uid, account.gid);
  record.status = 'copied';
}
