# Coordinator state and input contracts

## Ownership

This directory owns stage progression, merge admission, service dispatch,
checkout and closure, feedback, item controls, tool handling, input parsing and
the local project queue. The parent `runtime.ts` composes those owners and keeps
project pumping, admission, config reconciliation, queries and lifecycle.
The shared context retains the same injected owners and mutable lifecycle
references; factories form an acyclic dependency chain. The item store owns
revisions, effect settlement and transition validation; the execution store
owns immutable JSON recovery requests.

## Invariants

- Input schemas retain the coordinator's existing limits, strict objects,
  defaults and nullable fields. A pending tool's operation selects its input
  schema. Parsing never grants dispatch authority.
- Item mutation commits through the real store before indexing sessions,
  synchronizing attention and publishing the item event, in that order.
  Attention failure leaves the committed item intact and prevents publication.
- A transition removes the waiting projection outside human-wait states.
  Store validation remains authoritative for allowed transitions.
- Local project operations enter the file lock in arrival order. A failed
  operation rejects its caller and releases the local queue for its successor.
  Queue settlement ends at lock release; dirty repumping remains outside it.
- Schema-derived types describe parsed values. They do not make arbitrary
  execution-journal JSON into a stage run, question record or service request.
- Historical run views can omit invocation-only fields. A read of history must
  not synthesize a prompt, selection or token baseline to satisfy a live-stage
  type. Token accounting parses the captured baseline only when it is used.

## Decisions

### Why pending tools enumerate their operation schemas

The union pairs each operation with its existing service input schema. Mapping
over an operation array loses that relationship in TypeScript and would allow
an input for a different operation after narrowing. Runtime defaults and
accepted inputs remain unchanged.

### Why state mutation retains the existing callback contract

The coordinator and publication owner both mutate complete store items through
the same callback. Retaining that contract preserves store validation and the
post-commit attention and event ordering without another state representation.

### Why captured requests remain separate from decoded views

Schema parsing can insert defaults added after an older run was captured.
Effects receive the original request JSON for digest verification and replay,
while coordinator reads use decoded views. Allocating another run merges into
the raw journal map, preserving every previous capture. Item detail also returns
the retained reports and snapshot from the raw journal, without rewriting
historical reports through the current stage parser.

The legacy-recovery tests seed captures without a subsequently added config
default, context or idle cursor. They exercise restart receipt replay and
explicit-resume allocation against the real item store, execution journal and
effect engine. An absent idle cursor retains timestamp-based outcome selection.

Retained placement and shutdown records can also omit selection, prompt and
token baselines. Journal reads preserve those omissions. Token accounting
requires its baseline only when charging usage. Dispatch callbacks decode their
execution inputs only when the effect engine admits execution. Isolated create
consumes a complete selection; host create consumes neither selection nor prompt.
Receipt replay and outcome reads never require a replacement prompt or model.
Isolated Resume requires the selected provider when restoring its captured
grant; host Resume uses neither prompt nor selection.

Run selection is retained JSON, including separated config fields such as
`useDefaults`. Capture uses the existing JSON serialization semantics to omit
undefined fields. The stage owner decodes a provider for isolated creation or
Resume and a complete model for dispatch; journal reads add no model validation.

### Why removed-definition recovery retains a minimal bot

The coordinator recovers removed definitions with only
`{ id, enabled: false }`. Stop and revocation retain the captured requests and
bindings; they cannot invent a replacement enabled definition. Stage shutdown
accepts the existing optional isolation flag, and PR-watch shutdown needs only
the bot ID. Fresh stage or identity selection still requires a configured bot.

### Why the coordinator decodes only the service authority it consumes

The coordinator consumes service, identity ID, identity revision and destination
to retain effect authority. Remaining prepared fields stay in the private
descriptor and reach the service owner unchanged. The service owner validates
credential fields. Requiring those fields in the coordinator would reject
previously accepted injected adapters and recovery fixtures.

The service entry points accept JSON at their existing full-effect parser
boundary. This keeps credential validation in the service owner without
requiring the coordinator to add credential defaults or validate an injected
adapter's private fields. Effect recovery accepts only a reconciler; a prepared
effect remains unclaimed until the ordinary execution path admits it.

Stage methods currently share a request type requiring invocation-only fields.
That type does not yet express the accepted historical run projections. Each
method needs its consumed fields defined by the stage owner; the coordinator
cannot backfill those fields while preserving captured requests.
