# Delegated integration control

## Ownership

This module owns the restricted integration HTTP endpoint, wire V1 schemas,
read-only credential policy and delegated project/session authorization. Native
session dispatch stays with `openchamber-control` and `openchamber-sessions`.

## Invariants

- Policy is read and validated on every request. Missing, invalid, disabled,
  expired or revoked credentials grant no access. Tokens never reach logs.
- Each action requires its credential grant. Project paths are canonicalized
  afresh, and session ownership comes from persisted session metadata.
- Recognized worktree directories survive native dispatch. Wire `projectId`
  is removed from native input because it would override that directory.
- Request schemas reject extra keys. Responses expose only contracted fields,
  fixed public errors and valid partial-result identifiers.
- Integration credentials cannot authorize common HTTP routes or WebSocket
  upgrades, including when a valid UI cookie accompanies the request.
- Disconnect cancellation, raw-body limits and metadata-only auditing apply
  before native dispatch completes.

## Decisions

### Why schemas define the checked wire types

TypeScript types are inferred from the existing Zod schemas. Explicit variant
tuples preserve action/input correlation without weakening runtime validation.
The `.js` import specifiers remain valid for emitted server modules.

### Why defensive runtime guards remain

Policy files, request bytes and native control failures can be malformed at
runtime. Type checking does not replace fail-closed handling or response
serialization validation.

### Why the native failure fixture keeps its filename

The adjacent Hermes repository imports `native-failure-fixture.js` by its
exact filesystem path using plain Node. The source-only entry registers the
existing source resolver before loading `native-failure.fixture.js`, which
exercises the same routes as the in-repo tests. The server gate classifies
only that exact entry as test support; neither file ships in the server build.
