import { DashboardStore, dashboardEndpoints, presetEndpoints } from './dashboards.js'
import { serveHubUi } from './static-ui.js'
import process from 'node:process'

import {
  A2uiSnapshot,
  FanOut,
  closeSocket,
  createServicesEndpoints,
  joinRouteId,
  parseClientFrame,
  prefixClientMessage,
  readdressServerMessage,
  routeClientMessage,
  splitRouteId,
  startWsEndpoint,
  webSocketClient,
  type ServiceView,
  type TcpWsEndpoint,
} from '@omochi-ui/core'
import {
  connectGateway,
  createLocalLocator,
  createMdnsLocator,
  gatewaySocketPath,
  loadNodeIdentity,
  omochiRuntimeRoot,
  openTrustStore,
  mtlsClientOptions,
  type GatewayCandidate,
  type GatewayClient,
  type GatewayLocator,
  type NodeIdentity,
  type TrustStore,
} from '@omochi-ui/discovery'
import type { DashboardPreset } from '@omochi-ui/hub-ui/contracts'

import { superviseLocalGateway, type GatewaySupervisor } from './gateway-supervisor.js'

export interface HubOptions {
  host?: string
  port?: number
  allowOrigins?: string[]
  /** Where to look for gateways. Defaults to the gateway on this machine. */
  gateways?: GatewayLocator[]
  /** The local gateway's socket; defaults to `<runtime root>/gateway.sock`. */
  gatewaySocket?: string
  /** Start a local gateway when none is listening. Defaults to true. */
  autoGateway?: boolean
  /** Where the persisted identity and pinned peers live; defaults to the config root. */
  configRoot?: string
  /** Overrides this hub's identity and trust store; mainly useful in tests. */
  identity?: NodeIdentity
  trust?: TrustStore
  /** Also look for gateways on the local link. Off by default. */
  discoverLan?: boolean
  /** Read-only dashboard compositions exposed for this hub process only. */
  presets?: DashboardPreset[]
}

export interface HubHandle {
  readonly url: string
  readonly httpUrl: string
  /** How many gateways are currently connected. */
  readonly nodeCount: number
  close(): Promise<void>
}

const RECONNECT_MIN_MS = 100
const RECONNECT_MAX_MS = 5000

interface HubNode {
  candidate: GatewayCandidate
  client: GatewayClient | null
  nodeId: string | null
  nodeName: string | null
  /** Surfaces as the hub addresses them, already carrying the `<nodeId>~` prefix. */
  snapshot: A2uiSnapshot
  /** The gateway's own list, under its bare service ids. */
  services: ServiceView[]
  status: ServiceView['status']
  detail?: string
  attempt: number
  retry: NodeJS.Timeout | null
  authorization: number
}

function surfaceIdsOf(snapshot: A2uiSnapshot): string[] {
  const ids: string[] = []
  for (const message of snapshot.messages()) {
    if ('createSurface' in message) ids.push(message.createSurface.surfaceId)
  }
  return ids
}

/**
 * Aggregates every reachable gateway into one A2UI stream.
 *
 * The hub knows nothing about manifests, runtime directories, or application sockets:
 * a gateway owns all of that, and the hub only ever speaks the gateway contract. That is
 * what lets a gateway on another machine join on exactly the same terms as the local one.
 *
 * Surfaces arrive namespaced by service id and are re-namespaced as
 * `<nodeId>~<serviceId>/<surfaceId>`, so two machines running the same service stay
 * distinct all the way out to the renderer.
 */
