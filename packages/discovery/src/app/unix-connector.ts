import { createConnection } from 'node:net'

import { readJsonlMessages } from '@omochi-ui/core'

import type { DiscoveredService } from './provider.js'

export interface ServiceHandlers {
  onOpen(): void
  onMessage(value: unknown): void
  /** Fires exactly once, for a clean close, a socket error, or a protocol violation. */
  onClose(detail: string): void
}

export interface ServiceConnection {
  send(message: unknown): void
  close(): void
}

export interface ServiceConnector {
  connect(service: DiscoveredService, handlers: ServiceHandlers): ServiceConnection
}

export function createUnixConnector(): ServiceConnector {
  return {
    connect(service, handlers) {
      if (service.endpoint.kind !== 'unix') {
        throw new Error(`unix connector cannot reach a ${service.endpoint.kind} endpoint`)
      }
      const socket = createConnection(service.endpoint.path)
      socket.setNoDelay(true)
      let finished = false
      const finish = (detail: string) => {
        if (finished) return
        finished = true
        socket.destroy()
        handlers.onClose(detail)
      }

      socket.on('connect', () => handlers.onOpen())
      socket.on('error', (error) => finish(error.message))
      socket.on('close', () => finish('connection closed'))
      readJsonlMessages({
        input: socket,
        onMessage: (value) => handlers.onMessage(value),
        onInvalid: (detail, lineNumber) => finish(`line ${lineNumber}: invalid A2UI JSON: ${detail}`),
        onStreamError: (error) => finish(error.message),
      })

      return {
        send(message) {
          if (!finished && socket.writable) socket.write(`${JSON.stringify(message)}\n`)
        },
        close() {
          finish('closed by the hub')
        },
      }
    },
  }
}
