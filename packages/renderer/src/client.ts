import { basicCatalog, type ReactComponentImplementation } from '@a2ui/react/v0_9'
import {
  MessageProcessor,
  type A2uiClientAction,
  type A2uiMessage,
} from '@a2ui/web_core/v0_9'

export type Processor = MessageProcessor<ReactComponentImplementation>

export interface A2uiWebSocketClientCallbacks {
  onProcessor(processor: Processor | null): void
  onStatus(status: string): void
  onError(message: string | null): void
}

export function isA2uiMessage(value: unknown): value is A2uiMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const object = value as Record<string, unknown>
  if (object.version !== 'v0.9') return false
  const keys = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface']
  return keys.filter((key) => key in object).length === 1
}

export function createActionMessage(
  action: A2uiClientAction,
  clientDataModel: unknown,
) {
  return {
    version: 'v0.9' as const,
    action,
    metadata: {
      a2uiClientDataModel: clientDataModel ?? {
        version: 'v0.9',
        surfaces: {},
      },
    },
  }
}

export class A2uiWebSocketClient {
  private readonly url: string
  private readonly callbacks: A2uiWebSocketClientCallbacks
  private socket: WebSocket | null = null
  private processor: Processor | null = null

  private retry: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(url: string, callbacks: A2uiWebSocketClientCallbacks) {
    this.url = url
    this.callbacks = callbacks
  }

  connect(): void {
    if (this.socket || this.stopped) return
    const socket = new WebSocket(this.url)
    this.socket = socket
    socket.onopen = () => {
      this.processor = new MessageProcessor<ReactComponentImplementation>(
        [basicCatalog],
        (action: A2uiClientAction) => this.sendAction(action),
      )
      this.callbacks.onProcessor(this.processor)
      this.callbacks.onStatus('Connected')
      this.callbacks.onError(null)
    }
    socket.onmessage = (event) => {
      // One connection can carry several services, so a message the processor rejects
      // must not take the others down with it. Report it and keep the stream open.
      try {
        const message: unknown = JSON.parse(String(event.data))
        if (!isA2uiMessage(message)) throw new Error('expected one A2UI v0.9 server message')
        if (!this.processor) throw new Error('received an A2UI message before the connection opened')
        this.processor.processMessages([message])
      } catch (error) {
        this.callbacks.onError(error instanceof Error ? error.message : String(error))
      }
    }
    socket.onerror = () => this.callbacks.onError('WebSocket connection failed')
    socket.onclose = (event) => {
      this.socket = null
      this.processor = null
      this.callbacks.onProcessor(null)
      this.callbacks.onStatus(`Disconnected${event.reason ? `: ${event.reason}` : ''}`)
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), 1000)
    }
  }

  close(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    if (!this.socket) return
    this.socket.onopen = null
    this.socket.onmessage = null
    this.socket.onerror = null
    this.socket.onclose = null
    this.socket.close()
    this.socket = null
    this.processor = null
  }

  private sendAction(action: A2uiClientAction): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.processor) {
      this.callbacks.onError('cannot send an action while WebSocket is disconnected')
      return
    }
    const message = createActionMessage(action, this.processor.getClientDataModel())
    this.socket.send(JSON.stringify(message))
  }
}
