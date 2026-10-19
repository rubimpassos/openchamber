import { z } from 'zod';
import type { SourceControlReadContext } from '@/lib/api/types';

/** Where a new pull request goes: the bound repository, or the repository it was forked from. */
export type PullRequestTarget = 'origin' | 'parent';

const TARGET_KEY = 'openchamber:pr-create-target:v1';
const MAX_REMEMBERED = 50;

export const getPullRequestTargetKey = (context: Pick<SourceControlReadContext, 'provider' | 'instance' | 'repositoryId'>): string =>
  `${context.provider}:${context.instance}:${context.repositoryId}`;

const rememberedSchema = z.record(z.string(), z.enum(['origin', 'parent']));

/** Malformed storage counts as nothing remembered. */
const readAll = () => {
  try {
    const parsed = rememberedSchema.safeParse(JSON.parse(localStorage.getItem(TARGET_KEY) ?? '{}'));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
};

/** The target the person last switched to for this repository, if any. */
export const readRememberedTarget = (key: string): PullRequestTarget | null => readAll()[key] ?? null;

/** Kept only for explicit switches; the computed default is never stored. */
export const rememberTarget = (key: string, target: PullRequestTarget): void => {
  const entries = readAll();
  delete entries[key];
  entries[key] = target;
  const keys = Object.keys(entries);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED))) delete entries[stale];
  try { localStorage.setItem(TARGET_KEY, JSON.stringify(entries)); } catch { /* convenience only */ }
};

/**
 * Not a fork: the bound repository. Otherwise the remembered choice, else the
 * fork itself when the account can push to it (the person's own fork), else
 * the parent, where a fork without push access sends its changes.
 */
export const resolveDefaultTarget = (options: {
  isFork: boolean;
  viewerCanPush: boolean;
  remembered: PullRequestTarget | null;
}): PullRequestTarget => {
  if (!options.isFork) return 'origin';
  if (options.remembered) return options.remembered;
  return options.viewerCanPush ? 'origin' : 'parent';
};

const normalize = (value: string): string => value.trim()
  .replace(/^refs\/heads\//, '')
  .replace(/^heads\//, '')
  .replace(/^remotes\//, '');

/**
 * Base branches of the selected target only. The bound repository offers its
 * remote's branches; the parent offers the branches read from the provider,
 * never local refs of other remotes.
 */
export const buildBaseBranchOptions = (options: {
  target: PullRequestTarget;
  remoteBranches: readonly string[];
  primaryRemote: string | null;
  parentBranches: readonly string[];
  parentDefaultBranch: string | null;
  baseBranch: string;
  selected: string;
}): string[] => {
  const unique = new Set<string>();
  const add = (value: string | null | undefined) => {
    const name = value ? normalize(value) : '';
    if (name && name !== 'HEAD' && !name.includes('->')) unique.add(name);
  };
  if (options.target === 'parent') {
    options.parentBranches.forEach(add);
    add(options.parentDefaultBranch);
  } else {
    const prefix = options.primaryRemote ? `${options.primaryRemote}/` : null;
    for (const remoteBranch of options.remoteBranches) {
      const name = normalize(remoteBranch);
      if (prefix ? name.startsWith(prefix) : name.includes('/')) add(prefix ? name.slice(prefix.length) : name.slice(name.indexOf('/') + 1));
    }
    add(options.baseBranch);
  }
  add(options.selected);
  return Array.from(unique).sort((a, b) => a.localeCompare(b));
};
