// Restacks a chain of branches locally: each branch is rebased onto the one
// below it, the bottom one onto the remote trunk. Git only, no network: the
// UI fetches before and pushes the moved branches after.
//
// A branch is rebased with `git rebase --onto <new parent> <old parent tip>`
// (the Graphite algorithm), where the old parent tip is the parent branch as
// it was before this run moved it, so only the branch's own commits move.
// A branch checked out in a worktree is rebased there; any other branch in a
// private worktree under the data dir. A conflict stops the run on that
// branch: branches below stay restacked, branches above wait. What happens
// next follows the `prStackConflictMode` setting: the user continues or
// aborts, or the session gets the conflict and the run continues by itself
// once the session's turn ends with nothing left unmerged.

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';

const RUNS_FILE = 'pr-stack-restacks.json';
const MAX_RUNS = 20;
const SESSION_SETTLE_MS = 3_000;
const BRANCH_PATTERN = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/;

const isTerminal = (status) => status === 'done' || status === 'failed' || status === 'aborted';

const httpError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

const branchName = z.string().trim().regex(BRANCH_PATTERN);
const startInput = z.object({
  directory: z.string().trim().refine((value) => path.isAbsolute(value)),
  remote: branchName,
  trunk: branchName,
  branches: z.array(branchName).min(1).max(20).refine((list) => new Set(list).size === list.length),
  // The tip of the merged PR the bottom branch sat on: only commits after it move.
  oldBase: z.string().regex(/^[0-9a-f]{40}$/).nullish(),
  sessionId: z.string().trim().nullish(),
});
const storedRun = z.object({ id: z.string().min(1), directory: z.string().min(1), steps: z.array(z.unknown()) }).passthrough();
const directoryQuery = z.string().min(1);

const parseStart = (input) => {
  const parsed = startInput.safeParse(input);
  if (!parsed.success) throw httpError(`${parsed.error.issues[0]?.path.join('.') || 'input'} is invalid`);
  return parsed.data;
};

const parseWorktrees = (output) => {
  const byBranch = new Map();
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/') && current) byBranch.set(line.slice('branch refs/heads/'.length), current);
    else if (!line) current = null;
  }
  return byBranch;
};

