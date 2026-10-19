import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { listOwnCommits, normalizeCreatedFrom } from './own-commits.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
const runGit = async (cwd, args) => {
  try {
    return { success: true, stdout: execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { success: false, stdout: '', message: String(error.stderr || error.message) };
  }
};
const commit = (cwd, name) => {
  fs.writeFileSync(path.join(cwd, `${name}.txt`), name);
  sh(cwd, 'add', '.');
  sh(cwd, 'commit', '-q', '-m', name);
  return sh(cwd, 'rev-parse', 'HEAD');
};

let root;
let repo;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'own-commits-'));
  const origin = path.join(root, 'origin.git');
  repo = path.join(root, 'repo');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, repo);
  sh(repo, 'checkout', '-q', '-b', 'main');
  commit(repo, 'base');
  sh(repo, 'push', '-q', 'origin', 'main');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('own commits of a stacked branch', () => {
  test('lists the commits past the remote trunk, nearest first', async () => {
    sh(repo, 'checkout', '-q', '-b', 'one');
    const one = commit(repo, 'one');
    sh(repo, 'checkout', '-q', '-b', 'two');
    const two = commit(repo, 'two');
    sh(repo, 'checkout', '-q', '-b', 'three');
    const three = commit(repo, 'three');
    expect(await listOwnCommits(runGit, repo, { branch: 'three', remote: 'origin', trunk: 'main', limit: 10 }))
      .toEqual({ commits: [three, two, one], capped: false });
    expect(await listOwnCommits(runGit, repo, { branch: 'three', remote: 'origin', trunk: 'main', limit: 2 }))
      .toEqual({ commits: [three, two], capped: true });
  });

  test('answers null for a missing branch, trunk ref or unsafe name', async () => {
    expect(await listOwnCommits(runGit, repo, { branch: 'missing', remote: 'origin', trunk: 'main', limit: 10 })).toBeNull();
    expect(await listOwnCommits(runGit, repo, { branch: 'main', remote: 'upstream', trunk: 'main', limit: 10 })).toBeNull();
    expect(await listOwnCommits(runGit, repo, { branch: '--all', remote: 'origin', trunk: 'main', limit: 10 })).toBeNull();
  });

  test('reads a reflog creation source as a branch of the remote', () => {
    expect(normalizeCreatedFrom('qa/stack-2', 'origin')).toBe('qa/stack-2');
    expect(normalizeCreatedFrom('refs/remotes/origin/qa/stack-2', 'origin')).toBe('qa/stack-2');
    expect(normalizeCreatedFrom('origin/qa/stack-2', 'origin')).toBe('qa/stack-2');
    expect(normalizeCreatedFrom(null, 'origin')).toBeNull();
  });
});
