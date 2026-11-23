import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { fail } from './accounts.js';
import { hasCode, isRecord } from './host-inputs.js';
import { isPrimitiveString } from '../shared/guards.js';

import type { BotWorktreeMapping, ReadOptions, Principal, ChangedAccess, AccessReport, GrantOptions } from './bot-migration-access.types.js';
type AclScope = 'access' | 'default';
type AclType = 'user' | 'group' | 'mask' | 'other';
type AclEntry = { readonly scope: AclScope; readonly type: AclType; readonly id: string; value: number };
type PlannedAccess = { readonly target: string; readonly identity: string; readonly acl: string | null;
  readonly previousAcl: string; readonly ancestor: boolean };

const localFilesystems = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'tmpfs', 'overlay', 'bcachefs']);
const inside = (child: string, parent: string) => child === parent || child.startsWith(`${parent.replace(/\/$/, '')}/`);
const identity = (stat: BigIntStats) => `${stat.dev}:${stat.ino}`;
const bits = (value: string) => (value[0] === 'r' ? 4 : 0) | (value[1] === 'w' ? 2 : 0) | (value[2] === 'x' ? 1 : 0);
const permissions = (value: number) => `${value & 4 ? 'r' : '-'}${value & 2 ? 'w' : '-'}${value & 1 ? 'x' : '-'}`;
function refuse(): never { return fail('migration_bots_access_refused', 'The exact retained Bot filesystem access could not be granted safely'); }
const mappingKeys = ['directory', 'directoryIdentity', 'gitDirectory', 'gitIdentity', 'itemId', 'projectId'] as const;
const isMapping = (entry: unknown): entry is BotWorktreeMapping => isRecord(entry)
  && Object.keys(entry).sort().join(',') === mappingKeys.join(',')
  && mappingKeys.every((key) => { const value = entry[key]; return isPrimitiveString(value) && value.length > 0
    && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127); })
  && ['directoryIdentity', 'gitIdentity'].every((key) => isPrimitiveString(entry[key]) && /^[0-9]+:[0-9]+$/.test(entry[key]))
  && ['directory', 'gitDirectory'].every((key) => { const value = entry[key]; return isPrimitiveString(value)
    && path.isAbsolute(value) && path.normalize(value) === value && !value.endsWith('/'); });

