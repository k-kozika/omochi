import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestContext } from '@omochi-ui/core/testing'

import { FanOut, prefixServerMessage, webSocketClient, type ServiceView, type WsEndpoint } from '@omochi-ui/core'
import { startWsEndpoint } from '@omochi-ui/core'
import {
  GATEWAY_A2UI_PATH,
  GATEWAY_CONTROL_PATH,
  GATEWAY_NODE_PATH,
  GATEWAY_PROTOCOL,
  GATEWAY_SERVICES_PATH,
  type GatewayEndpoint,
} from '@omochi-ui/discovery'
import type { WebSocket } from 'ws'

export interface FakeGateway {
  readonly nodeId: string
  readonly name: string
  readonly socketPath: string
  readonly endpoint: GatewayEndpoint
  /** Replaces the service list and pushes it on the control channel. */
  setServices(services: ServiceView[]): void
  /** Sends one A2UI message, namespaced by `serviceId` as a real gateway would. */
  push(serviceId: string, message: unknown): void
  /** Sends one A2UI message verbatim, to exercise what the hub does with a bad one. */
  pushRaw(message: unknown): void
  /** Resolves with the next message the hub forwarded to this gateway. */
  next(): Promise<unknown>
  /** Drops every connection while staying bound, as a restarting gateway would. */
  drop(): void
  stop(): Promise<void>
}

/**
 * A gateway the hub can talk to, without any of the machinery behind a real one.
 *
 * It speaks the real contract over a real unix socket, so the hub's HTTP handshake and
 * both WebSocket channels are exercised, while the test drives the service list and the
 * A2UI stream directly instead of through manifests and application sockets.
 */
export async function startFakeGateway(
  t: TestContext,
  options: { nodeId?: string; name?: string } = {},
): Promise<FakeGateway> {
  const nodeId = options.nodeId ?? 'aaaaaaaaaaaaaaaa'
  const name = options.name ?? nodeId
  const directory = await mkdtemp(path.join(tmpdir(), 'omochi-fake-gateway-'))
  const socketPath = path.join(directory, 'gateway.sock')
  const startedAt = Date.now()

  let services: ServiceView[] = []
  const history: unknown[] = []
  const received: unknown[] = []
  const waiters: Array<(message: unknown) => void> = []
  const sockets = new Set<WebSocket>()

  const a2ui = new FanOut(function* () {
    for (const message of history) yield message
  })
  const control = new FanOut(function* () {
    yield { t: 'services', nodeId, services }
  })

  const endpoint: WsEndpoint = await startWsEndpoint({
    socketPath,
    paths: [GATEWAY_A2UI_PATH, GATEWAY_CONTROL_PATH],
    onRequest(request, response) {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      if (pathname === GATEWAY_NODE_PATH) {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({
          protocol: GATEWAY_PROTOCOL,
          nodeId,
          name,
          services: services.length,
          uptimeMs: Date.now() - startedAt,
        }))
        return true
      }
      if (pathname === GATEWAY_SERVICES_PATH) {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ nodeId, services }))
        return true
      }
      return false
    },
  })

  endpoint.onConnection((socket, request) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    const client = webSocketClient(socket)
    if (pathname === GATEWAY_CONTROL_PATH) {
      control.add(client)
      socket.on('close', () => control.remove(client))
      return
    }
    a2ui.add(client)
    socket.on('close', () => a2ui.remove(client))
    socket.on('message', (data) => {
      const value: unknown = JSON.parse(data.toString())
      const waiter = waiters.shift()
      if (waiter) waiter(value)
      else received.push(value)
    })
  })

  const gateway: FakeGateway = {
    nodeId,
    name,
    socketPath,
    endpoint: { kind: 'unix', socketPath },
    setServices(next) {
      services = next
      control.broadcast(JSON.stringify({ t: 'services', nodeId, services }))
    },
    push(serviceId, message) {
      gateway.pushRaw(prefixServerMessage(serviceId, message))
    },
    pushRaw(message) {
      history.push(message)
      a2ui.broadcast(JSON.stringify(message))
    },
    next() {
      const message = received.shift()
      return message ? Promise.resolve(message) : new Promise((resolvePromise) => waiters.push(resolvePromise))
    },
    drop() {
      for (const socket of sockets) socket.terminate()
      sockets.clear()
    },
    async stop() {
      // An open connection keeps http.Server.close() pending forever, so drop the hub's
      // sockets first, exactly as a real gateway does on the way down.
      gateway.drop()
      await endpoint.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
  t.after(() => gateway.stop())
  return gateway
}
