# System Stats Module Documentation

## Purpose
Reports resource usage of the machine this OpenChamber server runs on, for the "Machine" block and header status in the desktop instance menu.

## Entrypoints and structure
- `collect.js`: `createSystemStatsCollector({ os, fsPromises, process, diskPath? })` returns `{ collect() }`, a point-in-time sample. Dependencies are injected so tests can fake the host.
- `routes.js`: `registerSystemStatsRoutes(app, { collector, openchamberVersion, isOpenCodeRunning })` registers `GET /api/system/stats`.
- Wired from `../opencode/feature-routes-runtime.js`, after the `/api` auth gate.

## Contract
`GET /api/system/stats` requires the same auth as every other `/api` route (UI session, client bearer, or tunnel session). It is deliberately not part of the public `/health`: hostname, uptime and usage are not for anyone who can merely reach the server. Responses are `Cache-Control: no-store`; collection failure answers 500.

Fields that the host cannot report are `null`, never zero: `cpu.usagePercent` (no delta yet), `cpu.loadAverage` (Windows), `disk` (statfs failed), `process.cpuPercent` (first request).

The UI parser lives in `packages/ui/src/lib/serverMachineStats.ts`; keep both in step.

## Invariants
- **Memory** uses `/proc/meminfo` `MemAvailable` on Linux (`memory.source: 'available'`). `os.freemem()` counts page cache as used and makes a healthy box look full; it is only the fallback (`'free'`).
- **CPU** usage is a delta between readings. The collector keeps the previous reading; when it is missing or older than 60 s it takes a baseline and waits 250 ms, so the first request is slower. The UI ignores that request's round trip for its ping readout (`SERVER_CPU_BASELINE_MAX_AGE_MS` mirrors the 60 s).
- **Disk** is measured at the server user's home directory and matches `df`: `used / (used + available to unprivileged users)`.
- **Process CPU** is a share of the whole machine (all cores), on the same scale as host CPU.

## Clients
Only the Electron desktop instance menu polls this route (every 5 s while the menu is open, 30 s otherwise, paused while the window is hidden). Web, VS Code and mobile do not mount the menu. Older servers without the route answer 404, or forward it to OpenCode; the UI treats both as "not supported" until a valid sample arrives.
