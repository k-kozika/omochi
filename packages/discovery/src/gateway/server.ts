import { rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import process from 'node:process'
import path from 'node:path'

import {
  A2uiSnapshot,
  FanOut,
  closeSocket,
  parseClientFrame,
  prefixServerMessage,
  routeClientMessage,
  startWsEndpoint,
  webSocketClient,
  type ServiceView,
  type WsEndpoint,
} from '@omochi-ui/core'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebSocket } from '@omochi-ui/core/websocket'

import { ensureRuntimeRoot, gatewaySocketPath, omochiRuntimeRoot } from '../runtime-dir.js'
import { createUnixConnector, type ServiceConnection, type ServiceConnector } from '../app/unix-connector.js'
import { createXdgManifestProvider } from '../app/xdg-manifest.js'
import type { DiscoveredService, DiscoveryProvider } from '../app/provider.js'
import { loadNodeIdentity, type NodeIdentity } from '../auth/identity.js'
import { openPairingWindow, pairingHandler, type PairingWindow } from '../auth/pairing.js'
import { authenticatedPeer, mtlsServerOptions, TLS_MIN_VERSION } from '../auth/tls.js'
import { advertiseGateway, type GatewayAdvertisement } from './mdns.js'
import { openTrustStore, type TrustStore } from '../auth/trust-store.js'
import {
  GATEWAY_A2UI_PATH,
  GATEWAY_CONTROL_PATH,
  GATEWAY_NODE_PATH,
  GATEWAY_SERVICES_PATH,
  GATEWAY_PROTOCOL,
  parseHubControlFrame,
  type GatewayControlFrame,
  type GatewayNodeInfo,
  type GatewayServicesBody,
} from './protocol.js'

export interface GatewayOptions {
  /** Defaults to `<runtime root>/gateway.sock`. */
  socketPath?: string
  root?: string
  /** Overrides the persisted identity; mainly useful in tests. */
  nodeId?: string
  name?: string
  /** Where the persisted identity lives; defaults to the omochi config root. */
  configRoot?: string
  identity?: NodeIdentity
  /**
   * Also accept hubs over TCP, authenticated by pinned device certificates. Off by default: a
   * gateway is reachable only through its unix socket until someone asks for more.
   */
  listen?: { host: string; port: number }
  /** Overrides the trust store used for remote peers; mainly useful in tests. */
  trust?: TrustStore
  /**
   * Open a one-time pairing window. Needs `listen`: there is nothing to pair with over a
   * unix socket, where the filesystem already answers the question.
   */
  pairing?: { ttlMs?: number; maxAttempts?: number; attemptFloorMs?: number }
  /**
   * Publish this gateway over mDNS. Needs `listen`, and says nothing about who may
   * connect: discovery is untrusted, and authentication happens in the handshake.
   */
  advertise?: boolean
  discovery?: DiscoveryProvider
  connector?: ServiceConnector
}

export interface GatewayHandle {
  readonly socketPath: string
  readonly nodeId: string
  readonly name: string
  readonly root: string
  /** Where the TCP listener ended up, or null when there is none. */
  readonly address: { host: string; port: number } | null
  /** The open pairing window, or null when none was asked for. */
  readonly pairing: PairingWindow | null
  readonly pairingAddress: { host: string; port: number } | null
  /** The client URL for one of the gateway's WebSocket paths, over the unix socket. */
  urlFor(path: string): string
  close(): Promise<void>
}

const RECONNECT_MIN_MS = 100
const RECONNECT_MAX_MS = 5000

interface GatewayService {
  descriptor: DiscoveredService
  snapshot: A2uiSnapshot
  connection: ServiceConnection | null
  status: ServiceView['status']
  detail?: string
  attempt: number
  retry: NodeJS.Timeout | null
}

function surfaceIdsOf(snapshot: A2uiSnapshot): string[] {
  const ids: string[] = []
  for (const message of snapshot.messages()) {
    if ('createSurface' in message) ids.push(message.createSurface.surfaceId)
  }
  return ids
}

