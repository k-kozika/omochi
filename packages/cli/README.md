# CLI reference

[Overview](../../README.md) · [Architecture](../../docs/architecture.md) · [Discovery guide](../../docs/discovery.md)

Build the workspace with `bun install` and `bun run build`. Run commands from its
root using `bun run omochi-ui`; the binary is provided by `@omochi-ui/cli`; the TypeScript SDK is
`@omochi-ui/sdk`.

```sh
bun run omochi-ui --help
bun run omochi-ui hub --help
bun run omochi-ui help generate catalog
```

No arguments prints the overview. `-h`, `--help`, and `help <command>` print help
to stdout and exit successfully without starting services or changing config.
Invalid arguments print usage to stderr and exit with code 2.

## Command map

| Task | Command | Browser UI included? |
| --- | --- | --- |
| Start a project composition | `up [FILE]` | Yes; `--open` opens it automatically |
| Develop a single app | `dev -- <command> [args...]` | Start the Vite preview separately |
| Compose dashboards from running apps | `hub` | Yes |
| Publish this machine's running apps | `gateway` | No; connect a hub |
| Show or name this machine | `id` | No |
| Pair with a TCP gateway | `pair HOST:PORT` | No |
| Inspect or remove paired peers | `trust list`, `trust forget <nodeId>` | No |
| Generate SDK catalog types | `generate catalog` | No |

## up

Start local services, the hub, and a read-only dashboard preset from TOML.

```sh
bun run omochi-ui up --open
bun run omochi-ui up --port 5557 ./examples/quickstart/omochi.toml
```

The file defaults to `./omochi.toml`. A service uses either a literal `command`
or an `omochi-utils` shorthand. Commands do not use a shell; relative working
directories are resolved from the composition file. Child services receive
`OMOCHI_SERVICE` and remain independent: one exiting leaves its panel unavailable
without stopping the others. Utility shorthand supports `button`, `watch`,
`process`, `tail`, and `http`. Stdio-owned `stream` and `mcp` processes stay
external; this lets an agent connect and disconnect independently of the preset.

```toml
version = 1
id = "local-development"

[services.health]
utility = ["http", "http://127.0.0.1:5173/"]

[services.app]
command = ["uv", "run", "app.py"]
cwd = "./backend"

[dashboard]
name = "Local development"

[[dashboard.rows]]
panels = ["health", "app"]
height = "medium"

[dashboard.panels.health]
title = "Health"
service = "health"

[dashboard.panels.app]
title = "Application"
service = "app"
```

Rows divide the twelve-column dashboard evenly. Heights are `small`, `medium`,
or `large`; a panel's surface defaults to `main`. Presets do not modify saved
dashboard storage. Use **Save as dashboard** in the hub to make an editable copy.
Ctrl+C stops only the services and gateway started by this command.

| Option | Meaning | Default |
| --- | --- | --- |
| `--host HOST` | Hub bind address | `127.0.0.1` |
| `--port PORT` | Hub port; `0` chooses an available port | `5555` |
| `--allow-origin ORIGIN` | Add an exact browser origin; repeatable | Loopback origins only |
| `--open` | Open the selected preset in the desktop browser | Off |

## dev

Launch a child application and bridge its JSONL stdin/stdout to WebSocket.

```sh
# Terminal 1: browser preview
bun run --filter @omochi-ui/dev-server dev
# Terminal 2: app + bridge
bun run omochi-ui dev -- uv run --project examples/python examples/python/app.py
```

Open `http://127.0.0.1:5173/`. The preview's default `/ws` proxy reaches the bridge.
All arguments after `--` belong to the child, including any `--help` flag.
Application logging must go to stderr; stdout is reserved for A2UI JSONL.

| Option | Meaning | Default |
| --- | --- | --- |
| `--host HOST` | Bridge bind address | `127.0.0.1` |
| `--port PORT` | Bridge port; `0` chooses an available port | `5555` |

