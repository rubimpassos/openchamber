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

- `runtime.js` — `createSessionInterruptionRuntime({ persistMetadata })`,
  fed by the global hub subscriber in `server/index.js`.

## State

`metadata.openchamber.interruption`: `{ reason, at }`, written for every
interruption that reaches the hub as `session.idle` with `aborted: true`
(`user`, `superseded`, `inactivity`). `shutdown` never does, because OpenCode
resumes that turn. `at` is the arrival time, so it is at least the session's
`time.idle` for that turn; a later turn moves `time.idle` past it and the
record stops counting. The UI parser is `wasInterruptedByInactivity` in
`packages/ui/src/lib/questions/orphanedQuestions.ts`.

## Runtimes

- Web, desktop, hosted and Capacitor mobile: recorded by this server.
- VS Code: the extension host runs no hub subscriber, so nothing is recorded
  and a question errored by inactivity stays an error there.
- A turn interrupted while this server was not running has no record and is
  left as an error.

## Testing

`bunx vitest run server/lib/session-interruption` from `packages/web`.
