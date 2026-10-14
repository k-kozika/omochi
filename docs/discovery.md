# Discovery and dashboards

[Overview](../README.md) · [Architecture](architecture.md) · [CLI reference](../packages/cli/README.md)

The **hub** is a dashboard application: it combines live views from apps on one or
more machines. The development server remains a separate single-app preview.

| Part | Responsibility |
| --- | --- |
| app | Owns state and actions; publishes one or more A2UI surfaces. |
| gateway | Discovers and connects to the running apps for a user on one machine. |
| hub backend | Aggregates gateways, routes actions, stores dashboards, and serves the hub UI. |
| hub UI | Lets users compose surfaces into named dashboards. |
| renderer | Shared A2UI connection, state processing, and React surface rendering. |
| dev server | Previews an app through the stdio bridge or another A2UI endpoint. |

See the [architecture diagrams](architecture.md) for process boundaries and transports.

A dashboard panel references one **surface**, not an arbitrary component inside a
surface. Publish a small widget as its own surface when it should be independently
placeable. The gateway discovers apps; it does not launch them.

An application publishes itself on a unix domain socket and advertises it next to that
socket; the gateway discovers those advertisements and connects to each service.

```text
$XDG_RUNTIME_DIR/omochi/<serviceId>/manifest.json   {"name": "Mic", "icon": "🎤", "socket": "a2ui.sock"}
$XDG_RUNTIME_DIR/omochi/<serviceId>/a2ui.sock       A2UI v0.9 JSONL
$XDG_RUNTIME_DIR/omochi/gateway.sock                the gateway itself
```

When `XDG_RUNTIME_DIR` is unset, the registry falls back to
`<system temporary directory>/omochi-<uid>/omochi`. All participating processes
must use the same runtime directory and user.

`serviceId` is the directory name and must match `[A-Za-z0-9._-]{1,64}`; `.` and `..` are
rejected. `socket` must be a plain file name inside the service directory, and `icon` is
an emoji or a `data:image/...;base64,` URL, so a renderer never reads files out of the
runtime directory. Unknown manifest keys are ignored. The manifest is written only after
the socket accepts connections, so anything discoverable is connectable.

```python
from omochi_ui import UnixSocketServerTransport
await app.start(UnixSocketServerTransport("mic", name="Mic", icon="🎤"))
```

```ts
import { UnixSocketServerTransport } from "@omochi-ui/sdk/node";
await app.start(new UnixSocketServerTransport({ serviceId: "mic", name: "Mic", icon: "🎤" }));
```

```rust
use omochi_ui::{UnixSocketServerOptions, UnixSocketServerTransport};
let transport = UnixSocketServerTransport::bind(
    UnixSocketServerOptions::new("mic").with_name("Mic").with_icon("🎤"),
).await?;
app.start_with(transport).await
```

The bundled examples honour `OMOCHI_SERVICE`: setting it to a service id publishes on a
socket, and leaving it unset keeps the stdio behaviour `omochi-ui dev` expects.

```sh
OMOCHI_SERVICE=python-example uv run --project examples/python examples/python/app.py
OMOCHI_SERVICE=typescript-example bun run --cwd examples/typescript start
OMOCHI_SERVICE=rust-example cargo run --manifest-path examples/rust/Cargo.toml
```

Then aggregate them:

```sh
bun run build
bun run omochi-ui hub
```

Open `http://127.0.0.1:5555/` (or the URL printed by the command). The hub serves its
own dashboard UI; no Vite server is needed. Create a dashboard, add views from the
machine/app/surface picker, and save. In edit mode, drag the handles or enter X/Y/W/H
values to move and resize panels on a twelve-column grid. Collisions move other panels
down. Narrow screens show panels in a single column and preserve the saved layout.

Dashboards are shared by browsers using the same hub and stored in
`$XDG_CONFIG_HOME/omochi/dashboards.json` (default `~/.config/omochi/dashboards.json`).
They contain names, surface references, and layouts, never app state. Changes are saved
explicitly; Cancel restores the saved layout. A revision conflict keeps local edits and
asks the user to reload. Invalid storage is reported without overwriting the file.
Use one hub process per dashboard configuration directory.

Panels retain their placement when an app or surface disappears, and resume rendering
when the same node/service/surface returns. Different dashboards can reference the same
surface; all operate on the app's shared state. A surface can appear only once in each
dashboard. Independent panel sessions and component extraction are not supported.

The development server continues to preview every surface from its connected app:

```sh
bun run omochi-ui dev -- uv run --project examples/python examples/python/app.py
bun run --filter @omochi-ui/dev-server dev
```

