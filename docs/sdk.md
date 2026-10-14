# SDK guide

[Overview](../README.md) · [Architecture](architecture.md) · [CLI reference](../packages/cli/README.md)

Examples below use the local packages in this repository. Build the workspace
before running TypeScript examples. The APIs produce A2UI v0.9 messages;
`app.start()` alone uses stdin/stdout and does not open a browser.

## Python

```python
import asyncio

from omochi_ui import App

state = {"temperature": 50, "result": None}
app = App(state)

@app.action("run")
async def run(input, ctx):
    await ctx.update(lambda state: state.update(
        temperature=input["temperature"],
        result=f'Result: {input["temperature"]}',
    ))

@app.surface("main")
def main(ui, state):
    form = ui.local("form", {"temperature": state["temperature"]})
    ui.text("Hello", key="title")
    ui.slider("temperature", 0, 100, bind=form.bind("/temperature"))
    ui.button("Run", run.call({"temperature": form.value("/temperature")}))
    if state["result"]:
        ui.text(state["result"], key="result")

asyncio.run(app.start())  # JSONL over stdin/stdout by default
```

Run the bundled example from the repository root:

```sh
uv run --project examples/python examples/python/app.py
```

See the [quick start](../README.md#quick-start) to connect it to a browser.

## TypeScript

```ts
import { App } from "@omochi-ui/sdk";

const state = { temperature: 50, result: null as string | null };
const app = new App(state);

const run = app.action<{ temperature: number }>("run", async (input, ctx) => {
  await ctx.update((state) => {
    state.temperature = input.temperature;
    state.result = `Result: ${input.temperature}`;
  });
});

app.surface("main", (ui, state) => {
  const form = ui.local("form", { temperature: state.temperature });
  ui.text("Hello", { key: "title" });
  ui.slider("temperature", 0, 100, { bind: form.bind("/temperature") });
  ui.button("Run", run.call({ temperature: form.value("/temperature") }));
  if (state.result) ui.text(state.result, { key: "result" });
});

await app.start();
```

In Node.js, the application can also host WebSocket renderers directly without
the stdio bridge:

```ts
import { WebSocketServerTransport } from "@omochi-ui/sdk/node";

const transport = new WebSocketServerTransport({ port: 5555 });
await app.start(transport);
```

The server listens on `127.0.0.1` at `/ws` by default. It broadcasts one shared
application state to every connected client and sends a compact snapshot to
clients that join later. Use `host` and `path` to override the listener, `port: 0`
to select an available port, `await transport.ready` before reading
`transport.url`, and `await transport.close()` for graceful shutdown. The direct
server has no authentication or TLS; keep the loopback default unless external
exposure is explicitly intended.

## Rust

The crate is named `omochi-ui` and imported as `omochi_ui`. Typed application
state is mutated only through Runtime transactions.

```rust
use omochi_ui::{App, ButtonOptions, Result, SliderOptions};
use serde::Deserialize;

#[derive(Default)]
struct State { result: Option<f64> }
#[derive(Deserialize)]
struct RunInput { temperature: f64 }

#[tokio::main]
async fn main() -> Result<()> {
    let mut app = App::new(State::default());
    let run = app.action::<RunInput, _, _>("run", |input, context| async move {
        context.update(|state| { state.result = Some(input.temperature); }).await?;
        Ok(())
    })?;
    app.surface("main", move |ui, state| {
        let form = ui.local("form", serde_json::json!({ "temperature": 50.0 }))?;
        ui.text("Hello")?;
        ui.slider("temperature", 0.0, 100.0,
            SliderOptions { bind: Some(form.bind("/temperature")?), ..Default::default() })?;
        ui.button("Run", run.call(serde_json::json!({ "temperature": form.value("/temperature")? }))?, ButtonOptions::default())?;
        if let Some(result) = state.result {
            ui.text(result)?;
        }
        Ok(())
    })?;
    app.start().await
}
```

## Components and catalogs

The Basic Catalog exposes typed high-level APIs for all 18 A2UI v0.9 components,
including media, layouts, cards, tabs, modals, controls, and date/time input. Use
`component()` when you need the wire-level properties directly; its component name
selects the corresponding generated property type.

Generate typed bindings for a local custom catalog before compiling your application:

```sh
bun run omochi-ui generate catalog \
  --catalog ./catalog.json \
  --name ProductCatalog \
  --typescript ./src/generated/product-catalog.ts \
  --python ./src/generated/product_catalog.py \
  --rust ./src/generated/product_catalog.rs
```

Pass any subset of the three output flags. Add `--check` in CI to fail when an
existing generated file is stale. Generation is local-only and never fetches schemas
over the network.

The bundled preview and hub renderer use the Basic Catalog. Generated bindings
for a custom catalog also require a compatible renderer implementation; generating
bindings alone does not add those components to the bundled browser UI.

## State and actions

- `App` defines typed actions and surfaces; `App.build()` creates the transport-independent `Runtime`.
- `ui.local()` declares renderer-owned draft state. Its initial value is applied once and is preserved across rerenders; use `resetKey` / `reset_key` / `local_with` for an explicit reset.
- Actions receive only concrete typed input and `context.update()`. They cannot inspect a Surface, renderer model, binding, or transport.
- Each awaited `context.update()` mutates state, renders every Surface, and sends
  the resulting differences before returning. Completion means the transport's
  `send()` calls have completed, not that a browser has finished painting.
- `runtime.update()` remains ordered behind an active action. Actions are still
  serial; publishing progress does not allow another action to run concurrently.
- `runtime.handle()` accepts `getSurface` observations and `invoke` commands as JSON.
- Component keys become A2UI component IDs. The root ID is always `root` as
  required by A2UI. Use explicit keys for conditional or reorderable content.

### Progress during an action

In all three SDKs, await each context update before continuing the operation:

```python
@app.action("run")
async def run(input, context):
    await context.update(lambda state: setattr(state, "status", "Working"))
    await do_work(input)
    await context.update(lambda state: setattr(state, "status", "Done"))
```

Multiple updates in an action expose intermediate states. Group
changes in one mutator when they should appear together. The action's `invoke()`
or `handle()` result contains all generated messages in order, including those
already sent; they are not sent a second time at action completion. Without an
attached transport, these methods still return the same generated message list.

Update, rendering, and transport errors propagate through `context.update()`.
An action error does not roll back state changes or messages already sent. Await
updates within the action's lifetime; use `runtime.update()` for independent
background work. Calling and awaiting `runtime.update()` from an active action
would wait on that same action.

## Renderer-local inputs

Bind editable components to a `Local` returned by `ui.local()`. `Local.value()`
builds an Action input expression; the renderer resolves it when the user invokes
the action, so the Runtime receives concrete JSON and never stores the draft.

## Transports

The Python and TypeScript SDKs include stdio, WebSocket-like, and callback
transports. Rust exposes `StdioTransport`, a `Transport` trait, and
`CallbackTransport` for framework adapters.

TypeScript additionally exports the Node-only multi-client
`WebSocketServerTransport` from `@omochi-ui/sdk/node`.

All transports use the same JSON messages; adapters can carry them over
WebSocket, A2A, AG-UI, SSE, or another channel without changing app semantics.
`Transport` represents one duplex connection and does not own history or session
routing. TypeScript and Python use `await app.start(transport?)`; omitting the
transport selects stdio. Rust uses `app.start()` for stdio and
`app.start_with(transport)` for an explicitly supplied adapter because Rust has
no default function arguments.

Transport capability sets are passed to the reconciler before the first surface
is rendered.

TypeScript, Python, and Rust each export a `UnixSocketServerTransport` that hosts
one application on a discoverable unix domain socket; see [Discovery and dashboards](discovery.md).

The A2UI wire format has no omochi-ui session envelope. A `Transport` still hosts
exactly one application, and session membership stays outside the messages: the
hub keeps one connection per service and namespaces surface ids instead of
wrapping the frames.
