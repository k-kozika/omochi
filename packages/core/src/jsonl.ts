import { createInterface } from 'node:readline'

export interface JsonlReaderOptions {
  input: NodeJS.ReadableStream
  /** Receives every non-blank line. Throwing here is reported through `onInvalid`. */
  onMessage(value: unknown, raw: string, lineNumber: number): void
  /** Called once; the reader latches afterwards and ignores every later line. */
  onInvalid(detail: string, lineNumber: number): void
  /**
   * Reports a failure of the underlying stream.
   *
   * `readline` re-emits its input's errors on the interface, so this listener must exist
   * even when the caller already watches the stream: an unhandled one would be fatal.
   */
  onStreamError?(error: Error): void
}

export interface JsonlReader {
  readonly failed: boolean
  close(): void
}

/** Reads newline-delimited JSON and latches on the first protocol violation. */
export function readJsonlMessages(options: JsonlReaderOptions): JsonlReader {
  let lineNumber = 0
  let failed = false
  const lines = createInterface({ input: options.input, crlfDelay: Infinity })
  lines.on('error', (error: Error) => options.onStreamError?.(error))
  lines.on('line', (line) => {
    lineNumber += 1
    if (!line.trim() || failed) return
    try {
      options.onMessage(JSON.parse(line), line, lineNumber)
    } catch (error) {
      failed = true
      options.onInvalid(error instanceof Error ? error.message : String(error), lineNumber)
    }
  })
  return {
    get failed() {
      return failed
    },
    close() {
      lines.close()
    },
  }
}
