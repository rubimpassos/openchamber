# Protected MCP module

Protected MCP lets the agent call MCP servers whose stored credentials it cannot
read. A separate service on a Linux host holds the credentials and runs the MCP
servers under its own Linux account, `openchamber-mcp`. The managed OpenCode
reaches them through a relay that carries MCP messages and nothing else. The
owner adds credentials and changes connections in OpenChamber Settings → MCP,
and the OpenChamber server carries those changes to the service over a private
Unix socket, `admin.sock`, that only root, the service account and members of
`openchamber-mcp-admins` can open.

This module delivers stage 1 of the design. The service has its own account,
while OpenChamber and OpenCode still share one, so the account that administers
is also the account the agent runs as. An agent acting on purpose can therefore
change these servers or capture a secret while it is typed; Known limits has the
details. Stage 2 runs OpenCode under a separate account and is not built.

## Ownership

- `service/` is the protected service. The installer copies it, with
  `../shared/guards.js`, into a root-owned install directory,
  `/usr/lib/openchamber-protected-mcp/<version>/`, and runs it as the service
  account. Files under `service/` import only Node built-ins, each other and
  that guards file, which they name `../../shared/guards.js`;
  `service/closure.test.js` enforces it. The service never loads code, packages
  or configuration from a location the engine can write.
- `service/admin-socket.js` is the service's only administration entry point,
  and the service process opens no TCP listener. `service/oauth.js`,
  `service/oauth-authorization.js` and `service/oauth-redirect.js` run OAuth
  sign-in inside the service.
- `service/relay.js` is the engine-side relay OpenCode starts for a protected
  connection. It holds no credential and is not a security component, because
  the engine can already open the engine socket directly.
- `routes.js`, `service-client.js`, `selections.js` and `selections-reader.js`
  run in the OpenChamber server, with the engine's authority. `routes.js` serves
  `/api/protected-mcp/*`. `service-client.js` reads redacted status from the
  engine socket and sends administration frames to the admin socket.
  `selections.js` stores which protected connections each project uses.
  `selections-reader.js` parses the selection files and builds the relay
  entries for them. Because `../opencode/mcp-local-plugin.js` serializes it into
  the managed OpenCode plugin, the reader takes every dependency as an argument.
- `../shared/oauth-callback.js` derives the request origin and renders the page
  the OAuth callback shows.
- `../opencode/core-routes.js` holds the callback's exemption from the session
  check, next to the guest OAuth callback's, and the common middleware's
  body-parser skip for `/api/protected-mcp/*`.
- `../opencode/mcp-local-plugin-runtime.js` turns selections into OpenCode MCP
  entries that start the relay. It owns live reconciliation for both ordinary
  personal entries and protected selections.

The OpenChamber server, the OpenCode engine and everything they start share one
authority, the engine, and one Linux account, the engine account. The service,
its workers, its state and its installed code form the protected side, and the
service and its workers run as the service account, `openchamber-mcp`. The
admin socket is the only way into protected administration, and OpenChamber's
session check, `requireApiAuth`, guards the routes that reach it.

## Words

- A **connection** is one approved MCP server on the service: an id of `pmcp_`
  and 16 hex digits, a name, a transport, a destination, declared secret slots,
  an optional OAuth setup and a tool policy.
- A **destination** is everything that decides where a credential goes and what
  runs with it: the command and arguments, every environment value, the URL,
  every header, and the OAuth settings, which are the scopes, the client ID, the
  client secret slot, the issuer and the fixed redirect address. Changing any of
  them, "Fixed redirect address" in Settings included, is a destination change,
  so invariant 5 applies and an OAuth connection needs a new sign-in after the
  save.
- A **selection** names a connection for OpenCode, for all projects or for one
  project. Selections hold an MCP name and a connection id, never a credential.
- **Call authority** is the right to open MCP sessions on approved connections.
  Every engine process has it through the engine socket's group,
  `openchamber-mcp-clients`.
- **Administrative authority** is the right to add or change connections,
  credentials, destinations and policies. It is membership of
  `openchamber-mcp-admins`, the group of the admin socket, and root and the
  service account hold it too. In stage 1 the member is the OpenChamber account,
  which is also the engine account, and OpenChamber gates its routes with its
  session check.
- A **sign-in** is one OAuth authorization of a connection. Its **attempt** is
  the handle Settings polls; its **state** is the single-use value the browser
  carries back.

## Invariants

1. No credential value leaves the protected side through the engine socket, the
   status answer, an error, a log line, an admin socket answer or a file the
   engine can read. Credential values reach only the worker or upstream request
   of their own connection.
2. The engine socket accepts exactly two first frames, `hello` for an MCP session
   and `status` for redacted status. Any other request is refused before
   anything else happens, so no administrative operation exists there.
3. A `hello` names a connection id and nothing else. The relay cannot choose a
   command, arguments, environment, URL, header or policy.
