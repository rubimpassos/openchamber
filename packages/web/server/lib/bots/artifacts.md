# Durable Bot render artifacts

## Ownership

`artifacts-capture.ts` runs beside the existing `render.page` action, in the
runtime that can read the producer's files. `artifacts-owner.ts` owns publication
in the work record. `artifacts-store.ts` owns immutable blobs and locked catalog
attachment. Neither the producer nor the browser chooses an owner project or
item through render input.

The body is opaque HTML or an OpenUI program. `evidence` and `decision` are
categories only. There is no graph, benchmark, measurement or template contract.
`packages/ui/src/lib/bots/artifacts.ts` parses metadata, references and payloads
and reads them through `runtimeFetch` with the existing Bot runtime lifetime.

| Runtime | Behavior |
| --- | --- |
| Web | Execution capture, owner catalog and authenticated artifact reads. |
| Electron | Uses the same server contracts and existing sandbox renderer. |
| Hosted mobile | Uses its connected owner's authenticated reads. |
| Capacitor mobile | Uses its connected owner's authenticated reads. |
| VS Code | No Bots owner; the client returns `501 bots_unsupported`. |

## Invariants

- A render call is keyed by its authenticated session and call ID. Its ID is
  `artifact_` plus the SHA-256 of that pair. Repeating identical input reuses the
  first snapshot, even after the original files disappear. Changing the body,
  title, category, interaction mode or canonical binding is a conflict.
- Execution resolves provenance from the canonical session or execution
  registry. Owner publication separately compares the exact project, bot, item,
  session, directory and producer role against retained owner-recorded stage or
  conversation bindings. Session metadata alone cannot authorize publication.
- Workers can only publish read-only renders. Their `awaitAnswer`, `answerLater`
  and `share` requests are refused before those lifecycle owners run.
  Conversations retain the existing page answer, later-page and sharing owners.
  The artifact stores interaction intent and canonical session/call, never an
  independent answer or answer lifecycle. Archive viewers are read-only.
- Source remains capped at 200,000 characters. Local PNG, JPEG, GIF and WebP
  discovery uses `renderPageImageSources`; validation uses `inspectLocalImage`,
  including validation of the frozen bytes. The existing 10 MiB image and
  25 MiB ordered-prefix limits apply. At most 256 literal asset references are
  captured. Excess references fail the call explicitly. Missing, rejected,
  over-budget and external images have explicit incomplete metadata.
- HTML and OpenUI literal image references use the same capture path. External
  image URLs are reported as unavailable and are never fetched by the server.
  Generated paths, computed network resources and non-image dependencies cannot
  be captured by literal discovery. Pages must be self-contained as the render
  contract already requires.
- Immutable payload blobs are synced before atomic catalog attachment. Failed
  attachment leaves the old catalog valid and an unreferenced blob that an
  identical retry reuses. Interrupted transfer attaches nothing. Successful
  earlier artifacts remain valid when a later transfer fails.
- Capture catalogs live in `<execution-data-dir>/bots/artifact-captures`.
  Published catalogs live in `<owner-data-dir>/bots/artifacts`. Both are
  independent of sessions, worktrees and item archival. No lifecycle deletion,
  retention eviction or sweeping is installed. This adds a version 1 format;
  existing stored Bot data needs no conversion.
- Each session or item catalog has a 4 MiB, 4,096-entry ceiling. Reads are bounded,
  ordered by creation time then stable ID, and paginated. A full catalog refuses
  another attachment rather than evicting evidence. Malformed catalogs and I/O
  failures fail the read, preserving the existing snapshot.
- Owner pull requests contain only a captured binding, opaque ID, call and
  bounded byte offset. Payloads are at most 40 MiB, transferred in 256 KiB binary
  chunks encoded as base64. Each reply is capped at 2 MiB, below the existing
  Space transport's 8 MiB cap. The owner verifies association, exact chunk
  lengths, final length, digest, input digest and aggregate image budget before
  attachment. A producer-named path is never opened on the owner.
