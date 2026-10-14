import { createRequire } from 'node:module'
import path from 'node:path'

// Keep Bun's server implementation for ordinary HTTP/Unix endpoints. Remote mTLS
// needs npm ws: Bun 1.4.3's native client fails the pinned certificate handshake,
// and its server cannot upgrade HTTP connections handed off from node:tls.
// Loading the installed entry avoids Bun's
// hardcoded substitution of the bare "ws" import. No Node executable is used.
const require = createRequire(import.meta.url)
const implementation = require(path.join(path.dirname(require.resolve('ws/package.json')), 'index.js')) as typeof import('ws')
export const WebSocket = implementation.WebSocket
export const TlsWebSocketServer = implementation.WebSocketServer
export type WebSocket = import('ws').WebSocket
export { WebSocketServer } from 'ws'
