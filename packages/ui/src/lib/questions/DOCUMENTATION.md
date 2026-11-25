# Interrupted native questions

## Ownership

This module reconstructs the latest native `question` tool request after its live form is lost. Sync owns live forms, status and transcript loading; the server's session-interruption module owns persisted restart and inactivity evidence. `answerOrphanedQuestion` rechecks live forms before replying or sending a synthetic answer that resumes the session.

## Invariants

- Recovery waits for completed directory bootstrap and authoritative idle status. A pending or failed form-list read cannot establish that a live form is absent.
- Only the latest content message can supply a question. Later user messages or synthetic answers retire that candidate.
- A running or pending legacy question can recover without recorded cause. An errored question requires interruption evidence and an interruption error.
- Explicit dismissal, deferred answers and unrelated tool errors override stale interruption metadata. Completed questions never recover.
- The original tool-call identity matches live forms; synthetic orphan IDs are never sent to `form.reply`.
- A failed authoritative form-list recheck aborts submission without sending a synthetic answer.

## Decisions

### Why recovery waits for complete bootstrap

Status and live forms load independently. An idle status arriving first does not prove the form list is empty, so recovery waits for the existing bootstrap completion boundary rather than adding another readiness store.

### Why error classification is shared

The live recovery owner already distinguishes interruption, dismissal and deferral. Reusing that classification keeps persisted recovery from reviving a question whose tool result records an explicit closure.
