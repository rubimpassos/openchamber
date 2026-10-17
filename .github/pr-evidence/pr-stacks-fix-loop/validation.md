# Stacked PRs and protected fix-loop validation

## Real GitHub run

The user authorized a disposable private QA repository and an OpenAI login grant for a fresh protected worker. The worker ran the locally packed web/SDK 2.3.13 tools and OpenCode 2.0.29 with `openai/gpt-6-luna`.

The host seeded PR #6 at `ea65c3104c3086451ab8346404c747e5b5e0e1a5`. The worker changed only `qa-ui.md`. The host exported commit `73768d93318319314084fc6bb0892ef968127f01`, verified its direct parent and retained it for review. An independent archive of that exact commit passed `node --test`, 3 tests, 0 failures. The host checkout was not switched.

After the user inspected and approved the exported diff, the normal approval endpoint published that exact commit to `refs/heads/qa/ui-stack`. A subsequent GitHub read confirmed the approved SHA, exactly one generated thread reply, and a resolved review thread. Both durable host mutation records succeeded with their original operation keys. The loop finished at `budgetReached`, with review state `complete`, 2/2 host operations, one iteration, no pending receipt and no error.

The first post-publication attempt temporarily reported a review-write blocker before any durable provider mutation existed. The existing retry completed both operations without a duplicate reply. The generic intermediate message does not establish the original low-level cause.

The turn reported 75,205 tokens against a 20,000-token budget. Budgets are checked after a turn and prevent subsequent iterations; they do not cap one response.

The private QA repository is `rubimpassos/openchamber-stack-fixloop-test`. Its PR #6 and generated review reply are available to users with repository access:

- https://github.com/rubimpassos/openchamber-stack-fixloop-test/pull/6
- https://github.com/rubimpassos/openchamber-stack-fixloop-test/pull/6#discussion_r4298617649

## Isolation and refusal checks

Real Docker checks verified the permanent protected profile, empty network corridor, blocked direct and descendant egress, and an unreachable control listener. Ordinary-container same-IP TLS and host-exec health probes supplied positive controls. Restart preserved the profile and restored only the selected grant. The current packed-tools mount matched its expected fingerprint and was read-only. Read-only inspection inside the disposable worker found one OAuth credential whose access and refresh were both placeholders. No credential values were emitted.

Controlled HTTPS cases admitted the exact Luna Responses formats and refused Chat Completions, other models and hosted tools. Executed disposable mutations removed admission, allowed Chat, and allowed hosted search; each broke its corresponding regression. Separate executed mutations covered request/schema/resource guards. These checks do not claim full-filesystem or process-memory secret non-disclosure.

An authority-free stopped UI fixture could display a receipt but its direct approval request returned HTTP 409. A rendered receipt did not supply publication authority.

## Stack and automatic-loop checks

Live GitHub and browser exercises covered native stack registration and replay, append, bottom-up merge and retarget, upper-member merge refusal, restack publication, squash recovery and conflicts. Browser checks created a stacked PR, attached the whole stack and persisted its follow toggle. A later real model turn received refreshed stack context. The final production mobile composer automatically acknowledged context delivery, and the next pending-context read was empty. An unavailable binding retained unknown membership.

A separate headless automatic loop fixed and published QA PR #5, reached green CI, and stopped after one iteration at its post-turn token budget.

## Presentation evidence

These screenshots are from the final production UI bundle. Approval screenshots use a stopped authority-free fixture and do not depict the live published commit.

- [Desktop publication review and frozen proposed replies](approval-desktop.png)
- [Arabic mobile exact receipt and disabled publication](approval-mobile-rtl.png)
- [Mobile stacked-PR dialog](stacked-create-mobile.png)

Independent visual review passed the unobscured English desktop and Arabic desktop/mobile fixture captures. The mobile dialog retained long identities without page-level horizontal overflow. A later attempt to inspect the real receipt in the browser could not initialize Chrome; actual export/publication proof comes from the host API, Git object and GitHub reads.

## Automated validation

- `bun run check:changed` passed across 181 changed source files after the Luna and nullable-cursor changes. Package type checks, lint, Knip and anti-slop passed. One pre-existing exhaustive-deps warning in `useOrphanedQuestions.ts` remains.
- The complete root suite before the final server-only Luna/cursor delta passed scripts 18 files, SDK 30, UI 913, VS Code 64, Electron 53, and web 439 files with 7,992 cases. Web skipped 10 files and 170 cases.
- The Luna Spaces/fix-loop run passed 1,970 cases with 135 skipped. All 164 fix-loop cases passed after the nullable-cursor correction, including four regressions that failed before that fix.
- Production `bun run build:web` passed before the server-only Luna/cursor delta. Corrected local web/SDK packages were subsequently packed and exercised by the real protected worker.
- `bun run docs:validate` passed 721 pages and 60 sidebar links.

Validation used pinned Bun 1.4.3. The full suite used one isolated-test worker, a disk-backed temporary directory, an existing Hermes fixture checkout, and command-scoped `tag.gpgSign=false` for an unsigned-tag fixture. No global Git setting, assertion or timeout was weakened.

## Not verified here

Installed Electron, VS Code and native mobile shells are unavailable on the VPS. Shared browser/server tests do not certify those installed shells. Every theme, keyboard accessibility state and historical all-file LSP coverage were not checked. Focused diagnostics and all package type checks passed.

## Final review corrections

The independent gate found unsafe automatic skipping after a failed rebase continuation and concurrent restack admission. The corrected runtime preserves the paused rebase, staged resolution, original branch and error after a signing/commit failure. It never automatically skips that commit. Start admission reserves the repository before asynchronous settings reads and releases the reservation on failure.

