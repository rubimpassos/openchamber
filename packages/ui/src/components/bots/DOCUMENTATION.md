# Bots UI

## Ownership

This module owns the project Bots page: bot identity and navigation, editable
definitions, demand admission, an item's conversation workspace and work context,
archive, repository-policy review, identities, the sidebar's Bots section and
the Bot panel of the context zone. The chat column (`components/chat`) owns the transcript, composer and
lead digest shown inside the workspace. `BotRenderArtifactView` draws a retained
page in the work record with the chat's own page renderers and the read the
transcript uses (`components/chat/message/parts/DOCUMENTATION.md`, `ShownPage.tsx`);
this module lists page metadata and chooses which one to open. The server owns execution, approvals, credentials, item state
and recorded operations; see `packages/web/server/lib/bots/DOCUMENTATION.md` and
`runtime-contract.md`. Network parsing and session membership are described in
`packages/ui/src/lib/bots/DOCUMENTATION.md`. Visual constraints live in `DESIGN.md`.
Shared account reads and attention selection live in hook-only modules so
component exports remain compatible with Fast Refresh.

Web and Electron open the lazy project-rail page. Hosted mobile and Capacitor
open the same feature inside the mobile full-screen surface. VS Code has no
Bots server: its entry is absent, and direct view/API use reports unsupported.

## Invariants

- An item's conversation is `item.conversation` and nothing else. `useBotConversation`
  adopts the first address the server gives and keeps it for the visit, so a
  running or finished stage never changes the shown session. A missing
  conversation is asked for once through the ensure route while the item is
  active; failure shows the cause with a retry. No session ID or directory is
  built on the client.
- An ended or archived item without a conversation opens as its record
  (`BotItemDetail`), with stage links bound to validated addresses. With a
  conversation it opens read-only.
- Chat messages are ordinary input to the conversation. The page has no answer
  field: the bot asks its questions in its chat with the session's own question
  tools and passes the answer to the coordinator (`item.answer`). Resume and Stop
  stay explicit controls in Work and in the Bot panel.
- The workspace uses the native pinned chat column with `leadDigest`. It adds no
  transcript, composer, model, attachment, permission or render code of its own.
- A retained page in the record is the document the conversation draws for the
  same call: one owner read, the captured images and no live file or network
  read. While that read is in flight the page's row in the list says it is
  loading, and when it fails the dialog shows an error row with a retry
  (`RetainedPageFailure`), the same row the conversation shows. Its question opens only while the server lists the call as waiting or
  keeps an open later page; otherwise the record shows how the owner read it
  settled. A read-only record (an archived or ended item) never answers,
  declines or reports a page, and says the answer belongs in the conversation.
- A page's dialog first appears at the size of what it shows. A pressed row
  prepares its page out of sight (`ArtifactViewer` in `BotContextPanel`): the
  dialog root stays closed, the popup is staged (`DialogContent staged`), and
  the row shows Loading with Cancel. The root opens only when the view reports
  its content laid out (`onReady`): an HTML page after the first content
  height its frame reports is applied, a UI page and a failed read after they
  mount, a loading row never. The frame that was measured is the frame that
  shows. A report opens the dialog only for the selection that is current;
  Cancel and a replaced selection unmount the view and abort its read.
- A UI page mounts in the native frame only after the UI renderer's chunk has
  loaded (`UiArtifact`), so the page that is measured is the drawn page and never
  its source. A chunk that does not load ends the preparation the way a view
  that does not load does (`onLoadFailed`): the row returns to rest, the list
  says the page could not be opened, and pressing the row tries again.
- A page being prepared takes no answer or decline (`preparing`), and is laid
  out with the item's real `readOnly`, so the size measured is the size shown.
- Retry of a failed page closes the dialog first. The failure stays drawn while
  the dialog closes, and the read is asked again only after the close has
  completed, back in preparation, so neither the loading row nor the new answer
  resizes a dialog on screen.
- Artifacts shows the bot's required artifacts (`definition.artifacts`), each
  presented or pending by the `requirement` of a page, then every page the bot
  drew, of either kind, in one list shared by Work's record and the Bot panel.
  It is read while shown, and a failed read never reads as an empty list. The
  failed list and a failed page say which of three causes it was (the server
  could not be reached, the server is not ready, anything else) in translated
  text; a status code, an error code or a message from the response or the
  transport is never shown.
- A retained page remains readable when its canonical answer projection fails.
  `pageError` disables its answer controls, including while the live index still
  reports a waiting call.
- A photo is downsampled in the browser to a JPEG of about 96px under the
  definition's size cap, and saved with the definition. A failed pick leaves the
  draft unchanged. Files over 10 MB and other types are refused before decoding.
- On a desktop the project picker sits at the top of the bot navigation and the
  snapshot follows the project while any view is open, because the navigation
  shows every item's state. On a phone it follows only while a list is shown.

- Definitions expose the editable server configuration, including independent
  stage models and MCP rules. Machine approvals never enter a config write.
