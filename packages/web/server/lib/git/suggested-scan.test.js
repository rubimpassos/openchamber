import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addDetachedWorktree,
  configureGitEnvironment,
  listChangedPathsSince,
  readScanCheckout,
  removeDetachedWorktree,
} from './service.js';

let root;
let repository;
let scanPath;

const runGit = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_MASTER: '1' },
});

const snapshotMain = () => ({
  branch: runGit(repository, ['symbolic-ref', 'HEAD']),
  head: runGit(repository, ['rev-parse', 'HEAD']),
  status: runGit(repository, ['status', '--porcelain=v1', '-uall']),
  index: fs.readFileSync(path.join(repository, '.git', 'index')),
  staged: fs.readFileSync(path.join(repository, 'staged.txt'), 'utf8'),
  unstaged: fs.readFileSync(path.join(repository, 'unstaged.txt'), 'utf8'),
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-suggested-scan-'));
  repository = path.join(root, 'repository');
  scanPath = path.join(root, 'scan');
  fs.mkdirSync(repository);
  const emptyConfig = path.join(root, 'empty-config');
  fs.writeFileSync(emptyConfig, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', emptyConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_MASTER', '1');
  vi.stubEnv('GIT_OPTIONAL_LOCKS', '0');
  if (process.platform === 'win32') {
    vi.stubEnv('MSYS', [process.env.MSYS, 'noglob'].filter(Boolean).join(' '));
  }
  configureGitEnvironment({ forDirectory: async () => null });
  runGit(repository, ['init', '--initial-branch=main']);
  runGit(repository, ['config', '--local', 'user.name', 'Scan Test']);
  runGit(repository, ['config', '--local', 'user.email', 'scan@example.invalid']);
  runGit(repository, ['config', '--local', 'commit.gpgsign', 'false']);
  for (const name of ['staged.txt', 'unstaged.txt']) {
    fs.writeFileSync(path.join(repository, name), 'original\n');
  }
  runGit(repository, ['add', '.']);
  runGit(repository, ['commit', '-m', 'Initial fixture']);
});

