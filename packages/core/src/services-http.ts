import type { IncomingMessage, ServerResponse } from 'node:http'

/** The machine a service runs on, absent when the list has no node dimension. */
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

export interface ServicesEndpoints {
  /** Returns true once the request has been answered. */
  handleRequest(request: IncomingMessage, response: ServerResponse): boolean
  isAllowedOrigin(origin: string | undefined): boolean
  /** Pushes the full list to every SSE subscriber. */
  publish(services: ServiceView[]): void
  close(): void
}

export interface ServicesEndpointsOptions {
  list(): ServiceView[]
  /** Extra exact origins; loopback origins on any port are always allowed. */
  allowOrigins?: string[]
}

const HEARTBEAT_MS = 15000
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return LOOPBACK_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

export function createServicesEndpoints(options: ServicesEndpointsOptions): ServicesEndpoints {
  const allowOrigins = new Set(options.allowOrigins ?? [])
  const subscribers = new Set<ServerResponse>()
  let heartbeat: NodeJS.Timeout | null = null

  const isAllowedOrigin = (origin: string | undefined): boolean => {
    // A non-browser client sends no Origin at all.
    if (origin === undefined) return true
    return allowOrigins.has(origin) || isLoopbackOrigin(origin)
  }

  const applyCors = (request: IncomingMessage, response: ServerResponse): boolean => {
    const origin = request.headers.origin
    if (!isAllowedOrigin(origin)) {
      response.writeHead(403).end('Forbidden origin')
      return false
    }
    response.setHeader('Vary', 'Origin')
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
    return true
  }

  const write = (response: ServerResponse, services: ServiceView[]) => {
    response.write(`event: services\ndata: ${JSON.stringify(services)}\n\n`)
  }

  return {
    isAllowedOrigin,
    handleRequest(request, response) {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      if (pathname !== '/services' && pathname !== '/events') return false
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405).end('Method not allowed')
        return true
      }
      if (!applyCors(request, response)) return true

      if (pathname === '/services') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(options.list()))
        return true
      }

      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      response.flushHeaders()
      request.socket.setNoDelay(true)
      request.socket.setTimeout(0)
      subscribers.add(response)
      // The first event carries the whole list, so a subscriber never has to
      // race a separate /services fetch to learn the current state.
      write(response, options.list())
      const drop = () => subscribers.delete(response)
      request.on('close', drop)
      response.on('close', drop)
      if (!heartbeat) {
        heartbeat = setInterval(() => {
          for (const subscriber of subscribers) subscriber.write(':\n\n')
        }, HEARTBEAT_MS)
        heartbeat.unref()
      }
      return true
    },
    publish(services) {
      for (const subscriber of subscribers) write(subscriber, services)
    },
    close() {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      // An open SSE response keeps http.Server.close() pending forever.
      for (const subscriber of subscribers) subscriber.end()
      subscribers.clear()
    },
  }
}