Two regressions failed on the original runtime; all 11 restack cases passed after correction. An independent driver used the actual Express routes and real disposable Git repositories: start returned 200/paused, a failing commit hook made Continue return 409 while retaining staged content and the original branch, a concurrent start returned 409, and retry after removing the hook completed with the resolution retained and the private worktree removed. The driver deleted only its disposable repositories.

The gate also found branch-name collisions between fork anchors and same-repository PRs. Inferred parent, child and side-branch edges now include repository identity. Eight regressions failed before correction; all 29 stack cases passed afterward. A direct production-module driver confirmed separate fork/local chains from both anchor directions and preserved the ordinary same-repository chain and side branch. Unknown repository identity remains a failed read.

Stack writes now use canonical mutation admission with exact credentials, current head checks, durable locks, audit and replay. The actual web adapter sends the same bound contexts as the routes expect. Successful compact registration and merge results survive storage restart. Adapter-to-route regressions exercise registration, retarget and merge through real Express handlers, including original-key replay.

Live GitHub validation exposed a list/detail payload difference: list entries omit the detail endpoint's `merged` flag. The old preflight rejected those entries. The real-wire fixture reproduced 15 failures; all 103 mutation cases passed after validating the list shape and preserving repository and exact-target checks. On the running integrated host, existing native membership returned stack #4 and replayed its retained result without further provider requests. This verification used provider reads only. The original ambiguous action retained its unknown outcome and was not redispatched. GitHub separately refused a same-base retarget because the PR belongs to a native stack; that refusal is not counted as a successful retarget.

The production browser UI displayed distinct informational messages for `pending` and `enqueued` bottom-PR merge outcomes in Arabic RTL. Both kept the PRs open. A local presentation fixture required canonical head/key input and intercepted these two merge requests before any provider mutation. Real GitHub merge behavior was exercised earlier; the fixture checks only asynchronous feedback. The disposable QA server was stopped afterward. Browser errors from the stopped protected worker and unrelated model loading were observed; this presentation check did not request another model turn.

After integrating current `main`, `check:changed` passed across 270 changed source files, the production web build passed, and docs validation passed 733 pages and 61 sidebar links. The final list-shape delta is server-only. Existing lint and bundle-size warnings remain. Final suite and post-delta check results are recorded in the PR's validation table.

A second gate reproduced concurrent continuation overwriting `done` with `paused`. All restack controls now share a per-run execution reservation, including initial advancement, session handoff and automatic continuation. Four regressions failed on the old runtime. The final 16 restack tests passed, including both automatic/manual overlap directions. A real Git/HTTP driver confirmed overlapping Continue, Abort and Ask session each returned 409 while preserving the active worktree; the original continuation completed with the resolution retained, persisted `done` survived reload, and private-worktree cleanup succeeded.

The integrated complete root suite passed before this final restack-only delta: scripts 18 files, SDK 30, UI 926, VS Code 64, Electron 53, and web 446 files with 8,171 cases. Web skipped 10 files and 170 cases. The final restack delta has the focused 16-case pass and real Git/HTTP proof above.

The final cleanup gate also reproduced a new start overlapping a previous continuation's terminal worktree cleanup. Repository execution ownership now persists independently of retained run records until cleanup and final persistence finish. Its regression failed before the fix; all 17 final restack cases passed afterward. Real Git/HTTP QA returned 409 to start during terminal cleanup and 200 after release. The original operation retained its successful persisted result and resolution.

Final `bun run check:changed` passed against integrated main across 173 changed source files in 42.31 seconds after all server corrections. All package type checks, lint, Knip and anti-slop passed. The existing exhaustive-deps warning remains.

The final independent delta gate approved the corrected reservation. It verified synchronous ownership acquisition, release after cleanup and persistence, start refusal during execution, and independence from history eviction. Earlier gates' concrete blockers were fixed before publication.

## Review follow-up: automatic feedback authority

The PR's security review identified automatic host dispatch from comments by authors without repository write access. Automatic feedback now requires GitHub's current base `write` or `admin` permission for the author, read with the loop's exact account. This check also removes untrusted historical comments from otherwise trusted threads. Author lists and mentions do not grant authority. Permission errors preserve unknown state and the feedback baseline, with rate-limit handling and increasing backoff. Approval mode still keeps external feedback in its restricted worker and waits for approved publication.

Automatic admission is persisted before enqueue. Host dispatch rejects older queued prompts without that evidence. Before any automatic iteration, the server awaits the persisted queue read, so an existing unchecked item cannot inherit a later admission marker.

Seven runtime regressions failed before the author check. An additional restored-queue regression and a consecutive-permission-failure backoff regression also failed before their corrections. Final validation passed 272 cases across the feedback reader, fix-loop and message-queue suites. `check:changed` passed all package type checks, lint, Knip and anti-slop in 60.13 seconds; the existing exhaustive-deps warning remains. Docs validation passed 733 pages and 61 sidebar links.

Manual QA used the actual Express fix-loop routes, production readers/runtime and real Octokit over HTTP to a controlled GitHub fixture. Outsider feedback produced zero host deliveries; trusted feedback produced two. Untrusted thread history was absent, repeated feedback did not resend, a permission 403 prevented delivery without consuming feedback, recovery delivered the same retained request, and revoking write access prevented another dispatch. Every accepted delivery passed the persisted host-admission guard. The fixture and loop were stopped afterward. This check made no real GitHub writes and requested no model turn. The full-root suite and browser build recorded earlier were not rerun for this server-only correction.

An independent follow-up gate approved the author-permission and persisted-queue correction. It inspected the current code and red/green evidence, including the production queue restart regression. It did not rerun tests or claim a live GitHub permission check.
