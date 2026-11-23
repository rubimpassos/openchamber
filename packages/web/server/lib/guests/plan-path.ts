import defaultFs from 'node:fs/promises';
import defaultPath from 'node:path';
import type { Stats } from 'node:fs';
import { isGuestPlanPathOf } from '@openchamber/sdk';
import type { GuestPlanProviderContribution } from '@openchamber/sdk';
import { hasErrorCode } from './input-guards.js';
import { z } from 'zod';

const planPathSchema = z.string();

export type PlanFailure = {
  readonly ok: false;
  readonly code: 'DISABLED' | 'NOT_GRANTED' | 'NOT_FOUND' | 'DENIED' | 'BAD_PATH' | 'NO_DIRECTORY' | 'FILE_TOO_LARGE' | 'HOST_REJECTED';
  readonly message: string;
} | { readonly ok: false; readonly code: 'CONFLICT'; readonly message: string; readonly hash: string | null };
export type PlanResult<T> = PlanFailure | { readonly ok: true; readonly result: T };
export type PlanLocationOptions = {
  readonly provider: GuestPlanProviderContribution;
  readonly directory: string;
  readonly fsPromises?: typeof defaultFs;
  readonly nodePath?: typeof defaultPath;
};
type PlanPathContext = Required<PlanLocationOptions>;
export type ResolvedPlanFile = { readonly ok: true; readonly real: string; readonly stat: Stats };
type ResolvedPlanRoot = { readonly ok: true; readonly worktree: string; readonly root: string | null };

export const planFailure = (code: Exclude<PlanFailure['code'], 'CONFLICT'>, message: string): PlanFailure => ({ ok: false, code, message });
export const isInsidePlanRoot = (candidate: string, root: string, nodePath: typeof defaultPath): boolean => (
  candidate === root || candidate.startsWith(root.endsWith(nodePath.sep) ? root : `${root}${nodePath.sep}`)
);

const mapFsError = (cause: unknown): PlanFailure | null => {
  const code = hasErrorCode(cause) ? cause.code : undefined;
  if (code === 'ENOENT' || code === 'ENOTDIR') return planFailure('NOT_FOUND', 'No plan at that path.');
  if (code === 'EACCES' || code === 'EPERM') return planFailure('DENIED', 'The operating system refused access to that plan.');
  if (code === 'EISDIR') return planFailure('BAD_PATH', 'That path is a folder.');
  return null;
};

export const resolvePlanRoot = async ({ provider, directory, fsPromises, nodePath }: PlanPathContext): Promise<PlanFailure | ResolvedPlanRoot> => {
  let worktree: string;
  try {
    worktree = await fsPromises.realpath(directory);
  } catch {
    return planFailure('NO_DIRECTORY', 'The worktree is not available.');
  }
  let root: string;
  try {
    root = await fsPromises.realpath(nodePath.resolve(worktree, provider.root));
  } catch (error) {
    if (hasErrorCode(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { ok: true, worktree, root: null };
    throw error;
  }
  if (!isInsidePlanRoot(root, worktree, nodePath) || root === worktree) {
    return planFailure('BAD_PATH', 'The plan folder leaves the worktree.');
  }
  const stat = await fsPromises.stat(root);
  if (!stat.isDirectory()) return planFailure('BAD_PATH', 'The plan folder is not a folder.');
  return { ok: true, worktree, root };
};

export const resolvePlanFile = async ({ provider, directory, path, fsPromises, nodePath }: PlanPathContext & { readonly path: string }): Promise<PlanFailure | ResolvedPlanFile> => {
  const parsed = planPathSchema.safeParse(path);
  if (!parsed.success || !isGuestPlanPathOf(provider, parsed.data)) {
    return planFailure('BAD_PATH', 'That path is not a plan of this provider.');
  }
  const resolved = await resolvePlanRoot({ provider, directory, fsPromises, nodePath });
  if (!resolved.ok) return resolved;
  if (!resolved.root) return planFailure('NOT_FOUND', 'No plan at that path.');
  const real = await fsPromises.realpath(nodePath.resolve(resolved.worktree, parsed.data));
  if (!isInsidePlanRoot(real, resolved.root, nodePath) || real === resolved.root) {
    return planFailure('BAD_PATH', 'That plan leaves the plan folder.');
  }
  const stat = await fsPromises.lstat(real);
  if (!stat.isFile()) return planFailure('BAD_PATH', 'That plan is not a regular file.');
  return { ok: true, real, stat };
};

export const withPlanFsErrors = async <T>(run: () => Promise<T>): Promise<T | PlanFailure> => {
  try {
    return await run();
  } catch (error) {
    const mapped = mapFsError(error);
    if (mapped) return mapped;
    throw error;
  }
};
