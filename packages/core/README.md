# @omochi-ui/core

Transport primitives shared by every server-side omochi-ui component: the hub, the
gateway, and the stdio/WebSocket bridge.

Nothing here knows about service discovery or about where a backend lives. The package
carries the JSONL reader, the child-process session, the WebSocket endpoint and fan-out,
the A2UI v0.9 client-frame validator and replayable snapshot, the `/services` and
`/events` HTTP endpoints, and the surface-id prefixing that namespaces one backend's
surfaces inside a merged stream.

`@omochi-ui/core/testing` exports the helpers those components' test suites share.
