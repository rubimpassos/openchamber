# Built-in extension ownership

## Source and build

- `registry.json` is the app-owned allowlist. IDs use the reserved `openchamber-builtin-` prefix and remain stable across releases.
- Each package uses the ordinary SDK manifest and public SDK APIs. Built-in status does not expose private stores, credentials, or native bridges to its iframe.
- `scripts/build-builtin-extensions.mjs` copies only declared files, bundles declared entries, stamps the app version, and validates the staged output before replacing the previous complete bundle. Browser output is a self-contained IIFE. Node service output is ESM.
- A Node service declaring `ws` bundles the web host's installed Node implementation. These packages are not workspaces, so their declarations alone create no dependency links; Bun's built-in `ws` shim is not a portable Node dependency. The staged service runs without a sibling `node_modules`.
- Panel translations live with the package and use `HostReadyContext.locale`. They cannot consume the host React i18n context across the iframe boundary. Keep all 12 host locales covered.
- That all-locales rule binds the built-ins here only. An external extension keeps its own dictionaries, reads the app language from `HostReadyContext.locale` in frames and `query.locale` on a status source, and may ship any subset: untranslated text falls back to English, so a contribution of one language is accepted. The SDK has no translation mechanism and needs none. Either way, `zh-TW` never gets simplified strings, keys are semantic, and names, file names and log text stay verbatim.
- `packages/web/server/built-in-extensions/` is generated app code, not user data. Web builds, web prepack and root postinstall prepare it. Packaged Electron keeps it in `app.asar.unpacked/node_modules/@openchamber/web/server/built-in-extensions` and supplies that physical root to the in-process backend.

## Runtime authority

- `server/lib/guests/builtins.js` parses the registry; `catalog.js` binds it to an instance's persistence path during server startup. HTTP requests and extension manifests cannot change that binding.
- Only packages reached through that registry, with a matching ID and a canonical directory inside its root, become `source: 'bundled'`. An invalid individual package is skipped without blocking valid packages; a missing or invalid registry is a startup/build failure.
- The server derives grants from the built-in's current declarations. Keep normal capability, path, credential-target and enabled-state checks. Automatic approval is not unrestricted authority.
- User installs cannot use the reserved namespace, even with `replace`. Built-ins cannot be removed, Git-updated or have their grants edited through the public API.
- `disabledGuests` persists the user's decision independently of code paths and versions. Provider credentials and extension storage stay in the instance data directory. Disable stops services and API access while retaining data and credentials.
- A built-in may take a service role (`provides: ["browser"]` or `["source-control"]`) under the same rules as a user install: the same manifest contribution, the same host-derived provider id (`ext-<id>`, so the id must be at most 28 characters, which leaves eight after the `openchamber-builtin-` prefix), the same outbound proxy and host-owned accounts, and Disable withdraws the provider while keeping its accounts. Built-in status grants nothing beyond what the role grants any extension. A Git host the app should own outright (device flow, uploads, review threads, creating changes by push) belongs in core as a provider module instead (`packages/web/server/lib/source-control/DOCUMENTATION.md`).
- Settings puts enabled built-in token/OAuth cards inside Built-in integrations. Other extension accounts stay in their existing section.
- Built-ins render wherever user extensions do: web, Electron and the mobile shell, direct or relay, with the phone's per-surface rules (`packages/sdk/DOCUMENTATION.md`, *On the phone*). VS Code keeps the existing explicit unsupported behavior. Migrate an existing core feature only after deciding its behavior on every surface where it already exists.

## Server Browser presentation

The browser manager owns `state.viewId`, null without a selected scope and a
fresh UUID whenever the selected scope, active tab or runtime surface identity
changes. Returning to a previous view and restarting the manager create fresh
identities. Each capture binds to the identity before awaiting its engine;
changed identities discard that capture, and cached images retain their own
identity. The service sends it as the SDK's `SURFACE_VIEW_ID_HEADER`.

Remote Chrome uses the fonts available to its service process. On Linux,
Fontconfig must have a font covering the page's script, including a CJK font
for Japanese text. Correct Unicode delivery can still render missing-glyph
boxes when the host lacks that coverage; inspect the remote bitmap as well as
the field value.

### Why presentation identity is separate from generation and frame sequence

Generation still guards dock commands, and service frame sequences still reject
commands made on an earlier picture. HTTP selection and WebSocket presentation
complete independently, so the UI also needs an identity the host can confirm
after processing the exact picture's successful ACK. A reusable scope/tab key
or a frame captured before a switch cannot authorize the returned view.

## Adding a package

1. Add its SDK manifest and source under this directory.
2. Add an ID/directory entry to `registry.json`, with explicit files and build entries.
3. Add source type-check/lint coverage to the root checks when introducing executable package source. Run the build command in the README and the focused build/catalog/route tests.
4. Check Enable/Disable, retained data, automatic grants, and account placement. A newly requested capability should appear in the server's granted set without an approval dialog.
5. Verify the web tarball includes the registry and built files. Native services also need the unpacked Electron resource path.