4. Only root, the service account and members of `openchamber-mcp-admins` can
   open the admin socket; the kernel enforces it through the socket's mode and
   its directory's. The OpenChamber server opens the socket only for requests
   that passed `requireApiAuth`, or for the OAuth callback, which a single-use
   state authorizes. Agent tool tokens, the engine socket's group and call
   authority grant nothing there. An update, an enable or disable, a
   revocation, a removal and a sign-in start each name the `expectedRevision`
   the caller was looking at, and the service refuses a stale one with
   `revision_conflict`.
5. A destination change discards the connection's stored credentials and its
   worker state, where token caches live. A change that keeps secret slots must
   supply their values again in the same request, or the service refuses it
   with `credential_rebind_required`. OAuth tokens never survive a destination
   change. At every start the service also compares the stored credential
   fingerprint with the definition and ignores a mismatch.
   An update to the same destination accepts slots whose values are missing.
   They stay unset, the view shows `set: false`, and a connection that needs
   those secrets stays `missing`. A typed value fills its slot. Creation still
   requires every slot, and a destination change still requires them all again.
6. Secrets never appear in command arguments, because `/proc/<pid>/cmdline` is
   readable by every local user. They reach a worker through its environment or
   through a file in a directory of its own session,
   `connections/<id>/secrets/session-*`, so another session of the same
   connection starting or ending never touches it. The service deletes that
   directory when the worker exits or fails to start, and deletes every leftover
   one when it starts, before any worker runs.
7. A stdio worker runs only an executable whose resolution only root or the
   service can change, or a package the service installed into its state
   directory. The check walks the path the way the kernel does, from `/`, one
   component at a time, following a symbolic link wherever it appears, in a
   directory component as much as in the last one. Every directory and link on
   that way must be owned by root or the service and writable by neither the
   engine account nor anyone else. An ACL that cannot be read refuses the path
   too. An absolute path among the worker's arguments, such as the script an
   interpreter runs, passes the same check. An argument path that does not
   exist passes only when every existing entry on its way passes, so the engine
   cannot create it between the check and the start. An argument path the
   service cannot resolve for any other reason is refused. The worker's
   environment is built from scratch.
8. An HTTP upstream is `https`, or plain `http` on a loopback address. The
   service follows no redirect, so a credential cannot reach another origin.
9. A connection the service cannot run with credentials, because a secret is
   missing, OAuth is not authorized, a refresh failed or its package runtime is
   not ready, still answers MCP with one tool, `authorization_required`, whose
   text says what the owner must do. A missing service, a missing socket or an
   unknown connection fails closed. The relay exits with a message, and OpenCode
   shows the server as failed. Nothing falls back to credentials inside the
   engine.
10. Status is `protected` only after the service's own checks pass: its installed
    code, configuration, state and worker executables are out of the engine's
    reach, and no root-equivalent socket or group is reachable by the engine
    account. A failed or impossible check makes it `unverified` or
    `unprotected`, never `protected`. A root-owned container socket is
    reachable when its mode bits or a named ACL entry let the engine connect.
    Checks that could not be done are unknown findings, and any of them makes
    the status `unverified` when no finding is an `error`. Examples are
    `socket_not_inspected` for a socket the service cannot stat for any reason
    except its absence, `acl_not_inspected` when the host has no `getfacl`,
    `acl_unreadable` when `getfacl` fails on a path, and `groups_unreadable`
    when the service cannot read `/etc/group`. Who can administer is a separate
    observation, `administration`, and never changes this status.
11. Selections decide which connections OpenCode starts and grant no access.
    Every engine process can call every approved connection through the engine
    socket, so projects are not isolated from each other.
12. An OAuth token write applies only to the grant it started from. The stored
    token object is the grant's identity. Every change replaces it and nothing
    modifies it, and a policy-only update or a new sign-in start keeps it. A
    refresh stores its answer only while the stored object is still the one the
    request used, and a refusal forgets the grant under the same condition. A
    new sign-in therefore wins even when the authorization server hands out the
    same refresh token again.

    The OAuth record also counts finished sign-ins in `generation`, and a
    sign-in captures that count when it starts. Starting writes nothing to the
    store. The pending entry, held in memory, carries the discovered server and
    the client, registered or configured. Completion writes server, client,
    tokens and the next `generation` together, and only while the connection's
    revision is the one the sign-in started with and `generation` is still the
    captured value. A revocation or a newer sign-in that lands while a request
    is on the wire therefore wins, and the service drops the late answer. A flow
    started from another origin cannot swap the client under an exchange in
    flight.
13. No route or answer carries a credential value. A secret travels once, from
    the body of a create or update request to the admin socket, and
    OpenChamber keeps no copy. Reads show each secret slot as
    `{ "set": true|false }`. Error texts never echo a credential value, a
    request body or a parser message. They can carry a name, a directory
    message or a field path: `name_in_use` from `PUT .../selections/:name`
    quotes the MCP name, `invalid_directory` passes on the directory resolver's
    message, and the service's validation messages name fields such as
    `stdio.env.<NAME>`. OpenChamber forwards the authorization code in a pasted
    address to the socket and neither keeps nor logs it.