For development of the hub UI itself, use `bun run --filter @omochi-ui/hub-ui dev`. It proxies
WebSocket, service discovery, and dashboard API requests to `http://127.0.0.1:5555`
(or `OMOCHI_HUB`).

`omochi-ui hub` starts a gateway for this machine when none is already listening, so one
command is still all it takes. Run `omochi-ui gateway` on its own for a machine that only
publishes applications, and point a hub at it with `omochi-ui hub --gateway <target>`.

### Connecting through SSH

With a gateway already running on the remote machine, connect from your local machine:

```sh
bun run omochi-ui hub --ssh user@remote
# SSH config aliases (including Port, IdentityFile, and ProxyJump) work too:
bun run omochi-ui hub --ssh my-server
# Override the remote socket when the gateway uses a custom location:
bun run omochi-ui hub --ssh my-server --ssh-socket /run/user/1000/omochi/gateway.sock
```

The wrapper resolves the remote runtime socket path, opens an OpenSSH Unix socket
forward in a private temporary directory, and starts the hub against it. SSH handles
login and host-key confirmation normally. The remote gateway needs no TCP listener or
omochi pairing; it must already be running and SSH must allow Unix socket forwarding.
The local machine needs OpenSSH and the remote machine must be Unix-like. If an SSH
session has a different runtime environment from the gateway, use `--ssh-socket`.

One `--ssh` target is supported per hub. Like an explicit `--gateway`, it replaces the
default local gateway; add `--gateway /path/to/local/gateway.sock` to include that one
as well. Other explicit gateways and `--discover-lan` can also be combined with SSH.

Stopping the hub removes its SSH process and temporary socket, leaving the remote
gateway running. Gateway restarts use the hub's normal reconnect behavior. If SSH
itself exits, the hub exits with an error; rerun the command to reconnect. Authentication
prompts are not timed out; after the local forward is listening, the gateway must
answer within ten seconds.

### Namespacing

Because A2UI v0.9 has no service envelope, each layer namespaces surface ids and strips
the prefix again on the way back. A gateway namespaces by service id; a hub re-namespaces
by `<nodeId>~<serviceId>`, which is what keeps two machines running the same service from
colliding:

```text
main            what the application sends
mic/main        what the gateway publishes
k7m2q9x4~mic/main   what the renderer sees   (nodeId shortened here for brevity)
```

Actions travel the reverse path, and each layer restricts the renderer's client data model
to the channel it is forwarding to, so one backend never receives another's surfaces —
including the `/$local` drafts the user is still typing. The frames stay standard A2UI
v0.9, so any renderer can consume the merged stream, and a renderer can attach straight to
a gateway's `/v1/a2ui` for debugging.

Each service keeps its own snapshot inside its gateway, so one service restarting, or
emitting an invalid message, never disturbs the others; the hub keeps one snapshot per
node for the same reason. When a service or a whole node disappears, its surfaces are
retracted with `deleteSurface` and reattached when it returns.

The service list itself is not A2UI. The hub answers `GET /services` with the current list
and streams the same list over `GET /events` as server-sent events, which keeps the
WebSocket carrying nothing but A2UI frames. Each row names the node it came from, so the
hub UI can group available views by machine.

### Trust boundary

`$XDG_RUNTIME_DIR` is mode 0700, so reaching a service's socket — or the gateway's —
already proves the caller is the owning user, and neither performs any authentication of
its own. Nothing listens on the network yet: a gateway binds only its unix socket, and a
hub reaches other machines only when explicitly pointed at one. That protects
against other local users, not against other pages in the user's browser: WebSocket
upgrades are exempt from CORS, so the hub accepts upgrades and HTTP requests only from
loopback origins unless `--allow-origin` widens the list. Keep the default `127.0.0.1`
binding; the hub has no TLS.

### Remote access

A gateway is reachable only through its unix socket until someone asks for more. The
switches are independent, so "discoverable" never implies "reachable" and "reachable"
never implies "trusted":

```sh
bun run omochi-ui gateway --listen HOST:PORT   # accept hubs over TCP
bun run omochi-ui gateway --listen 0.0.0.0:5556 --advertise  # also publish over mDNS
bun run omochi-ui gateway --listen 0.0.0.0:5556 --pair       # also open a pairing window
bun run omochi-ui gateway --lan                # sugar for --listen 0.0.0.0:5556 --advertise

bun run omochi-ui hub --discover-lan                 # look for gateways on the local link
bun run omochi-ui hub --gateway <nodeId>@HOST:PORT   # or name one outright
```

All network switches are off by default. Both `--advertise` and `--pair` require
a TCP listener (`--listen` or `--lan`). With no flags, only a Unix socket is opened.

### Finding gateways

