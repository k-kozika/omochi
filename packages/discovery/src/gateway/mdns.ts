import { isValidNodeId } from '@omochi-ui/core'

import { GATEWAY_PROTOCOL, gatewayEndpointKey, type GatewayEndpoint } from './protocol.js'
import type { GatewayCandidate, GatewayLocator, GatewayLocatorSink } from './locator.js'

/**
 * DNS-SD advertises `_omochi-ui._tcp`; `bonjour-service` adds the underscore and the
 * protocol, so the type is given bare.
 */
export const MDNS_SERVICE_TYPE = 'omochi-ui'

/** How long to keep browsing before a service that stopped answering is dropped. */
const BROWSE_REFRESH_MS = 30_000

export interface GatewayTxt {
  protocol: number
  nodeId: string
  basePath: string
}

/**
 * What one gateway publishes about itself.
 *
 * Deliberately tiny: mDNS is untrusted discovery, so the record says only enough to
 * start an authenticated connection. No icons, no service list, and above all no
 * secrets — anything here is readable by everyone on the link.
 */
export function encodeGatewayTxt(nodeId: string): Record<string, string> {
  return { v: String(GATEWAY_PROTOCOL), id: nodeId, p: '/v1' }
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return null
}

/** Returns null for anything this hub could not act on; unknown keys are ignored. */
export function parseGatewayTxt(txt: unknown): GatewayTxt | null {
  if (!txt || typeof txt !== 'object' || Array.isArray(txt)) return null
  const record = txt as Record<string, unknown>
  const protocol = Number(textOf(record.v))
  if (!Number.isInteger(protocol) || protocol <= 0) return null
  const nodeId = textOf(record.id)
  if (nodeId === null || !isValidNodeId(nodeId)) return null
  const basePath = textOf(record.p) ?? '/v1'
  if (!basePath.startsWith('/')) return null
  return { protocol, nodeId, basePath }
}

/** Prefers a numeric IPv4 address: a `.local` name needs a resolver Node may not have. */
export function preferredAddress(addresses: readonly string[] | undefined): string | null {
  if (!addresses?.length) return null
  const ipv4 = addresses.find((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address))
  return ipv4 ?? addresses[0] ?? null
}

export interface GatewayAdvertisement {
  close(): Promise<void>
}

/**
 * Publishes this gateway on the local link.
 *
 * Advertising is separate from accepting: a hub that finds this record still has to
 * authenticate, and an unpaired one gets no further than the handshake.
 */
export async function advertiseGateway(options: {
  nodeId: string
  name: string
  port: number
}): Promise<GatewayAdvertisement> {
  // Imported here so `omochi-ui dev` and the bridge never load it.
  const { default: Bonjour } = await import('bonjour-service')
  const instance = new Bonjour()
  instance.publish({
    name: options.name,
    type: MDNS_SERVICE_TYPE,
    port: options.port,
    txt: encodeGatewayTxt(options.nodeId),
  })
  return {
    close() {
      // Withdraw before tearing down, so peers hear the goodbye instead of timing out.
      return new Promise<void>((resolvePromise) => {
        instance.unpublishAll(() => {
          instance.destroy()
          resolvePromise()
        })
      })
    },
  }
}

export interface MdnsLocatorOptions {
  /**
   * This node's own id, so the hub does not rediscover its own gateway over the network
   * and try to reach a machine it already talks to through a unix socket.
   */
  selfNodeId?: string
}

export function createMdnsLocator(options: MdnsLocatorOptions = {}): GatewayLocator {
  let instance: { destroy(): void } | null = null
  let refresh: NodeJS.Timeout | null = null
  const seen = new Map<string, string>()

  return {
    kind: 'mdns',
    async start(sink: GatewayLocatorSink) {
      const { default: Bonjour } = await import('bonjour-service')
      const bonjour = new Bonjour()
      instance = bonjour

      const browser = bonjour.find({ type: MDNS_SERVICE_TYPE })
      browser.on('up', (service) => {
        const txt = parseGatewayTxt(service.txt)
        if (!txt) return
        if (txt.nodeId === options.selfNodeId) return
        const host = preferredAddress(service.addresses)
        if (host === null || !service.port) return
        const endpoint: GatewayEndpoint = { kind: 'tcp', host, port: service.port }
        const key = gatewayEndpointKey(endpoint)
        if (seen.has(key)) return
        seen.set(key, txt.nodeId)
        const candidate: GatewayCandidate = { key, endpoint, source: 'mdns', nodeId: txt.nodeId }
        sink.found(candidate)
      })
      browser.on('down', (service) => {
        const host = preferredAddress(service.addresses)
        if (host === null || !service.port) return
        const key = gatewayEndpointKey({ kind: 'tcp', host, port: service.port })
        if (!seen.delete(key)) return
        sink.lost(key)
      })

      browser.start()
      // Multicast answers get lost; a periodic re-query is what keeps a gateway that
      // appeared during a dropped packet from staying invisible.
      refresh = setInterval(() => browser.update(), BROWSE_REFRESH_MS)
      refresh.unref()
    },
    async close() {
      if (refresh) clearInterval(refresh)
      refresh = null
      instance?.destroy()
      instance = null
      seen.clear()
    },
  }
}