## Topology on the host

| Path | Owner and mode | Holds |
| --- | --- | --- |
| `/usr/lib/openchamber-protected-mcp/<version>/` | `root:root`, `0755` dirs, `0644` files | Installed service code; `current` is a symlink to the active version |
| `/etc/openchamber/protected-mcp/service.json` | `root:root 0644` | Service configuration: identities, paths, both socket paths and their groups |
| `/etc/openchamber/protected-mcp/client.json` | `root:root 0644` | What OpenChamber needs to reach the service: the engine socket path, the admin socket path, the relay command |
| `/var/lib/openchamber-protected-mcp/` | `openchamber-mcp`, `0700` | Definitions, credentials, worker state, installed MCP packages, migration journals |
| `/run/openchamber-protected-mcp/` | `openchamber-mcp:openchamber-mcp-clients`, `0750` | Runtime directory; holds the engine socket `engine.sock`, `0660` |
| `/run/openchamber-protected-mcp-admin/` | `openchamber-mcp:openchamber-mcp-admins`, `0750` | Admin runtime directory; holds the admin socket `admin.sock`, `0660` |

The engine account is a member of `openchamber-mcp-clients`. In stage 1 the
installer also puts it in `openchamber-mcp-admins`. It is a member of nothing
else the service owns. The service runs as `openchamber-mcp` under the hardened
systemd unit the installer writes, with both groups as supplementary groups so
it can hand each socket to its group. The unit's `RuntimeDirectory` lists both
directories at mode `0750`.

`scripts/install.sh --protected-mcp` runs Node as root only after
`protected_mcp_trusted_path` accepts `/usr/bin/node` or `/usr/local/bin/node`.
It walks the path the way `integrity.js` does, and every directory and link on
the way must be owned by root and carry no group or other write bit. A named
ACL entry writes only through the ACL mask, which the group bits show, so the
same check covers ACLs. The installer it runs, `service/install.js`, checks
Node again with `integrity.js`, and the service's preflight checks the
installed tree at every start. The script unpacks the downloaded package in a
directory under `/var/cache` and removes that directory when it exits, however
it exits.

The installer asks for no password. It creates both groups, adds the engine
account to both, prints the boundary status, and says that in stage 1
OpenChamber administers through `openchamber-mcp-admins` as the engine account.
A reinstall with a different `--engine-user` removes the previous account from
both groups and reports the change. Existing processes keep their supplementary
groups until they exit, so stop the previous account's engine processes when
changing accounts.

`install.sh --protected-mcp-uninstall` runs the installed copy of
`service/install.js uninstall` with its other flags. It stops and disables the
unit and removes the unit file, the installed code, `client.json` and
`service.json`. The state, the `openchamber-mcp` account, both groups and the
engine account's memberships stay for a reinstall. With `--purge-state` it also
deletes the state directory, the `openchamber-mcp` account and both groups.
Given `--engine-user <account>` as well, it first takes that account out of
both groups. It ignores a failure to remove an account, a group or a
membership.

## Tool policy

The service enforces a connection's `policy` in the session, on every message,
so a change applies to running sessions without restarting them:

- With `allowTools`, only the tools it matches stay, and `denyTools` removes the
  tools it matches. A removed tool is missing from `tools/list`, and
  `tools/call` refuses it. A pattern ending in `*` matches a prefix.
- `defaultArguments` fills arguments the agent left out, only for tools whose
  input schema declares them, and never replaces one the agent gave. This
  carries dev-server's `MCP_DEFAULT_ARGS`, such as a Harness organization.

## Migration

`MIGRATION.md` is the cutover, step by step, with how to go back.

`service/dev-server-manifest.js` reads dev-server's non-secret workspace
catalog and, optionally, the broker list it renders, and writes a manifest.
With the broker list, a provider the service cannot take over yet becomes a
credential-free connection to its running loopback broker, which keeps its
credential and policy. Atlassian's group policy, AWS grants and Google
`workspace-mcp` are cases the service cannot take over yet. Such a provider
whose broker address is not plain `http` on `127.0.0.1` or `[::1]` is left out
and reported as `check`, and a provider with no running broker is left out and
reported as `skip`. Every other `check` is a provider migrated with a caveat.

`service/migrate.js` applies the manifest as root with the service stopped. It
reads credentials from the files the manifest names and writes them into
protected state. Each connection's journal entry goes from `pending` to
`created` to `done`. A rerun finishes every entry that is not `done`, state
files included, and reports it `resumed`. `migrate.js` refuses a manifest that
would change an existing connection's destination or policy, and `rollback`
removes exactly what the migration created.

A dry run reads the definitions with `readDefinitions` and opens no store, so
it takes no lock, creates no directory and deletes nothing. Run as root, the
command line gives the state tree back to its owner after a real run and leaves
it alone after a dry run.

