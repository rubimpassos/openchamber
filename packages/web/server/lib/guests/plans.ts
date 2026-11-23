import { createHash, randomBytes } from 'node:crypto';
import defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import { z } from 'zod';
import type { GuestPlanProviderContribution, PlanReadResult } from '@openchamber/sdk';
import type { GuestRecord } from './contracts.js';
import { hasErrorCode } from './input-guards.js';
import { planFailure as failure, isInsidePlanRoot as isInside, resolvePlanRoot as resolveRoot, resolvePlanFile, withPlanFsErrors as withFsErrors } from './plan-path.js';
import type { PlanFailure, PlanLocationOptions, PlanResult, ResolvedPlanFile } from './plan-path.js';

import {
  GUEST_PLAN_CONTENT_MAX,
  GUEST_PLAN_DEPTH_MAX,
  GUEST_PLANS_MAX,
  isGuestPlanPathOf,
  requestedGuestCapabilities,
} from '@openchamber/sdk';

const planContentSchema = z.string().max(GUEST_PLAN_CONTENT_MAX);
const planHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

type PlanFileOptions = PlanLocationOptions & { readonly path: string };
type PlanWriteOptions = PlanFileOptions & { readonly content: string; readonly expectedHash: string };
type PlanFile = { readonly path: string; readonly size: number; readonly mtime: number };
type PlanRead = PlanReadResult & { readonly mtime: number };
type PlanWrite = { readonly hash: string; readonly mtime: number };
type PlanList = { readonly plans: readonly PlanFile[]; readonly truncated: boolean };

export const hashPlanBytes = (bytes: string | NodeJS.ArrayBufferView): string => createHash('sha256').update(bytes).digest('hex');

const toPosix = (value: string, nodePath: typeof defaultPath) => (nodePath.sep === '/' ? value : value.split(nodePath.sep).join('/'));

export const authorizeGuestPlanProvider = (guest: GuestRecord, providerId: string, { disabled }: { readonly disabled: boolean }): PlanFailure | { readonly ok: true; readonly provider: GuestPlanProviderContribution } => {
  if (disabled) {
    return failure('DISABLED', `${guest.name} is disabled in Settings → Extensions.`);
  }
  const grants = guest.capabilityGrants ?? [];
  if (!requestedGuestCapabilities(guest).every((capability) => grants.includes(capability)) || !grants.includes('plans')) {
    return failure('NOT_GRANTED', `${guest.name} has not been allowed to show plans. Review it in Settings → Extensions.`);
  }
  const provider = (guest.plans ?? []).find((entry) => entry.id === providerId);
  if (!provider) {
    return failure('NOT_FOUND', 'This extension declares no such plan provider.');
  }
  return { ok: true, provider };
};

