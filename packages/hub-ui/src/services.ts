/**
 * The hub namespaces every surface as `<channelId>/<surfaceId>` and publishes the
 * service list on a separate HTTP channel, so the WebSocket stream stays raw A2UI v0.9.
 *
 * A channel id is `<nodeId>~<serviceId>` when a hub is aggregating gateways, and a bare
 * service id otherwise. The renderer never has to tell them apart: it treats the whole
 * thing as opaque and shows `node` when the hub reports one.
 */
export interface ServiceNodeView {
  id: string
  name: string
  local: boolean
}

export interface ServiceView {
  id: string
  name: string
  icon?: string
  status: 'connected' | 'disconnected' | 'error'
  detail?: string
  node?: ServiceNodeView
}

/** Derives the hub's HTTP origin from the renderer's WebSocket endpoint. */
export function resolveHubOrigin(webSocketUrl: string): string {
  const url = new URL(webSocketUrl)
  return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`
}

/** Splits on the first separator, because a backend surface id may contain slashes. */
export function splitSurfaceId(surfaceId: string): { channelId: string | null; surfaceId: string } {
  const separator = surfaceId.indexOf('/')
  if (separator <= 0 || separator === surfaceId.length - 1) return { channelId: null, surfaceId }
  return { channelId: surfaceId.slice(0, separator), surfaceId: surfaceId.slice(separator + 1) }
}

/** With no hub (a plain `omochi-ui dev` bridge) every surface belongs to the one session. */
export function surfacesForService<T extends { id: string }>(
  surfaces: Iterable<T>,
  channelId: string | null,
): T[] {
  const all = [...surfaces]
  if (channelId === null) return all
  return all.filter((surface) => splitSurfaceId(surface.id).channelId === channelId)
}

/** Groups the list by node, preserving order, for a sidebar that spans machines. */
export function groupByNode(services: readonly ServiceView[]): Array<{ node: ServiceNodeView | null; services: ServiceView[] }> {
  const groups: Array<{ node: ServiceNodeView | null; services: ServiceView[] }> = []
  for (const service of services) {
    const key = service.node?.id ?? null
    const existing = groups.find((group) => (group.node?.id ?? null) === key)
    if (existing) existing.services.push(service)
    else groups.push({ node: service.node ?? null, services: [service] })
  }
  return groups
}

/** Keeps the current selection unless it disappeared, then falls back to the first service. */
export function nextSelection(services: readonly ServiceView[], current: string | null): string | null {
  if (current !== null && services.some((service) => service.id === current)) return current
  return services[0]?.id ?? null
}

const STATUSES = new Set(['connected', 'disconnected', 'error'])

export function parseServices(value: unknown): ServiceView[] | null {
  if (!Array.isArray(value)) return null
  const services: ServiceView[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.name !== 'string') return null
    if (typeof record.status !== 'string' || !STATUSES.has(record.status)) return null
    const service: ServiceView = { id: record.id, name: record.name, status: record.status as ServiceView['status'] }
    if (typeof record.icon === 'string') service.icon = record.icon
    if (typeof record.detail === 'string') service.detail = record.detail
    if (record.node !== undefined) {
      const node = record.node as Record<string, unknown> | null
      // Reject the whole entry rather than silently dropping the node it belongs to.
      if (!node || typeof node !== 'object') return null
      if (typeof node.id !== 'string' || typeof node.name !== 'string' || typeof node.local !== 'boolean') return null
      service.node = { id: node.id, name: node.name, local: node.local }
    }
    services.push(service)
  }
  return services
}

export interface ServicesSubscription {
  close(): void
}

/**
 * Subscribes to the hub's service list.
 *
 * Every event carries the whole list, so a subscriber never has to reconcile a separate
 * fetch with a stream of deltas. A hub that is not there — a plain bridge, or any other
 * A2UI server — simply never reports, and the caller stays in single-session mode.
 */
export function subscribeServices(
  origin: string,
  onServices: (services: ServiceView[]) => void,
): ServicesSubscription {
  const events = new EventSource(`${origin}/events`)
  events.addEventListener('services', (event) => {
    try {
      const parsed = parseServices(JSON.parse((event as MessageEvent<string>).data))
      if (parsed) onServices(parsed)
    } catch {
      // A malformed frame is ignored; the next one carries the full list again.
    }
  })
  return { close: () => events.close() }
}