## Engine socket

Frames are UTF-8 JSON, one per line, at most 16 MiB each.

- `{"type":"status"}` answers one redacted status object and closes.
- `{"type":"hello","protocol":1,"connection":"pmcp_..."}` answers
  `{"type":"ready","connection":"...","name":"..."}` and then carries raw MCP
  JSON-RPC messages in both directions, one per line, until either side closes.
- Anything else, including a malformed first line, answers
  `{"type":"error","code":"..."}` and closes. Codes: `unsupported_request`,
  `malformed_frame`, `protocol_mismatch`, `unknown_connection`,
  `connection_disabled`, `too_many_sessions`, `hello_timeout`.

When the service stops, it closes the listener, drops every socket that has not
finished its first frame, ends every session and destroys whatever is still open
after 2 seconds, so no client can hold the shutdown.

The status object holds the service version, the enforcement status with
finding codes, `administration`, which is `shared` or `separate`, and for each
connection its id, name, transport, enabled flag, revision, a destination
summary and a credential state. The destination summary is the URL origin and
path, or the executable's base name or package name. The credential state is
`none`, `stored`, `missing`, `authorized` or `authorization_required`. The
status holds no argument, environment value, header value, query string or
credential.

OpenChamber asks for this object with `readServiceState` in `service-client.js`,
which reads `client.json` on every call. `GET /api/protected-mcp/status`
reports the outcome as `service.state`: `available` with the status,
`not_installed` when `client.json` is missing, `invalid_client_config` for any
other failure to read or parse it, `permission_denied` when the kernel refuses
the socket, `unreachable` when the socket is absent, refuses or does not answer
within 2 seconds, `invalid_response` for an answer that does not match the
schema, and `unsupported_platform` on a host that is not Linux.

## Admin socket

`/run/openchamber-protected-mcp-admin/admin.sock` is a Unix socket, mode `0660`,
owned by `openchamber-mcp` with group `openchamber-mcp-admins`, in a directory
of its own. Connecting needs write permission on the socket and search
permission on the directory. The service account has both as the owner, members
of `openchamber-mcp-admins` have both through the group, and root passes every
permission check. The kernel refuses every other account with `EACCES` before
the service sees a byte. The service sets the mode and the group after it
starts listening.

The protocol is one request per connection:

- The client sends one JSON object on one line, at most 1 MiB, and the service
  answers one JSON line and closes. A client that sends no complete line within
  5 seconds gets `request_timeout`. A 17th simultaneous connection gets
  `too_many_requests` with status 503.
- A first line that is not a JSON object answers `malformed_frame`; an oversized
  one, `frame_too_large`; an unknown `type`, `unsupported_request`; a field of
  the wrong shape, `invalid_request`.
- A failure answers `{"type":"error","code","status","message"}`. The
  `status` is the HTTP status OpenChamber passes on. An unexpected exception
  answers `internal_error` with status 500 and logs only the error's name.

| Request | Answer | Does |
| --- | --- | --- |
| `{"type":"list"}` | `connections`: redacted `status` and every connection view | Reads |
| `{"type":"get","id"}` | `connection`: one view, or `connection_not_found` | Reads |
| `{"type":"apply","operation"}` | `applied`: the changed view, or `null` after a removal | Creates, updates, enables, disables or removes a connection, or revokes its credentials |
| `{"type":"oauth-start","id","expectedRevision","redirectUri"}` | `oauth-started`: `attempt` and `authorizationUrl` | Starts a sign-in |
| `{"type":"oauth-complete","state","code"?,"error"?}` | `oauth-completed`: `outcome` and the connection `name` | Finishes a sign-in |
| `{"type":"oauth-attempt","attempt"}` | `oauth-attempt`: `status` `pending`, `done` or `unknown`, and the `outcome` once done | Reports a sign-in |

A view is the definition with every secret slot as `{ "set": true|false }`, the
`id` and `revision`, and `editable`. `editable` is the definition without `id`
and `revision`, exactly what an update accepts, so fields shown only for
reading, such as a stdio connection's `runtime`, never travel back. No answer
holds a credential, a token or a registered client secret.

`apply` takes the operations the store defines: `create`, `update`,
`set-enabled`, `remove` and `revoke-credentials`. After `revoke-credentials` or
`remove` the service answers `applied` after the local change, then revokes the
upstream tokens in tracked background work. Shutdown waits for that work.
`store.apply` returns a private `{ connection, removedCredentials }` result.
The removed definition and credentials are captured inside the store queue,
including the tokens and static client secret, and only the redacted connection
view reaches the socket. Revocation uses that snapshot even if new credentials
are stored meanwhile. A network failure or non-2xx response logs
`oauth_revocation_failed` with codes and the connection id, never a credential,
and does not undo the local deletion. A store refusal
comes back under the store's own error code, such as
`credential_rebind_required` or `revision_conflict`.