- A tool result carries `artifact` metadata and `publication: captured` or
  `published`. `captured` is durable execution capture, not owner publication.
  A wake failure or publication failure fails the call but keeps its captured
  snapshot available for recovery. Replaying the call repeats the wake.

## Decisions

### Why capture runs in the render action

Only the execution runtime can read its files before stage cleanup. OpenCode
tool input retains source but not image bytes, and later pages retain questions
and answers but not page bodies. Reconstructing from either after cleanup loses
evidence. Normal nonbot rendering takes its existing path.

### Why the owner pulls a snapshot

An execution server cannot push into owner authority. The owner initiates typed,
bounded pulls for its recorded binding and independently authorizes attachment.
This works for the existing agent connection and Space dispatcher without new
credentials, grants, listeners or filesystem authority.

### Why blobs precede the catalog

The catalog is the publication boundary. A failed write may leave an immutable
unreferenced blob, but never metadata that claims an absent payload is complete.
Retrying the same snapshot completes attachment.

### Why answers stay with the page owner

An artifact is an immutable body snapshot; a live wait or settled answer belongs
to the existing page owner. A retained message ID permits one canonical lookup,
while copying answer state into the artifact would create a competing lifecycle.

### Why render wakes use a transport outbox

The execution server holds the answer and its original synthetic message, while
only the owner can admit another conversation turn. The outbox preserves that
message through refusal and restart without changing the page or sharing
owner's answer transitions.

### Why final collection precedes cleanup

The producer's transport and files disappear when its Space or checkout goes.
Stopping the producer and collecting before removal preserves a retryable source
when transfer fails. A receipt is reset by dispatch and Resume so an earlier
successful collection cannot hide a later capture.

### Why answer failure preserves the retained body

The immutable payload is already complete in owner storage. An unavailable
canonical answer source cannot invalidate it, so reads keep the body and return
`pageError: BOT_ARTIFACT_PAGE_UNAVAILABLE` separately. This distinguishes a
failed projection from a successful lookup with no retained answer.

## Production composition

`host-artifacts.ts` composes publication, retained bindings, local capture and
remote collection. `artifacts-bindings.ts` reads retained items, stage receipts
and placement records, including archived items and superseded stage sessions.
`artifacts-execution.ts` constructs one capture and private service beside each
local host, separated agent and Space child. `runtime.ts` injects that capture
into the control service and supplies canonical SDK and metadata operations.

Capture also answers `isInteractiveSession` from that same resolved binding.
Page recovery consults it before creating or revalidating a recovered await.
This preserves worker refusal when a recorded producer has lost its canonical
metadata hint. Failed binding reads propagate without creating a page.

The public catalog mounts after authentication and before the generic proxy.
Private agent routes mount only on the agent; the child mounts the Space route.
The front door refuses the private agent namespace. Metadata wakes, startup,
agent reconnection and Space stream reconnection collect recorded bindings.
Collections of the same session coalesce, including a wake during transfer.

Host removal quiesces each recorded host producer before final collection.
Space stop and removal interrupt and verify their producers, collect, then save
a final-collection receipt before stopping the container. Dispatch and Resume
invalidate that receipt. Transfer failure blocks destructive cleanup. Shutdown
drains collections before the root closes either transport.

The execution service's authenticated `drain` waits for capture writes of the
named producer, including its metadata wake and local publication. `quiesce`
interrupts and verifies a host producer before that drain. Final collection
therefore includes a capture whose model turn ended while its write was still
in flight. Capture tracking is scoped per session; shutdown drains every scope.
Owner flush tracks direct local publications and pulled collections and waits
for all admitted operations even when one fails.

The constructor and transport contracts are:

1. Construct one `createBotArtifacts({ dataDir, resolveBinding, assertReadScope })`
   in the owner. `resolveBinding(sessionId)` must consult retained stage journals,
   isolated bindings or `item.conversation`, including archived items; it must
   verify the registered project and item's bot ID. It must return `null` for an
   unrecorded session. `assertReadScope({ projectId, itemId })` checks registered
   owner scope and an active or archived item without requiring its bot
   definition to remain installed.
