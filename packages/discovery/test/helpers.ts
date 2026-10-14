import { request } from 'node:http'
import type { TestContext } from '@omochi-ui/core/testing'

import { WebSocket } from '@omochi-ui/core/websocket'

import { startGateway, type GatewayHandle } from '../src/gateway/server.js'
import { GATEWAY_A2UI_PATH, GATEWAY_CONTROL_PATH } from '../src/gateway/protocol.js'
import { createXdgManifestProvider } from '../src/app/xdg-manifest.js'

/** A gateway on a socket inside the test's own runtime root, tuned for fast discovery. */
export async function startTestGateway(t: TestContext, root: string): Promise<GatewayHandle> {
  const gateway = await startGateway({
    root,
    nodeId: 'aaaaaaaaaaaaaaaa',
    name: 'test-node',
    discovery: createXdgManifestProvider({ root, debounceMs: 20, rescanMs: 100 }),
  })
  t.after(() => gateway.close())
  return gateway
}

export interface GatewayResponse {
  status: number
  text: string
  /** The parsed body, or null when the response is not JSON — a 404 answers in text. */
  body: unknown
}

/** `fetch` cannot reach a unix socket without an undici dispatcher, so use `http` directly. */
export function gatewayGet(socketPath: string, path: string): Promise<GatewayResponse> {
  return new Promise((resolvePromise, reject) => {
    const outgoing = request({ socketPath, path, method: 'GET' }, (response) => {
      let payload = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        payload += chunk
      })
      response.on('end', () => {
        const isJson = (response.headers['content-type'] ?? '').includes('application/json')
        resolvePromise({
          status: response.statusCode ?? 0,
          text: payload,
          body: isJson && payload ? JSON.parse(payload) : null,
        })
      })
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

export function connectA2ui(gateway: GatewayHandle): WebSocket {
  return new WebSocket(gateway.urlFor(GATEWAY_A2UI_PATH))
}

export function connectControl(gateway: GatewayHandle): WebSocket {
  return new WebSocket(gateway.urlFor(GATEWAY_CONTROL_PATH))
}

export interface GatewayServiceRow {
  id: string
  name: string
  icon?: string
  status: string
  detail?: string
}

export async function services(gateway: GatewayHandle): Promise<GatewayServiceRow[]> {
  const response = await gatewayGet(gateway.socketPath, '/v1/services')
  return (response.body as { services: GatewayServiceRow[] }).services
}
