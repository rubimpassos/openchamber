# PR stacks: local restack

Rebases a stack of branches after a lower one changed. Detection, native stack registration, retarget and merge live in `../github/pr-stacks.js` (see the GitHub module documentation); this module is the Git side, which needs no network. The UI fetches the remote before a restack and pushes the moved branches after it, with a force lease pinned to each PR's head SHA on GitHub.

## Files

- `restack.js`: `createRestackRuntime(...)` and `registerRestackRoutes(app, runtime)`.
- `restack.test.js`: real Git repositories: a clean cascade, a conflict paused and continued, the session resolving a conflict, abort, and a dirty worktree.

Wiring: created in `server/index.js` after the message queue, routes registered in `opencode/feature-routes-runtime.js`, JSON bodies through `opencode/core-routes.js` (`/api/pr-stacks`).

## Algorithm

A run takes `{ directory, sessionId, remote, trunk, branches (bottom to top), oldBase? }`. Step `i` rebases `branches[i]` onto `branches[i-1]`, step 0 onto `refs/remotes/<remote>/<trunk>`, with

```
git rebase --onto <new parent> <old parent tip> <branch>
```

The old parent tip is the parent branch as it was before this run moved it (`before` of the previous step), so only the branch's own commits move. For the bottom branch it is `oldBase`, the head SHA of the merged PR it sat on (`mergedParent.headSha` from the stack read), when that commit is in the branch's history, else `merge-base --fork-point` with the trunk, else the plain merge base. This is the restack Graphite's `gt` does with the parent revision it stores.

Before a branch moves, it is brought to what the UI just fetched: a branch missing locally is created from `refs/remotes/<remote>/<branch>`, one behind it is fast-forwarded (in its worktree when checked out), one with commits the remote lacks is kept as is, and one that diverged from the remote fails its step with a message to reconcile first.

A branch checked out in a worktree is rebased there. Any other branch is rebased in a private worktree under `<data dir>/pr-stacks/worktrees/<run id>`, removed when the run ends without a conflict pending. A worktree with uncommitted tracked changes fails that step: earlier steps stay done, later ones are skipped, nothing is stashed.

## Conflicts

A conflict stops the run on that branch (`paused`): branches below stay restacked, branches above wait. The setting `prStackConflictMode` decides what happens next, read when the run starts:

- `pause` (default): the run's pause is kept in the notification center as a `restack` entry, once per conflicting branch, and stays in its "Needs you" filter while the run is `paused`. The user resolves in the named worktree and stages, then Continue (`git rebase --continue`), or Abort (`git rebase --abort`, the branch returns to where it was, the rest is skipped). A failed continuation keeps the rebase and staged changes, pauses with its error and never automatically skips a commit. "Ask the session" hands the conflict over on request.
- `agent`: the run's session gets the conflict through the server message queue (`origin: { kind: 'pr-stack' }`), told to resolve and stage but not to continue, commit or push. When that session's turn ends (`session.idle`, 3 s settle) with nothing unmerged, the run continues by itself.

## State

Runs are `{ id, directory, sessionId, remote, trunk, status, conflictMode, steps[], createdAt, updatedAt }`, `status` one of `running`, `paused`, `waitingForSession`, `done`, `failed`, `aborted`; each step has `branch`, `onto`, `status` (`pending`, `done`, `unchanged`, `conflict`, `failed`, `skipped`), `before`/`after` SHAs, `worktree`, `conflictFiles`, `error`. One unfinished run per repository directory. The last 20 runs persist in `<data dir>/pr-stack-restacks.json` so a paused run survives a restart; the rebase itself is Git's own state in the worktree. Every change is broadcast as `openchamber:pr-stack.restack` `{ run }`.

Start admission reserves the repository directory before reading asynchronous settings. A concurrent start receives 409 before Git runs; a failed settings read releases the reservation.

Start, Continue, Abort, session handoff and automatic continuation share a per-run execution reservation through Git operations and persistence. Overlapping manual controls receive 409 without changing the run or worktree. An idle notification skips a run already executing. Every success or failure releases the reservation.

Execution also reserves the repository independently of run history. A new start receives 409 until terminal cleanup and final persistence finish, even when the executing run already reports `done` or `aborted` or is evicted from retained history.

## Routes

| Route | Purpose |
|---|---|
| `POST /api/pr-stacks/restack` | Start a run; answers the run (409 while another runs in that repository) |
| `GET /api/pr-stacks/restack?directory=` | `{ run }`, the latest run for the repository |
| `POST /api/pr-stacks/restack/:id/continue` | After the conflict is resolved and staged (409 while files are unmerged) |
| `POST /api/pr-stacks/restack/:id/abort` | Abort the rebase and skip the rest |
| `POST /api/pr-stacks/restack/:id/ask-session` | Hand a paused conflict to the run's session |

## Runtimes

Web, desktop and both mobile shells call these routes on the OpenChamber server. VS Code has no OpenChamber server routes for it, so the UI hides restack there.
