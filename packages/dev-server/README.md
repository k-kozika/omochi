# @omochi-ui/dev-server: browser preview

The standalone Vite preview for one A2UI application, using the shared
`@omochi-ui/renderer` React package. See the [quick start](../../README.md#quick-start)
and [architecture](../../docs/architecture.md#preview-one-app).

After `bun install` and `bun run build`, start the browser frontend:

```sh
bun run --filter @omochi-ui/dev-server dev
```

In another terminal, launch the app and its bridge:

```sh
bun run omochi-ui dev -- uv run --project examples/python examples/python/app.py
```

Open `http://127.0.0.1:5173/`. Vite proxies `/ws` to
`http://127.0.0.1:5555` by default; set `OMOCHI_HUB` before starting Vite to change
that target. A `ws` query parameter selects a direct `ws:` or `wss:` endpoint,
for example `http://127.0.0.1:5173/?ws=ws://127.0.0.1:5557/ws`.
Use the port printed by Vite if 5173 was occupied.

The preview shows every surface on its connection. For service selection and
saved dashboard layouts, use `bun run omochi-ui hub`, which serves the separate
hub UI at `http://127.0.0.1:5555/` without needing Vite. Stop the development
bridge first or choose a different hub port.

Build output lives under `dist/`; do not edit generated files.
