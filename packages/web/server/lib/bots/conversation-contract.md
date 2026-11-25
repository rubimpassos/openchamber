# Bot item conversation

## Ownership

The coordinator owns one durable root lead per item. `conversation` is separate
from the stage sessions. The registered project directory is its execution
address, including for items whose workers run in Spaces. Checkout disposal
never disposes the conversation. The existing coordinator remains the only owner
of workers, proof, judgment, questions, transitions and publication.

## Affected surfaces and risk

| Runtime | Behavior |
|---|---|
| Web | Authenticated server admission, normal native session transport. |
| Electron | Same server contracts and transport. |
| Hosted mobile | Same server contracts through its connection. |
| Capacitor | Same server contracts through direct or relay transport. |
| VS Code | No Bot backend; unsupported. |

Persistence risk belongs to the item store and conversation execution journal.
The optional field needs no conversion; old token records default conversation
usage to zero. Module and process contracts belong to the typed Bot services.
Native send admission belongs to the coordinator and transport guards. Focused
tests cover persistence, execution identity, restart, budget and refusal.
The parent runs combined builds, live runtime QA and review.

`session-defaults.ts` resolves the execution project's saved model, variant and
agent and reads the directory's OpenCode default only when the model is absent.
`conversation-queue.ts` installs owner admission before forwarding and joins the
native and conversation snapshots with independent revisions. Both keep runtime
owners deferred until the request is handled.

## Invariants

- A conversation has no parent and has the server-owned automation marker with
  `source: bot`, project, bot, item and `role: conversation`, plus `lead.at`.
- Session allocation uses a persisted identity before the SDK create. Uncertain
  allocation reconciles that identity; it never creates a replacement.
- Opening retained conversation information requires neither the bot definition
  nor its checkout. Sending still requires an active item and enabled bot.
- User chat does not answer a coordinator question or Resume an interrupted item.
  The UI answer route is explicit and must name the exact pending coordinator
  `questionKey`. Provider replies (Jira, Discord) keep their existing answer path.
- The coordinator pass allocates a lead only for an active item that has none
  (legacy or uncertain allocation) and whose bot is enabled and not stopping.
  An item that already has its lead costs that pass nothing.
- An isolated Bot's lead gets read access only: no web and no MCP tools, because
  the lead runs on the host outside the Space gatekeeper.
- Pending-human gating never limits the lead. Token budgets do; a queued item
  that exhausts them stops its lead and stays queued like coordinator admission.
- Cumulative conversation usage is separate from stage usage and contributes once
  to total and daily accounting. Stop and budget interruption stop the lead too.
- Native payloads retain their messages, files and model configuration. The
  owner admits inference before the existing transport sends it.

## Parent integration

- `POST /api/projects/:projectId/bots/items/:itemId/conversation` returns
  `{ conversation: { sessionId, directory, createdAt } }`. Open that native session.
  Detail responses include its address in `sessionDirectories`.
- Detail returns `questionKey` for the actual pending coordinator question.
  `/answer` accepts `{ text, eventId, questionKey }`; a missing key while a
  question is pending is refused. A stale key cannot settle the current question.
- The host installs admission into its existing session service and message
  queue. It registers `conversationGuard` before the local generic proxy.
  **The root server mounts `botsHost.conversationGuard` after owner
  authentication and before its front-door/Spaces dispatcher**, reading the
  current host through the same deferred slot as other owners. This is required
  because a separated request leaves before feature routes run. No body is read
  for unrelated sessions or reads. Matching native mutation bodies retain all
  fields. Matching native operations execute through the bounded typed
  `conversation-native` service and the existing SDK. They do not consume a
  request and then try to forward it through the streaming dispatcher.
- The control service calls
  `assertBotLeadControl(metadata, action)` from `session-lead/bot-guidance.js`
  against the authenticated calling session before executing its action.
  This permits brief/digest and explicit read actions, and refuses worker,
  workflow, session-send and publication controls. The render owner retains its
  separate read-only worker and conversation-only answer/share policy.
  The same control slot calls
  `await botsServer.assertConversationControlTarget(action, resolvedSessionId)`
  for the resolved target, so an unrelated session cannot send to this lead
  through generic `session.send`. Native user chat remains the admitted path.
- Ordinary native sends keep using the current message/attachment/model
  transport. `x-openchamber-operation-id`, or the native message `id`, keeps
  admission identity across client retries. Queue sends use their persisted
  queue item ID. Session-service callers may supply `messageId`.
- Separated execution uses dedicated `conversation-*` operations. None uses a
  stage scope, checkout key or `hostSessions` fallback. Agent execution validates
  registration and its saved conversation capture at every operation.
- Per-session native queue routes are handled by the owner guard, even behind
  the front door. The host installs its native dispatch hook into that queue,
  preserving captured files and configuration through `conversation-native`.
  The root combines `await botsHost.conversationQueueSnapshot()` with its native
  queue read for Bot conversation rows. Native `{ revision, sessions }` keeps its
  revision, with the independent owner snapshot in `conversation`. Owner rows
  carry `queueOwner: 'bot-conversation'` in snapshots, mutation replies and events.
  The shared queue parser tracks these revision owners separately. Ordinary
  session queues retain their existing owner.
- No `lead.review` state, verdict or approval owner exists. Progress notices are
  non-resuming and have stable snapshot-derived event IDs.

`runtime.ts` is the actual bootstrap; `index.js` remains its facade. The control
service checks canonical caller metadata before each action and checks resolved
targets before dispatch. The tool adapter carries the authenticated caller
separately from an explicitly selected context session. Render capture always
uses its authenticated session, call and message.

Automatic idle sleep compaction excludes Bot conversation metadata when arming
and before dispatch. Cache expiry cannot start inference outside coordinator
admission. Ordinary leads and overflow compaction inside an admitted turn retain
their existing behavior.

## Decisions

### Why the conversation queue has its own revision

The agent's native queue and the owner's conversation queue write independently,
even for sessions in the same directory. Combining their counters would discard
valid updates from the owner with the smaller counter. Each snapshot and event
therefore retains its actual queue owner.

### Why a durable project root rather than a stage

Workers can change between rounds and their checkouts can disappear. A separate
root preserves the same conversation through these changes without granting the
lead worker or publication authority.

### Why an isolated Bot's lead has no network or MCP tools

Its workers reach the network through the Space gatekeeper. The lead runs on the
host and reads worker reports, so granting the Bot's web or MCP settings there
would let untrusted report text steer host network access past that gatekeeper.

OpenCode 2.3.2 presents allowed tools directly when `execute` is disabled. The
lead therefore calls the advertised `openchamber` tool for brief and digest
updates. Code Mode is unnecessary for those controls; their availability does
not require widening the lead's execution permissions.

### Why progress delivery is deduplicated in memory and by message identity

Every item change, token-only ones included, reaches the progress owner. The
snapshot excludes tokens and revisions, so its digest only changes with
authoritative state; the last delivered digest skips repeats without an
OpenCode call, and after restart the stable message ID turns a repeat into a 409.

### Why progress does not start another autonomous checkpoint

Authoritative state and proof reach the conversation as non-resuming notices.
The lead explains them when the user speaks. Existing coordinator controls
continue to decide what executes and publishes.