The bridge serves WebSocket at `/ws`; it does not serve an HTML page. Startup
prints a preview URL with `?ws=` for its actual address. The preview must already
be running; use its printed port if Vite selected one other than 5173.
All clients share application state, and late clients receive a current snapshot.
The bridge has no authentication or TLS; keep the loopback default.

## hub

Serve the dashboard UI, discover available surfaces, and route browser actions.
Apps must already be running with `UnixSocketServerTransport`. The bundled
examples select that transport when `OMOCHI_SERVICE` is set.

```sh
# Terminal 1
OMOCHI_SERVICE=python-example uv run --project examples/python examples/python/app.py
# Terminal 2
bun run omochi-ui hub
```

Open `http://127.0.0.1:5555/`. The hub serves its own UI and automatically starts
a local gateway when none is listening. It reuses an existing gateway and does
not stop a gateway it did not start.

| Option | Meaning | Default |
| --- | --- | --- |
| `--host HOST` | HTTP/WebSocket bind address | `127.0.0.1` |
| `--port PORT` | HTTP/WebSocket port; `0` chooses an available port | `5555` |
| `--gateway TARGET` | Unix socket path or `<nodeId>@HOST:PORT`; repeatable | Local gateway |
| `--ssh HOST` | SSH hostname, alias, or `user@host`; one target | Off |
| `--ssh-socket PATH` | Remote gateway socket override; requires `--ssh` | Resolved through SSH |
| `--no-auto-gateway` | Do not start a missing local gateway | Auto-start enabled |
| `--discover-lan` | Also look for paired gateways via mDNS | Off |
| `--allow-origin ORIGIN` | Add an exact allowed browser origin; repeatable | Loopback origins only |

Explicit `--gateway` or `--ssh` targets replace the default local gateway. Add
`--gateway /path/to/local/gateway.sock` to include it too. Explicit targets can
be combined with `--discover-lan`. A TCP target needs its paired node ID; a Unix
socket or SSH target does not need pairing.

```sh
# Remote machine: gateway and apps must already be running
bun run omochi-ui gateway
# Local machine: SSH authenticates and forwards the remote gateway socket
bun run omochi-ui hub --ssh user@remote
```