export async function startHub(options: HubOptions = {}): Promise<HubHandle> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 5555
  const gatewaySocket = options.gatewaySocket ?? gatewaySocketPath(omochiRuntimeRoot())
  const locators = [...(options.gateways ?? [createLocalLocator(gatewaySocket)])]
  const nodes = new Map<string, HubNode>()
  const byNodeId = new Map<string, HubNode>()
  let supervisor: GatewaySupervisor | null = null
  let closed = false

  // Only a remote gateway needs either of these, so neither is created until one appears.
  let identity: NodeIdentity | null = options.identity ?? null
  let trust: TrustStore | null = options.trust ?? null
  const trustSubscription = { close: null as (() => Promise<void>) | null }
  let subscribingTrust: Promise<void> | null = null
  const remoteCredentials = async () => {
    identity ??= await loadNodeIdentity({ root: options.configRoot })
    trust ??= await openTrustStore(options.configRoot)
    subscribingTrust ??= trust.subscribe(() => {
      for (const node of nodes.values()) {
        if (node.candidate.endpoint.kind !== 'tcp') continue
        // Re-authorize on every trust change, including replacement of a certificate.
        if (node.retry) clearTimeout(node.retry)
        node.retry = null
        node.authorization += 1
        const client = node.client
        node.client = null
        client?.close()
        retractSurfaces(node)
        node.status = 'disconnected'
        node.services = []
        if (trust!.get(node.candidate.nodeId ?? '')?.role === 'gateway') scheduleReconnect(node)
      }
      publish()
    }).then(unsubscribe => { trustSubscription.close = unsubscribe })
    await subscribingTrust
    return { identity, trust }
  }

  const fanOut = new FanOut(function* () {
    for (const node of nodes.values()) {
      for (const message of node.snapshot.messages()) yield message
    }
  })

  const listServices = (): ServiceView[] => {
    const rows: ServiceView[] = []
    for (const node of nodes.values()) {
      if (node.nodeId === null) continue
      const nodeView = {
        id: node.nodeId,
        name: node.nodeName ?? node.nodeId,
        local: node.candidate.source === 'local',
      }
      for (const service of node.services) {
        // A gateway that is down takes its whole list down with it, so the reason the
        // node dropped is what the renderer shows rather than a stale per-service one.
        const view: ServiceView = {
          id: joinRouteId(node.nodeId, service.id),
          name: service.name,
          status: node.status === 'connected' ? service.status : node.status,
          node: nodeView,
        }
        if (service.icon !== undefined) view.icon = service.icon
        const detail = node.status === 'connected' ? service.detail : node.detail
        if (detail !== undefined) view.detail = detail
        rows.push(view)
      }
    }
    return rows
  }

  const endpoints = createServicesEndpoints({ allowOrigins: options.allowOrigins, list: listServices })
  const dashboards = dashboardEndpoints(new DashboardStore(options.configRoot), endpoints.isAllowedOrigin)
  const presets = presetEndpoints(options.presets ?? [], endpoints.isAllowedOrigin)
  const publish = () => endpoints.publish(listServices())

  /** Retracts a node's surfaces so no renderer keeps a zombie surface around. */
  const retractSurfaces = (node: HubNode) => {
    for (const surfaceId of surfaceIdsOf(node.snapshot)) {
      fanOut.broadcast(JSON.stringify({ version: 'v0.9', deleteSurface: { surfaceId } }))
    }
    node.snapshot = new A2uiSnapshot()
  }

  const scheduleReconnect = (node: HubNode) => {
    if (closed || !nodes.has(node.candidate.key)) return
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** node.attempt)
    node.attempt += 1
    node.retry = setTimeout(() => {
      node.retry = null
      connect(node)
    }, delay + Math.random() * delay)
    node.retry.unref()
  }

  const dropConnection = (node: HubNode, status: ServiceView['status'], detail: string) => {
    const client = node.client
    if (!client) return
    // Clearing the slot first makes the client's own close callback a no-op, so the
    // reason recorded here survives instead of being overwritten by the teardown.
    node.client = null
    client.close()
    retractSurfaces(node)
    node.status = status
    node.detail = detail
    publish()
    scheduleReconnect(node)
  }

  /**
   * Resolves the certificate pin that authenticates one remote gateway.
   *
   * The hub must know which node it is calling to select its certificate pin
   * before it connects. An unpaired peer is reported and left alone rather than reached
   * for without authentication.
   */
  const remoteTls = async (node: HubNode) => {
    const { identity: self, trust: store } = await remoteCredentials()
    const expected = node.candidate.nodeId ?? null
    if (expected === null) {
      throw new Error('name the node to reach it, as --gateway <nodeId>@host:port')
    }
    const peer = store.get(expected)
    if (!peer) throw new Error(`not paired with ${expected}; pair with it first`)
    if (peer.role !== 'gateway') throw new Error(`${expected} is paired as a ${peer.role}, not a gateway`)
    return mtlsClientOptions(self, peer)
  }

  const attach = (node: HubNode, tls?: ReturnType<typeof mtlsClientOptions>) => {
    if (closed) return
    node.client = connectGateway(node.candidate.endpoint, {
      onOpen(info) {
        node.attempt = 0
        node.nodeId = info.nodeId
        node.nodeName = info.name
        node.status = 'connected'
        delete node.detail
        byNodeId.set(info.nodeId, node)
        publish()
      },
      onServices(services) {
        node.services = services
        publish()
      },
      onMessage(message) {
        if (node.nodeId === null) return
        const readdressed = readdressServerMessage(node.nodeId, message)
        if (readdressed === null) {
          const detail = 'the gateway sent a surface id it had not namespaced'
          process.stderr.write(`[omochi-ui] node ${node.nodeId}: ${detail}\n`)
          dropConnection(node, 'error', detail)
          return
        }
        try {
          node.snapshot.apply(readdressed)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          process.stderr.write(`[omochi-ui] node ${node.nodeId}: invalid A2UI message: ${detail}\n`)
          dropConnection(node, 'error', detail)
          return
        }
        fanOut.broadcast(JSON.stringify(readdressed))
      },
      onClose(detail) {
        dropConnection(node, 'disconnected', detail)
      },
    }, tls ? { tls, expectedNodeId: node.candidate.nodeId } : {})
  }

  const connect = (node: HubNode) => {
    if (closed) return
    if (node.candidate.endpoint.kind === 'unix') {
      attach(node)
      return
    }
    const authorization = node.authorization
    void remoteTls(node).then(
      (tls) => {
        if (authorization !== node.authorization || closed || !nodes.has(node.candidate.key)) return
        const peer = trust?.get(node.candidate.nodeId ?? '')
        if (!peer || peer.role !== 'gateway' || peer.certificate !== tls.ca?.[0]) return
        attach(node, tls)
      },
      (error: Error) => {
        if (closed || authorization !== node.authorization || !nodes.has(node.candidate.key)) return
        node.status = 'error'
        node.detail = error.message
        process.stderr.write(`[omochi-ui] ${node.candidate.key}: ${error.message}\n`)
        publish()
        if (trust?.get(node.candidate.nodeId ?? '')?.role === 'gateway') scheduleReconnect(node)
      },
    )
  }

  const teardown = (node: HubNode) => {
    if (node.retry) clearTimeout(node.retry)
    node.retry = null
    node.authorization += 1
    const client = node.client
    node.client = null
    client?.close()
    retractSurfaces(node)
    if (node.nodeId !== null && byNodeId.get(node.nodeId) === node) byNodeId.delete(node.nodeId)
  }

  const sink = {
    found(candidate: GatewayCandidate) {
      if (closed || nodes.has(candidate.key)) return
      const node: HubNode = {
        candidate,
        client: null,
        nodeId: null,
        nodeName: null,
        snapshot: new A2uiSnapshot(),
        services: [],
        status: 'disconnected',
        attempt: 0,
        retry: null,
        authorization: 0,
      }
      nodes.set(candidate.key, node)
      connect(node)
    },
    lost(key: string) {
      const node = nodes.get(key)
      if (!node) return
      teardown(node)
      nodes.delete(key)
      publish()
    },
  }

  if (options.autoGateway !== false) supervisor = await superviseLocalGateway(gatewaySocket)
  if (options.discoverLan) {
    // Knowing our own id keeps this machine's gateway from arriving twice: once through
    // its unix socket, and once over the network as if it were somebody else.
    const { identity: self } = await remoteCredentials()
    locators.push(createMdnsLocator({ selfNodeId: self.nodeId }))
  }
  for (const locator of locators) await locator.start(sink)

  let endpoint: TcpWsEndpoint
  try {
    endpoint = await startWsEndpoint({
      host,
      port,
      onRequest: (request, response) => {
        if (!endpoints.isAllowedOrigin(request.headers.origin)) {
          response.writeHead(403).end('Forbidden origin')
          return true
        }
        return endpoints.handleRequest(request, response) || dashboards(request, response) || presets(request, response) || serveHubUi(request, response)
      },
      // WebSocket upgrades are exempt from CORS, so any page the user has open could
      // otherwise drive every discovered service. Restrict them the same way.
      onUpgrade: (request) =>
        endpoints.isAllowedOrigin(request.headers.origin)
          ? { ok: true }
          : { ok: false, status: 403, reason: 'Forbidden' },
    })
  } catch (error) {
    await trustSubscription.close?.()
    endpoints.close()
    for (const locator of locators) await locator.close()
    await supervisor?.close()
    throw error
  }

  endpoint.onConnection((socket) => {
    const client = webSocketClient(socket)
    fanOut.add(client)
    socket.on('message', (data, isBinary) => {
      const frame = parseClientFrame(data, isBinary)
      if (!frame.ok) {
        closeSocket(socket, frame.code, frame.reason)
        return
      }
      const routed = routeClientMessage(frame.value)
      const route = routed ? splitRouteId(routed.channelId) : null
      if (!routed || !route) {
        process.stderr.write('[omochi-ui] dropped a client message with no routable surface id\n')
        return
      }
      const node = byNodeId.get(route.nodeId)
      if (!node?.client) {
        process.stderr.write(`[omochi-ui] dropped a client message for unavailable node ${route.nodeId}\n`)
        return
      }
      // The gateway namespaces by bare service id, so hand it what a renderer attached
      // straight to it would have sent.
      node.client.send(prefixClientMessage(route.serviceId, routed.message))
    })
    socket.on('close', () => fanOut.remove(client))
  })

  return {
    url: endpoint.url,
    httpUrl: endpoint.httpUrl,
    get nodeCount() {
      return [...nodes.values()].filter((node) => node.status === 'connected').length
    },
    async close() {
      closed = true
      await subscribingTrust?.catch(() => {})
      for (const node of nodes.values()) teardown(node)
      await trustSubscription.close?.()
      for (const locator of locators) await locator.close()
      nodes.clear()
      byNodeId.clear()
      fanOut.closeAll(1001, 'hub shutting down')
      endpoints.close()
      await endpoint.close()
      await supervisor?.close()
    },
  }
}