2. In every execution server, construct `createBotArtifactCapture({ dataDir,
   resolveSession, onCaptured, publish? })`. `resolveSession(sessionId)` returns
   the canonical execution binding, or `null` only for a verified nonbot
   session. Failed reads throw. `botArtifactBindingFromSession` parses the SDK
   session shape and supports legacy stage metadata and
   `automation.role: conversation`. It grants no owner publication authority.
   A colocated owner supplies
   `publish: (manifest, bytes) => artifacts.publish(manifest.binding, manifest,
   bytes)`. Separated agents and children omit that callback.
3. Add a control-service option typed as
   `RenderPageDependencies['artifacts']` and pass it as `artifacts` to the
   existing `createRenderPageAction` constructor in `service.ts`. The public
   render tool schema already accepts `artifactKind`. No second action is needed.
   Explicitly allow `openchamber_render` after worker `*_*` denials in the stage
   permission owner, including investigation/judge scans. The action enforces
   read-only worker behavior even if tool input asks otherwise.
4. Register `registerBotArtifactRoutes(app, { artifacts })` on the owner after
   API authentication and before the OpenCode proxy. Existing normalized Bot
   route ownership keeps `/api/projects/:projectId/bots/...` on the front door.
   The routes are metadata-only `GET .../items/:itemId/artifacts`, with bounded
   `offset` and `limit`, and single-payload `GET .../artifacts/:artifactId`.
   No asset URL, filesystem path selector or separate browser credential exists.
5. On an agent server or child, construct `createBotArtifactService({ capture,
   resolveBinding })` and register `registerBotArtifactServiceRoutes(app, {
   service, placement: agent | space, isAllowed })` after its existing auth gate.
   The runtime-owned predicate must enforce agent-server or inside-Space mode.
   Agent requests use `/api/openchamber/bot-services/artifacts/pull` and `/chunk`;
   children use `/api/openchamber/bots/artifacts/pull` and `/chunk`. The existing
   front-door private Bot-service refusal already covers the agent namespace.
6. Construct `createBotArtifactTransport({ request })`. Its callback receives
   `operation`, serialized JSON body and a 30-second abort signal. The agent
   adapter calls the existing `agentUpstream.json` with POST and JSON headers.
   The Space adapter calls the captured Space's authenticated `requestInside`
   or its existing bounded JSON fetch adapter. Retain the transport's byte
   limit, refusal of redirects and incomplete-response checks. A failed Space
   request must never fall back to the agent or host.
7. `onCaptured(manifest)` wakes the owner through the existing session metadata
   event mechanism, naming only the captured session and artifact ID. The owner
   resolves that session's recorded binding and calls
   `artifacts.collect(binding, transport, signal)`. Startup and reconnect repeat
   collection for retained registered bindings, without scanning messages.
   Already-published identical manifests skip payload transfer.
8. After stopping or settling the stage, await `collect` for each recorded
   session before any destructive Space or checkout cleanup. A rejection blocks
   cleanup and preserves the source for retry. Then await `artifacts.flush()`
   before closing transports. `flush` drains already-admitted collections; it
   does not discover sessions or replace the explicit final collection. A new
   call cannot race cleanup once the stage has stopped.

## Retained page projection

New captures optionally retain `source.messageId` from the authenticated tool
context. Old snapshots remain valid. A payload read adds optional `page`, the
existing answer owner's projection. Its `kind` is `show`, `waiting`, `answered`,
`declined`, `not-drawn`, `answered-in-chat`, `chat-sent-earlier`, `unanswered` or
`later`. `answered` carries `summary` and `data`; later pages keep `undelivered`.

`page-projection.ts` reads the indexed later-page owner and live waiter first.
For a settled ordinary await it reads exactly that message through
`session.message.get`, scoped by session ID, and checks message, call and tool identity. The SDK message record has no session ID field. It
never scans history, manufactures a tool part or revives a historical wait.
The immutable body and publication authority remain unchanged.