/**
 * Publishes every service running for the current user as one A2UI stream.
 *
 * This is the only component that knows where an application lives: it watches the
 * runtime root, dials each service's unix socket, and namespaces its surfaces as
 * `<serviceId>/<surfaceId>`. A hub consumes the result without ever touching the
 * filesystem, which is what lets the same contract serve a hub on another machine.
 */
export async function startGateway(options: GatewayOptions = {}): Promise<GatewayHandle> {
  const root = options.root ?? omochiRuntimeRoot()
  const socketPath = options.socketPath ?? gatewaySocketPath(root)
  // A node keeps the same id across restarts, because that is what a paired peer
  // recognises it by. Tests pin one explicitly rather than touching the config root.
  const identity = options.identity ?? (options.nodeId === undefined
    ? await loadNodeIdentity({ root: options.configRoot, name: options.name })
    : { nodeId: options.nodeId, name: options.name ?? hostname() })
  const { nodeId, name } = identity
  const connector = options.connector ?? createUnixConnector()
  const provider = options.discovery ?? createXdgManifestProvider({ root })
  const services = new Map<string, GatewayService>()
  const startedAt = Date.now()
  let closed = false

  const listServices = (): ServiceView[] =>
    [...services.entries()].map(([id, service]) => {
      const view: ServiceView = { id, name: service.descriptor.name, status: service.status }
      if (service.descriptor.icon !== undefined) view.icon = service.descriptor.icon
      if (service.detail !== undefined) view.detail = service.detail
      return view
    })

  const servicesFrame = (): GatewayControlFrame => ({ t: 'services', nodeId, services: listServices() })

  const a2ui = new FanOut(function* () {
    for (const [serviceId, service] of services) {
      for (const message of service.snapshot.messages()) yield prefixServerMessage(serviceId, message)
    }
  })
  // A control client is sent the whole list on connect, so it never has to race a
  // separate /v1/services fetch to learn the current state.
  const control = new FanOut(function* () {
    yield servicesFrame()
  })

  const publish = () => control.broadcast(JSON.stringify(servicesFrame()))

  const broadcast = (serviceId: string, message: unknown) => {
    a2ui.broadcast(JSON.stringify(prefixServerMessage(serviceId, message)))
  }

  /** Retracts a service's surfaces so no renderer keeps a zombie surface around. */
  const retractSurfaces = (serviceId: string, service: GatewayService) => {
    for (const surfaceId of surfaceIdsOf(service.snapshot)) {
      broadcast(serviceId, { version: 'v0.9', deleteSurface: { surfaceId } })
    }
    service.snapshot = new A2uiSnapshot()
  }

  const scheduleReconnect = (serviceId: string, service: GatewayService) => {
    if (closed || !services.has(serviceId)) return
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** service.attempt)
    service.attempt += 1
    service.retry = setTimeout(() => {
      service.retry = null
      connect(serviceId, service)
    }, delay + Math.random() * delay)
    service.retry.unref()
  }

  const dropConnection = (
    serviceId: string,
    service: GatewayService,
    status: ServiceView['status'],
    detail: string,
  ) => {
    const connection = service.connection
    if (!connection) return
    // Clearing the slot first makes the connector's own close callback a no-op, so the
    // reason recorded here survives instead of being overwritten by the teardown.
    service.connection = null
    connection.close()
    retractSurfaces(serviceId, service)
    service.status = status
    service.detail = detail
    publish()
    scheduleReconnect(serviceId, service)
  }

  const connect = (serviceId: string, service: GatewayService) => {
    if (closed) return
    try {
      service.connection = connector.connect(service.descriptor, {
        onOpen() {
          service.attempt = 0
          service.status = 'connected'
          delete service.detail
          publish()
        },
        onMessage(value) {
          try {
            service.snapshot.apply(value)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            process.stderr.write(`[omochi-ui] service ${serviceId}: invalid A2UI message: ${detail}\n`)
            dropConnection(serviceId, service, 'error', detail)
            return
          }
          broadcast(serviceId, value)
        },
        onClose(detail) {
          dropConnection(serviceId, service, 'disconnected', detail)
        },
      })
    } catch (error) {
      service.status = 'error'
      service.detail = error instanceof Error ? error.message : String(error)
      publish()
      scheduleReconnect(serviceId, service)
    }
  }

  const teardown = (serviceId: string, service: GatewayService) => {
    if (service.retry) clearTimeout(service.retry)
    service.retry = null
    const connection = service.connection
    service.connection = null
    connection?.close()
    retractSurfaces(serviceId, service)
  }

  const nodeInfo = (): GatewayNodeInfo => ({
    protocol: GATEWAY_PROTOCOL,
    nodeId,
    name,
    services: services.size,
    uptimeMs: Date.now() - startedAt,
  })

  const answerJson = (response: ServerResponse, body: unknown) => {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }

  /** Reads a small JSON body, refusing anything that would not be one. */
  const handleRequest = (request: IncomingMessage, response: ServerResponse): boolean => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (pathname !== GATEWAY_NODE_PATH && pathname !== GATEWAY_SERVICES_PATH) return false
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end('Method not allowed')
      return true
    }
    if (pathname === GATEWAY_NODE_PATH) answerJson(response, nodeInfo())
    else answerJson(response, { nodeId, services: listServices() } satisfies GatewayServicesBody)
    return true
  }

  await ensureRuntimeRoot(root)
  await provider.start({
    added(descriptor) {
      const service: GatewayService = {
        descriptor,
        snapshot: new A2uiSnapshot(),
        connection: null,
        status: 'disconnected',
        attempt: 0,
        retry: null,
      }
      services.set(descriptor.serviceId, service)
      publish()
      connect(descriptor.serviceId, service)
    },
    changed(descriptor) {
      const service = services.get(descriptor.serviceId)
      if (!service) return
      // A rewritten manifest means the backend restarted; drop the old connection.
      teardown(descriptor.serviceId, service)
      service.descriptor = descriptor
      service.status = 'disconnected'
      delete service.detail
      service.attempt = 0
      publish()
      connect(descriptor.serviceId, service)
    },
    removed(serviceId) {
      const service = services.get(serviceId)
      if (!service) return
      teardown(serviceId, service)
      services.delete(serviceId)
      publish()
    },
  })

  const endpoints: WsEndpoint[] = []
  const closeEndpoints = async () => {
    for (const open of endpoints) await open.close()
  }

  let endpoint: WsEndpoint
  try {
    endpoint = await startWsEndpoint({
      socketPath,
      paths: [GATEWAY_A2UI_PATH, GATEWAY_CONTROL_PATH],
      onRequest: handleRequest,
    })
    endpoints.push(endpoint)
  } catch (error) {
    await provider.close()
    throw error
  }

  let remote: WsEndpoint | null = null
  let pairingEndpoint: WsEndpoint | null = null
  let pairing: PairingWindow | null = null
  let unsubscribe: (() => Promise<void>) | null = null
  if ((options.pairing || options.advertise) && !options.listen) {
    await provider.close(); await closeEndpoints()
    throw new Error('pairing and advertising need a TCP listener')
  }
  if (options.listen) {
    try {
      const trust = options.trust ?? await openTrustStore(options.configRoot)
      const credentials = options.identity ?? await loadNodeIdentity({ root: options.configRoot ?? path.dirname(trust.file), name: options.name })
      if (credentials.nodeId !== nodeId) throw new Error('gateway identity does not match its TLS credentials')
      remote = await startWsEndpoint({
        host: options.listen.host, port: options.listen.port,
        paths: [GATEWAY_A2UI_PATH, GATEWAY_CONTROL_PATH], onRequest: handleRequest,
        tls: mtlsServerOptions(credentials, trust),
        authorize: socket => !closed && authenticatedPeer(socket, trust, 'hub') !== null,
      })
      endpoints.push(remote)
      unsubscribe = await trust.subscribe(() => {
        try { remote!.updateTls(mtlsServerOptions(credentials, trust)) }
        finally { remote!.disconnectUnauthorized() }
      })
      if (options.pairing) {
        const port = Number(new URL(remote.httpUrl!).port)
        pairing = openPairingWindow({ identity: credentials, trust, port, ...options.pairing })
        pairingEndpoint = await startWsEndpoint({
          host: options.listen.host, port: 0, paths: [],
          tls: { key: credentials.privateKey, cert: credentials.certificate, minVersion: TLS_MIN_VERSION, maxVersion: TLS_MIN_VERSION },
          onRequest: pairingHandler(pairing, () => { void closePairing() }),
        })
        const closePairing = async () => {
          const endpoint = pairingEndpoint
          pairingEndpoint = null
          await endpoint?.close()
        }
        void pairing.ended.then(reason => { if (reason !== 'paired') return closePairing() }).catch(() => {})
      }
    } catch (error) {
      await unsubscribe?.(); await pairingEndpoint?.close(); pairing?.close('startup failed')
      await closeEndpoints(); await provider.close(); throw error
    }
  }

  const onA2uiConnection = (socket: WebSocket) => {
    const client = webSocketClient(socket)
    a2ui.add(client)
    socket.on('message', (data, isBinary) => {
      const frame = parseClientFrame(data, isBinary)
      if (!frame.ok) {
        closeSocket(socket, frame.code, frame.reason)
        return
      }
      const routed = routeClientMessage(frame.value)
      if (!routed) {
        process.stderr.write('[omochi-ui] gateway dropped a client message with no routable surface id\n')
        return
      }
      const service = services.get(routed.channelId)
      if (!service?.connection) {
        process.stderr.write(`[omochi-ui] gateway dropped a client message for unavailable service ${routed.channelId}\n`)
        return
      }
      service.connection.send(routed.message)
    })
    socket.on('close', () => a2ui.remove(client))
  }

  const onControlConnection = (socket: WebSocket) => {
    const client = webSocketClient(socket)
    control.add(client)
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      let frame: unknown
      try {
        frame = JSON.parse(data.toString())
      } catch {
        closeSocket(socket, 1007, 'invalid JSON on the control channel')
        return
      }
      const ping = parseHubControlFrame(frame)
      if (!ping) return
      client.send(JSON.stringify({ t: 'pong', id: ping.id } satisfies GatewayControlFrame))
    })
    socket.on('close', () => control.remove(client))
  }

  // Both listeners serve the same routes; only how a peer is authenticated differs.
  for (const open of endpoints) {
    open.onConnection((socket, request) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      if (pathname === GATEWAY_CONTROL_PATH) onControlConnection(socket)
      else onA2uiConnection(socket)
    })
  }

  const listenAddress = remote?.httpUrl ? new URL(remote.httpUrl) : null

  const pairingUrl = pairingEndpoint?.httpUrl ? new URL(pairingEndpoint.httpUrl) : null
  let advertisement: GatewayAdvertisement | null = null
  if (options.advertise && listenAddress) {
    try {
      advertisement = await advertiseGateway({ nodeId, name, port: Number(listenAddress.port) })
    } catch (error) {
      // A link with no multicast is a reason to be undiscoverable, not to refuse to run.
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[omochi-ui] could not advertise over mDNS: ${detail}\n`)
    }
  }

  return {
    socketPath,
    nodeId,
    name,
    root,
    address: listenAddress ? { host: listenAddress.hostname, port: Number(listenAddress.port) } : null,
    pairing,
    pairingAddress: pairingUrl ? { host: pairingUrl.hostname, port: Number(pairingUrl.port) } : null,
    urlFor: (path) => endpoint.urlFor(path),
    async close() {
      if (closed) return
      closed = true
      remote?.disconnectUnauthorized()
      await unsubscribe?.()
      await pairingEndpoint?.close()
      pairingEndpoint = null
      await provider.close()
      for (const [serviceId, service] of services) teardown(serviceId, service)
      services.clear()
      control.broadcast(JSON.stringify({ t: 'bye', reason: 'gateway shutting down' } satisfies GatewayControlFrame))
      await advertisement?.close()
      pairing?.close('the gateway is shutting down')
      control.closeAll(1001, 'gateway shutting down')
      a2ui.closeAll(1001, 'gateway shutting down')
      await closeEndpoints()
      // Node leaves the socket file behind, and a stale one blocks the next bind.
      await rm(socketPath, { force: true })
    },
  }
}