On start the service removes a stale socket file. It refuses to start when
another service answers on the path or when something that is not a socket
occupies it. When the service stops, it ends open connections, destroys any
still open after 2 seconds, and waits for requests already accepted, so a write
in flight finishes before the store unlocks.

The OpenChamber side is `requestAdmin` in `service-client.js`. It reads
`client.json` on every call, sends one frame and validates the answer against a
schema. Because it reads the file every time, a reinstall needs no restart.
Failures reach the routes as:

| Cause | Status and code |
| --- | --- |
| `client.json` missing, invalid or unreadable for a reason other than permission, or the socket absent or refusing | 503 `service_unavailable` |
| The kernel refuses reading `client.json` or connecting to the socket (`EACCES`, `EPERM`) | 503 `service_permission_denied` |
| No answer within the request's timeout | 504 `service_timeout` |
| An answer that is not valid JSON, does not match the schema, exceeds 1 MiB, or no answer before the close | 502 `invalid_response` |
| An `error` frame | The frame's own status, code and message |

Ordinary requests have a 10 second timeout. OAuth start gets 80 seconds because
discovery can try 2 resource metadata addresses and 2 issuer metadata addresses,
then register a client, each with a 15 second network timeout. The remaining
5 seconds cover the socket exchange. Both pasted and browser completion get
20 seconds for one token exchange with a 15 second network timeout.

## Administration through OpenChamber

Settings → MCP lists protected connections in the main MCP list and edits them
on the same page as other servers. The page talks to these routes in
`routes.js`. Every route except the OAuth callback sits behind the session
check, `requireApiAuth`. On a host that is not Linux every route except the
status route answers 501 `unsupported_platform`, and with an external OpenCode
501 `external_opencode`. The status route answers 200 there, with
`host: { supported: false, reason }` naming the same reason.

| Route | Does |
| --- | --- |
| `GET /api/protected-mcp/status` | Redacted service state, the project's effective selections and their conflicts with ordinary entries |
| `PUT` and `DELETE /api/protected-mcp/selections/:name` | Set or remove a selection for all projects or one project |
| `GET /api/protected-mcp/connections/:id` | One connection view |
| `POST /api/protected-mcp/connections` | Create a connection from `{ definition, secrets?, use }` and select it |
| `PUT /api/protected-mcp/connections/:id` | Update with `expectedRevision`, `definition` and the secrets the change asks for again |
| `PUT /api/protected-mcp/connections/:id/enabled` | Enable or disable |
| `POST /api/protected-mcp/connections/:id/revoke` | Drop the stored credentials and tokens |
| `DELETE /api/protected-mcp/connections/:id` | Remove the connection and its selections |
| `POST /api/protected-mcp/connections/:id/oauth` | Start a sign-in; answers `attempt` and `authorizationUrl` |
| `GET /api/protected-mcp/oauth/attempts/:attempt` | Report the attempt |
| `POST /api/protected-mcp/oauth/complete` | Finish a sign-in from a pasted address |
| `GET /api/protected-mcp/oauth/callback` | The address the browser returns to; public |

Errors are `{ code, error }`. A route that needs a project answers 400
`project_required` without one, and a bad directory answers 400
`invalid_directory`.

**Request bodies.** The common request middleware skips the shared body parsers
for `/api/protected-mcp/*`, matched regardless of case. These routes parse only
JSON themselves, up to 1 MiB. Invalid JSON answers 400 `invalid_request` and an
oversized body 413 `body_too_large`, both with the fixed texts invariant 13
requires.

**Create.** The route refuses with 500 `ordinary_mcp_unreadable` when the
directory's ordinary MCP configuration cannot be read, with 409 `name_in_use`
when an ordinary entry has the name, and with 409 `selection_name_in_use` when a
selection has it. When the existing selections cannot be read it answers 500
`selections_unreadable` before it creates anything, so no connection exists
without a way to select it. After the service creates the connection, the route
writes the selection. If that write fails, the route removes the connection
again and answers 500 `selection_not_saved` with `connectionRemoved` saying
whether the rollback worked.

**Delete.** The route removes the connection and then every selection that points
at it, in the global file and in every project file. It answers `removed`,
`selectionsRemoved` and `selectionsNotUpdated`, the files it could not update.
A removal made elsewhere, such as `migrate.js rollback`, leaves selections that
still name the missing connection. DELETE treats the broker's 404
`connection_not_found` as already removed and still cleans those selections, so
the owner can retry safely. A failure to enumerate the selection directory is
reported as `mcp-protected` in `selectionsNotUpdated` with an empty
`selectionsRemoved` list. Local deletion stays successful and cleanup can be
retried after the filesystem problem is fixed.

