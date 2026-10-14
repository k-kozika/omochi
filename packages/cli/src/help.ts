const overview = `omochi-ui — attach a declarative UI to your program

Usage: omochi-ui <command> [options]

Develop an app:
  dev -- <command> [args...]   Run an app behind a stdio/WebSocket bridge
  generate catalog           Generate typed bindings from a local catalog

Compose dashboards:
  up [FILE]                  Start a composition and its dashboard preset
  hub                        Serve the dashboard UI; auto-start a local gateway
  gateway                    Publish running apps on this machine

Connect machines:
  id                         Show or name this machine's identity
  pair HOST:PORT             Pair with a gateway using its one-time code
  trust list                 List paired peers
  trust forget <nodeId>      Remove a paired peer

Start here:
  omochi-ui dev -- <command>  Preview one app (requires a separate UI server)
  omochi-ui up --open         Start ./omochi.toml and open its preset
  omochi-ui hub               Open dashboards at http://127.0.0.1:5555/

Use omochi-ui <command> --help or omochi-ui help <command> for options.
`

const topics: Record<string, string> = {
  up: `Start services and a read-only dashboard preset from a TOML composition.

Usage: omochi-ui up [options] [FILE]

Options:
  --host HOST            Hub bind address (default: 127.0.0.1)
  --port PORT            Hub port (default: 5555; 0 selects a port)
  --allow-origin ORIGIN  Allow an additional exact browser origin; repeatable
  --open                 Open the selected preset in the desktop browser

FILE defaults to ./omochi.toml. Commands run without an implicit shell and
receive OMOCHI_SERVICE. Utility entries invoke the matching omochi-utils mode.
The preset is temporary; use Save as dashboard in the hub to keep and edit it.
If a child service exits, its view becomes unavailable while the hub continues.
`,
  dev: `Run an application and bridge its JSONL stdin/stdout to WebSocket.

Usage: omochi-ui dev [options] -- <command> [args...]

Options:
  --host HOST    Bind address (default: 127.0.0.1)
  --port PORT    WebSocket port (default: 5555; 0 selects an available port)

This command starts the app and bridge. Start the browser preview separately:
  bun run --filter @omochi-ui/dev-server dev
  omochi-ui dev -- uv run --project examples/python examples/python/app.py

Open http://127.0.0.1:5173/ with the default bridge port. For another port,
use the ?ws= URL printed at startup. All arguments after -- go to the app.
The bridge has no authentication or TLS; keep the loopback default.
`,
  hub: `Serve dashboards combining surfaces from running applications.

Usage: omochi-ui hub [options]

Options:
  --host HOST            HTTP/WebSocket bind address (default: 127.0.0.1)
  --port PORT            HTTP/WebSocket port (default: 5555; 0 selects a port)
  --gateway TARGET       Gateway socket path or <nodeId>@HOST:PORT; repeatable
  --ssh HOST             Reach a remote gateway through SSH (one target)
  --ssh-socket PATH      Override the remote socket; requires --ssh
  --no-auto-gateway      Do not start a missing local gateway
  --discover-lan         Also discover paired gateways through mDNS
  --allow-origin ORIGIN  Allow an additional exact browser origin; repeatable

With no target, the hub reuses or starts the local gateway. --gateway and
--ssh replace that default; add --gateway with the local socket to include it.
The hub serves its own UI at http://127.0.0.1:5555/; no Vite server is needed.
Apps must already be running with UnixSocketServerTransport.

Examples:
  omochi-ui hub
  omochi-ui hub --ssh user@remote
  omochi-ui hub --gateway <nodeId>@192.168.1.42:5556

SSH requires a running remote gateway. TCP requires pairing first.
The hub has no authentication or TLS; keep the loopback default.
`,
  gateway: `Discover and publish the current user's running apps on one machine.

Usage: omochi-ui gateway [options]

Options:
  --root DIR        App registry directory (default: $XDG_RUNTIME_DIR/omochi)
  --socket PATH     Gateway socket (default: <root>/gateway.sock)
  --node-name NAME  Set this machine's display name
  --listen HOST:PORT  Enable the certificate-authenticated mTLS listener
  --advertise       Advertise with mDNS; requires --listen or --lan
  --pair            Open a one-time pairing window; requires --listen or --lan
  --lan             Shorthand for --listen 0.0.0.0:5556 --advertise

The gateway discovers apps; it does not launch them or serve a browser UI.
Without network flags, it listens only on a Unix socket. If XDG_RUNTIME_DIR
is unset, the registry is <temp>/omochi-<uid>/omochi.

Examples:
  omochi-ui gateway
  omochi-ui gateway --lan --pair
`,
  id: `Show this machine's persistent node ID and display name.

Usage: omochi-ui id [--node-name NAME]

Creates an identity on first use. --node-name sets its display name.
Configuration: $XDG_CONFIG_HOME/omochi (default: ~/.config/omochi).
`,
  pair: `Pair this machine with a gateway accepting a one-time code.

Usage: omochi-ui pair HOST:PORT [--code CODE]

Start omochi-ui gateway --lan --pair on the machine running the apps first.
Without --code, read the code from stdin to keep it out of shell history.
Use the printed random pairing port; it differs from the normal mTLS port.
After pairing, use the printed hub --gateway command to connect.

Example:
  omochi-ui pair 192.168.1.42:42317  # use the printed random pairing port
`,
  trust: `Manage paired peers stored in $XDG_CONFIG_HOME/omochi/peers.json.

Usage:
  omochi-ui trust list
  omochi-ui trust forget <nodeId>

list shows peer IDs, roles, names, and pairing times.
forget removes the local entry and waits for running processes to close revoked connections.
The machines must pair again to reconnect.
`,
  'trust list': `List this machine's paired peers.

Usage: omochi-ui trust list

Prints peer IDs, roles, names, pairing times, and last-seen times when known.
`,
  'trust forget': `Remove a peer from this machine's trust store.

Usage: omochi-ui trust forget <nodeId>

Use omochi-ui trust list to find its ID. Pair again to reconnect.
Returns exit code 1 if the peer was not found.
`,
  generate: `Generate SDK bindings from local schema files.

Usage: omochi-ui generate catalog [options]

Use omochi-ui generate catalog --help for required inputs and output flags.
`,
  'generate catalog': `Generate typed SDK bindings from a local A2UI v0.9 catalog.

Usage: omochi-ui generate catalog --catalog FILE [options]

Options:
  --catalog FILE     Required local catalog JSON file
  --name NAME        Type name (default: catalog title or GeneratedCatalog)
  --typescript FILE Write TypeScript bindings
  --python FILE     Write Python bindings
  --rust FILE       Write Rust bindings
  --check           Fail if output files are missing or stale; do not write

Choose at least one output language. Output directories must already exist.
Schema resolution is local-only; no network fetches are performed.

Example:
  omochi-ui generate catalog --catalog ./catalog.json --typescript ./catalog.ts
`,
}

export function helpText(topic = ''): string | undefined {
  if (!topic) return overview
  const body = Object.hasOwn(topics, topic) ? topics[topic] : undefined
  return body === undefined ? undefined : `${body}\n  -h, --help    Show this help\n`
}

/** Only command words select a topic; options and child arguments never do. */
export function helpTopic(args: string[]): string {
  const command = args[0] ?? ''
  const subcommand = args[1]
  return (command === 'trust' || command === 'generate') && subcommand && !subcommand.startsWith('-')
    ? `${command} ${subcommand}`
    : command
}
