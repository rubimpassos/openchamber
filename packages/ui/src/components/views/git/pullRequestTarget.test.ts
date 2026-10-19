import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildBaseBranchOptions,
  getPullRequestTargetKey,
  readRememberedTarget,
  rememberTarget,
  resolveDefaultTarget,
} from './pullRequestTarget';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  },
});

afterEach(() => storage.clear());

describe('pull request target', () => {
  test('a repository that is not a fork always targets itself', () => {
    expect(resolveDefaultTarget({ isFork: false, viewerCanPush: false, remembered: 'parent' })).toBe('origin');
  });

  test('a fork the account can push to targets the fork', () => {
    expect(resolveDefaultTarget({ isFork: true, viewerCanPush: true, remembered: null })).toBe('origin');
  });

  test('a fork without push access targets the parent', () => {
    expect(resolveDefaultTarget({ isFork: true, viewerCanPush: false, remembered: null })).toBe('parent');
  });

  test('an explicit earlier choice wins over the computed default', () => {
    expect(resolveDefaultTarget({ isFork: true, viewerCanPush: true, remembered: 'parent' })).toBe('parent');
  });

  test('remembers the choice per repository and ignores malformed storage', () => {
    const key = getPullRequestTargetKey({ provider: 'github', instance: 'github.com', repositoryId: 'repo_one' });
    expect(readRememberedTarget(key)).toBeNull();
    rememberTarget(key, 'parent');
    expect(readRememberedTarget(key)).toBe('parent');
    expect(readRememberedTarget('github:github.com:other')).toBeNull();

    storage.set('openchamber:pr-create-target:v1', JSON.stringify({ [key]: 'elsewhere' }));
    expect(readRememberedTarget(key)).toBeNull();
    storage.set('openchamber:pr-create-target:v1', 'not json');
    expect(readRememberedTarget(key)).toBeNull();
  });

  test('keeps at most 50 remembered repositories, dropping the oldest', () => {
    for (let index = 0; index < 55; index += 1) rememberTarget(`repo-${index}`, 'origin');
    expect(readRememberedTarget('repo-0')).toBeNull();
    expect(readRememberedTarget('repo-54')).toBe('origin');
  });
});

describe('base branch options', () => {
  const remoteBranches = ['origin/main', 'origin/qa/stack-2', 'origin/HEAD -> origin/main', 'upstream/main', 'upstream/iuliia/feature'];

  test('the bound repository lists only its own remote branches', () => {
    expect(buildBaseBranchOptions({
      target: 'origin', remoteBranches, primaryRemote: 'origin', parentBranches: ['iuliia/other'],
      parentDefaultBranch: 'main', baseBranch: 'qa/stack-2', selected: 'qa/stack-2',
    })).toEqual(['main', 'qa/stack-2']);
  });

  test('the parent lists only the branches the provider returned, never local refs of other remotes', () => {
    expect(buildBaseBranchOptions({
      target: 'parent', remoteBranches, primaryRemote: 'origin', parentBranches: ['main', 'release'],
      parentDefaultBranch: 'main', baseBranch: 'qa/stack-2', selected: 'main',
    })).toEqual(['main', 'release']);
  });
});
