import { isValidNodeId } from '@omochi-ui/core'

import { gatewayEndpointKey, type GatewayEndpoint } from './protocol.js'

/**
 * One gateway a hub could try to reach.
 *
 * `nodeId` is whatever the candidate's source claimed before any connection was made,
 * so it is only ever used to dedupe. The identity handshake is what the hub believes.
 */
export interface GatewayCandidate {
  /** Stable per endpoint, so the hub dedupes candidates it has not yet connected to. */
  readonly key: string
  readonly endpoint: GatewayEndpoint
  readonly source: 'local' | 'static' | 'mdns'
  readonly nodeId?: string
}

export interface GatewayLocatorSink {
  found(candidate: GatewayCandidate): void
  lost(key: string): void
}

export interface GatewayLocator {
  readonly kind: string
  start(sink: GatewayLocatorSink): Promise<void>
  close(): Promise<void>
}

function candidate(
  endpoint: GatewayEndpoint,
  source: GatewayCandidate['source'],
  nodeId?: string,
): GatewayCandidate {
  const found: GatewayCandidate = { key: gatewayEndpointKey(endpoint), endpoint, source }
  return nodeId === undefined ? found : { ...found, nodeId }
}

/**
 * The gateway on this machine.
 *
 * It is reported unconditionally and never withdrawn: reaching the socket is the whole
 * trust boundary, and a gateway that is not up yet is the hub's own reconnect loop to
 * worry about, not a reason to forget the endpoint exists.
 */
export function createLocalLocator(socketPath: string): GatewayLocator {
  return {
    kind: 'local',
    async start(sink) {
      sink.found(candidate({ kind: 'unix', socketPath }, 'local'))
    },
    async close() {},
  }
}

/**
 * Gateways named explicitly with `--gateway`.
 *
 * This is a first-class path, not a test seam: multicast does not cross a VLAN or a VPN
 * and is missing entirely in most containers, so naming a peer has to keep working.
 */
export function createStaticLocator(
  endpoints: readonly GatewayEndpoint[],
  nodeIds: ReadonlyMap<string, string> = new Map(),
): GatewayLocator {
  return {
    kind: 'static',
    async start(sink) {
      for (const endpoint of endpoints) {
        sink.found(candidate(endpoint, 'static', nodeIds.get(gatewayEndpointKey(endpoint))))
      }
    },
    async close() {},
  }
}

export interface ParsedGatewayTarget {
  endpoint: GatewayEndpoint
  /**
   * Which node is expected there, so a hub can select its pinned certificate
   * before opening a remote connection.
   */
  nodeId?: string
}

/**
 * Parses a `--gateway` value: a path to a unix socket, or `[<nodeId>@]host:port`.
 *
 * A bare path is the common case locally, so anything containing `/` is a socket.
 */
export function parseGatewayTarget(value: string): ParsedGatewayTarget | null {
  if (!value) return null
  if (value.includes('/')) return { endpoint: { kind: 'unix', socketPath: value } }

  const at = value.indexOf('@')
  const nodeId = at > 0 ? value.slice(0, at) : null
  const authority = at > 0 ? value.slice(at + 1) : value
  if (nodeId !== null && !isValidNodeId(nodeId)) return null

  const separator = authority.lastIndexOf(':')
  if (separator <= 0) return null
  const host = authority.slice(0, separator)
  const port = Number(authority.slice(separator + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  const endpoint: GatewayEndpoint = { kind: 'tcp', host, port }
  return nodeId === null ? { endpoint } : { endpoint, nodeId }
}
