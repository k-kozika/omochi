/**
 * The three identifiers that namespace one backend's surfaces inside a merged stream.
 *
 * A **service id** is what an application publishes itself under: the name of its
 * directory in the runtime root. A **node id** names one machine's gateway. A **channel
 * id** is whatever a given layer namespaces by — a bare service id inside a gateway,
 * and `<nodeId>~<serviceId>` inside a hub that aggregates several gateways.
 *
 * None of them may contain `/`, so the first separator always splits a prefixed surface
 * id into its two parts even when a backend uses `/` inside its own surface ids. `~` is
 * outside `SERVICE_ID_PATTERN`, so it unambiguously separates the two halves of a route
 * id, and it is RFC 3986 unreserved, so `encodeURIComponent` leaves it alone.
 */
export const SERVICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

export const NODE_ID_PATTERN = /^[a-z2-7]{16}$/

/** A node id (16), `~`, and a service id (64). */
export const CHANNEL_ID_PATTERN = /^[A-Za-z0-9._~-]{1,81}$/

export function isValidServiceId(serviceId: string): boolean {
  // `.` and `..` match the character class but would escape or collapse the service directory.
  if (serviceId === '.' || serviceId === '..') return false
  return SERVICE_ID_PATTERN.test(serviceId)
}

export function isValidNodeId(nodeId: string): boolean {
  return NODE_ID_PATTERN.test(nodeId)
}

export function isValidChannelId(channelId: string): boolean {
  if (channelId === '.' || channelId === '..') return false
  return CHANNEL_ID_PATTERN.test(channelId)
}

export function joinRouteId(nodeId: string, serviceId: string): string {
  return `${nodeId}~${serviceId}`
}

/**
 * Splits a hub-level channel id into the node and the service it names.
 *
 * Returns null for a bare service id, which is how a caller tells a gateway-level
 * channel from a hub-level one.
 */
export function splitRouteId(channelId: string): { nodeId: string; serviceId: string } | null {
  const separator = channelId.indexOf('~')
  if (separator < 0) return null
  const nodeId = channelId.slice(0, separator)
  const serviceId = channelId.slice(separator + 1)
  if (!isValidNodeId(nodeId) || !isValidServiceId(serviceId)) return null
  return { nodeId, serviceId }
}