- Isolated definitions retain explicit place, network and provider-source references.
  `BotSpaceFields` probes inventories only after the existing Spaces switch says on,
  preserves partial-read failures and hidden drafts, and permits no typed secret.
  The host projection is documented in `packages/web/server/lib/bots/space-options.md`.
- Discord destinations are an explicit per-bot list of guild/channel ID pairs.
  The Execution form preserves IDs as text and adds/removes whole pairs. An
  empty list selects no channel; approved people's DMs remain server-governed.
- Reads belong to one mounted runtime/project visit. A failed refresh retains
  that owner's last result with an error; changing the owner hides old data
  immediately. A confirmed replacement invalidates older in-flight reads.
- Refreshes come from the shared control stream and explicit user actions.
  An open item owns the refresh of its own detail and, while Evidence or
  Decisions is shown, of its page list. No bot polling or background
  per-project fan-out is introduced.
- Mutations are explicit and serial per form. Failure leaves the editable draft
  on screen. Config persistence can succeed before scheduler synchronization
  fails, so errors tell the user to refresh before retrying.
- Identity forms keep secret inputs only in mounted React state, clear them
  after a submission, and never hydrate them from a response. Managing identities
  preserves the bot draft; closing that dialog refreshes identity choices.
  Jira OAuth forms edit public site/cloud/client IDs and require a fresh client
  secret for replacement. Switching kinds clears the mounted secret too.
- Proof absence, failed/inconclusive proof, judge reasons, retained waits,
  transitions, stage sessions, diff and recorded operations remain inspectable.
  Archive detail reads the item-detail route for retained evidence, stage reports
  and diff. Resume, answer and stop controls remain absent.
- Stage session links use the current detail's validated `sessionDirectories`
  entry for that exact session ID. Missing addresses disable the link, including
  before detail loads and in archive views without a valid projection. An initial
  detail failure grants no navigation authority.
- The page body owns vertical scroll on both layouts. A project or view-identity
  change starts it at the top before paint, including the phone's project picker.
  Bot, editor and item IDs, archive mode, create mode and the selected list tab
  define navigation; resource refreshes and edits within the same form preserve
  scroll. A conversation has no page scroll: the chat column and the work context
  body each scroll inside it.
- Policy approval requires a reviewed fingerprint and visible content. Missing
  reviewable people content blocks approval rather than trusting an empty list.
- `useUIStore.botsPageTarget` is a one-shot `{ projectId, itemId?, botId? }`
  navigation target, consumed after the project snapshot resolves. `botId` opens
  the exact definition for managed scheduled rows. Runtime switches retire the
  target, and main-page transitions close Bots atomically.

- Definitions are global (`fetchBotDefinitions`/`saveBotDefinitions`, written
  whole at their revision; `BOT_DEFINITIONS_CHANGED` keeps the draft and reloads).
  The project page keeps items, audit, rules and archive for its project and
  writes only `{ concurrency, retentionDays }` to the project config. The editor
  edits project access (Projects), connectors in one tab (own identity, which
  acts as the bot, and MCP rules, which act as whoever configured the MCP, each
  saying what the bot does without it) and the required-artifacts list (slug IDs
  kept stable once created). Request errors are translated sentences per code.
- The sidebar's Bots section (`BotsSidebarSection`, on the phone
  `apps/mobileSidebar/MobileBotsSection`) lists the runtime's bots with each
  bot's main chat and item conversations; `useBotsSidebar` owns its reads, the
  session sidebar owns its place and fold state (`bots`, `bots:<botId>`). It reads
  on showing, on `bots-changed` and `event-stream-ready`, and when the Bots page
  closes; nothing polls. 501, `bots_unsupported` and 404 hide it; a failed read
  shows an error row with retry. Its + opens a new bot in the editor
  (`botsPageTarget.newBot`). A chat row opens the session like a sidebar session
  row and never opens the Bots page; a taken-over item opens its released
  session in the item's worktree.
- The Bot panel (`BotPanel`, context mode `bot`) is offered for a bot session
  (main chat or item conversation) and opens once by itself per directory. It
  declares its width (340px, 300 to 480) and keeps it per panel. Home groups
  needs-you work (reason as a sentence, the pending question, Open chat, Resume,
  Stop) and working items (Open chat, Take over) and the schedule; Artifacts is
  the shared list above.

## Decisions

### Why the sidebar reads per bot and not per project

The section is global, and `fetchBotChats` already returns one bot's work across
every project it may access, so no per-project fan-out is needed.

### Why questions go through the bot's chat and not a page field

The session already has question, form and page tools with their own answer
lifecycle. A second answer field duplicated that and could answer for a person
the chat never asked; the coordinator now accepts the answer the chat relays
with the exact question key.

### Why the project picker moved into the bot navigation

Bot navigation, conversation and work context already fill the page. Keeping
`ProjectRailPage`'s project column as well left the conversation narrower than
a readable line on a laptop. The picker is the one the phone already used.

### Why the workspace loads the chat column on demand

The Bots pages are their own chunk and most visits never open a conversation.
Asking for `ChatView` when a conversation exists keeps the chat's module graph
out of the Bots pages; in the running app the module is already loaded, so the
conversation appears on the next frame.

