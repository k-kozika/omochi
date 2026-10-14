import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ConnectionOptions } from 'node:tls'

import type { ServiceView } from '@omochi-ui/core'
import { WebSocket } from '@omochi-ui/core/websocket'

import {
  GATEWAY_A2UI_PATH,
  GATEWAY_CONTROL_PATH,
  GATEWAY_NODE_PATH,
  gatewayRequestOptions,
  gatewayWsUrl,
  parseGatewayControlFrame,
  parseGatewayNodeInfo,
  type GatewayEndpoint,
  type GatewayNodeInfo,
} from './protocol.js'

export interface GatewayHandlers {
  /** Fires once the identity handshake and both sockets are up. */
  onOpen(node: GatewayNodeInfo): void
  /** Every frame carries the whole list, so there are no deltas to reconcile. */
  onServices(services: ServiceView[]): void
  /** One A2UI v0.9 message, still namespaced by the gateway's bare service ids. */
  onMessage(message: unknown): void
  /** Fires exactly once, for a clean close, a socket error, or a rejected handshake. */
  onClose(detail: string): void
}

export interface GatewayClient {
  send(message: unknown): void
  close(): void
}

export interface GatewayConnectOptions {
  /**
   * TLS options for a TCP gateway. Required for one: without a pinned certificate there is
   * nothing to authenticate the peer with, and an unauthenticated LAN peer is exactly
   * what this design refuses to talk to.
   */
  tls?: ConnectionOptions
  /** Must match the identity advertised inside the authenticated connection. */
  expectedNodeId?: string
}

const HANDSHAKE_TIMEOUT_MS = 5000

function fetchNodeInfo(endpoint: GatewayEndpoint, tls?: ConnectionOptions, expectedNodeId?: string): Promise<GatewayNodeInfo> {
  const send = endpoint.kind === 'unix' ? httpRequest : httpsRequest
  const options = {
    ...gatewayRequestOptions(endpoint, GATEWAY_NODE_PATH),
    ...(tls ?? {}),
    // Node's agent pools by host and port, not by credentials, so a pooled socket could
    // answer a request that presented an entirely different key. Each probe gets its own.
    agent: false as const,
  }
  return new Promise((resolvePromise, reject) => {
    const outgoing = send(options, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`the gateway answered ${GATEWAY_NODE_PATH} with ${response.statusCode}`))
        return
      }
      let payload = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        payload += chunk
      })
      response.on('end', () => {
        let parsed: GatewayNodeInfo | null = null
        try {
          parsed = parseGatewayNodeInfo(JSON.parse(payload))
        } catch {
          parsed = null
        }
        // An unknown protocol version is reported rather than half-spoken.
        if (!parsed) reject(new Error('the gateway sent an identity this hub does not understand'))
        else if (expectedNodeId !== undefined && parsed.nodeId !== expectedNodeId) reject(new Error('the gateway identity does not match its pinned node'))
        else resolvePromise(parsed)
      })
    })
    outgoing.setTimeout(HANDSHAKE_TIMEOUT_MS, () => outgoing.destroy(new Error('the gateway did not answer in time')))
    outgoing.on('error', reject)
    outgoing.end()
  })
}

/**
 * Asks a gateway who it is, without opening a stream.
 *
 * Returns null when nothing is listening or the answer is not an identity this hub
 * understands, so a caller can tell "no gateway here" from "a gateway that works".
 */
export async function probeGateway(
  endpoint: GatewayEndpoint,
  options: GatewayConnectOptions = {},
): Promise<GatewayNodeInfo | null> {
  try {
    if (endpoint.kind === 'tcp' && !options.tls) return null
    return await fetchNodeInfo(endpoint, options.tls, options.expectedNodeId)
  } catch {
    return null
  }
}

/**
 * Connects one hub to one gateway.
 *
 * The control channel and the A2UI channel come up together and go down together: the
 * service list is only meaningful alongside the stream it describes, so a half-open pair
 * is torn down and reported instead of being carried. Reconnection is the caller's, so
 * one backoff governs the whole node.
 */
export function connectGateway(
  endpoint: GatewayEndpoint,
  handlers: GatewayHandlers,
  options: GatewayConnectOptions = {},
): GatewayClient {
  let control: WebSocket | null = null
  let a2ui: WebSocket | null = null
  let finished = false
  let opened = 0
  // A gateway replays its snapshot the moment a socket attaches, so frames can arrive
  // before the other socket has opened. Holding them keeps the contract simple for the
  // caller: `onOpen` always comes first, and nothing is lost to socket ordering.
  let pending: Array<() => void> | null = []

  const deliver = (emit: () => void) => {
    if (finished) return
    if (pending) pending.push(emit)
    else emit()
  }

  const flush = (node: GatewayNodeInfo) => {
    const buffered = pending ?? []
    pending = null
    handlers.onOpen(node)
    for (const emit of buffered) {
      if (finished) return
      emit()
    }
  }

  const finish = (detail: string) => {
    if (finished) return
    finished = true
    pending = null
    control?.terminate()
    a2ui?.terminate()
    control = null
    a2ui = null
    handlers.onClose(detail)
  }

  const attach = (socket: WebSocket, onFrame: (value: unknown) => void, node: GatewayNodeInfo) => {
    socket.on('open', () => {
      opened += 1
      if (opened === 2 && !finished) flush(node)
    })
    socket.on('error', (error) => finish(error.message))
    socket.on('close', () => finish('the gateway connection closed'))
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        finish('the gateway sent a binary frame')
        return
      }
      try {
        onFrame(JSON.parse(data.toString()))
      } catch (error) {
        finish(error instanceof Error ? error.message : String(error))
      }
    })
  }

  if (endpoint.kind === 'tcp' && !options.tls) {
    // Fail loudly rather than reaching a LAN peer with no way to authenticate it.
    setTimeout(() => finish('a TCP gateway needs a pinned certificate; pair with it first'), 0)
    return { send() {}, close() { finish('closed by the hub') } }
  }

  void fetchNodeInfo(endpoint, options.tls, options.expectedNodeId).then(
    (node) => {
      if (finished) return
      const socketOptions = { ...(options.tls ?? {}), agent: false as const }
      control = new WebSocket(gatewayWsUrl(endpoint, GATEWAY_CONTROL_PATH), socketOptions)
      a2ui = new WebSocket(gatewayWsUrl(endpoint, GATEWAY_A2UI_PATH), socketOptions)
      attach(control, (value) => {
        const frame = parseGatewayControlFrame(value)
        if (!frame) return
        if (frame.t === 'services') deliver(() => handlers.onServices(frame.services))
        else if (frame.t === 'bye') finish(frame.reason)
      }, node)
      attach(a2ui, (value) => deliver(() => handlers.onMessage(value)), node)
    },
    (error: Error) => finish(error.message),
  )

  return {
    send(message) {
      if (!finished && a2ui?.readyState === WebSocket.OPEN) a2ui.send(JSON.stringify(message))
    },
    close() {
      finish('closed by the hub')
    },
  }
}
