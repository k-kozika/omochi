/**
 * A2UI v0.9 carries no service envelope, so every aggregation layer namespaces surface
 * ids as `<channelId>/<surfaceId>` on the way out and strips the prefix on the way back.
 *
 * A gateway namespaces by service id. A hub receives an already-namespaced stream and
 * re-namespaces it by `<nodeId>~<serviceId>`, which is what keeps two machines running
 * the same service from colliding.
 */
import { isValidChannelId, joinRouteId } from './service-id.js'

/** Surface id carriers in the four A2UI v0.9 server messages. */
const SERVER_SURFACE_KEYS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'] as const

/**
 * Surface id carriers in A2UI v0.9 client messages. `A2uiClientMessageSchema` is
 * `{version} & ({action} | {error})` and both error variants carry a surfaceId too.
 */
const CLIENT_SURFACE_KEYS = ['action', 'error'] as const

export function joinSurfaceId(channelId: string, surfaceId: string): string {
  return `${channelId}/${surfaceId}`
}

export function splitSurfaceId(prefixed: string): { channelId: string; surfaceId: string } | null {
  const separator = prefixed.indexOf('/')
  if (separator <= 0 || separator === prefixed.length - 1) return null
  const channelId = prefixed.slice(0, separator)
  if (!isValidChannelId(channelId)) return null
  return { channelId, surfaceId: prefixed.slice(separator + 1) }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Namespaces the surface id of one backend message before it reaches a renderer. */
export function prefixServerMessage(channelId: string, message: unknown): unknown {
  const record = asRecord(message)
  if (!record) return message
  for (const key of SERVER_SURFACE_KEYS) {
    const body = asRecord(record[key])
    if (!body || typeof body.surfaceId !== 'string') continue
    return { ...record, [key]: { ...body, surfaceId: joinSurfaceId(channelId, body.surfaceId) } }
  }
  return message
}

/**
 * Widens an already-namespaced server message from a gateway's channel to a hub's.
 *
 * Returns null when the message carries a surface id the gateway failed to namespace:
 * forwarding it would let one node's surface collide with another's.
 */
export function readdressServerMessage(nodeId: string, message: unknown): unknown | null {
  const record = asRecord(message)
  if (!record) return message
  for (const key of SERVER_SURFACE_KEYS) {
    const body = asRecord(record[key])
    if (!body || typeof body.surfaceId !== 'string') continue
    const split = splitSurfaceId(body.surfaceId)
    if (!split) return null
    const surfaceId = joinSurfaceId(joinRouteId(nodeId, split.channelId), split.surfaceId)
    return { ...record, [key]: { ...body, surfaceId } }
  }
  return message
}

/**
 * Restricts the renderer's client data model to one channel.
 *
 * The SPA keeps a single MessageProcessor, so `getClientDataModel()` returns the union
 * across every service. Forwarding it verbatim would hand one backend the other backends'
 * surfaces, including the `/$local` drafts the user is still typing.
 */
function scopeClientDataModel(dataModel: Record<string, unknown>, channelId: string): Record<string, unknown> {
  const surfaces = asRecord(dataModel.surfaces)
  if (!surfaces) return dataModel
  const scoped: Record<string, unknown> = {}
  for (const [prefixed, value] of Object.entries(surfaces)) {
    const split = splitSurfaceId(prefixed)
    if (split?.channelId === channelId) scoped[split.surfaceId] = value
  }
  return { ...dataModel, surfaces: scoped }
}

function scopeMetadata(metadata: Record<string, unknown>, channelId: string): Record<string, unknown> {
  const dataModel = asRecord(metadata.a2uiClientDataModel)
  if (!dataModel) return metadata
  return { ...metadata, a2uiClientDataModel: scopeClientDataModel(dataModel, channelId) }
}

function prefixClientDataModel(dataModel: Record<string, unknown>, channelId: string): Record<string, unknown> {
  const surfaces = asRecord(dataModel.surfaces)
  if (!surfaces) return dataModel
  const prefixed: Record<string, unknown> = {}
  for (const [surfaceId, value] of Object.entries(surfaces)) prefixed[joinSurfaceId(channelId, surfaceId)] = value
  return { ...dataModel, surfaces: prefixed }
}

function prefixMetadata(metadata: Record<string, unknown>, channelId: string): Record<string, unknown> {
  const dataModel = asRecord(metadata.a2uiClientDataModel)
  if (!dataModel) return metadata
  return { ...metadata, a2uiClientDataModel: prefixClientDataModel(dataModel, channelId) }
}

export interface RoutedClientMessage {
  channelId: string
  message: Record<string, unknown>
}

/** Resolves the target channel and rewrites the message into that backend's namespace. */
export function routeClientMessage(message: unknown): RoutedClientMessage | null {
  const record = asRecord(message)
  if (!record) return null
  for (const key of CLIENT_SURFACE_KEYS) {
    const body = asRecord(record[key])
    if (!body || typeof body.surfaceId !== 'string') continue
    const split = splitSurfaceId(body.surfaceId)
    if (!split) return null
    const routed: Record<string, unknown> = { ...record, [key]: { ...body, surfaceId: split.surfaceId } }
    const metadata = asRecord(record.metadata)
    if (metadata) routed.metadata = scopeMetadata(metadata, split.channelId)
    return { channelId: split.channelId, message: routed }
  }
  return null
}

/**
 * The inverse of `routeClientMessage`, for a hub handing one gateway a message that the
 * gateway will route again under its own bare service ids.
 */
export function prefixClientMessage(channelId: string, message: Record<string, unknown>): Record<string, unknown> {
  for (const key of CLIENT_SURFACE_KEYS) {
    const body = asRecord(message[key])
    if (!body || typeof body.surfaceId !== 'string') continue
    const prefixed: Record<string, unknown> = {
      ...message,
      [key]: { ...body, surfaceId: joinSurfaceId(channelId, body.surfaceId) },
    }
    const metadata = asRecord(message.metadata)
    if (metadata) prefixed.metadata = prefixMetadata(metadata, channelId)
    return prefixed
  }
  return message
}