**Sign-in.** `POST .../oauth` builds the redirect address from the request's
origin, `<origin>/api/protected-mcp/oauth/callback`, using
`x-forwarded-proto` and `x-forwarded-host` when present and the `Host` header
otherwise; a request without a host answers 400 `origin_unknown`. The service
discovers the authorization server, registers a client when the connection has
none configured, and returns the authorization URL. Settings opens that URL
with `openExternalUrl`, which uses the system browser on desktop, and polls the
attempt. A sign-in lasts 10 minutes. While Settings waits, it shows the authorization address in a
read-only field with "Open" and "Copy". "Open" runs from its own click so a
blocked automatic tab does not prevent sign-in. The service holds at most 16 pending
sign-ins, and a 17th evicts the oldest, whose attempt then reports
`oauth_state_invalid`.

A destination save, typed secrets, an enabled-state change, forgetting
credentials and a completed OAuth sign-in end the connection's live sessions.
After a destination or typed-secret save, enabling, forgetting or signing in,
Settings reconnects every name of that connection used in the current project
in OpenCode, disconnecting and then connecting. Other projects show the server
as failed until it is reconnected there, for example from the chat's MCP menu.
Tool policy changes keep live sessions and take effect on their next message.

**The public callback.** The browser that returns from the authorization server
carries no OpenChamber session, and the system browser on desktop never had
one. The callback is therefore exempt from the session check, for `GET` only.
The single-use state is enough, because:

- the state is 32 random bytes, valid for one use and for 10 minutes, and
  deleted when presented, whatever the outcome;
- the service ties it to the connection, its revision, its destination
  fingerprint and its `generation`, so a changed connection ends the flow with
  `oauth_connection_changed`;
- the PKCE verifier never leaves the service, so a stolen code cannot be
  exchanged without it;
- the callback reveals nothing but a fixed outcome text and the connection
  name, and the caller changes no state beyond finishing a sign-in the owner
  started.

An unknown or reused state answers `oauth_state_invalid`. The callback answers
locally with that same 400 page when state is not the canonical unpadded
base64url encoding of 32 bytes, before it opens an admin socket. At most
4 callback calls may wait on the broker at once. An additional call gets the
503 service-not-answering page without opening a socket, leaving room for
authenticated administration within the broker's 16 connection limit. The
slot is released on success or failure. The callback answers
an English HTML page with `Cache-Control: no-store`:

| Outcome | Status | Page text |
| --- | --- | --- |
| `authorized` | 200 | `Signed in to <name>. You can close this tab and return to OpenChamber.` |
| `oauth_denied` | 400 | The sign-in was cancelled. |
| `oauth_state_invalid` | 400 | This sign-in link has expired or was already used. Start the sign-in again in OpenChamber. |
| `oauth_connection_changed` | 409 | The server changed during the sign-in. Start the sign-in again in OpenChamber. |
| `oauth_exchange_failed` | 502 | The sign-in server did not accept the code. Start the sign-in again in OpenChamber. |
| The service does not answer | 503 | The protected MCP service is not answering. |

**The paste fallback and `redirectUri`.** When the tab that finishes the
sign-in cannot reach OpenChamber, `POST /api/protected-mcp/oauth/complete`
accepts the final address from the address bar as `{ address }` and sends its
`state`, `code` and `error` to the service. It answers `{ outcome, name }`, and
a failed sign-in is an outcome in that answer, with no error status. A
connection may also fix its return address with `http.oauth.redirectUri`,
"Fixed redirect address" in Settings, for a client registered with fixed
addresses. Like every OAuth setting, it is part of the destination. The service
then uses that address in place of the one derived from the origin. The browser
lands on it, so the sign-in ends with the paste fallback. The service accepts
only an `http` or `https` address of at most 2048 characters without
credentials or a fragment, and otherwise answers
`invalid_redirect_uri: http.oauth.redirectUri` for a definition error.

**Tunnel sessions.** The routes follow `requireApiAuth`. A request that arrives
through a tunnel needs a valid tunnel session, which can administer protected
MCP as it can use any other Settings page. A host with no UI password accepts
every request that reaches the server, as for every route behind that check.

**No agent tool action.** No agent tool action, CLI command or MCP tool
administers protected MCP. Changing protected MCP needs a request that passes
the session check.

**What `administration` means.** The status carries `administration: "shared"`
or `"separate"`. It answers one question: can the engine account open the admin
socket? The preflight reports `separate` only when the socket exists, the
engine account cannot connect by the owner, group and mode bits, and no named
ACL entry grants write access. A missing socket, a socket that cannot be
inspected and an ACL that cannot be read, including on a host without
`getfacl`, all give `shared`. The value adds no finding and never changes the
enforcement status. In stage 1 it is always `shared` on a real installation,
and Settings says that an agent acting on purpose could change these servers or
capture a secret while it is typed.

## Selections