Page and shared-answer synthetic wakes use `conversation-delivery.ts` beside
their existing answer owner. A durable transport outbox and per-session pending
index keep the original message ID and body. A metadata hint wakes an owner
pull, which checks conversation budget and Stop before typed native dispatch.
Settlement lets the existing page or sharing owner finish its own receipt on
retry. No second answer lifecycle exists. Non-resuming archived delivery keeps
its direct path. Refused wakes stay pending for recovery or an explicit owner
state change.

Private artifact operations additionally include `page`, `drain`, `quiesce`, `deliveries`
and `settle-delivery`, with the same exact binding and authentication checks.
When `pageError` is present, `page` is absent and the viewer has no projected
answer authority. The retained body remains available.

## Renderer integration

`ShownPage.tsx` owns the transcript composition. `BotRenderArtifactView.tsx`
uses the same `useBotArtifactRead`, `retainedImages`, `retainedHtmlDocument`,
`HtmlRenderDocument` and `UiPageFrame` owners for the work record.
`HtmlRenderDocument.tsx` owns the shared HTML document, theme updates, submit
bridge and opaque-origin `sandbox="allow-scripts allow-forms"`. The transcript's
`HtmlRenderFrame` adds its chrome and receives the retained `snapshot`.

`retainedHtmlDocument` inlines captured assets by exact `source` and installs a
content policy before the page's own markup. Missing, external and computed
resources stay unavailable. `RetainedPageNotice` displays incomplete assets.
No retained document reads a live file or requests an image grant.

`UiPageFrame` receives `origin: RenderedPageOrigin`, `source`, `ask` and
`readOnly`. The origin holds `sessionId`, `callId`, `partId` and optional
`messageId`. The work record derives these from the artifact's canonical source
and ID. `RetainedMarkdownImagesContext` supplies the exact-source image map
around the OpenUI renderer. An empty map still means retained-only images;
`null` permits the ordinary live image owner. Capture discovers literal OpenUI
strings with the same Markdown destination parser as message image grants,
including inline and reference-style images. The opaque program stays intact.

`useHtmlPageAnswer` and the existing page/later owners retain answer state and
submission. Only the live waiting index or open later page can enable answers;
`interaction` and persisted history grant no answer authority. Archives and
`pageError` reads are read-only.

The authenticated managed render callback publishes the canonical reference as
`metadata.openchamber.artifact` through native `context.progress` immediately
after capture, before any answer wait. It is the same `BotArtifactReference`
as `data.artifact` in a successful final result, including optional
`source.messageId`. A running capture has no success or answer claim. The final
metadata preserves the reference alongside the existing `answer`; Stop leaves
the running metadata on the native interrupted call. History shells retain
this metadata even when they strip the completed result text.

`botArtifactReferenceSchema` parses either reference location.
`fetchBotArtifacts` and `fetchBotArtifact` read the owner's catalog and payload.
Both views use the same artifact ID. A separated capture can have
`publication: captured` until owner collection makes its payload available.

## Validation

The focused `artifacts-capture.test.js`, `artifacts-owner.test.js` and
`artifacts-transport.test.js` suites exercise actual filesystem persistence,
render/page-answer integration, owner-authenticated HTTP routes, typed pull
routes, interrupted transfer, restart, content conflicts, binding refusal,
atomic write failure and a 25 MiB image snapshot.

`production-artifacts.test.js` exercises the actual control/capture/owner path
and deferred-answer admission. The separated composition tests collect a final
capture after a lost wake before removing its source. Process drivers exercise
the real bootstrap, authentication, owner guards, private route placement and
independent queue snapshots through controlled OpenCode peers.

The parent owns combined type-check/lint/build, runtime QA, sandbox rendering
on desktop/mobile, packaging and release. Focused tests make no live container
isolation or live provider claim.
