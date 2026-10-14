# @omochi-ui/discovery

Finding and reaching omochi backends. Both ends of every wire contract live here
together, so the publishing and consuming halves cannot drift apart.

## The app registry

An application publishes itself as `<runtime root>/<serviceId>/manifest.json` beside a
unix domain socket. This package watches that layout, validates the manifests, and dials
the sockets.

- `omochiRuntimeRoot` / `ensureRuntimeRoot`: the `$XDG_RUNTIME_DIR/omochi` trust boundary.
- `createXdgManifestProvider`: reports services as they appear, change, and disappear.
- `createUnixConnector`: connects to one discovered service's socket.

## The gateway

`startGateway` publishes every service running for the current user as one A2UI stream.
It is the only component that knows where an application lives, so a hub can consume the
result without ever touching the filesystem — which is what lets the same contract serve
a hub running on another machine.

It listens on `<runtime root>/gateway.sock` and speaks HTTP and WebSocket over it, so a
client dials it with `ws+unix:<socket path>:<route>`. The same four routes will serve a
remote hub over TCP unchanged:

| route | purpose |
| --- | --- |
| `GET /v1/node` | identity handshake: protocol version, node id, name |
| `GET /v1/services` | the current service list |
| `WS /v1/control` | the service list pushed on every change, plus ping/pong |
| `WS /v1/a2ui` | A2UI v0.9 for the whole node, surfaces namespaced `<serviceId>/<surfaceId>` |

`/v1/a2ui` carries nothing but standard A2UI v0.9, identical to what the hub serves on
`/ws`, so any renderer can attach to a gateway directly for debugging.

## Identity and trust

`loadNodeIdentity` reads or creates this machine's node ID, P-256 key and self-signed
device certificate under
`$XDG_CONFIG_HOME/omochi/node.json`; `openTrustStore` manages the peers it has been paired
with in `peers.json` beside it. Files are replaced atomically at mode 0600, with
read/modify/write serialized across processes. Revocation waits for live hubs and
gateways to acknowledge the updated trust and close affected connections.

`openPairingWindow` and `pairWithGateway` introduce the devices over a temporary
HTTPS listener on a separate random port. Its initially untrusted certificate is
bound into SPAKE2 (`auth/spake2.ts`, RFC 9382 over P-256), along with both device
IDs, roles, certificates, session and normal gateway port. The hub proves ownership
of its enrolled private key. Subsequent connections require TLS 1.3 and mutual
authentication with the exact pinned device certificates. Legacy PSK records require
re-pairing; they grant no access. See the [pairing guide](../../docs/discovery.md#pairing).

`test/spake2.test.ts` gates the implementation on the RFC's own Appendix B test vectors —
they live in `test/fixtures/spake2-rfc9382.json`, and if they do not reproduce byte for
byte, nothing ships.

`advertiseGateway` and `createMdnsLocator` are the two halves of discovery. The
`bonjour-service` dependency is imported inside those functions, so nothing loads it
unless a gateway advertises or a hub browses — `omochi-ui dev` and the bridge never pay
for it.

`@omochi-ui/discovery/testing` exports `fakeService`, a stand-in for an SDK application
publishing itself over a unix socket.