With `--advertise`, a gateway publishes `_omochi-ui._tcp` on the local link. The record
carries only a protocol version, the node id, and the API base path — no icons, no service
list, and no secrets, because everything in it is readable by everyone on the link. It is
untrusted discovery and nothing more: a hub that finds a gateway this way still has to
authenticate, and one it has not paired with gets no further than the handshake. A hub
ignores its own machine's advertisement, which it already reaches through a unix socket.

Multicast does not cross a VLAN or a VPN and is missing entirely in most containers, so
`--gateway <nodeId>@host:port` stays a first-class way to name a peer rather than a
fallback.

### Pairing

Two machines are introduced using a one-time code:

```sh
# On the machine running the applications
bun run omochi-ui gateway --lan --pair
# Prints a one-time code and a command with a randomly assigned pairing port:
#   omochi-ui pair 192.168.1.42:42317

# On the machine running the hub: use the printed pairing port, not 5556
bun run omochi-ui pair 192.168.1.42:42317
```

The temporary HTTPS listener exposes only pairing endpoints and closes after success,
expiry, cancellation or exhaustion of its attempt budget. The normal gateway listener
never accepts pairing requests and always requires a client certificate.

SPAKE2 (RFC 9382, P-256) proves knowledge of the eight-character code without sending
it or enabling offline guesses. A window lasts three minutes, allows five exchange
attempts, and admits one successful registration. Attempts are counted at exchange
start, even if the caller abandons the exchange after seeing the gateway confirmation.
Case and dashes are ignored; `I`, `L`, `O`, and `U` are not generated.

Each device has a private P-256 key and a self-signed certificate valid for one year.
The exchange binds the actual hub and gateway IDs, roles, both certificate fingerprints,
protocol version, session nonce, and normal gateway port. The client checks the certificate
observed on the bootstrap TLS connection against the exchange; both sides confirm the
SPAKE2 result, and the hub proves possession of the private key being enrolled. The
completion receipt is authenticated. Only the dedicated pairing client permits an
initially untrusted TLS certificate. No private key is transmitted.

After pairing, HTTPS/WSS uses TLS 1.3 with mutual certificate authentication. Each side
pins the exact peer certificate and validates its device ID and role; system CA trust
alone grants no access. There are no Bearer tokens or TLS-PSK credentials. The printed
`hub --gateway NODE@HOST:PORT` command uses the normal service port, not the temporary
pairing port. Certificate expiry or replacement requires re-pairing. If the final response
is lost, the gateway may have registered the hub while the hub has not saved its peer;
open a new pairing window and pair again.

`omochi-ui id` prints the persistent node ID. Identity and peers live in
`$XDG_CONFIG_HOME/omochi` (directory 0700, files 0600). `trust list` lists peers.
`trust forget NODE` removes a peer and waits for running local hubs and gateways to
apply the change and destroy affected connections before reporting success. A live
process that cannot acknowledge the update causes an error; removal remains persisted.
Concurrent metadata updates cannot resurrect a removed peer.

The remote protocol is now version 2. Legacy PSK trust entries are not accepted or
silently upgraded; pair those machines again. Bun 1.4.3 uses npm `ws` on Bun's TLS
compatibility layer for remote mTLS, while ordinary HTTP/Unix servers use Bun's native
WebSocket implementation. No Node.js executable is required.

A service killed without a chance to clean up leaves its manifest behind. The gateway
reports it as `disconnected` with the reason and keeps retrying rather than deleting an
advertisement it does not own, so a restart of that service reattaches on its own. A
gateway already listening is likewise reused and never stopped by a hub that did not
start it.


### Dashboard API and verification

The hub exposes `GET /api/dashboards`, `POST /api/dashboards`, and
`GET`, `PUT`, `DELETE /api/dashboards/:id`. Writes require JSON; updates and deletes
require the current `revision` and return 409 on conflict. `POST` accepts `{name, panels}`;
`PUT` accepts `{name, panels, revision}`; `DELETE` accepts `{revision}`. Dashboard and panel
types are available from `@omochi-ui/hub-ui/contracts`. Existing A2UI, `/services`, and `/events`
contracts are unchanged. The same origin restrictions apply to the dashboard API.

When a hub is started by `omochi-ui up`, `GET /api/presets` also returns the
read-only `DashboardPreset[]` supplied by that composition. Presets exist only for
the hub process and never write `dashboards.json`; the UI copies one through the
normal dashboard API when the user chooses **Save as dashboard**.

Run `bun run test` for unit and integration tests. After building, run
`bun packages/hub-ui/test/browser.mjs` for the Chromium smoke test (set `CHROMIUM_BIN`
if necessary). It starts isolated apps, gateways, and a hub, checks editing and action
routing, and writes screenshots to `/tmp/omochi-hub-screenshots` or `SCREENSHOT_DIR`.
