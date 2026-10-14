import type { Socket } from 'node:net'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createTlsServer, type TlsOptions as SecureServerOptions, type TLSSocket, type Server as TlsServer } from 'node:tls'

import { WebSocket, WebSocketServer, TlsWebSocketServer } from './websocket.js'

import type { FanOutClient } from './fan-out.js'

export interface UpgradeDecision {
  ok: boolean
  status?: number
  reason?: string
}

export interface WsEndpointCommonOptions {
  /** Paths that accept a WebSocket upgrade. An upgrade to any other path is destroyed. */
  paths?: string[]
  /** Return true once the request has been answered; otherwise a 404 is sent. */
  onRequest?(request: IncomingMessage, response: ServerResponse): boolean
  /** Rejecting here answers the upgrade with `status` and destroys the socket. */
  onUpgrade?(request: IncomingMessage): UpgradeDecision
}

export interface TcpWsEndpointOptions extends WsEndpointCommonOptions {
  host: string
  port: number
  /**
   * TLS options. Their presence is what makes the endpoint `wss:`; a TCP listener is
   * never served in the clear, because only a unix socket has the filesystem as its
   * trust boundary.
   */
  tls?: SecureServerOptions
  authorize?(socket: TLSSocket): boolean
}

export interface UnixWsEndpointOptions extends WsEndpointCommonOptions {
  /**
   * Listen on a unix domain socket instead of TCP. Reaching the socket is the whole
   * trust boundary, so a listener here is never exposed off the machine.
   */
  socketPath: string
}

export type WsEndpointOptions = TcpWsEndpointOptions | UnixWsEndpointOptions

export interface WsEndpoint {
  /** The client URL of the first path, ready to hand to `new WebSocket(...)`. */
  readonly url: string
  /** `http://host:port`, or null when the endpoint listens on a unix socket. */
  readonly httpUrl: string | null
  readonly httpServer: Server
  /** The client URL for one of the endpoint's paths. */
  urlFor(path: string): string
  onConnection(handler: (socket: WebSocket, request: IncomingMessage) => void): void
  updateTls(options: SecureServerOptions): void
  disconnectUnauthorized(): void
  close(): Promise<void>
}

/** A TCP endpoint always has an HTTP origin, so callers that need one keep a `string`. */
export interface TcpWsEndpoint extends WsEndpoint {
  readonly httpUrl: string
}

function displayHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

export function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) return
  let safeReason = ''
  for (const character of reason) {
    if (Buffer.byteLength(safeReason + character) > 123) break
    safeReason += character
  }
  socket.close(code, safeReason)
}

/** Adapts a `ws` socket to the transport-neutral fan-out client contract. */
export function webSocketClient(socket: WebSocket): FanOutClient {
  return {
    send(text) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text)
    },
    close(code, reason) {
      closeSocket(socket, code, reason)
    },
  }
}

export function startWsEndpoint(options: TcpWsEndpointOptions): Promise<TcpWsEndpoint>
export function startWsEndpoint(options: UnixWsEndpointOptions): Promise<WsEndpoint>
export async function startWsEndpoint(options: WsEndpointOptions): Promise<WsEndpoint> {
  const paths = options.paths ?? ['/ws']
  const socketPath = 'socketPath' in options ? options.socketPath : null
  const tcp = 'socketPath' in options ? null : options
  const authorized = (socket: unknown) => {
    try { return !tcp?.authorize || tcp.authorize(socket as TLSSocket) } catch { return false }
  }
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    if (!authorized(request.socket)) { request.socket.destroy(); return }
    if (options.onRequest?.(request, response)) return
    response.writeHead(404).end('Not found')
  }
  const httpServer: Server = createServer(handle)
  const secureSockets = new Set<TLSSocket>()
  const tcpSockets = new Set<Socket>()
  let tlsServer: TlsServer | null = null
  if (tcp?.tls) {
    tlsServer = createTlsServer(tcp.tls, socket => {
      if (!authorized(socket)) { socket.destroy(); return }
      secureSockets.add(socket)
      const expiry = Date.parse(socket.getPeerCertificate()?.valid_to ?? '')
      let expires: NodeJS.Timeout | null = null
      const expire = () => {
        if (Date.now() >= expiry) { socket.destroy(); return }
        expires = setTimeout(expire, Math.min(2_147_483_647, expiry - Date.now()))
        expires.unref()
      }
      if (Number.isFinite(expiry)) expire()
      socket.once('close', () => { secureSockets.delete(socket); if (expires) clearTimeout(expires) })
      httpServer.emit('connection', socket)
    })
    tlsServer.on('tlsClientError', () => {})
    tlsServer.on('connection', socket => {
      tcpSockets.add(socket)
      socket.once('close', () => tcpSockets.delete(socket))
    })
  }
  const listener = tlsServer ?? httpServer
  const webSocketServer = new (tlsServer ? TlsWebSocketServer : WebSocketServer)({ noServer: true })

  httpServer.on('upgrade', (request, socket, head) => {
    if (!authorized(request.socket)) { socket.destroy(); return }
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (!paths.includes(pathname)) {
      socket.destroy()
      return
    }
    const decision = options.onUpgrade?.(request) ?? { ok: true }
    if (!decision.ok) {
      const status = decision.status ?? 403
      socket.write(`HTTP/1.1 ${status} ${decision.reason ?? 'Forbidden'}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
      return
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request)
    })
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error)
    listener.once('error', onError)
    const listening = () => {
      listener.off('error', onError)
      resolveListen()
    }
    if (tcp) listener.listen(tcp.port, tcp.host, listening)
    else httpServer.listen(socketPath!, listening)
  })

  let urlFor: (route: string) => string
  let httpUrl: string | null
  if (tcp === null) {
    // `ws` dials a unix socket with `ws+unix:<socket path>:<route>`, splitting on the
    // first colon, so both halves travel as one URL string.
    urlFor = (route) => `ws+unix:${socketPath!}:${route}`
    httpUrl = null
  } else {
    const address = listener.address()
    // A TCP listener always reports an object; a string would mean a unix socket.
    if (!address || typeof address === 'string') {
      httpServer.close()
      throw new Error('failed to resolve bridge address')
    }
    const secure = tcp.tls !== undefined
    urlFor = (route) => `${secure ? 'wss' : 'ws'}://${displayHost(tcp.host)}:${address.port}${route}`
    httpUrl = `${secure ? 'https' : 'http'}://${displayHost(tcp.host)}:${address.port}`
  }

  return {
    url: urlFor(paths[0]!),
    httpUrl,
    httpServer,
    urlFor,
    onConnection(handler) {
      webSocketServer.on('connection', handler)
    },
    updateTls(options) { tlsServer?.setSecureContext(options) },
    disconnectUnauthorized() {
      for (const socket of secureSockets) if (!authorized(socket)) socket.destroy()
    },
    async close() {
      for (const socket of webSocketServer.clients) socket.terminate()
      for (const socket of secureSockets) socket.destroy()
      for (const socket of tcpSockets) socket.destroy()
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()))
      if (listener.listening) await new Promise<void>((resolveClose) => listener.close(() => resolveClose()))
      if (tlsServer) httpServer.closeAllConnections()
    },
  }
}
