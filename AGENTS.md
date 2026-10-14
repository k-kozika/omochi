# Repository Guidelines

## Project Structure & Module Organization

This workspace implements the same declarative A2UI runtime in three languages. TypeScript lives in `packages/sdk/typescript/src`, Python in `packages/sdk/python/src/omochi_ui`, and Rust in `packages/sdk/rust/src`. The shared browser renderer is in `packages/renderer`, the development preview is in `packages/dev-server`, and the dashboard frontend is in `packages/hub-ui`; transport primitives shared by every server-side component are in `packages/core`; service discovery and the gateway are in `packages/discovery`; the CLI, the WebSocket bridge, and the discovery hub are in `packages/cli`; runnable integrations are under `examples/`. Shared protocol contracts and conformance data belong in `spec/`, especially `spec/ir.schema.json` and `spec/fixtures/basic.json`. Keep cross-language behavior aligned, and do not hand-edit generated `dist/` or `dist-test/` output.

## Build, Test, and Development Commands

- `bun install`: install workspace JavaScript dependencies (Bun 1.4.3+).
- `bun run build`: compile the TypeScript SDK and build the Vite dev server.
- `bun run test`: run TypeScript SDK, CLI, and dev-server tests.
- `bun run test:python`: run Python `unittest` tests with the local package on `PYTHONPATH`.
- `bun run test:rust`: run the Rust crate tests.
- `OMOCHI_MDNS_TEST=1 bun run --filter @omochi-ui/discovery test`: also run the real-multicast mDNS tests, which are skipped by default because most CI has no multicast. Run them by hand when bumping `bonjour-service`.
- `bun run --filter @omochi-ui/dev-server dev`: start the Vite frontend during renderer work.

For an end-to-end example, build first, then run `bun run omochi-ui dev -- uv run --project examples/python examples/python/app.py`.

## Coding Style & Naming Conventions

Follow the existing language idioms: two-space indentation, semicolons, and `camelCase` in TypeScript; four spaces and `snake_case` in Python; standard `rustfmt` layout and `snake_case` in Rust. Use `PascalCase` for exported types and classes. Name modules after responsibilities (`transport`, `reconcile`, `catalog`) and preserve equivalent concepts across SDKs. Run `bun run --filter @omochi-ui/dev-server lint` for frontend linting and `cargo fmt --manifest-path packages/sdk/rust/Cargo.toml` for Rust formatting.

## Testing Guidelines

TypeScript uses `bun:test` through the disposal helper in `@omochi-ui/core/testing`, Python uses `unittest`, and Rust uses built-in `#[test]`/`#[tokio::test]`. Put tests in each package's `test` or `tests` directory and follow existing names such as `runtime.test.ts`, `test_runtime.py`, and descriptive Rust function names. Changes to protocol messages, IDs, reconciliation, or component catalogs should update all affected SDK tests and the shared fixture. No numeric coverage threshold is configured; prioritize exact message-sequence and regression assertions.

## Commit & Pull Request Guidelines

Use short, imperative commit subjects such as `align rust reconciliation fixtures`, keeping each commit focused. Pull requests should explain behavior and affected SDKs, list verification commands, and link relevant issues. Include screenshots for renderer/UI changes and call out intentional schema or fixture changes.

## Security & Configuration

The dev server is unauthenticated and has no TLS. Keep its default `127.0.0.1` binding unless external exposure is explicitly required, and never commit credentials or local environment files.

Local service discovery trusts `$XDG_RUNTIME_DIR` being mode 0700: reaching a service's `a2ui.sock`, or the gateway's `gateway.sock`, is the only authentication. Because WebSocket upgrades are exempt from CORS, the hub restricts both upgrades and its HTTP endpoints to loopback origins unless `--allow-origin` widens the list — keep that check when touching `packages/cli/src/hub`. A manifest is written by an arbitrary local process, so keep validating `serviceId`, `socket`, and `icon` before acting on one.

Remote access is off unless asked for. A gateway binds TCP only with `--listen` (or `--lan`). Normal HTTPS/WSS requires TLS 1.3 and mutually authenticated device certificates, pinned to an exact certificate fingerprint and peer role. Keep both TLS version bounds pinned in `packages/discovery/src/auth/tls.ts`. On Bun 1.4.3 the remote TLS path uses the installed `ws` package because native ws cannot complete the pinned mTLS handshake or upgrade the TLS socket passed to HTTP. Ordinary HTTP/Unix WebSocket servers still use Bun's built-in implementation. Never weaken verification to work around runtime limitations.

`--pair` opens a separate temporary HTTPS listener on an OS-selected port, exposing only pairing routes. The CLI prints that port; it differs from the normal gateway port. Initial TLS has no trusted identity yet: SPAKE2 authenticates the code and binds both device IDs, roles, certificate fingerprints, session nonce, protocol version and normal service port. Verify private-key possession and both confirmations before registering a peer. Never derive a TLS key from the short code. Count a guess when an exchange starts, not when confirmation fails. Keep the RFC 9382 Appendix B vectors unchanged.

TLS-PSK trust records are not migrated into trusted certificates; require re-pairing. Store writes are serialized across processes and re-read under the lock. `trust forget` succeeds only after all registered live processes acknowledge updated authorization and destruction of revoked connections; acknowledgement failure must remain an error. Do not restore deleted records from stale caches. Outgoing HTTPS uses `agent: false`, and WSS must not reuse TLS sessions across credentials. mDNS is discovery only: TXT records contain protocol version, node ID and base path, never pairing codes or secrets.