export async function readTrustedBotWorktrees({ root = '/', file, readIdentity = (handle) => handle.stat({ bigint: true }) }: ReadOptions): Promise<readonly BotWorktreeMapping[]> {
  if (file === undefined) return [];
  function invalid(): never { return fail('migration_bots_path_authority_required', 'Give --bot-worktrees-file with a root-owned, read-only regular JSON file on a root-owned physical path'); }
  if (!isPrimitiveString(file) || !path.isAbsolute(file) || path.normalize(file) !== file || file.endsWith('/')) invalid();
  const physicalRoot = path.resolve(root);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(physicalRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const components = path.relative('/', file).split(path.sep);
    for (let index = 0; index <= components.length; index += 1) {
      const stat = await readIdentity(handle);
      const last = index === components.length;
      if (Number(stat.uid) !== 0 || Number(stat.mode) & (last ? 0o222 : 0o022)
        || (last ? !stat.isFile() || Number(stat.nlink) !== 1 : !stat.isDirectory())) invalid();
      if (last) break;
      const next = await fs.open(`/proc/self/fd/${handle.fd}/${components[index]}`,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      await handle.close(); handle = next;
    }
    const before = await readIdentity(handle);
    const raw = await handle.readFile('utf8');
    const after = await readIdentity(handle);
    if ((['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const).some((key) => before[key] !== after[key])) invalid();
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'entries,version' || value['version'] !== 1 || !Array.isArray(value['entries'])) invalid();
    const entries: readonly unknown[] = value['entries'];
    if (!entries.every(isMapping)) invalid();
    const owners = new Set<string>();
    const locations = new Set<string>();
    for (const entry of entries) {
      const owner = `${entry.projectId}\0${entry.itemId}`;
      if (owners.has(owner)) invalid();
      owners.add(owner);
      for (const location of [entry.directory, entry.gitDirectory]) {
        if (locations.has(location)) invalid();
        locations.add(location);
      }
    }
    return entries;
  } catch (error) {
    if (hasCode(error, 'migration_bots_path_authority_required')) throw error;
    return invalid();
  } finally { await handle?.close(); }
}

function parseAcl(text: string): AclEntry[] {
  const entries = text.trim().split('\n').filter(Boolean).map((line): AclEntry => {
    const match = /^(default:)?(user|group|mask|other):([0-9]*):([r-][w-][x-])$/.exec(line);
    if (!match) refuse();
    const [, defaults, type, id, value] = match;
    if ((type !== 'user' && type !== 'group' && type !== 'mask' && type !== 'other') || id === undefined || value === undefined
      || (type === 'mask' || type === 'other') && id) refuse();
    return { scope: defaults ? 'default' : 'access', type, id, value: bits(value) };
  });
  if (new Set(entries.map((entry) => `${entry.scope}:${entry.type}:${entry.id}`)).size !== entries.length) refuse();
  for (const scope of ['access', 'default']) {
    const selected = entries.filter((entry) => entry.scope === scope);
    if (scope === 'default' && selected.length === 0) continue;
    if (!['user', 'group', 'other'].every((type) => selected.some((entry) => entry.type === type && !entry.id))) refuse();
    if (selected.some((entry) => entry.id) && !selected.some((entry) => entry.type === 'mask')) refuse();
  }
  return entries;
}

const entryOf = (entries: readonly AclEntry[], type: AclType, id = '') => entries.find((entry) => entry.type === type && entry.id === id);
function effectiveAccess(entries: readonly AclEntry[], stat: BigIntStats, agent: Principal) {
  if (Number(stat.uid) === agent.uid) return (entryOf(entries, 'user') ?? refuse()).value;
  const mask = entryOf(entries, 'mask')?.value ?? 7;
  const named = entryOf(entries, 'user', String(agent.uid));
  if (named) return named.value & mask;
  const groups = new Set([agent.gid, ...agent.gids ?? []].map(String));
  const applicable = entries.filter((entry) => entry.type === 'group' && groups.has(entry.id || String(stat.gid)));
  return applicable.length ? applicable.reduce((value, entry) => value | entry.value, 0) & mask : (entryOf(entries, 'other') ?? refuse()).value;
}

function grantScope(entries: AclEntry[], scope: AclScope, grants: readonly (readonly [number, number])[]) {
  const selected = entries.filter((entry) => entry.scope === scope);
  const previousMask = entryOf(selected, 'mask')?.value ?? 7;
  for (const entry of selected) if (entry.type === 'group' || entry.type === 'user' && entry.id) entry.value &= previousMask;
  for (const [uid, desired] of grants) {
    const previous = entryOf(selected, 'user', String(uid));
    if (previous) previous.value |= desired;
    else { const entry: AclEntry = { scope, type: 'user', id: String(uid), value: desired }; selected.push(entry); entries.push(entry); }
  }
  let mask = entryOf(selected, 'mask');
  const wanted = selected.filter((entry) => entry.type === 'group' || entry.type === 'user' && entry.id).reduce((value, entry) => value | entry.value, 0);
  if (mask) mask.value = wanted;
  else { mask = { scope, type: 'mask', id: '', value: wanted }; entries.push(mask); }
}

function aclFor(text: string, stat: BigIntStats, { human, agent, ancestor }: { readonly human: GrantOptions['human']; readonly agent: Principal; readonly ancestor: boolean }) {
  const originalEntries = parseAcl(text);
  const entries = structuredClone(originalEntries);
  const access = entries.filter((entry) => entry.scope === 'access');
  const original = effectiveAccess(access, stat, agent);
  const needed = ancestor ? 1 : (stat.isDirectory() || Number(stat.mode) & 0o111 ? 7 : 6);
  if (ancestor && (original & 1)) return null;
  if (Number(stat.uid) === agent.uid) (entryOf(access, 'user') ?? refuse()).value |= needed;
  else grantScope(entries, 'access', [[agent.uid, original | needed]]);
  if (!ancestor && stat.isDirectory()) {
    if (!entries.some((entry) => entry.scope === 'default')) {
      for (const type of ['user', 'group', 'other'] as const) {
        const originalAccess = originalEntries.filter((entry) => entry.scope === 'access');
        const originalEntry = entryOf(originalAccess, type) ?? refuse();
        const value = type === 'group' ? originalEntry.value & (entryOf(originalAccess, 'mask')?.value ?? 7) : originalEntry.value;
        entries.push({ scope: 'default', type, id: '', value });
      }
    }
    (entryOf(entries.filter((entry) => entry.scope === 'default'), 'user') ?? refuse()).value = 7;
    grantScope(entries, 'default', [[agent.uid, 7], [human.uid, 7]]);
  }
  if (!stat.isDirectory() && entries.some((entry) => entry.scope === 'default')) refuse();
  return entries.map((entry) => `${entry.scope === 'default' ? 'd:' : ''}${entry.type}:${entry.id}:${permissions(entry.value)}`).join(',');
}

async function openPhysical(root: string, target: string) {
  if (!inside(target, root) || path.normalize(target) !== target) refuse();
  let handle = await fs.open(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
      const next = await fs.open(`/proc/self/fd/${handle.fd}/${component}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      await handle.close(); handle = next;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

function requireLocalTrees(trees: readonly string[], text: string) {
  const decode = (value: string) => value.replace(/\\([0-7]{3})/g, (_match: string, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
  const mounts = text.split('\n').filter(Boolean).map((line) => {
    const [before, after] = line.split(' - ');
    return { directory: decode((before ?? '').split(' ')[4] ?? ''), type: after?.split(' ')[0] };
  });
  for (const tree of trees) {
    const containing = mounts.filter((mount) => inside(tree, mount.directory)).sort((a, b) => b.directory.length - a.directory.length)[0];
    if (!containing || !containing.type || !localFilesystems.has(containing.type)
      || mounts.some((mount) => mount.directory !== tree && inside(mount.directory, tree))) refuse();
  }
}

export async function grantRetainedBotAccess({ root = '/', botRoot, entries, human, agent, run, dryRun = false,
  readMountInfo = () => fs.readFile('/proc/self/mountinfo', 'utf8') }: GrantOptions): Promise<AccessReport> {
  const pendingAgent = dryRun && agent.uid === undefined && agent.gid === undefined;
  if (!Number.isSafeInteger(human.uid) || human.uid < 0 || !pendingAgent
    && (![agent.uid, agent.gid].every((id) => id !== undefined && Number.isSafeInteger(id) && id >= 0) || agent.uid === 0 || human.uid === agent.uid)) refuse();
  const principal = pendingAgent ? null : { uid: agent.uid ?? refuse(), gid: agent.gid ?? refuse(), gids: agent.gids };
  const physicalRoot = path.resolve(root);
  const trees = new Map<string, string>();
  for (const entry of entries) {
    if (path.dirname(entry.directory) !== botRoot) refuse();
    for (const [directory, expected] of [[entry.directory, entry.directoryIdentity], [entry.gitDirectory, entry.gitIdentity]] as const) {
      if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory.endsWith('/')
        || inside(human.home, directory) || inside(botRoot, directory)) refuse();
      const physical = path.join(physicalRoot, directory);
      if (trees.has(physical) && trees.get(physical) !== expected) refuse();
      trees.set(physical, expected);
    }
  }
  if (!trees.size) return { status: dryRun ? 'planned' : 'granted', trees: [], changed: [] };
  requireLocalTrees([...trees.keys()], await readMountInfo());
  const plan = new Map<string, PlannedAccess>();
  const inspect = async (target: string, expected: string | null, ancestor: boolean): Promise<void> => {
    const handle = await openPhysical(physicalRoot, target);
    try {
      const stat = await handle.stat({ bigint: true });
      if (expected && identity(stat) !== expected || !stat.isDirectory() && !stat.isFile()
        || !ancestor && ![human.uid, agent.uid].includes(Number(stat.uid))
        || stat.isFile() && (stat.nlink > 1n || Number(stat.mode) & 0o6000)) refuse();
      const result = await run('/usr/bin/getfacl', ['-cEn', '--', `/proc/${process.pid}/fd/${handle.fd}`]);
      if (result.code !== 0) refuse();
      if (pendingAgent) parseAcl(result.stdout);
      const acl = principal ? aclFor(result.stdout, stat, { human, agent: principal, ancestor }) : null;
      const previous = plan.get(target);
      if (!previous || !ancestor) plan.set(target, { target, identity: identity(stat), acl, previousAcl: result.stdout.trim(), ancestor });
      if (!ancestor && stat.isDirectory()) {
        for (const name of await fs.readdir(`/proc/self/fd/${handle.fd}`)) {
          const child = await fs.lstat(`/proc/self/fd/${handle.fd}/${name}`, { bigint: true });
          if (child.isSymbolicLink()) continue;
          if (child.dev !== stat.dev) refuse();
          await inspect(path.join(target, name), identity(child), false);
        }
      }
    } finally { await handle.close(); }
  };
  for (const [tree, expected] of trees) {
    await inspect(tree, expected, false);
    for (let ancestor = path.dirname(tree); inside(ancestor, physicalRoot); ancestor = path.dirname(ancestor)) {
      await inspect(ancestor, null, true);
      if (ancestor === physicalRoot) break;
    }
  }
  const changed: ChangedAccess[] = [];
  try {
    if (!dryRun) for (const entry of plan.values()) {
      if (!entry.acl) continue;
      const handle = await openPhysical(physicalRoot, entry.target);
      try {
        const stat = await handle.stat({ bigint: true });
        if (identity(stat) !== entry.identity || !entry.ancestor && ![human.uid, agent.uid].includes(Number(stat.uid))
          || stat.isFile() && (stat.nlink > 1n || Number(stat.mode) & 0o6000)) refuse();
        const current = await run('/usr/bin/getfacl', ['-cEn', '--', `/proc/${process.pid}/fd/${handle.fd}`]);
        if (current.code !== 0 || current.stdout.trim() !== entry.previousAcl) refuse();
        const result = await run('/usr/bin/setfacl', ['-n', `--set=${entry.acl}`, '--', `/proc/${process.pid}/fd/${handle.fd}`]);
        if (result.code !== 0) {
          const error = Object.assign(new Error('A retained Bot access grant failed; retain the migration journal and retry offline'),
            { code: 'migration_bots_access_refused', botAccess: { status: 'partial', trees: [...trees.keys()], changed, failed: entry.target } satisfies AccessReport });
          throw error;
        }
        changed.push({ path: entry.target, access: entry.ancestor ? 'traverse' : 'tree' });
      } finally { await handle.close(); }
    }
  } catch (error) {
    if (isRecord(error) && (!('botAccess' in error) || error['botAccess'] == null)) {
      Object.assign(error, { botAccess: { status: changed.length ? 'partial' : 'refused', trees: [...trees.keys()], changed } satisfies AccessReport });
    }
    throw error;
  }
  return { status: dryRun ? 'planned' : 'granted', trees: [...trees.keys()], changed };
}
