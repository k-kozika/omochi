import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import process from 'node:process'

import {
  A2uiSnapshot,
  FanOut,
  closeSocket,
  parseClientFrame,
  readJsonlMessages,
  spawnChildSession,
  startWsEndpoint,
  webSocketClient,
  type WsEndpoint,
} from '@omochi-ui/core'

export interface StdioWebSocketBridgeOptions {
  command: string[]
  host?: string
  port?: number
}

export interface StdioWebSocketBridgeHandle {
  readonly url: string
  readonly child: ChildProcessWithoutNullStreams
  readonly exited: Promise<number>
  close(): Promise<void>
}

/**
 * Hosts one child application for every connected renderer. The hub generalizes this
 * to many backends; this entry point stays single-session and never rewrites surface ids.
 */
export async function startStdioWebSocketBridge(
  options: StdioWebSocketBridgeOptions,
): Promise<StdioWebSocketBridgeHandle> {
  if (!options.command.length) throw new Error('a child command is required after --')
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 5555
  const snapshot = new A2uiSnapshot()
  const fanOut = new FanOut(() => snapshot.messages())

  let endpoint: WsEndpoint | null = null
  let childProtocolFailed = false
  const closeEndpoint = () => {
    if (endpoint?.httpServer.listening) endpoint.httpServer.close()
  }

  const session = spawnChildSession(options.command, {
    onExit(exitCode) {
      if (!childProtocolFailed) {
        fanOut.closeAll(exitCode === 0 ? 1000 : 1011, `child process exited with code ${exitCode}`)
      }
      closeEndpoint()
    },
    onError(error) {
      fanOut.closeAll(1011, `failed to start child: ${error.message}`)
      closeEndpoint()
    },
  })

  readJsonlMessages({
    input: session.child.stdout,
    onMessage(value, raw) {
      snapshot.apply(value)
      fanOut.broadcast(raw)
    },
    onInvalid(detail, lineNumber) {
      childProtocolFailed = true
      const message = `child stdout line ${lineNumber}: invalid A2UI JSON: ${detail}`
      process.stderr.write(`[omochi-ui] ${message}\n`)
      fanOut.closeAll(1002, message)
      session.kill('SIGTERM')
    },
  })

  try {
    endpoint = await startWsEndpoint({ host, port })
  } catch (error) {
    session.kill('SIGTERM')
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
      session.writeLine(frame.value)
    })
    socket.on('close', () => fanOut.remove(client))
  })

  if (session.finished) closeEndpoint()

  return {
    url: endpoint.url,
    child: session.child,
    exited: session.exited,
    async close() {
      fanOut.closeAll(1001, 'bridge shutting down')
      session.kill('SIGTERM')
      await endpoint.close()
    },
  }
}
