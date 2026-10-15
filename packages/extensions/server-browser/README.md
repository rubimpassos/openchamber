# Server Browser (built-in)

Runs Chrome on the OpenChamber server so agents can browse with no client
open and a person can watch, take over, and hand back the same page. This
package is the service engine behind the `openchamber-builtin-server-browser`
built-in: `contributes.service` only, `provides: ["browser"]`,
`surface: true`. It ships no panel/page UI; the native Browser pane
(`packages/ui`) is the viewer.

Built and staged by `scripts/build-builtin-extensions.mjs` (see
`packages/extensions/registry.json`), the same path every built-in uses.
`service/main.js` is the Node-target ESM bundle Bun produces from
`src/main.js`; it is not committed, only built.

## Source

Adapted from the community extension
[`rubimpassos/openchamber-server-browser`](https://github.com/rubimpassos/openchamber-server-browser)
(branch `feat/phase1`, MIT), itself an extraction of OpenChamber's own
browser backend (upstream
[`JosueGalRe/openchamber-server-browser`](https://github.com/JosueGalRe/openchamber-server-browser),
OpenChamber PR #3425). See `NOTICE` and `LICENSE`.

The extension's panel/page UI (`panel.js`, `profiles-view.js`,
`inspector-page.js`, `panel/*`) was dropped: the native Browser pane and
Settings → Browser replace it. Everything under `src/` is the engine:
Chrome process and install management, the CDP client, the browser runtime
and its actions, the egress policy proxy, development-server discovery,
saved profiles, the inspector, and the shared-surface wire.

## What pages ask of the person

Headless Chrome has no window, so things a local browser would show the
person reach the Browser pane instead:

- **Dialogs** (`page-requests.js`). An `alert`, `confirm`, `prompt`, or
  "leave this page?" dialog pauses the page until it is answered. The tab
  keeps it in the dock state (`tabs[].dialog`), the pane draws it over the
  picture, and `POST /page/dialog` answers it. An agent action on that tab
  fails at once naming the dialog, an action that opens one ends as soon as
  it opens, and `browser.dialog` lets the agent answer.
- **File inputs** (`page-requests.js`). Chrome intercepts the chooser; the
  tab keeps it as `tabs[].fileChooser` with a folder of its own under
  `<project>/.openchamber/uploads/`. The pane uploads the person's files there
  through OpenChamber's file routes and `POST /page/file-chooser` hands them
  to the page, or cancels.
- **Downloads** (`downloads.js`). Chrome downloads into
  `<project>/.openchamber/downloads/.partial/` and a finished file moves next
  to it under the site's name, never replacing a file already there. The
  dock state lists them (`scopes[].downloads`), snapshots tell the agent the
  path, and the pane offers each finished one to save on the person's device.
  A browser with no project (signing into a profile) keeps downloads with the
  service's data and takes no uploads. Both folders get a `.gitignore` of
  `*`.
- **Sound** (`tab-audio.js`, `capture-guard.js`). Chrome runs with
  `--auto-accept-this-tab-capture`, so the service captures the sound of the
  tab in front from an isolated world of its own, encodes Opus with
  WebCodecs, and serves it on `GET /surface/audio` while a viewer has sound
  on. The same switch would let any page record its own tab without asking,
  so every page and frame target is attached paused, gets a
  `getDisplayMedia` that refuses before any of its scripts run, and only
  then resumes; a page Chrome refuses the guard for is closed. A new tab's
  guard is only confirmed once its first page arrives, so a slow one is
  waited for, not closed. Pages on insecure origins (plain `http` outside
  `localhost`) cannot be captured, so they send no sound.

## Configuration

There is no user-editable package directory for a built-in, so configuration
is read from, in order of increasing priority:

1. `${XDG_CONFIG_HOME:-~/.config}/openchamber-server-browser/config.json` —
   same file a folder install of the original extension used, so an existing
   one keeps working.
2. `<OPENCHAMBER_DATA_DIR>/server-browser.json`, when the host passes
   `OPENCHAMBER_DATA_DIR` to the service — instance-specific overrides, for a
   host that runs more than one OpenChamber instance on the box. Keys here
   win over (1).

Both files share `config.example.json`'s shape (`allowedOrigins`,
`allowedNetworks`, `discoverDevServers`, `projectDevServers`, `profileStore`,
`profileKeyFile`, `chromePath`). `projectDevServers` defaults to `true`;
`allowedOrigins`/`allowedNetworks` default to empty. Profiles, Chrome's
download, and the profile key still default under XDG data/config
directories (`${XDG_DATA_HOME:-~/.local/share}/openchamber-server-browser/`,
`${XDG_CONFIG_HOME:-~/.config}/openchamber-server-browser/profile.key`),
independent of `OPENCHAMBER_DATA_DIR`.

## Build and test

From the repository root:

```sh
bun run extensions:build
```

This package is not a Bun workspace member (see `packages/extensions/README.md`),
so most of its suites — the ones with no `@openchamber/sdk` import — run as
plain `node:test` files:

```sh
node scripts/run-isolated-tests.mjs packages/extensions/server-browser/test
```

Three suites import source that reaches into `@openchamber/sdk`
(`service.js`, `browser-runtime.js`, `tab-audio.js`): `service.test.js`,
`browser-integration.test.js`, and `tab-audio.test.js`. They are written in
`bun:test` style and run through `packages/web`'s Vitest, which already
aliases `@openchamber/sdk` to the SDK's TypeScript source
(`packages/web/vitest.config.ts`) the same way it does for every other server
suite that touches the SDK; that config lists these files explicitly, so they
are already part of `bun run --cwd packages/web test` (and therefore the root
`bun run test`):

```sh
bun run --cwd packages/web vitest run ../extensions/server-browser/test/service.test.js ../extensions/server-browser/test/browser-integration.test.js ../extensions/server-browser/test/tab-audio.test.js
```

`browser-integration.test.js` skips its Chrome-dependent cases when no
Chrome/Chromium binary is available; they ran against real Chrome during
this move (see the plan's QA notes). `chrome-install.test.js` and
`browser-manager.test.js` need no real Chrome and always run.
