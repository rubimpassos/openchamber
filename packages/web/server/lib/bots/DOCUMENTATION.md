# Bots persistence and repository policy

Persistent item leads and their parent integration slots are documented in
[conversation-contract.md](conversation-contract.md).

Production Git, isolated-result adoption, exact service context and PR-watch composition are documented in [production-worktrees.md](production-worktrees.md). The coordinator contract remains in [runtime-contract.md](runtime-contract.md).

The running server constructs those owners through [host-composition.md](host-composition.md), including its child-only tool inbox, lifecycle, isolated queues and event wiring.

Bot-owned isolated network and model-access references, the pure resolver and its required host composition are documented in [space-options.md](space-options.md).

Durable questions, approved recipient routing, service-only mentions and answer
recovery are documented in [questions-contract.md](questions-contract.md).

Durable render capture, owner publication, bounded agent/Space pull transport and
the required composition hooks are documented in [artifacts.md](artifacts.md).

`createBotNotices` adapts feedback to durable synthetic delivery. Its required
constructor, dispatch guard and isolated-queue contract are in
[notices-contract.md](notices-contract.md).

## Ownership

This module owns personal bot definitions, item snapshots, archival, approved repository policy and the production coordinator composition. Its runtime, adapter, attention and notice contracts define the execution boundaries. `host.js` registers authenticated routes through the server's feature composition; shared UI lives in `packages/ui`. Web, Electron, hosted mobile and Capacitor use the server contract. VS Code has no bots backend.

