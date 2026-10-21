/**
 * The wire contract between one machine's gateway and a hub.
 *
 * Both ends of it live in this package so the server and the client cannot drift
 * apart. The same contract is spoken over a unix socket locally and over TCP
 * remotely, so nothing here may assume an origin, a hostname, or a port.
 */
import { randomBytes } from 'node:crypto'
import type { RequestOptions } from 'node:http'

import { isValidNodeId, type ServiceView } from '@omochi-ui/core'

/** Bumped on any breaking change. A hub refuses a version it does not know. */
export const GATEWAY_PROTOCOL = 2

export const GATEWAY_NODE_PATH = '/v1/node'
export const GATEWAY_SERVICES_PATH = '/v1/services'
export const GATEWAY_CONTROL_PATH = '/v1/control'
export const GATEWAY_A2UI_PATH = '/v1/a2ui'

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * Ten random bytes encode to exactly sixteen base32 characters, so the id needs no
 * padding. A gateway generates one per process until identities are persisted.
 */
export function randomNodeId(): string {
  let bits = 0
  let accumulator = 0
  let encoded = ''
  for (const byte of randomBytes(10)) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      encoded += BASE32_ALPHABET[(accumulator >>> bits) & 31]
    }
  }
  return encoded
}

/** The identity handshake answered by `GET /v1/node`. */
export interface GatewayNodeInfo {
  protocol: number
  nodeId: string
  name: string
  services: number
  uptimeMs: number
}

/** The body of `GET /v1/services`. */
export interface GatewayServicesBody {
  nodeId: string
  services: ServiceView[]
}

/** Frames a gateway sends on `/v1/control`. */
export type GatewayControlFrame =
  | { t: 'services'; nodeId: string; services: ServiceView[] }
  | { t: 'bye'; reason: string }
  | { t: 'pong'; id: number }

/** Frames a hub sends on `/v1/control`. */
export type HubControlFrame = { t: 'ping'; id: number }

export function parseHubControlFrame(value: unknown): HubControlFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.t !== 'ping' || typeof record.id !== 'number') return null
  return { t: 'ping', id: record.id }
}

/** Where a gateway can be reached. The local one is always a unix socket. */
export type GatewayEndpoint =
  | { kind: 'unix'; socketPath: string }
  | { kind: 'tcp'; host: string; port: number }

/** A stable key for one endpoint, so a hub can dedupe before it knows the node id. */
export function gatewayEndpointKey(endpoint: GatewayEndpoint): string {
  return endpoint.kind === 'unix' ? `unix:${endpoint.socketPath}` : `tcp:${endpoint.host}:${endpoint.port}`
}

/** A TCP gateway is always `wss:`; only a unix socket is trusted in the clear. */
export function gatewayWsUrl(endpoint: GatewayEndpoint, route: string): string {
  return endpoint.kind === 'unix'
    ? `ws+unix:${endpoint.socketPath}:${route}`
    : `wss://${endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}${route}`
}

export function gatewayRequestOptions(endpoint: GatewayEndpoint, route: string): RequestOptions {
  return endpoint.kind === 'unix'
    ? { socketPath: endpoint.socketPath, path: route, method: 'GET' }
    : { host: endpoint.host, port: endpoint.port, path: route, method: 'GET' }
}

/** Validates the identity handshake. A hub refuses anything it cannot fully understand. */
export function parseGatewayNodeInfo(value: unknown): GatewayNodeInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.protocol !== GATEWAY_PROTOCOL) return null
  if (typeof record.nodeId !== 'string' || !isValidNodeId(record.nodeId)) return null
  if (typeof record.name !== 'string' || !record.name) return null
  const services = typeof record.services === 'number' ? record.services : 0
  const uptimeMs = typeof record.uptimeMs === 'number' ? record.uptimeMs : 0
  return { protocol: GATEWAY_PROTOCOL, nodeId: record.nodeId, name: record.name, services, uptimeMs }
}

export function parseGatewayControlFrame(value: unknown): GatewayControlFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.t === 'services') {
    if (typeof record.nodeId !== 'string' || !Array.isArray(record.services)) return null
    return { t: 'services', nodeId: record.nodeId, services: record.services as ServiceView[] }
  }
  if (record.t === 'bye') return { t: 'bye', reason: typeof record.reason === 'string' ? record.reason : 'closed' }
  if (record.t === 'pong' && typeof record.id === 'number') return { t: 'pong', id: record.id }
  return null
}