### Why width is measured and not left to container queries

When the work context covers the conversation, the conversation must also leave
the focus order (`inert`). CSS can hide it but cannot do that, so the workspace
measures its own width and renders one arrangement.

### Why pages open in a dialog and not inside the panel

A page is authored for the width of a chat reply. The panel is narrower than
that on a desktop, so the dialog gives the page its intended width while the
list stays where the user left it.

### Why a page is prepared in a staged popup and not opened on a loading row

Opening at once showed three heights in a row: the loading row, the frame's
provisional 240px, then the page's own height, each on an opaque sheet. A fixed
height or a remembered size cannot fix a first opening, and a second frame for
measuring would load the page twice and split who answers it. The page is
instead drawn once in the dialog's own popup while the root is closed, and the
root opens on that same node. Readiness comes from the frame's first reported
height because a frame's `load` fires before the page has measured itself.

### Why the UI renderer is loaded before the native frame mounts and not inside it

`UiPageFrame` draws a page's source in a `<pre>` until the renderer's chunk
arrives, then swaps in the drawn page at another height. Its hook does not say
whether the chunk is still loading or has failed, so readiness reported from
the frame would either measure the source or wait forever. `UiArtifact` asks
for the chunk through the renderer's own `load()`, which fills the cache the
native hook reads, and mounts the unchanged native frame once it is there.

### Why a prepared page is refused answers at the frame and not through `readOnly`

`readOnly` changes what a waiting page draws: the read-only note, the decline
button, and what the page is told about its question. Turning it off at the
moment the dialog opens would resize the dialog on screen. Preparation instead
hands the frame no submit or decline handler, which `HtmlRenderDocument`
already refuses; a UI page needs nothing more, because the staged popup is
inert and only a frame runs script of its own.

### Why the page list reads every page of results

The server returns at most 100 entries per read and both tabs filter one list by
kind. Reading until `nextOffset` is null keeps a kind from looking empty because
its pages sit on a later read. A `nextOffset` that does not advance fails the read.

### Why the mobile scroll owner receives view changes

The list, editor and item detail share one persistent body. Keeping its prior
offset clipped the new page's controls under the fixed mobile header. The owner
resets through its own ref when scalar navigation identity changes; refreshed
snapshots and edited draft objects do not move the reader's position.

### Why session addresses come from detail and not the item worktree

The item worktree describes the host checkout. An isolated stage can run under
a different directory, so each link needs the server-captured address for its
session. Without that address navigation remains disabled, avoiding the shared
session opener's active-directory fallback. Archived inspection uses the same
detail projection, so retained reports and diff stay readable while session
navigation requires the server-projected address for each session.

### Why visit-local resources and not a Bots store

Only the shown project needs a full read, and the sidebar and the Bot panel each
read one bot's work while shown. Durable notifications and the control stream
already say when to read again, so another global cache would duplicate authority
and require another reset/reconciliation protocol.

### Why explicit content review and not fingerprint-only approval

A fingerprint identifies bytes but does not let a person review them. The policy
route supplies `people.content` for review before approval, while routing identities
remain unavailable until that exact fingerprint is approved. Missing reviewable
content disables the approval action.

### Why suggestion handoff remains with the source owner

`BotItemCreate.initial` carries source identity and evidence into admission, but
it does not reserve or convert a suggested task. The suggested-task owner must
connect its server-owned idempotent conversion; direct UI mutation of suggestion
status would lose the cross-feature transaction.

## Coordinator integration and QA

The shared stream parser accepts `openchamber:bots-changed` and
`openchamber:bot.item.changed` envelopes with `properties.projectId`. The server
must forward its bot invalidations into that existing authenticated control
stream. Only the named visible project refreshes.

Durable attention entries must have `kind: 'bot'`, `resolvedAt: null` and
`action: { type: 'bots', projectId, itemId }`; read state alone does not settle
them. The server resolves them when attention ends. Blocking session requests
come from the live request index, including requests on unmarked descendants.

The coordinator owns suggestion conversion and managed scheduled-row links;
their existing editors were excluded from this worker's file ownership. A
managed row sets `botsPageTarget` and opens the desktop page or mobile Bots
action instead of editing the server-managed scheduled definition.

Focused tests cover the HTTP boundary, membership, read authority, evidence,
atomic page transitions, managed targets, archive waits, real form-to-HTTP
bot creation/editing, the photo round-trip and removal, bot-page navigation,
conversation failure and retry, the page lists by kind, a page's preparation,
cancel and retry, and the phone's conversation and work-context views. No unit test mounts the chat column inside
the workspace: a ready conversation with its digest, sending, and an opened page
need the running app. Combined runtime QA still needs the coordinator's server:
create/edit a bot and source item, review and approve policy content, create and
replace redacted identities, answer/stop/resume an item, navigate stage sessions,
and observe the sidebar's Bots section and the Bot panel follow item changes. Verify desktop, narrow mobile,
RTL, both themes, and a runtime switch with a mounted secret form. Unit tests
and per-file diagnostics do not establish that runtime or visual evidence.