export const listGuestPlans = ({ provider, directory, fsPromises = defaultFs, nodePath = defaultPath }: PlanLocationOptions): Promise<PlanResult<PlanList>> => withFsErrors(async (): Promise<PlanResult<PlanList>> => {
  const resolved = await resolveRoot({ provider, directory, fsPromises, nodePath });
  if (!resolved.ok) return resolved;
  if (!resolved.root) return { ok: true, result: { plans: [], truncated: false } };
  const plans: PlanFile[] = [];
  let truncated = false;
  const queue = [{ absolute: resolved.root, logical: provider.root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    let entries;
    try {
      entries = await fsPromises.readdir(current.absolute, { withFileTypes: true });
    } catch (error) {
      if (hasErrorCode(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      throw error;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = nodePath.join(current.absolute, entry.name);
      const logical = `${current.logical}/${entry.name}`;
      if (entry.isDirectory()) {
        if (current.depth < GUEST_PLAN_DEPTH_MAX) queue.push({ absolute, logical, depth: current.depth + 1 });
        continue;
      }
      if (!isGuestPlanPathOf(provider, logical)) continue;
      let stat;
      try {
        const real = entry.isSymbolicLink() ? await fsPromises.realpath(absolute) : absolute;
        if (!isInside(real, resolved.root, nodePath)) continue;
        stat = await fsPromises.stat(real);
      } catch (error) {
        if (hasErrorCode(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
        throw error;
      }
      if (!stat.isFile()) continue;
      if (plans.length >= GUEST_PLANS_MAX) {
        truncated = true;
        break;
      }
      plans.push({ path: toPosix(logical, nodePath), size: stat.size, mtime: Math.floor(stat.mtimeMs) });
    }
    if (truncated) break;
  }
  plans.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { ok: true, result: { plans, truncated } };
});

const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const readBytes = async (resolved: ResolvedPlanFile, fsPromises: typeof defaultFs): Promise<PlanFailure | { readonly ok: true; readonly bytes: Buffer; readonly content: string }> => {
  if (resolved.stat.size > GUEST_PLAN_CONTENT_MAX * 4) {
    return failure('FILE_TOO_LARGE', `Plan is over ${GUEST_PLAN_CONTENT_MAX} characters.`);
  }
  const bytes = await fsPromises.readFile(resolved.real);
  const content = decodeUtf8(bytes);
  if (content === null) return failure('HOST_REJECTED', 'The plan is not UTF-8 text.');
  if (content.length > GUEST_PLAN_CONTENT_MAX) {
    return failure('FILE_TOO_LARGE', `Plan is over ${GUEST_PLAN_CONTENT_MAX} characters.`);
  }
  return { ok: true, bytes, content };
};

export const readGuestPlan = ({ provider, directory, path, fsPromises = defaultFs, nodePath = defaultPath }: PlanFileOptions): Promise<PlanResult<PlanRead>> => withFsErrors(async (): Promise<PlanResult<PlanRead>> => {
  const resolved = await resolvePlanFile({ provider, directory, path, fsPromises, nodePath });
  if (!resolved.ok) return resolved;
  const read = await readBytes(resolved, fsPromises);
  if (!read.ok) return read;
  return { ok: true, result: { content: read.content, hash: hashPlanBytes(read.bytes), mtime: Math.floor(resolved.stat.mtimeMs) } };
});

const fileLocks = new Map<string, Promise<unknown>>();

const withFileLock = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
  const previous = fileLocks.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(run);
  fileLocks.set(key, pending);
  try {
    return await pending;
  } finally {
    if (fileLocks.get(key) === pending) fileLocks.delete(key);
  }
};

export const writeGuestPlan = ({
  provider,
  directory,
  path,
  content,
  expectedHash,
  fsPromises = defaultFs,
  nodePath = defaultPath,
}: PlanWriteOptions): Promise<PlanResult<PlanWrite>> => withFsErrors(async (): Promise<PlanResult<PlanWrite>> => {
  const parsedContent = planContentSchema.safeParse(content);
  if (!parsedContent.success) {
    return failure('FILE_TOO_LARGE', `Plan is over ${GUEST_PLAN_CONTENT_MAX} characters.`);
  }
  const parsedHash = planHashSchema.safeParse(expectedHash);
  if (!parsedHash.success) {
    return failure('HOST_REJECTED', 'A plan write needs the hash of the text it replaces.');
  }
  const first = await resolvePlanFile({ provider, directory, path, fsPromises, nodePath });
  if (!first.ok) return first;
  return withFileLock(first.real, async (): Promise<PlanResult<PlanWrite>> => {
    const resolved = await resolvePlanFile({ provider, directory, path, fsPromises, nodePath });
    if (!resolved.ok) return resolved;
    if (resolved.real !== first.real) return { ok: false, code: 'CONFLICT', message: 'The plan moved while it was being saved.', hash: null };
    const current = await fsPromises.readFile(resolved.real);
    const currentHash = hashPlanBytes(current);
    if (currentHash !== parsedHash.data) {
      return { ok: false, code: 'CONFLICT', message: 'The plan changed since it was opened.', hash: currentHash };
    }
    const bytes = Buffer.from(parsedContent.data, 'utf8');
    const tmp = nodePath.join(
      nodePath.dirname(resolved.real),
      `.${nodePath.basename(resolved.real)}.openchamber-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      await fsPromises.writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
      await fsPromises.chmod(tmp, resolved.stat.mode & 0o777);
      await fsPromises.rename(tmp, resolved.real);
    } catch (error) {
      await fsPromises.unlink(tmp).catch(() => {});
      throw error;
    }
    const stat = await fsPromises.stat(resolved.real);
    return { ok: true, result: { hash: hashPlanBytes(bytes), mtime: Math.floor(stat.mtimeMs) } };
  });
});

export const createPlanDirectoryAuthorizer = ({ listProjectPaths, listWorktreePaths, fsPromises = defaultFs }: {
  readonly listProjectPaths: () => Promise<readonly string[]>;
  readonly listWorktreePaths: (directory: string) => Promise<readonly string[]>;
  readonly fsPromises?: Pick<typeof defaultFs, 'realpath'>;
}): ((directory: string) => Promise<boolean>) => {
  const canonical = async (value: string) => {
    try {
      return await fsPromises.realpath(value);
    } catch {
      return null;
    }
  };
  return async (directory: string) => {
    const target = await canonical(directory);
    if (!target) return false;
    const projects = new Set((await Promise.all((await listProjectPaths()).map(canonical))).filter((value): value is string => value !== null));
    if (projects.has(target)) return true;
    const worktrees = await listWorktreePaths(target);
    const canonicalWorktrees = (await Promise.all(worktrees.map(canonical))).filter((value): value is string => value !== null);
    return canonicalWorktrees.includes(target) && canonicalWorktrees.some((worktree) => projects.has(worktree));
  };
};
