/**
 * Helpers shared by the test suites of every package that speaks A2UI over a socket.
 *
 * These live in `src` rather than a test directory so each package can import them
 * across the `dist` boundary the same way it imports the code under test.
 */
import type { WebSocket } from 'ws'
import { test as bunTest } from 'bun:test'

/** Per-test disposal, including dynamically allocated sockets and directories. */
export interface TestContext {
  after(dispose: () => unknown | Promise<unknown>): void
  skip(reason: string): never
}

const skipped = Symbol('skipped')
export function test(name: string, body: (context: TestContext) => unknown | Promise<unknown>): void
export function test(name: string, options: { timeout?: number; skip?: boolean }, body: (context: TestContext) => unknown | Promise<unknown>): void
export function test(name: string, optionsOrBody: { timeout?: number; skip?: boolean } | ((context: TestContext) => unknown | Promise<unknown>), body?: (context: TestContext) => unknown | Promise<unknown>): void {
  const options = typeof optionsOrBody === 'function' ? {} : optionsOrBody
  const run = typeof optionsOrBody === 'function' ? optionsOrBody : body!
  const register = options.skip ? bunTest.skip : bunTest
  register(name, async () => {
    const disposers: Array<() => unknown | Promise<unknown>> = []
    try {
      await run({ after: dispose => { disposers.push(dispose) }, skip: () => { throw skipped } })
    } catch (error) {
      if (error !== skipped) throw error
    } finally {
      const errors: unknown[] = []
      for (const dispose of disposers.reverse()) {
        try { await dispose() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'test cleanup failed')
    }
  }, options.timeout ?? 15_000)
}

export function messageQueue(socket: WebSocket): () => Promise<unknown> {
  const pending: unknown[] = []
  const waiters: Array<(message: unknown) => void> = []
  socket.on('message', (data) => {
    const message: unknown = JSON.parse(data.toString())
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else pending.push(message)
  })
  return () => {
    const message = pending.shift()
    return message ? Promise.resolve(message) : new Promise((resolvePromise) => waiters.push(resolvePromise))
  }
}

export function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    socket.once('open', resolvePromise)
    socket.on('error', reject)
  })
}

export function createSurface(surfaceId: string, catalogId = 'test'): unknown {
  return { version: 'v0.9', createSurface: { surfaceId, catalogId, sendDataModel: true } }
}

export function actionMessage(surfaceId: string, surfaces: Record<string, unknown>): unknown {
  return {
    version: 'v0.9',
    action: {
      name: 'run',
      surfaceId,
      sourceComponentId: 'root',
      timestamp: '2026-08-12T00:00:00.000Z',
      context: {},
    },
    metadata: { a2uiClientDataModel: { version: 'v0.9', surfaces } },
  }
}

/** Resolves once `condition` holds, so tests never depend on a fixed discovery delay. */
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  throw new Error('timed out waiting for a condition')
}