export function createRestackRuntime({
  runGit,
  dataDir,
  readConflictMode = async () => 'pause',
  sendToSession = async () => undefined,
  broadcast = () => undefined,
  now = Date.now,
  setTimer = setTimeout,
}) {
  const runs = new Map();
  const starting = new Set();
  const executing = new Set();
  const executingDirectories = new Set();
  const sessionTimers = new Map();
  let loaded = null;
  let writing = Promise.resolve();

  const filePath = path.join(dataDir, RUNS_FILE);

  const persist = () => {
    const snapshot = JSON.stringify({ runs: [...runs.values()].slice(-MAX_RUNS) });
    writing = writing.then(async () => {
      const temp = `${filePath}.${process.pid}.tmp`;
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(temp, snapshot, { mode: 0o600 });
      await fs.rename(temp, filePath);
    }).catch((error) => console.warn('[pr-stacks] could not save restack runs:', error?.message ?? error));
    return writing;
  };

  const load = () => {
    loaded ??= fs.readFile(filePath, 'utf8').then((text) => {
      const stored = JSON.parse(text);
      for (const entry of Array.isArray(stored?.runs) ? stored.runs : []) {
        const parsed = storedRun.safeParse(entry);
        if (parsed.success) runs.set(parsed.data.id, parsed.data);
      }
    }).catch((error) => {
      if (error?.code !== 'ENOENT') console.warn('[pr-stacks] could not read restack runs:', error?.message ?? error);
    });
    return loaded;
  };

  const publish = async (run) => {
    run.updatedAt = now();
    while (runs.size > MAX_RUNS) {
      const oldest = [...runs.values()].find((entry) => isTerminal(entry.status));
      if (!oldest) break;
      runs.delete(oldest.id);
    }
    broadcast({ type: 'openchamber:pr-stack.restack', properties: { run } });
    await persist();
    return run;
  };

  const git = async (cwd, args) => {
    const result = await runGit(cwd, args);
    if (!result.success) {
      const error = new Error(result.message || result.stderr || `git ${args[0]} failed`);
      error.stdout = result.stdout;
      error.stderr = result.stderr;
      throw error;
    }
    return result.stdout.trim();
  };
  const gitOk = async (cwd, args) => (await runGit(cwd, args)).success;

  const privateWorktree = (run) => path.join(dataDir, 'pr-stacks', 'worktrees', run.id);

  const removePrivateWorktree = async (run) => {
    const target = privateWorktree(run);
    await runGit(run.directory, ['worktree', 'remove', '--force', target]);
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    await runGit(run.directory, ['worktree', 'prune']);
  };

  const workingDirectoryFor = async (run, branch) => {
    const worktrees = parseWorktrees(await git(run.directory, ['worktree', 'list', '--porcelain']));
    const checkedOut = worktrees.get(branch);
    if (checkedOut) return checkedOut;
    const target = privateWorktree(run);
    const exists = await fs.stat(target).then(() => true, () => false);
    if (!exists) await git(run.directory, ['worktree', 'add', '--detach', target]);
    return target;
  };

  const conflictedFiles = async (cwd) => {
    const output = await git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
    return output ? output.split(/\r?\n/).filter(Boolean) : [];
  };

  const rebaseInProgress = async (cwd) => {
    for (const name of ['rebase-merge', 'rebase-apply']) {
      const gitPath = await git(cwd, ['rev-parse', '--git-path', name]).catch(() => '');
      if (gitPath && await fs.stat(path.resolve(cwd, gitPath)).then(() => true, () => false)) return true;
    }
    return false;
  };

  const stopAtConflict = async (run, step, cwd) => {
    step.status = 'conflict';
    step.worktree = cwd;
    step.conflictFiles = await conflictedFiles(cwd);
    run.status = 'paused';
    if (run.conflictMode === 'agent' && run.sessionId) await handToSession(run, step);
  };

  const handToSession = async (run, step) => {
    run.status = 'waitingForSession';
    await sendToSession({
      sessionId: run.sessionId,
      directory: run.directory,
      text: [
        `Restacking the pull request stack stopped on a conflict while rebasing \`${step.branch}\` onto \`${step.onto}\`.`,
        `The rebase is in progress in \`${step.worktree}\`.`,
        step.conflictFiles?.length ? `Conflicted files:\n${step.conflictFiles.map((file) => `- ${file}`).join('\n')}` : '',
        'Resolve the conflicts in that directory and stage the result with `git add`. Do not commit, do not run `git rebase --continue` or `--abort`, and do not push: OpenChamber continues the rebase and the rest of the stack when your turn ends with nothing left unmerged.',
      ].filter(Boolean).join('\n\n'),
    });
  };

  const finish = async (run) => {
    if (!run.steps.some((step) => step.status === 'conflict')) await removePrivateWorktree(run).catch(() => undefined);
  };

  // Brings the local branch to what was just fetched, so a restack never works
  // from a stale copy: created when missing, fast-forwarded when behind, kept
  // when it has commits the remote lacks, refused when the two diverged.
  const syncWithRemote = async (run, branch, cwd) => {
    const remoteRef = `refs/remotes/${run.remote}/${branch}`;
    const remote = await git(run.directory, ['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`]).catch(() => null);
    const local = await git(run.directory, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]).catch(() => null);
    if (!remote) {
      if (!local) throw new Error(`${branch} exists neither locally nor on ${run.remote}`);
      return;
    }
    if (!local) {
      await git(run.directory, ['branch', '--no-track', branch, remote]);
      return;
    }
    if (local === remote || await gitOk(run.directory, ['merge-base', '--is-ancestor', remote, local])) return;
    if (!await gitOk(run.directory, ['merge-base', '--is-ancestor', local, remote])) {
      throw new Error(`${branch} has local commits that are not on ${run.remote}, and ${run.remote} has commits it lacks. Reconcile them first.`);
    }
    const checkedOut = (await git(cwd, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')) === `refs/heads/${branch}`;
    if (checkedOut) await git(cwd, ['merge', '--ff-only', remote]);
    else await git(run.directory, ['update-ref', `refs/heads/${branch}`, remote, local]);
  };

  // Runs every step that is still pending, in order.
  const advance = async (run) => {
    for (const [index, step] of run.steps.entries()) {
      if (step.status !== 'pending') continue;
      const previous = run.steps[index - 1];
      let cwd;
      try {
        cwd = await workingDirectoryFor(run, step.branch);
        const status = await git(cwd, ['status', '--porcelain', '--untracked-files=no']);
        if (status) throw new Error(`${step.branch} has uncommitted changes in ${cwd}`);
        await syncWithRemote(run, step.branch, cwd);
        step.before = await git(run.directory, ['rev-parse', `refs/heads/${step.branch}`]);
        const onto = await git(run.directory, ['rev-parse', `${step.onto}^{commit}`]);
        // The parent as it was before this run moved it; for the bottom branch
        // the explicit old base, else where it forked from the trunk.
        const upstream = previous?.before
          ?? (step.oldBase && await gitOk(run.directory, ['rev-parse', '--verify', `${step.oldBase}^{commit}`]) ? step.oldBase : null)
          ?? await git(run.directory, ['merge-base', '--fork-point', step.onto, step.branch]).catch(() => null)
          ?? await git(run.directory, ['merge-base', step.onto, step.branch]);
        const result = await runGit(cwd, ['rebase', '--onto', onto, upstream, step.branch]);
        if (!result.success) {
          if (await rebaseInProgress(cwd)) {
            await stopAtConflict(run, step, cwd);
            return;
          }
          throw new Error(result.message || result.stderr || 'git rebase failed');
        }
        step.after = await git(run.directory, ['rev-parse', `refs/heads/${step.branch}`]);
        step.status = step.after === step.before ? 'unchanged' : 'done';
      } catch (error) {
        step.status = 'failed';
        step.error = String(error?.message ?? error).slice(0, 500);
        if (cwd) step.worktree = cwd;
        for (const later of run.steps.slice(index + 1)) later.status = 'skipped';
        run.status = 'failed';
        await finish(run);
        return;
      }
    }
    run.status = 'done';
    await finish(run);
  };

  const requireRun = (id) => {
    const run = runs.get(id);
    if (!run) throw httpError('restack run not found', 404);
    return run;
  };

  const conflictStep = (run) => run.steps.find((step) => step.status === 'conflict');

  const withExecution = async (run, action) => {
    if (executing.has(run.id) || executingDirectories.has(run.directory)) throw httpError('A restack operation is already in progress', 409);
    executing.add(run.id);
    executingDirectories.add(run.directory);
    try {
      return await action();
    } finally {
      executing.delete(run.id);
      executingDirectories.delete(run.directory);
    }
  };

  const continueRun = async (run) => {
    const step = conflictStep(run);
    if (!step) throw httpError('nothing to continue', 409);
    const remaining = await conflictedFiles(step.worktree);
    if (remaining.length > 0) {
      step.conflictFiles = remaining;
      throw httpError('Resolve and stage every conflicted file first', 409);
    }
    const result = await runGit(step.worktree, ['rebase', '--continue']);
    if (!result.success) {
      if (await rebaseInProgress(step.worktree)) {
        step.conflictFiles = await conflictedFiles(step.worktree);
        if (step.conflictFiles.length > 0) {
          run.status = run.conflictMode === 'agent' && run.sessionId ? 'waitingForSession' : 'paused';
          if (run.status === 'waitingForSession') await handToSession(run, step);
          return;
        }
      }
      run.status = 'paused';
      step.error = String(result.message || result.stderr || 'git rebase --continue failed').slice(0, 500);
      await publish(run);
      throw httpError(step.error, 409);
    }
    step.after = await git(run.directory, ['rev-parse', `refs/heads/${step.branch}`]);
    step.status = 'done';
    delete step.conflictFiles;
    delete step.worktree;
    delete step.error;
    run.status = 'running';
    await advance(run);
  };

  return {
    async start(input) {
      await load();
      const { directory, remote, trunk, branches, oldBase, sessionId: rawSessionId } = parseStart(input);
      const sessionId = rawSessionId || null;
      const active = [...runs.values()].find((run) => run.directory === directory && !isTerminal(run.status));
      if (active || starting.has(directory) || executingDirectories.has(directory)) throw httpError('A restack is already in progress for this repository', 409);
      starting.add(directory);
      try {
        const run = {
          id: `restack_${crypto.randomUUID()}`,
          directory,
          sessionId,
          remote,
          trunk,
          status: 'running',
          conflictMode: (await readConflictMode()) === 'agent' ? 'agent' : 'pause',
          steps: branches.map((branch, index) => ({
            branch,
            onto: index === 0 ? `refs/remotes/${remote}/${trunk}` : `refs/heads/${branches[index - 1]}`,
            status: 'pending',
            oldBase: index === 0 && oldBase ? oldBase : null,
          })),
          createdAt: now(),
          updatedAt: now(),
        };
        runs.set(run.id, run);
        return await withExecution(run, async () => {
          await publish(run);
          await advance(run);
          return publish(run);
        });
      } finally {
        starting.delete(directory);
      }
    },

    async latest(directory) {
      await load();
      return [...runs.values()].filter((run) => run.directory === directory).sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
    },

    async continue(id) {
      await load();
      const run = requireRun(id);
      return withExecution(run, async () => {
        if (run.status !== 'paused' && run.status !== 'waitingForSession') throw httpError('the restack is not waiting', 409);
        await continueRun(run);
        return publish(run);
      });
    },

    async abort(id) {
      await load();
      const run = requireRun(id);
      return withExecution(run, async () => {
        if (isTerminal(run.status)) return run;
        const step = conflictStep(run);
        if (step?.worktree && await rebaseInProgress(step.worktree)) await runGit(step.worktree, ['rebase', '--abort']);
        if (step) step.status = 'skipped';
        for (const later of run.steps) if (later.status === 'pending') later.status = 'skipped';
        run.status = 'aborted';
        await removePrivateWorktree(run).catch(() => undefined);
        return publish(run);
      });
    },

    async askSession(id) {
      await load();
      const run = requireRun(id);
      return withExecution(run, async () => {
        const step = conflictStep(run);
        if (!step || run.status !== 'paused') throw httpError('the restack is not paused on a conflict', 409);
        if (!run.sessionId) throw httpError('the restack has no session', 409);
        await handToSession(run, step);
        return publish(run);
      });
    },

    /** The session's turn ended: continue a run that handed it a conflict, once nothing is unmerged. */
    noteSessionIdle(sessionId) {
      if (!sessionId || sessionTimers.has(sessionId)) return;
      const timer = setTimer(() => {
        sessionTimers.delete(sessionId);
        return (async () => {
          await load();
          for (const run of runs.values()) {
            if (run.sessionId !== sessionId || run.status !== 'waitingForSession') continue;
            if (executing.has(run.id)) continue;
            await withExecution(run, async () => {
              const step = conflictStep(run);
              if (!step || (await conflictedFiles(step.worktree)).length > 0) return;
              await continueRun(run).catch((error) => {
                run.status = 'paused';
                step.error = String(error?.message ?? error).slice(0, 500);
              });
              await publish(run);
            });
          }
        })().catch((error) => console.warn('[pr-stacks] continue after session failed:', error?.message ?? error));
      }, SESSION_SETTLE_MS);
      timer.unref?.();
      sessionTimers.set(sessionId, timer);
    },
  };
}

export function registerRestackRoutes(app, runtime) {
  const send = (res, error) => res.status(error?.statusCode ?? 500).json({ error: error?.message ?? 'Restack failed' });
  app.post('/api/pr-stacks/restack', async (req, res) => {
    try { res.json(await runtime.start(req.body ?? {})); } catch (error) { send(res, error); }
  });
  app.get('/api/pr-stacks/restack', async (req, res) => {
    const query = directoryQuery.safeParse(req.query?.directory);
    if (!query.success) return res.status(400).json({ error: 'directory is required' });
    const directory = query.data;
    try { return res.json({ run: await runtime.latest(directory) }); } catch (error) { return send(res, error); }
  });
  for (const [action, method] of [['continue', 'continue'], ['abort', 'abort'], ['ask-session', 'askSession']]) {
    app.post(`/api/pr-stacks/restack/:id/${action}`, async (req, res) => {
      try { res.json(await runtime[method](req.params.id)); } catch (error) { send(res, error); }
    });
  }
}