`<dataDir>/mcp-protected/global.json` holds
`{ version: 1, servers: { <mcp name>: { connection, disabled? } } }`.
`<dataDir>/mcp-protected/project-<sha256(identity)>.json` holds the same plus
`identity`, the project identity personal MCP entries use, and a reader refuses
a project file whose `identity` differs. The MCP name need not be the
connection's own name: migrated selections keep the provider names projects
used before, such as `github` for the connection `precocerto-github`. A project
entry wins over a global one of the same name, and a disabled project entry
hides it. Protected selections win over ordinary MCP entries of the same name,
and the routes refuse a new selection whose name an ordinary entry already uses
in that directory.

Deleting a connection through the routes calls `removeConnection`, which walks
every selection file under a lock and drops each entry that names the
connection. A file it cannot read or write is reported and left as it was.

## Runtime surfaces

| Runtime | Behavior |
| --- | --- |
| Web server on Linux | Full support when the service is installed; otherwise `service.state` in the status says why, such as `not_installed`, `unreachable` or `permission_denied` |
| Electron desktop on Linux | Same backend as web. The sign-in opens in the system browser, and the callback reaches the address the app uses: the local server, or the SSH forward to a remote host |
| Phone, hosted mobile and Capacitor | Use the connected host's backend. The callback reaches OpenChamber through a tunnel or the LAN address; where it cannot, the owner pastes the final address |
| Electron, web server on macOS or Windows | Status says `unsupported_platform`; selections and administration are refused with 501 |
| VS Code | No protected connections, because the extension host runs its own local OpenCode. The webview answers `/api/protected-mcp/*` with 501 `unsupported_runtime`, so the MCP list shows no protected cards and the scope select hides the protected scope |
| External OpenCode | No selections, like personal MCP entries: OpenChamber cannot inject its plugin. Administration answers 501 `external_opencode` |

## Tests

- `service/*.test.js` and `routes.test.js` run the service over temporary state
  with synthetic credentials: admin socket authority and frames, relay, OAuth
  against local fixtures, installer in a temporary root, integrity,
  configuration, package runtimes with npm replaced by a recorder, and
  migration. Executables the integrity check must trust live under the
  repository's ignored `.tmp/`, because `/tmp` is world-writable.
- `test-support/admin-socket-client.js` is a one-frame client for the admin
  socket, with a 20 second bound, and the tests' only way to administer.
- `install-script.test.js` loads `scripts/install.sh` with
  `OPENCHAMBER_INSTALL_FUNCTIONS_ONLY=1`, which defines its functions without
  running the installer, and runs the trust check on real files, links and ACLs.
- `boundary.docker.live.test.js` is the proof between real Linux accounts. With
  `OPENCHAMBER_TEST_DOCKER=1` it runs the installer and the service in a
  disposable container with five accounts: an outsider, one in the clients group
  only, one in the admins group only, the engine account in both, and the
  service. A matrix shows each account reaching only the socket its group grants
  and getting `EACCES` everywhere else, with an allowed control for each. The
  proof checks the directory and socket owners and modes, and that the service
  holds no listening TCP socket. It probes reads, writes, process memory and the
  engine socket for administration frames. It creates a connection and a
  redirected destination over the admin socket, and searches everything the
  engine account could read for the credential. It then repeats with a
  protection removed to show the probes can fail, including one run that opens
  the admin socket to the outsider. The container has no systemd, so the unit's
  hardening is not part of it.
- `test-support/qa-service.js` starts a service with four synthetic connections
  for manual QA: `qa-stdio`, `qa-http`, `qa-migrated` (secret file, private
  state path, tool policy and default arguments) and `qa-oauth` (a local OAuth
  upstream). Point a development server at it with
  `OPENCHAMBER_PROTECTED_MCP_CLIENT_CONFIG=<root>/client.json`, and give that
  server its own `HOME` so its OpenCode does not attach to another one.

## Decisions

### Why a separate system identity and not encryption inside the engine

Encryption inside the engine needs a key the engine account can read, and then
every process running as that account can decrypt. File modes, masked fields
and a second process under the same user do not stop a shell that runs as that
user. A different user with its own state directory is the smallest boundary
the kernel enforces.

### Why administration moved to OpenChamber Settings

Administration has to work in a desktop app connected to a remote host and on a
phone, and protected servers belong in the same list as the other MCP servers.
Settings → MCP already reaches every runtime and already sits behind the session
check the owner relies on, so protected servers use its list and edit page.
What protects the credentials is the service, which holds them under its own
account and drops them when their destination changes. Administration can
therefore move into OpenChamber without giving anyone a way to read a stored
credential. The cost is stage 1's limit. Until the accounts are separate,
whoever runs as the engine account can also administer.

### Why a Unix socket and not HTTP

An HTTP listener needs a password, sessions, a request-origin check and a rule
for enterprise mode about listening addresses. A Unix socket takes its
authority from the kernel's file permissions. The check is group membership,
enforced before any service code runs, and no listening address exists for
enterprise policy to gate. A second socket, in its own directory with its own
group, lets stage 2 grant it to a different account without touching the engine
socket.

### Why the OAuth callback needs no session

