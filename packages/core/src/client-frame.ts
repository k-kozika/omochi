import { A2uiClientMessageSchema } from '@a2ui/web_core/v0_9'

export type ClientFrame =
  | { ok: true; value: unknown }
  | { ok: false; code: 1003 | 1007; reason: string }

/**
 * Validates one inbound WebSocket or unix socket frame as an A2UI v0.9 client message.
 * The parsed value is intentionally the raw `JSON.parse` result rather than the zod
 * output: `A2uiClientMessageSchema` strips `metadata`, which carries the client data
 * model that every backend needs.
 */
export function parseClientFrame(data: { toString(): string }, isBinary: boolean): ClientFrame {
  if (isBinary) return { ok: false, code: 1003, reason: 'expected a text JSON message' }
  try {
    const value: unknown = JSON.parse(data.toString())
    const parsed = A2uiClientMessageSchema.safeParse(value)
    if (!parsed.success || parsed.data.version !== 'v0.9') {
      throw new Error(parsed.success ? `unsupported version: ${parsed.data.version}` : 'expected an A2UI v0.9 client message')
    }
    return { ok: true, value }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, code: 1007, reason: `invalid JSON: ${detail}` }
  }
}
