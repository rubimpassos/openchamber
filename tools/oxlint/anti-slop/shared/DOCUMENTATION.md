# Anti-slop boundary recognition

## Ownership

This folder owns AST evidence shared by anti-slop rules. Rule reporting and severity belong to the rules and lint configuration. Server boundary regression probes run real oxlint in `packages/web/scripts/server-types-lint.test.mjs`.

## Invariants

- Schema consumption exempts one plain `unknown` parameter binding only when its sole reference reads it directly into `schema.safeParse` in the same function. Reading that function's `arguments` also prevents the exemption because it can expose the raw parameter.
- The schema binding is a local immutable `const` initialized by the imported Zod `z.object` constructor, optionally chained through `strict`. Its other runtime references may only call `safeParse`.
- Namespace resolution follows lexical bindings and checks equivalent Zod imports together. Fake imports, shadowed bindings, writes, forwarded namespaces or schemas, exported schemas, and visible prototype extraction do not establish parsing evidence. Unknown object fields remain valid boundary data for subsequent parsing.
- Captures, deferred class-field reads, and direct `eval` prevent exclusive-consumption proof. Analysis is local to the linted module and trusts the installed Zod implementation; it does not trace mutation through other modules.
- Shared-folder parser and type-guard exceptions remain independent. Schema consumption does not change `no-runtime-typeof`.

## Decisions

### Why schema consumption requires binding evidence

An annotation alone cannot distinguish an unparsed helper from an I/O parser. A method named `safeParse` alone can belong to a fake object. Exclusive raw-input consumption and resolved Zod construction establish the narrow exception without a filename allowlist or hidden domain-type alias.

### Why only object construction and strict chains qualify

These constructors establish an object boundary without retaining arbitrary root data. Accepting arbitrary Zod chains would also accept passthrough schemas and transforms that return raw input.

A generic `Schema extends z.ZodType` parameter provides no constructor evidence and includes `z.unknown()`. It remains outside this exception even when its `safeParse` call consumes the input once.
