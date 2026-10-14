# Contributing

Start with the [architecture](docs/architecture.md) and [CLI reference](packages/cli/README.md)
to find the component you want to change. Development commands run from the
repository root unless stated otherwise.

## Setup

Use Bun 1.4.3 or newer, with the version pinned in `.bun-version` and
`package.json`. Node.js is not required. Python changes need Python 3.11+; Rust changes need
Rust 1.85+ and Cargo. The Python example uses uv. Discovery tests use Unix domain sockets and a Unix-like environment.

```sh
bun install
bun run build
```

Follow the [quick start](README.md#quick-start) to run an app in the browser.
For hub frontend work, run `bun run omochi-ui hub` and, in another terminal,
`bun run --filter @omochi-ui/hub-ui dev`. The frontend proxies the hub on port 5555;
set `OMOCHI_HUB` to use another address.

## Verification

| Change | Verification |
| --- | --- |
| JavaScript/TypeScript workspace | `bun run test` (builds all packages, then runs tests) |
| CLI after building dependencies | `bun run --filter @omochi-ui/cli test` |
| Python SDK | `bun run test:python` |
| Rust SDK | `bun run test:rust` |
| Preview frontend | `bun run --filter @omochi-ui/dev-server lint` |
| Dashboard frontend | `bun run --filter @omochi-ui/hub-ui lint` |
| Rust formatting | `cargo fmt --manifest-path packages/sdk/rust/Cargo.toml --check` |

Run the checks affected by your change. Protocol messages, stable IDs,
reconciliation, and component catalogs must stay aligned across all three SDKs;
update their tests and shared fixtures in `spec/fixtures` together.

After building, `bun packages/hub-ui/test/browser.mjs` runs the dashboard browser
smoke test with Chromium. Set `CHROMIUM_BIN` if necessary. Screenshots go to
`/tmp/omochi-hub-screenshots`, or `SCREENSHOT_DIR` when set.

Real multicast tests are opt-in because many environments cannot use multicast:

```sh
OMOCHI_MDNS_TEST=1 bun run --filter @omochi-ui/discovery test
```

Run those when changing mDNS integration or updating `bonjour-service`.

## Changes and pull requests

Keep changes focused and follow the surrounding language conventions. Do not
hand-edit generated `dist/` or `dist-test/` files. Put regression tests alongside
the affected package's existing tests. CLI changes should update command help
and the CLI reference; architecture or protocol changes should update the diagrams
and relevant guides.

Explain the problem, resulting behavior, affected SDKs, and verification in the
pull request. Include screenshots for renderer or dashboard changes and call out
intentional schema or fixture changes. Use short, imperative commit subjects.

Keep loopback defaults and origin checks intact. Never commit credentials, local
environment files, or pairing state. Runtime manifests are untrusted input; keep
service IDs, socket names, and icons validated. See [AGENTS.md](AGENTS.md) for
repository-specific implementation and security constraints.
