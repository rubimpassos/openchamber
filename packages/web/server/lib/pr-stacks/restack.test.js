import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createRestackRuntime } from './restack.js';

const runGit = async (cwd, args) => {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_EDITOR: 'true', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
    return { success: true, stdout, stderr: '' };
  } catch (error) {
    return { success: false, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), message: String(error.stderr || error.message) };
  }
};

const sh = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).trim();

const commit = (cwd, file, content, message) => {
  fs.writeFileSync(path.join(cwd, file), content);
  sh(cwd, 'add', file);
  sh(cwd, 'commit', '-q', '-m', message);
};

let root;
let repo;
let dataDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'restack-'));
  const origin = path.join(root, 'origin.git');
  repo = path.join(root, 'repo');
  dataDir = path.join(root, 'data');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, repo);
  sh(repo, 'checkout', '-q', '-b', 'main');
  commit(repo, 'base.txt', 'base\n', 'base');
  sh(repo, 'push', '-q', 'origin', 'main');
  sh(repo, 'checkout', '-q', '-b', 'one');
  commit(repo, 'one.txt', 'one\n', 'one');
  sh(repo, 'checkout', '-q', '-b', 'two');
  commit(repo, 'two.txt', 'two\n', 'two');
  sh(repo, 'checkout', '-q', 'main');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const advanceTrunk = (file, content) => {
  commit(repo, file, content, `main ${file}`);
  sh(repo, 'push', '-q', 'origin', 'main');
  sh(repo, 'fetch', '-q', 'origin');
};

