/**
 * How to reach one discovered backend.
 *
 * `credentials` is deliberately opaque: a future remote provider (mDNS, static config)
 * attaches whatever its backend expects and the hub forwards it without interpreting it.
 */
export type ServiceEndpoint =
  | { kind: 'unix'; path: string }
  | { kind: 'ws'; url: string; credentials?: unknown }

export interface DiscoveredService {
  serviceId: string
  name: string
  icon?: string
  endpoint: ServiceEndpoint
}

export interface DiscoverySink {
  added(service: DiscoveredService): void
  /** The same id came back with a different manifest, which means the backend restarted. */
  changed(service: DiscoveredService): void
  removed(serviceId: string): void
}

export interface DiscoveryProvider {
  readonly kind: string
  start(sink: DiscoverySink): Promise<void>
  close(): Promise<void>
}
