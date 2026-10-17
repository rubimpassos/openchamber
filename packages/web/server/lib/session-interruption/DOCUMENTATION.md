# Session interruption

## Purpose

Records why OpenCode interrupted a session's last turn, so the UI can tell a
question OpenCode killed from one the user stopped.

OpenCode 2.x evicts a directory's location after 60 minutes without session
events and interrupts every execution there first (`location-activity.ts`,
reason `inactivity`). A `question` waiting for an answer emits no events, so
a question left unanswered for an hour ends with its tool part in `error`.
The UI shows such a question again as answerable (`orphanedQuestions.ts`).
A Stop errors the part the same way, and the reason that tells them apart
lives only on the live `session.execution.interrupted` event: OpenCode
stores `interrupted` and nothing more.

## Files

- `runtime.js` — `createSessionInterruptionRuntime({ persistMetadata, updateMetadata, buildOpenCodeUrl, getOpenCodeAuthHeaders })`,
  fed by the global hub subscriber in `server/index.js`; `recordRestartInterruptions` is called by its `onOpenCodeRestarted`.
- `restart.js` — the restart record patch, `findInterruptedTool` and the
  `opencode-restart-interrupted` notification payload.

## State

`metadata.openchamber.interruption`: `{ reason, at, cause, tool }`, written
for every interruption that reaches the hub as `session.idle` with
`aborted: true` (`user`, `superseded`, `inactivity`; `cause` and `tool` are
null there, so the write replaces a restart record whole). `shutdown` never does, because OpenCode
resumes that turn. `at` is the arrival time, so it is at least the session's
`time.idle` for that turn; a later turn moves `time.idle` past it and the
record stops counting. The UI parser is `wasInterruptedByInactivity` in
`packages/ui/src/lib/questions/orphanedQuestions.ts`.

## A managed OpenCode restart

A restart of the managed OpenCode kills every running turn with reason
`shutdown`, which the hub drops, so nothing above records it. After the
restart, `recordRestartInterruptions({ sessionIds, cause })` writes on each
session `session-runtime.js` settled:

```jsonc
{ "reason": "opencode-restart", "at": 1760649461000,
  "cause": "memory-pressure",          // memory-pressure | health-timeout | process-exited | unknown
  "tool": { "name": "shell", "input": "sleep 600" } }   // or null
```

- `cause` comes from the lifecycle (`../opencode/cgroup-memory.js`).
- `tool` is the last tool call of the newest turn whose state is `running`,
  `streaming`, or `error` with `error.type: "aborted"`, read from the 30
  newest message records after the restart. `input` is the first of
  `command`, `filePath`, `path`, `url`, `pattern`, `query`, `description`,
  flattened and cut to 200 characters.
- Each session is read and written on its own (`updateMetadata`, decided at
  write time in the store's queue). A failed read records `tool: null`, a
  failed write is logged, and neither stops the other sessions or the toast.
- The record is cleared when the user sends the next message in the session
  or dismisses the notice: the UI deletes the key through the metadata route
  (`dismissRestartInterruption` in `packages/ui/src/sync/session-actions.ts`).
  Nothing resumes the turn on its own. The UI parser is
  `packages/ui/src/lib/sessionRestartInterruption.ts`; the notice is
  `SessionRestartInterruptionRow.tsx` above the composer.

## Priority sessions

`metadata.openchamber.priority = { at }`: the user marked the session as a
priority (the UI sets it through the metadata route and deletes the key to
clear it; `packages/ui/src/lib/sessionPriority.ts`). An absent key or any
other shape means an ordinary session.

## Automatic resume

Only priority sessions; every other session keeps the notice and Continue.
After `recordRestartInterruptions`, `index.js` hands its answer to
`autoResumeRuntime.resume`, which sends the agent one message saying what was
cut off, the cause, the time and the running command
(`buildResumeMessage`). Its progress is written on the restart record:

```jsonc
"resume": { "state": "waiting" | "sent" | "manual", "at": 1760649500000,
            "reason": "memory-timeout" | "memory-unreadable" | "send-failed" }  // manual only
```

Every step is decided in the metadata store's write queue against the record
as it is then:

- **Once per interruption.** A record is claimed (`waiting`) only while it
  has no `resume`, and marked `sent` before the message goes out. A new
  restart writes a new record with `resume: null`, and every other
  interruption record also carries `resume: null`, so an old state never
  carries over. A crash between `sent` and the send loses that one message
  rather than repeating it.
- **The user wins.** A message the user sends or Dismiss deletes the record;
  the priority switched off, or a newer restart, also stops the resume. Each
  is checked again right before `sent`.
- **Memory.** After a `memory-pressure` restart the messages wait, once for
  all sessions of that restart, until the cgroup is calm:
  `full avg60 < RESUME_MEMORY_CALM_FULL_AVG60` (2 percent) with the
  `high`/`max` counters unchanged since the previous read, polled every
  `RESUME_MEMORY_POLL_MS` (15 s). Past `RESUME_MEMORY_DEADLINE_MS` (10 min)
  the record becomes `manual` with `memory-timeout`; memory that cannot be
  read becomes `manual` with `memory-unreadable`. A server that stops while
  waiting leaves `waiting` behind; the UI reads a `waiting` older than 15
  minutes as `manual`.
- **A failed send** (OpenCode not answering within 15 s) becomes `manual`
  with `send-failed`; it is not retried.

The message is a plain prompt, so the session's own agent and model answer
it. The result of a job that finished during the restart is not in it yet:
that needs the execution queue (stage 2).

## Runtimes

- Web, desktop, hosted and Capacitor mobile: recorded, and priority
  sessions resumed, by this server.
- VS Code: the extension host runs no hub subscriber and owns its own
  OpenCode lifecycle, so nothing is recorded or resumed, and the priority
  mark only lists the session first; a question errored by
  inactivity stays an error there. The notice still renders for a record
  another server wrote, and Dismiss works through the metadata bridge.
- A turn interrupted while this server was not running has no record and is
  left as an error.

## Testing

`bunx vitest run server/lib/session-interruption` from `packages/web`.