describe('restack runtime', () => {
  test('start stays reserved through terminal continuation cleanup', async () => {
    sh(repo, 'checkout', '-q', 'one');
    commit(repo, 'clash.txt', 'one side\n', 'clash');
    sh(repo, 'checkout', '-q', 'main');
    advanceTrunk('clash.txt', 'trunk side\n');
    let release;
    let entered;
    const waiting = new Promise((resolve) => { release = resolve; });
    const cleaning = new Promise((resolve) => { entered = resolve; });
    let holdCleanup = true;
    const runtime = createRestackRuntime({ dataDir, runGit: async (cwd, args) => {
      if (holdCleanup && args[0] === 'worktree' && args[1] === 'remove') {
        holdCleanup = false;
        entered(); await waiting;
      }
      return runGit(cwd, args);
    } });
    const input = { directory: repo, remote: 'origin', trunk: 'main', branches: ['one', 'two'] };
    const run = await runtime.start(input);
    const worktree = run.steps[0].worktree;
    fs.writeFileSync(path.join(worktree, 'clash.txt'), 'resolved\n');
    sh(worktree, 'add', 'clash.txt');
    const first = runtime.continue(run.id);
    await cleaning;
    try {
      expect(run.status).toBe('done');
      expect(fs.existsSync(worktree)).toBe(true);
      await expect(runtime.start(input)).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      release();
      await first;
    }
    expect((await runtime.start(input)).status).toBe('done');
  });

  for (const overlapping of ['continue', 'abort', 'askSession']) {
    test(`rejects overlapping ${overlapping} while continuation owns the run`, async () => {
      sh(repo, 'checkout', '-q', 'one');
      commit(repo, 'clash.txt', 'one side\n', 'clash');
      sh(repo, 'checkout', '-q', 'main');
      advanceTrunk('clash.txt', 'trunk side\n');
      let release;
      let entered;
      const waiting = new Promise((resolve) => { release = resolve; });
      const continuing = new Promise((resolve) => { entered = resolve; });
      let continuations = 0;
      const runtime = createRestackRuntime({ dataDir, runGit: async (cwd, args) => {
        if (args[0] === 'rebase' && args[1] === '--continue') {
          continuations += 1;
          if (continuations === 1) { entered(); await waiting; }
        }
        return runGit(cwd, args);
      } });
      const run = await runtime.start({ directory: repo, remote: 'origin', trunk: 'main', branches: ['one', 'two'], sessionId: 'ses_1' });
      const worktree = run.steps[0].worktree;
      fs.writeFileSync(path.join(worktree, 'clash.txt'), 'resolved\n');
      sh(worktree, 'add', 'clash.txt');
      const first = runtime.continue(run.id);
      await continuing;
      try {
        await expect(runtime[overlapping](run.id)).rejects.toMatchObject({ statusCode: 409 });
        expect(continuations).toBe(1);
        expect(fs.existsSync(worktree)).toBe(true);
        expect(run.status).toBe('paused');
      } finally {
        release();
        await first;
      }
      expect(run.status).toBe('done');
      expect(run.steps.map((step) => step.status)).toEqual(['done', 'done']);
      expect((await createRestackRuntime({ runGit, dataDir }).latest(repo)).status).toBe('done');
    });
  }

  for (const automaticFirst of [true, false]) {
  test(`${automaticFirst ? 'automatic' : 'manual'} continuation excludes idle and manual overlap`, async () => {
    sh(repo, 'checkout', '-q', 'one');
    commit(repo, 'clash.txt', 'one side\n', 'clash');
    sh(repo, 'checkout', '-q', 'main');
    advanceTrunk('clash.txt', 'trunk side\n');
    const timers = [];
    let release;
    let entered;
    const waiting = new Promise((resolve) => { release = resolve; });
    const continuing = new Promise((resolve) => { entered = resolve; });
    let continuations = 0;
    const runtime = createRestackRuntime({ dataDir, readConflictMode: async () => 'agent',
      setTimer: (fn) => { timers.push(fn); return { unref() {} }; },
      runGit: async (cwd, args) => {
        if (args[0] === 'rebase' && args[1] === '--continue') {
          continuations += 1;
          if (continuations === 1) { entered(); await waiting; }
        }
        return runGit(cwd, args);
      },
    });
    const run = await runtime.start({ directory: repo, remote: 'origin', trunk: 'main', branches: ['one', 'two'], sessionId: 'ses_1' });
    const worktree = run.steps[0].worktree;
    fs.writeFileSync(path.join(worktree, 'clash.txt'), 'resolved\n');
    sh(worktree, 'add', 'clash.txt');
    if (automaticFirst) runtime.noteSessionIdle('ses_1');
    const first = automaticFirst ? timers[0]() : runtime.continue(run.id);
    await continuing;
    try {
      await expect(runtime.continue(run.id)).rejects.toMatchObject({ statusCode: 409 });
      await expect(runtime.abort(run.id)).rejects.toMatchObject({ statusCode: 409 });
      runtime.noteSessionIdle('ses_1');
      await timers.at(-1)();
      expect(continuations).toBe(1);
      expect(fs.existsSync(worktree)).toBe(true);
    } finally {
      release();
      await first;
    }
    expect((await runtime.latest(repo)).status).toBe('done');
  });
  }

  test('a failed resolution commit preserves the staged changes and paused rebase', async () => {
    sh(repo, 'checkout', '-q', 'one');
    commit(repo, 'clash.txt', 'one side\n', 'clash');
    const before = sh(repo, 'rev-parse', 'one');
    sh(repo, 'checkout', '-q', 'main');
    advanceTrunk('clash.txt', 'trunk side\n');
    const calls = [];
    let failSigning = true;
    const runtime = createRestackRuntime({ dataDir, runGit: async (cwd, args) => {
      calls.push(args);
      return runGit(cwd, failSigning && args[0] === 'rebase' && args[1] === '--continue'
        ? ['-c', 'commit.gpgsign=true', '-c', 'gpg.format=openpgp', '-c', 'gpg.program=/nonexistent-restack-signer', ...args]
        : args);
    } });
    const run = await runtime.start({ directory: repo, remote: 'origin', trunk: 'main', branches: ['one', 'two'] });
    const worktree = run.steps[0].worktree;
    fs.writeFileSync(path.join(worktree, 'clash.txt'), 'resolved content\n');
    sh(worktree, 'add', 'clash.txt');

    await expect(runtime.continue(run.id)).rejects.toThrow('sign');
    expect((await runtime.latest(repo)).status).toBe('paused');
    expect(run.steps[0].status).toBe('conflict');
    expect(run.steps[0].error).toContain('sign');
    expect(calls.some((args) => args.includes('--skip'))).toBe(false);
    expect(sh(repo, 'rev-parse', 'one')).toBe(before);
    expect(sh(worktree, 'show', ':clash.txt')).toBe('resolved content');
    expect(fs.existsSync(path.resolve(worktree, sh(worktree, 'rev-parse', '--git-path', 'rebase-merge')))).toBe(true);

    failSigning = false;
    expect((await runtime.continue(run.id)).status).toBe('done');
    expect(sh(repo, 'show', 'one:clash.txt')).toBe('resolved content');
  });

  test('a concurrent start is refused while conflict settings are loading', async () => {
    let release;
    let entered;
    const waiting = new Promise((resolve) => { release = resolve; });
    const reading = new Promise((resolve) => { entered = resolve; });
    let gitCalls = 0;
    let settingsReads = 0;
    const runtime = createRestackRuntime({ dataDir,
      runGit: async (...args) => { gitCalls += 1; return runGit(...args); },
      readConflictMode: async () => {
        settingsReads += 1;
        if (settingsReads > 1) throw new Error('concurrent settings read');
        entered(); await waiting; return 'pause';
      },
    });
    const input = { directory: repo, remote: 'origin', trunk: 'main', branches: ['one', 'two'] };
    const first = runtime.start(input);
    await reading;
    try {
      await expect(runtime.start(input)).rejects.toThrow('already in progress');
      expect(gitCalls).toBe(0);
    } finally {
      release();
      await first;
    }
  });

  test('a failed settings read releases the start reservation', async () => {
    let fail = true;
    const runtime = createRestackRuntime({ runGit, dataDir, readConflictMode: async () => {
      if (fail) throw new Error('settings unavailable');
      return 'pause';
    } });
    const input = { directory: repo, remote: 'origin', trunk: 'main', branches: ['one', 'two'] };
    await expect(runtime.start(input)).rejects.toThrow('settings unavailable');
    fail = false;
    expect((await runtime.start(input)).status).toBe('done');
  });

  test('moves every branch onto the one below it', async () => {
    advanceTrunk('trunk.txt', 'trunk\n');
    const events = [];
    const runtime = createRestackRuntime({ runGit, dataDir, broadcast: (event) => events.push(event) });
    const run = await runtime.start({ directory: repo, sessionId: null, remote: 'origin', trunk: 'main', branches: ['one', 'two'] });
    expect(run.status).toBe('done');
    expect(run.steps.map((step) => step.status)).toEqual(['done', 'done']);
    expect(sh(repo, 'merge-base', '--is-ancestor', 'origin/main', 'one') === '').toBe(true);
    expect(sh(repo, 'rev-parse', 'two~1')).toBe(sh(repo, 'rev-parse', 'one'));
    expect(sh(repo, 'log', '--format=%s', 'main..two').split('\n')).toEqual(['two', 'one']);
    expect(events.at(-1).properties.run.status).toBe('done');
  });

  test('pauses on a conflict, keeps lower branches, and continues after resolution', async () => {
    sh(repo, 'checkout', '-q', 'two');
    commit(repo, 'shared2.txt', 'two side\n', 'two shared');
    sh(repo, 'checkout', '-q', 'main');
    advanceTrunk('shared2.txt', 'trunk side\n');

    const runtime = createRestackRuntime({ runGit, dataDir });
    const run = await runtime.start({ directory: repo, sessionId: null, remote: 'origin', trunk: 'main', branches: ['one', 'two'] });
    expect(run.status).toBe('paused');
    expect(run.steps[0].status).toBe('done');
    expect(run.steps[1]).toMatchObject({ status: 'conflict', conflictFiles: ['shared2.txt'] });

    await expect(runtime.continue(run.id)).rejects.toThrow('Resolve');
    const worktree = run.steps[1].worktree;
    fs.writeFileSync(path.join(worktree, 'shared2.txt'), 'merged\n');
    sh(worktree, 'add', 'shared2.txt');
    const continued = await runtime.continue(run.id);
    expect(continued.status).toBe('done');
    expect(continued.steps[1].status).toBe('done');
    expect(fs.existsSync(path.join(dataDir, 'pr-stacks', 'worktrees', run.id))).toBe(false);
  });

  test('agent mode hands the conflict to the session and continues on idle', async () => {
    sh(repo, 'checkout', '-q', 'one');
    commit(repo, 'clash.txt', 'one side\n', 'clash');
    sh(repo, 'checkout', '-q', 'main');
    advanceTrunk('clash.txt', 'trunk side\n');
    const sent = [];
    const timers = [];
    const runtime = createRestackRuntime({
      runGit,
      dataDir,
      readConflictMode: async () => 'agent',
      sendToSession: async (message) => sent.push(message),
      setTimer: (fn) => { timers.push(fn); return { unref() {} }; },
    });
    const run = await runtime.start({ directory: repo, sessionId: 'ses_1', remote: 'origin', trunk: 'main', branches: ['one', 'two'] });
    expect(run.status).toBe('waitingForSession');
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('clash.txt');

    const worktree = run.steps[0].worktree;
    fs.writeFileSync(path.join(worktree, 'clash.txt'), 'resolved\n');
    sh(worktree, 'add', 'clash.txt');
    runtime.noteSessionIdle('ses_1');
    await timers[0]();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const latest = await runtime.latest(repo);
    expect(latest.status).toBe('done');
    expect(latest.steps.map((step) => step.status)).toEqual(['done', 'done']);
  });

  test('abort restores the conflicted branch and skips the rest', async () => {
    sh(repo, 'checkout', '-q', 'one');
    commit(repo, 'clash.txt', 'one side\n', 'clash');
    const before = sh(repo, 'rev-parse', 'one');
    sh(repo, 'checkout', '-q', 'main');
    advanceTrunk('clash.txt', 'trunk side\n');
    const runtime = createRestackRuntime({ runGit, dataDir });
    const run = await runtime.start({ directory: repo, sessionId: null, remote: 'origin', trunk: 'main', branches: ['one', 'two'] });
    const aborted = await runtime.abort(run.id);
    expect(aborted.status).toBe('aborted');
    expect(aborted.steps.map((step) => step.status)).toEqual(['skipped', 'skipped']);
    expect(sh(repo, 'rev-parse', 'one')).toBe(before);
  });

  test('after a squash merge, only the top branch\'s own commits move onto the trunk', async () => {
    const parentTip = sh(repo, 'rev-parse', 'one');
    sh(repo, 'checkout', '-q', 'main');
    sh(repo, 'merge', '-q', '--squash', 'one');
    sh(repo, 'commit', '-q', '-m', 'one (squashed)');
    sh(repo, 'push', '-q', 'origin', 'main');
    sh(repo, 'fetch', '-q', 'origin');
    const runtime = createRestackRuntime({ runGit, dataDir });
    const run = await runtime.start({ directory: repo, sessionId: null, remote: 'origin', trunk: 'main', branches: ['two'], oldBase: parentTip });
    expect(run.status).toBe('done');
    expect(sh(repo, 'log', '--format=%s', 'origin/main..two').split('\n')).toEqual(['two']);
  });

  test('a branch missing locally is taken from the remote, and a stale one is fast-forwarded', async () => {
    sh(repo, 'push', '-q', 'origin', 'one', 'two');
    const other = path.join(root, 'other');
    sh(root, 'clone', '-q', path.join(root, 'origin.git'), other);
    sh(other, 'checkout', '-q', 'one');
    commit(other, 'more.txt', 'more\n', 'one more');
    sh(other, 'push', '-q', 'origin', 'one');
    sh(repo, 'branch', '-q', '-D', 'two');
    advanceTrunk('trunk.txt', 'trunk\n');
    const runtime = createRestackRuntime({ runGit, dataDir });
    const run = await runtime.start({ directory: repo, sessionId: null, remote: 'origin', trunk: 'main', branches: ['one', 'two'] });
    expect(run.status).toBe('done');
    expect(sh(repo, 'log', '--format=%s', 'origin/main..two').split('\n')).toEqual(['two', 'one more', 'one']);
  });

  test('a branch that diverged from the remote fails instead of guessing', async () => {
    sh(repo, 'push', '-q', 'origin', 'one');
    const other = path.join(root, 'other');
    sh(root, 'clone', '-q', path.join(root, 'origin.git'), other);
    sh(other, 'checkout', '-q', 'one');
    commit(other, 'remote.txt', 'r\n', 'remote side');
    sh(other, 'push', '-q', 'origin', 'one');
    sh(repo, 'checkout', '-q', 'one');
    commit(repo, 'local.txt', 'l\n', 'local side');
    sh(repo, 'checkout', '-q', 'main');
    advanceTrunk('trunk.txt', 'trunk\n');
    const runtime = createRestackRuntime({ runGit, dataDir });
    const run = await runtime.start({ directory: repo, sessionId: null, remote: 'origin', trunk: 'main', branches: ['one', 'two'] });
    expect(run.status).toBe('failed');
    expect(run.steps[0].error).toContain('Reconcile');
  });

  test('a branch with uncommitted changes fails the run without touching the rest', async () => {
    advanceTrunk('trunk.txt', 'trunk\n');
    sh(repo, 'checkout', '-q', 'one');
    fs.writeFileSync(path.join(repo, 'one.txt'), 'dirty\n');
    const runtime = createRestackRuntime({ runGit, dataDir });
    const run = await runtime.start({ directory: repo, sessionId: null, remote: 'origin', trunk: 'main', branches: ['one', 'two'] });
    expect(run.status).toBe('failed');
    expect(run.steps.map((step) => step.status)).toEqual(['failed', 'skipped']);
    expect(run.steps[0].error).toContain('uncommitted');
  });
});
