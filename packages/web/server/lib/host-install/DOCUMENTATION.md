# Host install module

The host install puts OpenChamber on a Linux host with systemd as a system
service, from one root command:

```bash
curl -fsSL https://raw.githubusercontent.com/rubimpassos/openchamber/main/scripts/install.sh \
  | sudo bash -s -- --host --owner <account> [--port 3000] [--host 127.0.0.1] [--repo owner/name]
```

After it, OpenChamber runs as `<account>` from root-owned code, the protected
MCP service runs under its own account, and a root updater installs new
releases daily or when OpenChamber asks. Nothing else on the host has to
configure it.

## Ownership

- `host.js` runs as root. It installs, updates, rolls back and removes the
  host install, writes the units, installs OpenCode for the owner when the
  owner has none, and installs the protected MCP service through
  `../protected-mcp/service/install.js`.
- `release.js` finds a release's web package on GitHub and downloads it,
  checked against the SHA-256 digest GitHub records for the asset.
- `main.js` is the command line `scripts/install.sh --host` and the updater
  unit run.
- `managed.js` runs as the owner, in the server and the CLI. It tells whether
  this copy is the host install and asks the root updater for an update.
- `scripts/install.sh --host` bootstraps a host with no OpenChamber: it
  downloads and verifies the package, unpacks it as root and hands it to
  `main.js install`.

## Layout

| Path | Owner, mode | What it is |
| --- | --- | --- |
| `/usr/lib/openchamber/<version>-<random>/node_modules/@openchamber/web` | `root:root`, `0755`/`0644` | Installed package; `current` and `previous` link to these directories |
| `/etc/openchamber/host.json` | `root:root 0644` | Owner, repository, port, host, auto-update and protected MCP choices, and `skipVersion` after a rollback |
| `/etc/openchamber/openchamber.env` | `root:root 0600` | Environment for OpenChamber, such as `OPENCHAMBER_UI_PASSWORD` |
| `/var/lib/openchamber-host/requests/` | owner, `0700` | Where OpenChamber drops the empty `update` request file |
| `/etc/systemd/system/openchamber.service` | `root:root 0644` | Runs OpenChamber as the owner |
| `openchamber-updater.service`, `.timer`, `.path` | `root:root 0644` | The updater, its daily timer and the request trigger |
| `/usr/local/bin/openchamber` | link | The installed CLI, unless that name was already taken |

## Invariants

1. The owner account cannot change any code root runs or any code OpenChamber
   runs. Every installed file belongs to root with no group or other write
   bit, and the installer refuses a Node.js or npm the owner can replace.
2. The owner can only ask for an update. The request file carries no content;
   the updater reads the repository from `host.json`, which only root writes,
   and installs only a web package whose digest matches the one GitHub
   records. Its dependencies come from the npm registry unpinned, so npm runs
   with `--ignore-scripts` and no dependency runs code as root. node-pty and
   ripgrep ship their Linux x64 and arm64 binaries inside their packages.
3. OpenChamber never runs as root. `--owner root` is refused.
4. A unit file without the installer's marker line belongs to someone else and
   is never replaced or removed. Settings of the person running the host go
   in drop-ins, which updates keep.
5. Every install goes into a new directory, so the running server's files are
   never replaced under it, also when the same version is installed again.
   `current` moves only after the new version is installed, carries a host
   updater, passes the integrity check and has OpenCode available. When a later
   step throws, or the restarted OpenChamber does not report the new version on
   `/health` within 90 seconds, `current` and `previous` go back to what they
   were, the protected MCP service is reinstalled from the version that ran
   before, that version restarts, and `skipVersion` holds the failed one back.
6. A rollback, automatic or by `main.js rollback`, records the version it left
   in `skipVersion`. The updater does not install that version again; an
   explicit `install` or `update --tarball` clears the hold.
7. The update check of a host install reads the stable channel only, because
   the updater installs the repository's latest release. A Canary pick in
   Settings is not offered there.
8. The protected MCP service is installed before OpenChamber restarts, so the
   new OpenChamber process gets the service's groups. A host the service
   refuses still gets OpenChamber; the result and exit code 2 report it.
9. An update request is consumed before the updater works, so a failing
   update does not run again until the next request or timer. The path unit
   watches with `PathChanged=`, so a request file the owner turned into a
   directory cannot keep restarting the updater.
10. Root never deletes recursively inside the request directory. Uninstall
   first takes it from the owner, then removes the entries it knows.
11. OpenCode is installed by `../opencode/v2-install.js` running as the owner
   through `runuser`, so root never runs a binary the owner can write.

## Decisions

### Why a root updater and not a root OpenChamber server

The HTTP server, its routes, extensions and the agent it starts would all run
as root, and any defect in one of them would be root on the host. The updater
is a short oneshot that reads nothing the owner wrote, so it is the only code
that needs root.

### Why a request file and not a socket or sudo rule

A path unit is enough to start a oneshot, needs no listener and no password,
and the empty file gives the owner nothing to choose. A sudo rule would also
be blocked by `NoNewPrivileges=yes` on OpenChamber's own unit.

### Why GitHub's recorded asset digest and not a signature

GitHub records a SHA-256 digest for every release asset, and both the bootstrap
script and the updater check it. This trusts whoever can publish releases in
the configured repository. A signature with a key pinned at install time would
also survive a compromised GitHub account; it is not built yet.

### Why npm installs the package under root

The web package needs its dependencies and node-pty's native build. Running
npm from a root-owned Node.js into a staging directory, with an empty user
config and a root-only cache, keeps the result root-owned and leaves the
owner's npm configuration out of it.

### Why npm skips install scripts and not a lockfile

A lockfile in the release would pin every dependency, but the web package does
not ship one, and adding it changes the release pipeline. Skipping install
scripts keeps unverified dependency code from running as root today; the
dependencies are still resolved at install time, so two installs of one
version can differ. A shrinkwrap in the release would close that.

### Why releases without a host updater are refused

A release published before this module would replace `current` with code
that has no `main.js`. The updater unit would then fail on every run and the
host could not update again without a person.