The hub has no authentication or TLS on its browser-facing listener. Keep its
loopback binding. See [SSH setup](../../docs/discovery.md#connecting-through-ssh)
for requirements and cleanup behavior.

## gateway

Discover the current user's apps and publish their surfaces. A gateway does not
launch apps or serve the dashboard UI. It normally listens only on a Unix socket.

```sh
bun run omochi-ui gateway
```

| Option | Meaning | Default |
| --- | --- | --- |
| `--root DIR` | Directory containing service manifests and sockets | `$XDG_RUNTIME_DIR/omochi` |
| `--socket PATH` | Gateway Unix socket | `<root>/gateway.sock` |
| `--node-name NAME` | Persist this machine's display name | Existing name or hostname |
| `--listen HOST:PORT` | Enable the TLS TCP listener | Off |
| `--advertise` | Advertise over mDNS; requires a TCP listener | Off |
| `--pair` | Open a one-time pairing window; requires a TCP listener | Off |
| `--lan` | `--listen 0.0.0.0:5556 --advertise` | Off |

If `XDG_RUNTIME_DIR` is unset, the registry uses
`<system temporary directory>/omochi-<uid>/omochi`. Apps and gateways must use the
same runtime directory. See [Service discovery](../../docs/discovery.md) for the
manifest format and SDK transport examples.

Network reachability, advertisement, and trust are separate. `--listen` enables
the paired TLS listener; mDNS only advertises its location. Neither allows an
unpaired hub to read application data.

## pair

Pair once before connecting a hub to a gateway over TCP. SSH does not require this.

```sh
# Machine running the apps: open a TCP listener and pairing window
bun run omochi-ui gateway --lan --pair
# Machine running the hub: enter the code printed by the gateway
bun run omochi-ui pair 192.168.1.42:42317  # use the random pairing port printed above
```

`pair HOST:PORT` reads the code from stdin. `--code CODE` supplies it explicitly;
stdin keeps it out of shell history. The window lasts three minutes, permits
five exchange attempts, and closes after one successful pairing. Its dedicated HTTPS
listener uses a random port and exposes no application API. Normal connections use
mutual TLS with pinned device certificates; legacy PSK peers must pair again.

After success, run the printed `hub --gateway <nodeId>@HOST:PORT` command, prefixed
with `bun run` in a source checkout. Alternatively, use `hub --discover-lan`
when the gateway advertises on the same local network. mDNS generally does not
cross VLANs or VPNs.

## id and trust

```sh
bun run omochi-ui id
bun run omochi-ui id --node-name workstation
bun run omochi-ui trust list
bun run omochi-ui trust forget NODE_ID
```

`id` creates a persistent identity on first use and prints its node ID and name.
Changing the name preserves the ID. `trust list` prints peer IDs, roles, names,
and pairing times. `trust forget` removes the local peer entry and waits for running local processes
to close affected connections before reporting success; it returns code
1 when the peer does not exist. Pair again to establish trust after removal.

## generate catalog

Generate typed bindings from a local A2UI v0.9 catalog for any subset of SDKs.
Create output directories before running the command.

```sh
mkdir -p generated
bun run omochi-ui generate catalog \
  --catalog ./catalog.json \
  --name ProductCatalog \
  --typescript ./generated/product-catalog.ts \
  --python ./generated/product_catalog.py \
  --rust ./generated/product_catalog.rs
```

| Option | Meaning |
| --- | --- |
| `--catalog FILE` | Required catalog JSON input |
| `--name NAME` | Type name; defaults to catalog title or `GeneratedCatalog` |
| `--typescript FILE` | TypeScript output |
| `--python FILE` | Python output |
| `--rust FILE` | Rust output |
| `--check` | Check outputs without writing; fail if missing or stale |

At least one output flag is required. Generation resolves local schemas only;
it does not fetch schemas over the network. Reuse the same invocation with
`--check` in CI.

## Ports and storage

| Resource | Default |
| --- | --- |
| Vite browser preview | `http://127.0.0.1:5173/` |
| Development bridge | `ws://127.0.0.1:5555/ws` |
| Hub UI / A2UI | `http://127.0.0.1:5555/` / `ws://127.0.0.1:5555/ws` |
| Gateway Unix socket | `$XDG_RUNTIME_DIR/omochi/gateway.sock` (fallback above) |
| Gateway TCP with `--lan` | `0.0.0.0:5556` (paired TLS) |
| Node identity and peers | `$XDG_CONFIG_HOME/omochi/{node,peers}.json` |
| Saved dashboards | `$XDG_CONFIG_HOME/omochi/dashboards.json` |

`XDG_CONFIG_HOME` defaults to `~/.config`. Runtime directories and configuration
are per-user; identity and trust persist across restarts. Dashboard files store
names, surface references, and layouts, not app state.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `dev` starts but there is no page | Start `bun run --filter @omochi-ui/dev-server dev` and open its URL, not port 5555 |
| Preview says disconnected | Start the bridge; with a custom port, use the printed `?ws=` URL |
| Address already in use | `dev` and `hub` share default port 5555; stop one or set `--port 5557` |
| Vite uses a port other than 5173 | Use Vite's printed URL, adding the bridge's `?ws=` parameter if needed |
| Hub has no apps | Run an app with `OMOCHI_SERVICE` set and the same user/runtime directory |
| Hub loses the local apps when using SSH | Explicit targets replace the local default; add the local socket with `--gateway` |
| Pairing/advertising requires a listener | Use `gateway --lan --pair` or provide `--listen HOST:PORT` |
| Remote gateway is not found | Check that it is running; use SSH or an explicit paired TCP target when multicast is unavailable |
| Command or build output is missing | Run `bun install` and `bun run build` from the repository root |
