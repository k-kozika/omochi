# Architecture

[Overview](../README.md) · [SDK guide](sdk.md) · [CLI reference](../packages/cli/README.md) · [Discovery guide](discovery.md)

This document maps the current implementation: all nine packages, the processes
started by the CLI, the protocols between them, and the ownership of state and
persistent data. The diagrams describe existing behavior, not a future design.

| View | What it answers |
| --- | --- |
| [System map](#system-map) | Where does every runtime component fit? |
| [Package dependencies](#package-dependencies) | Which package depends on which? |
| [Inside one application](#inside-one-application) | How do declarations become incremental UI updates? |
| [Preview one app](#preview-one-app) | What starts, and which process serves the page? |
| [Compose dashboards](#compose-dashboards) | How are applications discovered and aggregated? |
| [Routing and boundaries](#routing-and-boundaries) | How does an action reach exactly one app? |
| [Browser and dashboard state](#browser-and-dashboard-state) | Which traffic updates the UI, service picker, and layout? |
| [State and storage](#state-and-storage) | What is authoritative, cached, or saved? |
| [Remote access and trust](#remote-access-and-trust) | What do SSH, mDNS, pairing, and TLS each do? |
| [Failure and recovery](#failure-and-recovery) | What disappears, survives, and reconnects? |
| [Catalogs and conformance](#catalogs-and-conformance) | How are SDKs, schemas, and renderers kept aligned? |
| [Implementation index](#implementation-index) | Where is each responsibility implemented? |

## System map

[Open the full-size SVG](diagrams/architecture-overview.svg) · [PNG](diagrams/architecture-overview.png)

Solid arrows are live communication or data delivery. Dashed arrows are discovery,
configuration, or process startup. A box inside a process is a responsibility,
not another daemon. The preview, direct-transport, and hub paths are alternatives;
a program selects its transport when it starts.

```mermaid
flowchart TB
  subgraph Applications["APPLICATION HOST · repeated on each machine"]
    subgraph AppProcess["APP PROCESS · one selected transport"]
    App["Application process<br/>Python / TypeScript / Rust SDK<br/>State → views → IR → reconciliation"]
    Stdio["StdioTransport"]
    Unix["UnixSocketServerTransport<br/>One shared app, multiple clients"]
    Direct["Direct / custom transport<br/>TS WebSocketServerTransport<br/>or framework adapter"]
    end
    Registry[("Runtime registry<br/>manifest.json + a2ui.sock<br/>per service")]
    Gateway["Gateway process · omochi-ui gateway<br/>Discover + validate + connect apps<br/>Per-service snapshots / routing / fan-out"]
    App <--> Stdio
    App <--> Unix
    App <--> Direct
    Unix -.->|"Publish when listening"| Registry
    Registry -.->|"Watch manifests"| Gateway
    Unix <-->|"Unix socket · A2UI JSONL"| Gateway
  end

  subgraph Preview["SINGLE-APP DEVELOPMENT"]
    Bridge["Bridge process · omochi-ui dev<br/>Launch child / snapshot / fan-out<br/>127.0.0.1:5555/ws"]
    Vite["Preview Vite server<br/>packages/dev-server<br/>127.0.0.1:5173"]
    Bridge -.->|"Starts app with stdio"| App
    Stdio <-->|"stdin / stdout JSONL"| Bridge
  end

  subgraph OtherHosts["OTHER APPLICATION HOSTS"]
    Remote["Other gateway processes<br/>Same per-host app topology<br/>Each with its own registry and peer trust"]
  end

  subgraph Aggregation["HUB HOST · may be the same machine as the apps"]
    subgraph HubProcess["HUB PROCESS · omochi-ui hub"]
    Locator["Gateway locators<br/>Local socket / explicit targets<br/>Optional mDNS discovery"]
    Client["Gateway clients<br/>Identity handshake + control WS + A2UI WS<br/>Unix socket / SSH forward / paired TLS"]
    Hub["Per-node snapshots / namespacing / action routing<br/>Service list + dashboard API + built UI assets<br/>127.0.0.1:5555"]
    end
    Config[("Hub user's configuration<br/>node.json / peers.json<br/>dashboards.json")]
    Remote -.->|"Optional mDNS advertisements"| Locator
    Locator -.->|"Candidates"| Client
    Gateway <-->|"Gateway protocol v1"| Client
    Remote <-->|"Gateway protocol v1"| Client
    Client <--> Hub
    Hub -.->|"Start local gateway only if needed"| Gateway
    Hub <--> Config
  end

  subgraph Browsers["BROWSER · separate client state per connection"]
    PreviewUI["Preview page<br/>All surfaces on its connection"]
    HubUI["Dashboard page<br/>Service picker + saved layouts"]
    Renderer["Shared @omochi-ui/renderer in either page<br/>WebSocket client → MessageProcessor → SurfaceView<br/>React basic catalog + renderer-local input drafts"]
    PreviewUI --> Renderer
    HubUI --> Renderer
  end

  Vite -->|"HTML / JS / CSS"| PreviewUI
  Bridge <-->|"A2UI WS · via Vite proxy or direct URL"| PreviewUI
  Direct <-->|"A2UI · matching adapter required"| PreviewUI
  Hub <-->|"A2UI WS + HTTP API + services SSE"| HubUI

  classDef app fill:#eef2ff,stroke:#818cf8,color:#312e81
  classDef transport fill:#ecfeff,stroke:#22d3ee,color:#164e63
  classDef server fill:#ecfdf5,stroke:#34d399,color:#064e3b
  classDef browser fill:#fff7ed,stroke:#fb923c,color:#7c2d12
  classDef storage fill:#f1f5f9,stroke:#94a3b8,color:#334155
  class App app
  class Stdio,Unix,Direct transport
  class Gateway,Bridge,Vite,Locator,Client,Hub,Remote server
  class PreviewUI,HubUI,Renderer browser
  class Registry,Config storage
```

The SDKs generate A2UI v0.9. `@omochi-ui/core` supplies the server-side snapshot,
validation, routing, JSONL, and fan-out primitives used by the bridge, gateway,
and hub. `@omochi-ui/discovery` implements both ends of the gateway protocol.
The remote gateway has its own identity and trust files on its host; the storage
table below distinguishes those from the hub's configuration.

The direct browser path works out of the box for a WebSocket endpoint. A callback
adapter needs a matching frontend integration if it uses another channel. Both
browser pages use the shared renderer, but have separate application code.

`dev` and `hub` both default to port 5555: run them separately or override a port.
Network discovery and TCP gateway listeners are disabled by default.

## Package dependencies

[Open diagram as SVG](diagrams/package-dependencies.svg)

Arrows mean **depends on**, not network traffic. Solid arrows cover every internal
JavaScript workspace dependency declared in package manifests. Dashed arrows show
shared contracts across the independent SDK implementations. External libraries
below are selected runtime dependencies, not the complete lockfile.

```mermaid
flowchart TB
  subgraph Tools["CLI and browser applications"]
    CLI["packages/cli<br/>@omochi-ui/cli<br/>binary: omochi-ui"]
    HubUI["packages/hub-ui<br/>@omochi-ui/hub-ui"]
    Dev["packages/dev-server<br/>@omochi-ui/dev-server"]
  end
  subgraph Shared["Shared JavaScript packages"]
    Discovery["packages/discovery<br/>@omochi-ui/discovery"]
    Core["packages/core<br/>@omochi-ui/core"]
    Renderer["packages/renderer<br/>@omochi-ui/renderer"]
  end
  subgraph SDKs["Independent SDK implementations"]
    TS["packages/sdk/typescript<br/>npm: @omochi-ui/sdk"]
    Py["packages/sdk/python<br/>Python: omochi_ui"]
    Rust["packages/sdk/rust<br/>crate: omochi-ui"]
    Spec["spec/<br/>IR schema + conformance fixtures"]
  end
  subgraph External["Selected external runtime libraries"]
    WebCore["@a2ui/web_core/v0_9"]
    A2uiReact["@a2ui/react/v0_9"]
    React["React / React DOM"]
    Network["ws"]
    Auth["bonjour-service<br/>@noble/curves"]
  end
  CLI --> Discovery
  CLI --> Core
  CLI -->|"contracts + built UI assets"| HubUI
  Discovery --> Core
  HubUI --> Renderer
  Dev --> Renderer
  CLI --> WebCore
  Core --> WebCore
  TS --> WebCore
  Renderer --> WebCore
  Renderer --> A2uiReact
  Renderer --> React
  HubUI --> React
  Dev --> React
  CLI --> Network
  Core --> Network
  Discovery --> Network
  TS --> Network
  Discovery --> Auth
  TS -.-> Spec
  Py -.-> Spec
  Rust -.-> Spec
```

The SDKs do not import the gateway or hub. In particular, their Unix socket
transports implement the shared filesystem/wire contract independently rather
than calling `@omochi-ui/discovery`. TypeScript's Node server transports are exported
through `@omochi-ui/sdk/node`. Python and Rust have no dependency on the JavaScript
packages. `examples/` consumes the local SDKs; it is not another runtime layer.

The CLI's dependency on `hub-ui` is intentional: it imports the side-effect-free
`contracts` export and locates the `assets` export to serve the built dashboard.
This does not execute browser React code in the hub backend.

## Inside one application

[Open diagram as SVG](diagrams/sdk-runtime.svg)

The following responsibilities exist in each SDK; the TypeScript filenames label
one implementation. `App` registers declarations and callbacks, then builds one
`Runtime` around the state instance.

```mermaid
flowchart TB
  subgraph Host["APPLICATION PROCESS · one SDK implementation"]
    Definition["App<br/>Register surfaces + typed actions"]
    Runtime["Runtime<br/>Ordered action / update queue<br/>Lifecycle + background tasks"]
    State[("Application state<br/>Authoritative host-language values")]
    Views["Surface functions<br/>UI builder + Local declarations"]
    IR["Declaration / normalized IR v2<br/>Root tree, slots, data, locals, catalog ID"]
    Reconciler["Reconciler<br/>Stable IDs / component and data diffs<br/>Previous declaration per surface"]
    Transport["Transport<br/>send + receive + capabilities"]
    Handler["Action handler<br/>Concrete input + update context"]
    Definition -->|"build / start"| Runtime
    Runtime -->|"Evaluate all surfaces after updates"| Views
    State -->|"Read"| Views
    Views --> IR
    IR --> Reconciler
    Transport -.->|"Capabilities before first render"| Reconciler
    Reconciler -->|"A2UI messages"| Transport
    Transport -->|"Runtime.handle / dispatch"| Runtime
    Runtime -->|"Invoke named action"| Handler
    Handler -->|"context.update"| State
    Runtime -->|"runtime.update for external events"| State
  end
  subgraph Browser["BROWSER"]
    Processor["MessageProcessor<br/>Surface model + component tree"]
    Draft[("Renderer-local drafts<br/>/$local bindings")]
    Widget["React components<br/>Render / edit / invoke"]
    Processor --> Widget
    Widget <-->|"Editable bindings"| Draft
    Draft -->|"Resolve action input"| Processor
    Widget -->|"User action"| Processor
  end
  Transport -->|"createSurface / updateComponents<br/>updateDataModel / deleteSurface"| Processor
  Processor -->|"A2UI action + client data model metadata"| Transport
```

The transport arrows can traverse the bridge and aggregators from the system
map; those layers do not evaluate views or execute application callbacks.

- The root component ID is `root`; explicit keys keep conditional or reordered
  components stable. Component IDs are scoped to a surface.
- The reconciler compares declarations and sends incremental changes. Initial
  rendering sends a full surface; changing the catalog recreates it. Normalized
  IR remains inside the SDK and is not the wire protocol.
- `ui.local()` supplies initial values and reset keys. Ordinary rerenders preserve
  browser edits; an explicit reset replaces the corresponding local draft.
- Action handlers receive resolved input, not a renderer object. The wire action
  can carry client data model metadata; it is scoped in transit and is not
  automatically copied into authoritative app state.
- `Runtime.handle()` also accepts `getSurface` and `invoke` observations/commands.
  These SDK entry points are distinct from the browser's standard A2UI action.
- Transport capabilities are supplied to the reconciler before first rendering;
  this is not a network capability-negotiation protocol.

## Preview one app

[Open diagram as SVG](diagrams/single-app-preview.svg)

These are separate processes. `omochi-ui dev` starts the child app and bridge;
Vite serves the preview page. The browser can use Vite's `/ws` proxy or select a
direct endpoint with `?ws=`.

```mermaid
flowchart LR
  subgraph Dev["omochi-ui dev -- your-command"]
    Bridge["Bridge process<br/>Child session / JSONL validation<br/>Snapshot + WebSocket fan-out<br/>127.0.0.1:5555/ws"]
    App["Child process<br/>App + SDK + StdioTransport"]
    Bridge -.->|"spawn / signals"| App
    App <-->|"stdout updates / stdin actions"| Bridge
  end
  Vite["Vite process<br/>bun run --filter @omochi-ui/dev-server dev<br/>127.0.0.1:5173"]
  Browser["Browser preview<br/>Shared renderer"]
  Vite -->|"HTML / JS / CSS"| Browser
  Browser <-->|"Default: /ws"| Vite
  Vite <-->|"Proxy to bridge"| Bridge
  Browser <-.->|"Alternative: ?ws= direct URL"| Bridge
```

The bridge's port does not serve a page. Logs from the app belong on stderr;
stdout is A2UI JSONL. All browsers connected to one bridge share the same app
state. Late clients receive a compact current snapshot rather than event history.

| Transport | SDK availability | Typical connection |
| --- | --- | --- |
| `StdioTransport` | Python, TypeScript, Rust | Child app to bridge through stdin/stdout |
| `UnixSocketServerTransport` | Python, TypeScript, Rust | Discoverable app to gateway; multiple clients |
| `WebSocketTransport` | Python, TypeScript | Adapter around an existing WebSocket-like connection |
| `WebSocketServerTransport` | TypeScript, Node export | Browser directly to app's `/ws`; multiple clients |
| `CallbackTransport` / transport interface | Python, TypeScript, Rust | Application-supplied framework integration |

The direct TypeScript server and Unix socket servers maintain their own snapshots
for late clients. A generic callback or WebSocket-like adapter does not itself
supply discovery, a browser page, or multi-client routing.

## Compose dashboards

[Open diagram as SVG](diagrams/gateway-connection.svg)

A **service** is an app's published socket, identified by `serviceId`. A **node**
is a machine identity that survives gateway restarts. A **surface** is one view
published by an app. A dashboard places surface references, not arbitrary
components extracted from a surface.

```mermaid
sequenceDiagram
  autonumber
  participant App as App + Unix transport
  participant Registry as Runtime directory
  participant Gateway as Gateway process
  participant Hub as Hub process
  participant Browser as Browser hub UI
  App->>App: Bind a2ui.sock
  App->>Registry: Publish service manifest after listener is ready
  Registry-->>Gateway: Provider discovers and validates manifest
  Gateway->>App: Connect Unix socket (A2UI JSONL)
  App-->>Gateway: Current surfaces, then incremental updates
  Note over Gateway: Snapshot per service, prefix surface IDs
  Hub->>Gateway: GET /v1/node over Unix socket, SSH forward, or paired TLS
  Gateway-->>Hub: Protocol version, node ID, name
  par Control channel
    Hub->>Gateway: Open WS /v1/control
    Gateway-->>Hub: Complete service list, then changes
  and UI channel
    Hub->>Gateway: Open WS /v1/a2ui
    Gateway-->>Hub: Merged service snapshots, then updates
  end
  Note over Hub: Client announces open after both channels connect<br/>Snapshot per node, replace service prefix with node + service
  Browser->>Hub: GET / and assets
  Hub-->>Browser: Built dashboard application
  Browser->>Hub: Open WS /ws
  Hub-->>Browser: Current merged snapshots, then updates
  Browser->>Hub: Subscribe SSE /events
  Hub-->>Browser: Complete service list, then changes
  Browser->>Hub: GET /api/dashboards
  Hub-->>Browser: Saved dashboard definitions
```

The two gateway WebSockets form one logical connection: losing either closes
both. A separate `GET /v1/services` endpoint exists for inspection; the hub gets
its live service list from `/v1/control`, not polling that endpoint.
Browser startup requests may run concurrently; their order above is illustrative.

With no explicit target, the hub locates the local gateway and can start it if
missing. `--gateway` and `--ssh` replace that default selection. The supervisor
reuses an existing gateway and stops only a child gateway it owns. Applications
must already be running; the hub and gateway do not launch them.

## Routing and boundaries

[Open diagram as SVG](diagrams/action-routing.svg)

One browser connection can contain surfaces from many apps and machines. Surface
IDs provide routing without an extra omochi session envelope.

```mermaid
sequenceDiagram
  participant App as App: service mic
  participant Gateway as Gateway: node NODE
  participant Hub as Hub
  participant Browser as Browser renderer
  App->>Gateway: Update surface main
  Gateway->>Hub: Update surface mic/main
  Hub->>Browser: Update surface NODE~mic/main
  Browser->>Browser: Resolve draft fields into action input
  Browser->>Hub: Action for NODE~mic/main + client data model
  Hub->>Hub: Select NODE and mic, retain only this channel's model
  Hub->>Gateway: Action for mic/main + scoped model
  Gateway->>Gateway: Select mic, strip service prefix and scope model
  Gateway->>App: Action for main + scoped model
  App->>App: Invoke handler, apply context.update, render all surfaces
  App-->>Gateway: Incremental A2UI updates
  Gateway-->>Hub: Prefix + snapshot + fan-out
  Hub-->>Browser: Readdress + snapshot + fan-out to all clients
```

`NODE` is an illustrative node ID. Actual IDs are validated. Draft metadata for
another app is removed before forwarding; action routing does not change which
app owns the authoritative state. All connected clients of that app observe its
updates. Different dashboards referencing one surface are not independent app
sessions.

| Boundary | Channel / endpoint | Payload |
| --- | --- | --- |
| App ↔ bridge | stdin/stdout | A2UI JSONL |
| App ↔ gateway | `<service>/a2ui.sock` | A2UI JSONL |
| Hub → gateway | `GET /v1/node` | Gateway protocol version and node identity |
| Hub ↔ gateway | `WS /v1/control` | Full service lists, ping/pong, bye |
| Hub ↔ gateway | `WS /v1/a2ui` | Namespaced A2UI updates and actions |
| Inspector → gateway | `GET /v1/services` | Node ID and current services |
| Browser ↔ bridge or direct TS server | `WS /ws` by default | A2UI updates and actions |
| Browser ↔ hub | `WS /ws` | A2UI with node/service surface IDs |
| Browser ← hub | `GET /events` (SSE) | Full service lists as `services` events |
| Inspector → hub | `GET /services` | Current merged service list |
| Browser ↔ hub | `/api/dashboards` and `/:id` | Dashboard CRUD, revisions, validation errors |
| Browser ← hub | `/`, `/index.html`, `/assets/*` | Built dashboard assets |
| Pair CLI ↔ gateway | `POST /v1/pair/start`, `/v1/pair/finish` | Pairing exchange during an open window |

Gateway HTTP/WebSocket routes run over a Unix socket locally, an SSH-forwarded
Unix socket, or the explicit TLS TCP listener. The app's Unix socket speaks
JSONL, while the gateway's Unix socket speaks HTTP/WebSocket; they are not
interchangeable endpoints.

## Browser and dashboard state

[Open diagram as SVG](diagrams/browser-state.svg)

Three traffic types serve different purposes. Selecting or moving a dashboard
panel does not create a new backend session.

```mermaid
flowchart TB
  subgraph Backend["HUB BACKEND"]
    Wire["/ws<br/>Merged A2UI stream"]
    Services["/events · SSE<br/>Node / service availability"]
    API["/api/dashboards<br/>JSON CRUD + revision checks"]
    Disk[("dashboards.json")]
    API <--> Disk
  end
  subgraph Frontend["BROWSER · packages/hub-ui"]
    Session["useA2uiSession<br/>A2uiWebSocketClient<br/>One MessageProcessor per connection"]
    Models["A2UI surface models<br/>Components + bound data + local drafts"]
    Picker["subscribeServices<br/>Machine / app / surface picker"]
    Editor["Dashboard state + edit draft<br/>12-column layout / collision handling"]
    Panels["Panels reference node + service + surface<br/>SurfaceView → A2uiSurface"]
    Session <--> Models
    Models --> Panels
    Session -->|"Known surface IDs"| Picker
    Picker -->|"Add surface reference"| Editor
    Editor -->|"Placement + titles"| Panels
  end
  Wire <-->|"Updates / actions"| Session
  Services -->|"Full lists"| Picker
  API <-->|"Load / explicit Save / Delete"| Editor
```

The shared renderer registers `basicCatalog`, processes A2UI messages with
`@a2ui/web_core`, and renders with `@a2ui/react`. It reports malformed server
messages without tearing down other surfaces on that connection.

The preview frontend only renders the surfaces on its connection. The hub
frontend adds discovery, dashboard selection, layout editing, and persistence.
Unsaved edits live in browser memory. Cancel discards them; a revision conflict
returns HTTP 409 and asks for a reload while preserving the local edit draft.

Hub frontend development uses a separate Vite process (`@omochi-ui/hub-ui dev`) that
proxies `/ws`, `/services`, `/events`, and `/api` to the hub. Normal `omochi-ui hub`
serves its built frontend directly and needs no Vite process.

## State and storage

| Data | Owner | Lifetime / location | Role |
| --- | --- | --- | --- |
| Application state | SDK runtime in app process | Memory; persistence is the app's responsibility | Authoritative business state |
| Previous declarations | SDK reconciler | Memory, per surface | Compute incremental component/data changes |
| Local input drafts | Browser MessageProcessor | Memory, per connection under `/$local` | Editable input; preserved across normal rerenders |
| Direct/Unix server snapshot | SDK server transport | Memory, per hosted app | Initialize late clients |
| Bridge snapshot | Bridge | Memory, one app | Initialize late browser clients |
| Service snapshots | Gateway | Memory, per service | Validate and replay merged app streams |
| Node snapshots | Hub | Memory, per gateway connection | Validate and replay merged gateway streams |
| Registry manifest and socket | SDK Unix server transport | `<runtime>/omochi/<serviceId>/{manifest.json,a2ui.sock}` | Discover app and connect |
| Gateway socket | Gateway | `<runtime>/omochi/gateway.sock` | Local HTTP/WebSocket access |
| Node identity | Discovery auth module on each machine | `<config>/omochi/node.json` | Persistent node ID, display name, private key and device certificate |
| Peer trust | Discovery auth module on each machine | `<config>/omochi/peers.json` | Paired peer IDs, roles, certificate pins, and timestamps |
| Saved dashboards | Hub's DashboardStore | `<config>/omochi/dashboards.json` | Names, surface references, layout, revisions |
| Unsaved dashboard draft | Hub UI | Browser memory | Editing before explicit Save |
| SSH forward socket | CLI SSH wrapper | Private temporary directory | Local endpoint forwarding to remote gateway |

`<runtime>` is `XDG_RUNTIME_DIR`; when unset, the registry root is
`<system temp>/omochi-<uid>/omochi`. `<config>` is `XDG_CONFIG_HOME`, defaulting to
`~/.config`. Service IDs and manifest socket/icon fields are validated before use.
Private runtime/config directories use mode 0700; identity, trust, and dashboard
JSON files are written with mode 0600.

Snapshots materialize server messages; they are not a durable event log or a
backup of application state. Browser drafts are not shared authoritative state
and are not guaranteed to survive a reload or reconnect. Dashboard files contain
no application state or draft input. Use one hub process per dashboard config
directory; revision checks handle concurrent browser edits, not cross-process
file locking.

## Remote access and trust

| Path | How it reaches a gateway | Authentication / boundary |
| --- | --- | --- |
| Local default | Private Unix socket | Owning user's runtime directory permissions |
| `hub --ssh HOST` | OpenSSH forwards the remote Unix socket into a private local temp directory | SSH login and host-key checks; no omochi pairing needed |
| `hub --gateway NODE@HOST:PORT` | Explicit TCP endpoint | Pinned device certificates through mutual TLS 1.3 |
| `hub --discover-lan` | mDNS yields TCP candidates and claimed node IDs | Discovery is untrusted; paired TLS is still required |

A gateway opens TCP only with `--listen` or `--lan`. `--advertise` adds mDNS and
requires a listener; `--lan` combines listening on `0.0.0.0:5556` and advertising.
The TXT record contains protocol version, node ID, and base path, not peer keys or
app data. A hub does not open a TCP connection without a pinned gateway certificate.

Pairing introduces two machines before ordinary TLS access:

[Open the pairing diagram](diagrams/pairing.svg)

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant Pair as Pair CLI on hub machine
  participant Gateway as Gateway with listener + pairing window
  participant HubTrust as Hub machine peers.json
  participant GatewayTrust as Gateway machine peers.json
  User->>Gateway: gateway --lan --pair
  Gateway-->>User: One-time code (3 minutes, 5 exchange attempts)
  User->>Pair: pair HOST:PORT, enter code
  Pair->>Gateway: HTTPS on temporary random port, observe gateway certificate
  Note over Pair,Gateway: This channel authenticates nobody, the code is proved inside it
  Pair->>Gateway: POST /v1/pair/hello, then /start: device certificate + SPAKE2 share
  Gateway->>Gateway: Count attempt when exchange starts
  Gateway-->>Pair: Gateway identity + share + confirmation
  Pair->>Pair: Verify gateway confirmation using code
  Pair->>Gateway: POST /v1/pair/finish: session + confirmation + private-key proof
  Gateway->>Gateway: Verify caller confirmation
  Gateway->>GatewayTrust: Store caller as hub with pinned device certificate
  Gateway-->>Pair: Pairing succeeded, window closes
  Pair->>HubTrust: Store gateway with pinned device certificate
  Note over Pair,Gateway: Later hub connections use the pinned certificates and mutual TLS 1.3
```

SPAKE2 runs over P-256 with actual device IDs and binds both certificates, the session,
protocol version, and normal port. Pairing has a dedicated random-port HTTPS listener;
it never exposes application routes. The normal listener requires TLS 1.3 and client
certificates. Peer roles and exact certificate fingerprints authorize HTTP and WSS.
Trust updates are serialized across processes; revocation waits for running processes
to close affected connections. Legacy PSK pairings require registration again.
Outgoing HTTPS disables pooled agents. See [discovery](discovery.md#pairing) for details.

The hub's browser-facing HTTP/WebSocket listener is separate from gateway TLS.
It defaults to loopback, has no TLS or login, and applies origin checks to HTTP
requests and WebSocket upgrades. `--allow-origin` widens that exact-origin list.
The development bridge and direct TS WebSocket server also default to loopback
and have no authentication or TLS.

## Failure and recovery

[Open diagram as SVG](diagrams/recovery.svg)

The gateway applies the following lifecycle to each service; the hub applies the
same isolation principle to each gateway connection. This is a conceptual
lifecycle, not a list of exported status enum values.

```mermaid
stateDiagram-v2
  [*] --> Located: Valid manifest or gateway candidate
  Located --> Connecting: Open connection
  Connecting --> Live: Connected and protocol ready
  Connecting --> Retry: Connection fails
  Live --> Retry: Disconnect or invalid upstream message
  Retry --> Connecting: Exponential backoff with jitter
  Live --> Removed: Manifest or candidate removed
  Retry --> Removed: Manifest or candidate removed
  Connecting --> Removed: Manifest or candidate removed
  Removed --> [*]
  state Live {
    [*] --> Snapshot
    Snapshot --> Streaming: Replay current surfaces
    Streaming --> Streaming: Validate, cache, and forward updates
  }
```

| Event | Result |
| --- | --- |
| App connection drops or sends invalid updates | Gateway retracts that service's surfaces with `deleteSurface`, clears its snapshot, reports status/reason, and retries |
| App crashes leaving a manifest | Gateway keeps the advertisement, reports disconnection, and retries; it does not delete an app's manifest |
| Gateway connection drops or either WS closes | Hub closes the logical connection, retracts that node's surfaces, and retries independently of other nodes |
| Same service/node returns | Fresh snapshots restore its surfaces; dashboard panels retain their saved placement |
| Browser disconnects | Shared client clears its processor and retries after one second; the server initializes it from current snapshots |
| Browser sends invalid input | Bridge, gateway, or hub closes that client socket; other clients continue |
| Bridge child emits invalid JSONL | Bridge closes connected clients and terminates its child |
| SSH process exits | CLI exits the hub and cleans up the SSH forward; rerun to reconnect |
| Hub stops | Its own gateway child and SSH forward are cleaned up; reused or remote gateways remain running |

The hub and gateway recover connections, not application processes. Neither
restarts an app that has exited. A retained panel displays unavailability until
the referenced node/service/surface becomes available again.

## Catalogs and conformance

[Open diagram as SVG](diagrams/catalogs-conformance.svg)

Custom catalog generation is a build-time path, separate from discovery and
runtime message forwarding.

```mermaid
flowchart LR
  Catalog["Local A2UI catalog JSON<br/>and local schema references"]
  Codegen["CLI: generate catalog<br/>Normalize / hash / emit<br/>--check detects stale output"]
  Bindings["Generated TypeScript / Python / Rust<br/>catalog types and definitions"]
  App["Application declarations<br/>SDK builder + reconciler"]
  Wire["A2UI v0.9<br/>catalog ID + components + data"]
  Render["Renderer catalog implementations<br/>Bundled renderer: basicCatalog"]
  Schema["spec/ir.schema.json<br/>Normalized IR v2"]
  Fixtures["spec/fixtures/basic.json<br/>spec/fixtures/snapshot.json"]
  Tests["Independent SDK test suites<br/>TS bun:test / Python unittest / Rust tests"]
  Catalog --> Codegen
  Codegen --> Bindings
  Bindings --> App
  App --> Wire
  Wire --> Render
  App -.->|"Declaration contract"| Schema
  Tests -->|"Execute equivalent SDK scenarios"| App
  Tests -->|"Compare exact messages and snapshots"| Fixtures
```

Codegen reads local inputs and does not fetch schemas over the network. Generated
SDK types do not implement browser components: a custom catalog also needs a
matching renderer implementation. The bundled frontend currently registers the
basic catalog.

The SDKs have separate builders, reconcilers, transports, and snapshot code.
Shared fixtures check observable behavior across languages, including exact
message sequences and snapshot materialization. The server-side bridge and
aggregators use the shared `@omochi-ui/core` snapshot implementation. Protocol changes
must update the affected SDKs, their tests, and the shared fixtures together.

Gateway protocol version `1`, normalized IR version `2`, and A2UI wire version
`v0.9` describe different contracts. A gateway handshake validates its protocol
version; the renderer consumes the A2UI wire version.

## Implementation index

| Responsibility | Source |
| --- | --- |
| CLI dispatch, help, and command lifecycle | [`cli.ts`](../packages/cli/src/cli.ts), [`help.ts`](../packages/cli/src/help.ts) |
| App / Runtime / action dispatch | [TypeScript](../packages/sdk/typescript/src/app.ts), [Python](../packages/sdk/python/src/omochi_ui/app.py), [Rust](../packages/sdk/rust/src/app.rs) |
| Declarations and reconciliation | [TS builder](../packages/sdk/typescript/src/builder.ts), [TS reconciler](../packages/sdk/typescript/src/reconcile.ts), equivalent modules in each SDK |
| Direct Node server transports | [`typescript/src/node`](../packages/sdk/typescript/src/node) |
| Unix app publication | [TypeScript](../packages/sdk/typescript/src/node/unix-socket-server-transport.ts), [Python](../packages/sdk/python/src/omochi_ui/unix_server.py), [Rust](../packages/sdk/rust/src/unix_server.rs) |
| Stdio bridge | [`stdio-websocket-bridge.ts`](../packages/cli/src/stdio-websocket-bridge.ts) |
| Snapshot / validation / fan-out / routing | [`core/src`](../packages/core/src), especially [`prefix.ts`](../packages/core/src/prefix.ts) |
| Manifest provider and Unix connector | [`discovery/src/app`](../packages/discovery/src/app) |
| Gateway server / client / wire contract | [`server.ts`](../packages/discovery/src/gateway/server.ts), [`client.ts`](../packages/discovery/src/gateway/client.ts), [`protocol.ts`](../packages/discovery/src/gateway/protocol.ts) |
| Local / static / mDNS gateway lookup | [`locator.ts`](../packages/discovery/src/gateway/locator.ts), [`mdns.ts`](../packages/discovery/src/gateway/mdns.ts) |
| Identity, trust, pairing, TLS | [`discovery/src/auth`](../packages/discovery/src/auth) |
| Hub aggregation and origin checks | [`hub.ts`](../packages/cli/src/hub/hub.ts), [`services-http.ts`](../packages/core/src/services-http.ts) |
| Gateway supervision / SSH | [`gateway-supervisor.ts`](../packages/cli/src/hub/gateway-supervisor.ts), [`ssh-gateway.ts`](../packages/cli/src/hub/ssh-gateway.ts) |
| Dashboard storage / built asset server | [`dashboards.ts`](../packages/cli/src/hub/dashboards.ts), [`static-ui.ts`](../packages/cli/src/hub/static-ui.ts) |
| Shared browser connection / surfaces | [`client.ts`](../packages/renderer/src/client.ts), [`surface.tsx`](../packages/renderer/src/surface.tsx) |
| Dashboard frontend / layout / contracts | [`hub-ui/src`](../packages/hub-ui/src) |
| Single-app preview | [`dev-server/src`](../packages/dev-server/src) |
| Catalog generation | [`catalog-codegen.ts`](../packages/cli/src/catalog-codegen.ts) |
| Language-neutral contracts and fixtures | [`spec`](../spec) |
| Runnable applications | [`examples`](../examples) |

Mermaid blocks in this file are the editable diagram sources. Each SVG is rendered from its corresponding block; the overview PNG is rendered
from the first block. Export settings and instructions are in
[`diagrams/README.md`](diagrams/README.md). Update diagrams alongside changes to
process boundaries, transports, package dependencies, or persistence.