The browser that returns from the authorization server is often not the one
that holds the owner's OpenChamber session. On desktop it is the system browser,
and the sign-in can also finish on another device. The guest OAuth callback
already works this way. The state is unguessable, single use, short-lived and
bound to the connection and its revision, and the PKCE verifier stays in the
service, so the state alone authorizes the callback, once. A session check would
only break desktop sign-in.

### Why the public callback has its own capacity limit

Anonymous callbacks can hold admin sockets during a token exchange. Checking
the exact issued state shape before connecting and allowing 4 exchanges at
once leaves capacity for authenticated requests within the service's limit
of 16 sockets. A syntactically valid state still needs the service's single-use
state check to authorize anything.

### Why OAuth requests have longer admin timeouts

The default 10 second socket timeout is shorter than one allowed OAuth network
request. Start can make 5 sequential requests and completion can make 1, so the
routes allow their full network budgets plus 5 seconds. Ordinary administration
keeps its existing timeout.

### Why one socket with two frame types and not separate status and call sockets

Both need the same group permission. One listener keeps the installed layout and
the client configuration smaller; the refusal of every other frame type keeps
administration off it.

### Why the relay is not protected code

The relay holds nothing the engine could not get by connecting to the socket
itself, so its integrity protects nothing. It ships with the service only so
its protocol version matches.

### Why a destination change drops credentials and not only asks for approval

A form can hide a changed URL or environment value from the person saving it.
Dropping the stored credentials makes a redirected credential impossible
without the owner typing it again for the new destination, and Settings lists
the secrets it will ask for before it saves.

### Why missing secrets do not block updates to the same destination

Forgetting credentials leaves the connection editable, including tools
autosave. Requiring those credentials on a policy update prevents that edit
without strengthening destination binding. The store accepts missing slots
only while the destination stays unchanged; creation and destination changes
still require every value.

### Why deletion does not wait for upstream revocation

The local deletion is authoritative and can finish before 2 upstream revocation
requests, each bounded at 15 seconds. Waiting would let the 10 second admin
client timeout hide a successful deletion and skip selection cleanup.
Background revocation keeps the removed credentials' own client authentication,
and shutdown waits for it before releasing the store.

### Why the protected routes parse their own bodies

The shared parser's error messages can quote the body, and a body here may hold
a secret. The routes run one parser of their own, whose failures become fixed
codes, and the common middleware skips `/api/protected-mcp/*` so that this
parser is the only one. The skip ignores letter case because Express matches
routes that way, and a path in another case would otherwise reach the shared
parser.

### Why the service duplicates no guards

It imports `../../shared/guards.js`, and the installer copies that file into the
installed tree at the same relative path, so the installed tree has the same
layout as the repository.

## Known limits

- Stage 1 shares one account. An agent acting on purpose reaches administration
  through it. It can open the admin socket, and it can read what OpenChamber
  holds, including `jwt-secret`, with which it can mint a session. It can then
  change these servers or add one that sends a credential somewhere the owner
  did not intend. Settings says so while `administration` is `shared`. What
  stage 1 protects is credentials an agent could read by accident, in files and
  environments.
- A secret typed into the Browser Panel, or into any browser the agent can
  operate, is within the agent's reach while it is typed.
- Every MCP server runs as the service account. An implementation is trusted
  with its own credential and can send it anywhere, and a hostile one can read
  the other connections' credentials. Approve only implementations you trust.
  One account per connection comes later.
- Each sign-in that registers its client on the fly registers a new one, and the
  service keeps it only when the sign-in succeeds. Abandoned sign-ins leave
  registrations at the authorization server.
- A tool result can carry sensitive data. Protection covers authentication
  secrets only, and what the tools return reaches the agent.
- When the engine account is also the human's administrator account, the agent
  can tamper with its shell startup files and catch a later `sudo`. Use a
  separate account for privileged administration.
- Root, and anything root-equivalent, can read everything. The checks cover the
  sockets and groups they know, and they do not detect an unauthenticated
  container daemon on TCP.
- Only root and the upstream's own account can read plain `http` to a loopback
  upstream.
- Every OpenCode location that uses a protected connection runs its own relay,
  a Node process of about 50 MB, and every stdio session runs its own worker
  in the service. A connection selected for all projects therefore costs one
  relay per open location, and the service accepts 64 sessions at a time.
- A connection that bridges to a dev-server loopback broker sends no credential;
  the broker's own account keeps it. The engine can reach that broker directly,
  as it could before, so a bridge adds no exposure and no protection beyond what
  the broker gives.
- `dev-server-manifest.js` reads a catalog in the engine account's home, so in
  stage 1 an agent acting on purpose can change the paths, arguments and
  environment values that `migrate.js` then binds to real credentials, while
  URL origins and executables are fixed in the code; MIGRATION.md has root read
  every destination in the manifest before applying it.
- The unit's systemd hardening, such as `NoNewPrivileges` and
  `ProtectSystem=strict`, is written and tested as text. The proof between
  accounts runs without systemd and does not exercise it.