afterEach(() => {
  configureGitEnvironment(null);
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Suggested tasks real-Git scan helpers', () => {
  it('reads the selected branch in a detached scan while preserving the dirty main checkout', async () => {
    // Given a different branch and staged, unstaged, and untracked main files.
    runGit(repository, ['checkout', '-b', 'release']);
    fs.writeFileSync(path.join(repository, 'branch-only.txt'), 'release contents\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'Release fixture']);
    const releaseCommit = runGit(repository, ['rev-parse', 'HEAD']).trim();
    runGit(repository, ['checkout', 'main']);
    fs.writeFileSync(path.join(repository, 'staged.txt'), 'staged edit\n');
    runGit(repository, ['add', 'staged.txt']);
    fs.writeFileSync(path.join(repository, 'unstaged.txt'), 'unstaged edit\n');
    fs.writeFileSync(path.join(repository, 'untracked.txt'), 'untracked edit\n');
    const before = snapshotMain();
    const worktreesBefore = runGit(repository, ['worktree', 'list', '--porcelain']);

    // When the module creates and reads a scan of release, then removes it twice.
    try {
      await addDetachedWorktree(repository, scanPath, 'release');
      expect(await readScanCheckout(scanPath)).toEqual({ branch: null, commit: releaseCommit });
      expect(fs.readFileSync(path.join(scanPath, 'branch-only.txt'), 'utf8')).toBe('release contents\n');
      expect(await readScanCheckout(repository)).toEqual({ branch: 'main', commit: before.head.trim() });
    } finally {
      await removeDetachedWorktree(repository, scanPath);
      await removeDetachedWorktree(repository, scanPath);
    }

    // Then all main state survives and no temporary checkout remains.
    expect(snapshotMain()).toEqual(before);
    expect(fs.readFileSync(path.join(repository, 'untracked.txt'), 'utf8')).toBe('untracked edit\n');
    expect(fs.existsSync(path.join(repository, 'branch-only.txt'))).toBe(false);
    expect(fs.existsSync(scanPath)).toBe(false);
    expect(runGit(repository, ['worktree', 'list', '--porcelain'])).toBe(worktreesBefore);
  });

  it('blocks an executable post-checkout hook that writes during an ordinary checkout', async () => {
    // Given a proven executable repository hook, with its marker outside the checkout.
    const hooks = path.join(root, 'hooks');
    const marker = path.join(root, 'hook-marker');
    fs.mkdirSync(hooks);
    vi.stubEnv('SCAN_HOOK_MARKER', marker);
    fs.writeFileSync(path.join(hooks, 'post-checkout'), '#!/bin/sh\nprintf executed > "$SCAN_HOOK_MARKER"\n', { mode: 0o755 });
    runGit(repository, ['config', '--local', 'core.hooksPath', hooks]);
    runGit(repository, ['checkout', 'main']);
    expect(fs.readFileSync(marker, 'utf8')).toBe('executed');
    fs.rmSync(marker);
    const before = snapshotMain();

    // When a scan checkout is populated through the real module.
    try {
      await addDetachedWorktree(repository, scanPath, 'main');
      // Then the hook did not execute and population still produced tracked contents.
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.readFileSync(path.join(scanPath, 'staged.txt'), 'utf8')).toBe('original\n');
      expect(snapshotMain()).toEqual(before);
    } finally {
      await removeDetachedWorktree(repository, scanPath);
    }
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(scanPath)).toBe(false);
  });

  it('blocks a required smudge filter that writes during ordinary file population', async () => {
    // Given committed filter attributes and a proven executable smudge filter.
    fs.writeFileSync(path.join(repository, '.gitattributes'), '*.txt filter=scanattack\n');
    runGit(repository, ['add', '.gitattributes']);
    runGit(repository, ['commit', '-m', 'Filter attributes']);
    const marker = path.join(root, 'smudge-marker');
    vi.stubEnv('SCAN_SMUDGE_MARKER', marker);
    runGit(repository, ['config', '--local', 'filter.scanattack.clean', 'cat']);
    runGit(repository, ['config', '--local', 'filter.scanattack.smudge', 'printf executed > "$SCAN_SMUDGE_MARKER"; cat']);
    runGit(repository, ['config', '--local', 'filter.scanattack.required', 'true']);
    fs.rmSync(path.join(repository, 'staged.txt'));
    runGit(repository, ['checkout-index', '--force', '--all']);
    expect(fs.readFileSync(marker, 'utf8')).toBe('executed');
    fs.rmSync(marker);
    const before = snapshotMain();

    // When the scan populates files matching those attributes.
    try {
      await addDetachedWorktree(repository, scanPath, 'main');
      // Then raw tracked files exist without running the filter or changing main.
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.readFileSync(path.join(scanPath, 'unstaged.txt'), 'utf8')).toBe('original\n');
      expect(snapshotMain()).toEqual(before);
    } finally {
      await removeDetachedWorktree(repository, scanPath);
    }
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(scanPath)).toBe(false);
  });

  it('includes staged, unstaged, and nested untracked paths when HEAD has not moved', async () => {
    // Given dirty files and an ignored file, with no additional commit.
    const { commit } = await readScanCheckout(repository);
    fs.writeFileSync(path.join(repository, 'staged.txt'), 'staged\n');
    runGit(repository, ['add', 'staged.txt']);
    fs.writeFileSync(path.join(repository, 'unstaged.txt'), 'unstaged\n');
    fs.mkdirSync(path.join(repository, 'new directory'));
    fs.writeFileSync(path.join(repository, 'new directory', 'new file.txt'), 'untracked\n');
    fs.writeFileSync(path.join(repository, '.git', 'info', 'exclude'), 'ignored.txt\n');
    fs.writeFileSync(path.join(repository, 'ignored.txt'), 'ignored\n');
    const before = snapshotMain();

    // When the incremental helper compares the same HEAD with itself.
    const changed = await listChangedPathsSince(repository, commit, commit);

    // Then every dirty path is included, ignored files are excluded, and state is unchanged.
    expect(changed.sort()).toEqual(['new directory/new file.txt', 'staged.txt', 'unstaged.txt']);
    expect(snapshotMain()).toEqual(before);
    expect(await readScanCheckout(repository)).toEqual({ branch: 'main', commit });
  });

  it.each(['--detach', '-b injected'])('refuses option-shaped ref %s without creating a worktree', async (ref) => {
    // Given the original repository topology and an option-shaped scan ref.
    const before = snapshotMain();
    const worktreesBefore = runGit(repository, ['worktree', 'list', '--porcelain']);

    // When creation rejects and the caller performs its normal cleanup.
    await expect(addDetachedWorktree(repository, scanPath, ref)).rejects.toThrow('Invalid scan branch');
    await removeDetachedWorktree(repository, scanPath);

    // Then no temporary path, registered worktree, or main checkout change remains.
    expect(fs.existsSync(scanPath)).toBe(false);
    expect(runGit(repository, ['worktree', 'list', '--porcelain'])).toBe(worktreesBefore);
    expect(snapshotMain()).toEqual(before);
  });
});