Behind a front door, the owner runs the complete Bot coordinator for both
placements. [Separated authority](separated-boundary.md) defines the typed agent
execution services, owner policy checks, queues and recovery boundary. Bot UI
changes originate from that coordinator. Durable attention and sessionless item
alerts are created directly in the owner center and notification runtime, with
no agent Bot attention bridge, as described in
[notifications](../notifications/DOCUMENTATION.md#front-door-bot-attention).

The private identity store accepts `jira-oauth` for Jira service-account client credentials, with `{ label, site, cloudId, clientId, clientSecret }`. The site remains a canonical Jira Cloud origin and the cloud ID is a UUID. Public identity methods return site/cloudId/clientId metadata, never clientSecret or an access token. Replacing the secret requires a complete definition and the expected identity revision. Existing email/API-token Jira identities retain their stored format; OAuth is a separate additive kind. The service adapter owns token exchange and gateway routing.

The production discovery, isolated stage and provider lifecycle adapters are documented in [production-adapters.md](./production-adapters.md). Their private records capture dispatch and space identity before effects, and keep provider cursor ownership separate for each consuming item or bot.

Bot definitions persist `discord: { channels: [{ guildId, channelId }] }`, with an empty channel list for older definitions. Channels are explicit guild destinations; approved people separately authorize DMs. Source discovery uses the user's JQL and selected Jira site without a configured project restriction. Discovery has its own per-occurrence token ledger so candidate admission cannot multiply or discard its usage.

`attention.ts` adapts authoritative item transitions to durable notification-center
requests. [attention-contract.md](attention-contract.md) defines its required
constructor, alert owner, UI target and failure behavior.

`createBotsConfig({ projectConfigRuntime, dataDir })` in `config.ts` owns two documents. Bot definitions are global, in `<dataDir>/bots/definitions.json` (`{ version: 1, revision, definitions }`, file lock, atomic rename, mode 0600). Each definition carries `projects: { [projectId]: 'read' | 'pr' | 'merge' }`; an absent project grants nothing. The project config keeps `{ concurrency, retentionDays, approvals }` under its `bots` key.

- `read(projectId)` returns that project's settings and approvals with only the definitions that have access to it. It is the coordinator's single entry, so stages, policy and providers see a project view and never the global list.
- `update(projectId, edit)` writes `{ concurrency, retentionDays }`. An edit that also lists `definitions` is a project-view edit: listed bots replace their global definition and keep or gain access to this project (full access unless they name one); unlisted bots lose access to this project only.
- `readDefinitions(projectIds)` and `saveDefinitions(definitions, expectedRevision)` serve the global list. A stale revision fails with `BOT_DEFINITIONS_CHANGED` (409).
- `setApproval(projectId, relativeFile, fingerprint | null)` is server-only.

Definitions found in a project section (files written before bots became global, or by an older version) are migrated on the next read of that project with full access to it, and removed from the project file. A legacy bot whose ID another project already migrated with different content stays in its own project section and keeps working there, so no project's mission, source, proof or tools replace another's. A project whose config cannot be read is skipped and named in `unreadable`; it never blocks the global list. The project route `PUT .../config` accepts only `{ concurrency, retentionDays }`, so an older client cannot rewrite global definitions without their revision. `readBotsConfig(raw)` parses the project section; `parseConfigEdit` parses a project edit. A missing key defaults to `{ concurrency: 2, retentionDays: 90, approvals: {} }`; explicit null or malformed config fails. Definition parsing is exported as `botDefinitionSchema`.

Access is enforced by state on every coordinator pass, so a question answer, a Resume or a later change of access cannot route around it: under `read` an item past its investigation ends `done` (after the artifact check) and never enters a correction; below `merge` an active admission is revoked, a `merging` item returns to `in-review` and no merge is authorized. A bot without access cannot admit work (`BOT_PROJECT_ACCESS_REQUIRED`).

`createBotScheduler({ projectConfigRuntime, scheduledTasksRuntime })` in
`scheduler.ts` exposes server-only `sync(projectId, managedRows)` and
`remove(projectId, botId)`. `managedRows` is the complete successful
`config.definitions.map(botTaskFor)` projection for one project. Invalid snapshots
throw before reconciliation. Existing non-bot IDs cannot be taken over. Sync
preserves task state through locked upserts, then removes stale bot rows and
refreshes scheduler timers. Remove affects only rows carrying the requested
`botId`. Normal tasks, suggested scans and other owners remain unchanged.

Each row write is atomic. A later failure leaves earlier successful writes valid,
preserves obsolete rows until replacements persist, and reports failure to the
config caller. Repeating the complete sync safely finishes reconciliation. A
timer-refresh failure also propagates; the next successful sync refreshes it.
No failed config read or source discovery may be converted into an empty sync.

Host composition constructs `createScheduledTasksRuntime` with the deferred
`runBot: (projectId, botId, occurrence) => botsRuntime.runScheduled(projectId, botId, occurrence)`
dependency, preserving the existing `runSuggestedScan` dependency. It constructs
`createBotScheduler({ projectConfigRuntime, scheduledTasksRuntime })`, passes that
adapter as `scheduler` to `createBotsRuntime`, assigns `botsRuntime`, and only
then starts either runtime. Imports come from `scheduled-tasks/runtime.js`,
`bots/scheduler.js`, and `bots/runtime.js` respectively. This module does not
edit `server/index.js` or register routes.

`scheduler.test.js` covers ownership persistence, managed mutation refusal,
manual dispatch, concurrency, failed writes, stale cleanup and shared occurrence
claiming. `node packages/web/server/lib/bots/scheduler-driver.mjs` drives real bot
config, project persistence, scheduler and task service with an explicit
deterministic bot hook. It proves config sync/list/run and refusal without an
ordinary session; it does not exercise production source discovery or providers.

`scheduler.contract.test.ts` composes the owner-local store with the Bot-only
runtime and scheduler adapter under TypeScript, then dispatches a controlled
manual run without project execution dependencies. `owner-config.test.js`
preserves legacy schedules, omitted zones, partial state and unknown fields
through locked state writes. These checks use temporary personal-config files.

`createBotStore({ projectsDirPath, fsImpl?, now?, owner? })` in `store.ts` exposes:

- `read(projectId)` returns `{ revision, items }`.
- `update(projectId, change)` runs `change(snapshot)` under the file lock. Return `{ snapshot: { revision, items }, result? }` to commit, or `{ result }` to skip. With no result, a commit returns the committed snapshot. The callback receives a detached current value and must preserve its revision and existing item revisions. A state-only mutation replaces a matching item in the array. The store increments revisions and appends transition history. Remote calls must happen after the promise resolves, outside the callback.
- `archive(projectId, { before?, itemIds? })` moves terminal items whose `finishedAt < before` and whose effects have settled. It returns `{ archived: string[], snapshot }`. The coordinator derives `before` from configured retention days. Ordinary writes never evict items.
- `readArchive(projectId, month?)` returns deduplicated archived items, optionally restricted to `YYYY-MM`.
- `filePathFor(projectId)` returns `<projectsDir>/<projectConfigFileStemOf(projectId)>/bots.json`. Archives are sibling `bots-archive/YYYY-MM.jsonl` files. Snapshot and archive operations share `bots.json.lock`.

`schema.ts` exports `createBotItem({ id?, botId, source, title, description?, now? })`, `botItemSchema`, `botItemSourceSchema`, `botItemStateSchema`, `botEffectSchema`, `botEffectAuthoritySchema`, `botOwnerSchema`, `BOT_ITEM_STATES`, `TERMINAL_ITEM_STATES`, `assertItemTransition`, and `assertEffectTransition`. The source and state schemas are reused by typed execution projections without picking fields from the refined item schema. Sources have `{ kind: manual | jira | suggestion | alert | investigation, id, url? }`; source identity and bot ID are immutable. Sessions are `{ investigation?, fixing?, judge? }` with session IDs as values. Worktree and branch are strings. Evidence is `{ source, summary, url? }[]`. Proof, judgment, wait, token usage, transitions and effects are parsed structured records, never opaque provider payloads.

Effects have stable `key`, a kind, SHA-256 `inputDigest`, `createdAt`, `updatedAt`, and `{ service, identityId, revision, target }` authority. Identity and target are opaque executor-resolved references, never credentials. `prepared` has no result; `dispatching` has `{ pid, host }` owner; `succeeded` has `{ id, url?, sha?, sessionId? }` receipt; `refused` and `outcome-unknown` have a stable `code`. Persist prepared, then dispatching, before a remote write. A persisted dispatching record must be reconciled after restart; it can never become prepared again. Unknown outcomes require human attention until authoritative reconciliation settles them. The coordinator owns that live reconciliation and setting `needs-you`; loading persisted history does not prove activity.

`readRepositoryPolicy(projectPath, approvals?)` reads `.agents/areas/*.md` and `.openchamber/people.json`. Area frontmatter is `{ name, paths: string[], level: human | judgment, owners: string[] }`, followed by explanatory Markdown. People JSON is an array of `{ id, name, roles: string[], github?, jira?, discord? }`. Service identities are strings. Every file fingerprint hashes exact UTF-8 contents. `approveRepositoryPolicy({ config, projectId, projectPath, file, fingerprint })` verifies the expected fingerprint and records explicit machine approval. It never edits repository files. `evaluateRepositoryPolicy(policy, [{ oldPath?, newPath? }])` returns level, reason, matched areas, owners, people trust and the policy fingerprint. `resolvePolicyPeople(policy, { owners?, role?, service })` returns `resolved` or `ask`; unresolved owners never become guessed accounts.

## Invariants

`drivers.test.js` runs the standalone process, provider and mutation drivers through the web package's existing `test` command. Each driver runs in a separate Node process. A nonzero exit or timeout fails its test, preserving the driver's assertions and cleanup boundaries.

- Only ENOENT means an empty snapshot. Invalid JSON, root/version errors, permissions and I/O failures throw and preserve disk contents. Invalid individual items are dropped independently. Successful empty snapshots remain authoritative.
- Every read and complete mutation takes the cross-process file lock. Writes use unique same-directory temporary files, mode 0600, and rename. Failed pre-rename writes preserve the old file and clean their temporary file. This supports process restart; snapshots do not claim power-loss durability.
- IDs and per-bot source identities cannot repeat or be reused after archival. Existing items leave the snapshot only through archive. New items start queued; history and identity cannot be rewritten. Each changed item has a monotonic revision and the process/host that committed it. Stage sessions must be persisted by the coordinator before prompt dispatch.
- Effects cannot disappear or change their digest or captured authority. A new effect starts prepared. Terminal receipts are immutable. Dispatching and unknown effects never re-enter a sendable state.
- Archive appends and syncs a complete newline-terminated record before snapshot removal. Restart reads suppress snapshot copies whose IDs already reached the archive. Repeating archive removes those copies without duplicating records. A torn final line has no authority and is truncated before the next append. One invalid archived item falls independently; unsupported record versions fail.
- Repository policy rejects symlinks at each relative component, verifies canonical containment and file identity around reads, and bounds files to 1 MiB. Linux additionally checks the opened handle's canonical path. Repository policy inputs must be stable during an admission check; callers re-read policy and compare its fingerprint at execution along with the exact base/head SHAs and destinations.
- New, changed, removed or unreadable area rules force human review globally until repaired or explicitly approved/withdrawn. Both old and new diff paths count. `.agents/areas/`, `.openchamber/`, `.github/` and any `CODEOWNERS` file require human review regardless of a judge's response. An unapproved people file supplies no identities.

## Decisions

### Why gateway projection precedes frame validation

`agent-gateway-transport.ts` retains the credential-bearing Discord socket; the
owner gateway owns heartbeats, durable cursors and reconnects. Its mutable
connection state tracks bounded unacknowledged frames and pull waiters. The
existing provider credential resolver owns authentication and current-identity
checks; provider HTTP responses remain untrusted until parsed here.

The transport reads the frame envelope before projecting READY and MESSAGE_CREATE
data through the existing wire schemas. Other dispatches retain only their
sequence and event name, with null data. Validating their unused snapshots first
would change which frames are accepted. Fragment-array socket messages retain
the prior invalid-frame outcome, and `.js` import specifiers remain valid for
both the source loader and emitted Node modules.

### Why persistence types follow the existing schemas

The TypeScript implementations infer item, effect, definition, identity and journal types from their existing Zod schemas, preserving defaults, strictness and stored versions. Owner project documents retain unknown fields without granting those fields policy or credential authority. Identity responses explicitly project public metadata, while only server-side resolution returns secret-bearing definitions. Source imports keep `.js` specifiers for emitted Node modules and use the server source loader in direct Node tests.

Public Bot routes and separated execution use the same checked TypeScript source
resolution. Checkout request types describe consumed identity, checkout and
publication fields; their effects ledger contains only the keys, kinds and states
used for admission. `BotBindingContext` describes credential-free owner context,
while local checkout and blame owners still require the GitHub credential API.
PR construction requires delegated execution when its context returns only a
binding. No coordinator-only fields are fabricated to satisfy execution types.

Notices, attention, scheduler, placement, presets, space options and proof also
use TypeScript implementations. Their existing parsers retain input authority:
notice callers supply only item identity, placement uses captured execution and
bindings, scheduler rows are parsed before writes, and proof uses immutable
snapshots. This conversion changes no persisted versions, defaults or dispatch
ordering. The adapter-state, discovery, effects, events and prompts owners also
use checked TypeScript with their existing parsers and `.js` import specifiers.

`repository-policy.ts` retains the exact-byte fingerprints, serialized field
order and validation schemas. Its local type owner, `repository-policy.types.ts`,
describes policy snapshots and service-specific identity resolution.
`judge-policy.ts` consumes that resolution directly: a resolved GitHub recipient
has a GitHub identity; an unresolved recipient carries the question reason.

Proof runs the configured command on separate immutable snapshots, leaving the
item checkout untouched. Only completed process exit codes count as red/green
evidence; signals, missing executables and output limits are inconclusive.
Cleanup releases each Git worktree before deleting its owned directory, and a
failed release remains visible. Presets return fresh editable definitions with
independent nested defaults on every call.

### Why global definitions behind a project view and not a global coordinator

A bot works in several projects, but items, policy, approvals, worktrees and budgets remain per project. Keeping `config.read(projectId)` as the only entry lets the coordinator stay project-scoped while the definition lives once; the global file owns identity, mission and access. A separate global coordinator would duplicate every project-owned invariant.

### Why a missing connector does not stop the item

Connectors are capabilities. Branch rules matter only for publication, so a host bot without GitHub investigates and fixes in a checkout made from the local default branch (`identityId: 'local'` in the checkout record) and ends `done` after judgment with the branch left in the project. Writes that need an absent connector are refused to the worker session (`BOT_CONNECTOR_MISSING`, 400) without item attention. An isolated bot still requires GitHub because its Space receives code through the GitHub transfer.

### Why a missing artifact first asks the worker

Only the worker can draw a page. When a required artifact is missing before judgment (only pages drawn since the current producing round count), the coordinator starts one more round with feedback naming the missing artifacts; a second miss in that round waits for the person (`BOT_ARTIFACTS_MISSING`), and Resume grants one more request. The judge must rule on every required artifact; one it does not mark proven turns `auto` into `review`.

### Why the main chat is re-created under a new ID

A user can delete or archive the main chat. OpenCode may keep a deleted ID reserved, so a missing or archived main chat is allocated again with a new identity, persisted before creation like the first.

### Why scheduled rows carry the bot ID

The task ID names the scheduler record while `botId` identifies the dispatch
owner and configuration page. Persisting both ownership fields keeps list,
mutation refusal and dispatch consistent after restart and loop discovery.

### Why a locked callback and not a read followed by replacement

The callback sees the latest disk revision inside the process-shared lock. Independent coordinators can mutate different items without losing either update, and stale detached snapshots fail the revision check.

### Why archive records precede snapshot removal

Removing first loses an item if the process stops before append. Appending first can leave 2 copies, which stable IDs reconcile on every subsequent read and archive operation.

### Why untrusted areas block the whole change

Changed or unreadable paths cannot prove the previous rule's scope. Treating only the new patterns as human would let a repository edit remove its own review requirement.

### Why approval stays in the personal config

Repository changes can alter policy and routing of questions. Only an explicit local approval grants the exact fingerprint authority; pulling a teammate's files cannot grant that consent.
