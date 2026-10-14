/**
 * Test doubles for the publishing side of the discovery contract.
 *
 * `fakeService` stands in for an SDK application: it listens on a unix socket and
 * publishes a manifest beside it, exactly as `UnixSocketServerTransport` does in the
 * TypeScript, Python, and Rust SDKs.
 */
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import type { TestContext } from '@omochi-ui/core/testing'

export async function tempRuntimeRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'omochi-hub-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

export async function writeManifest(directory: string, manifest: unknown): Promise<void> {
  const temporary = path.join(directory, `.manifest.${process.pid}.tmp`)
  await writeFile(temporary, JSON.stringify(manifest))
  await rename(temporary, path.join(directory, 'manifest.json'))
}

export interface FakeService {
  readonly directory: string
  /** Sends one A2UI server message and keeps it for renderers that connect later. */
  push(message: unknown): void
  /** Resolves with the next message the hub forwarded to this service. */
  next(): Promise<unknown>
  /** Drops the listener while leaving the manifest in place, as a crash would. */
  disconnect(): Promise<void>
  restart(): Promise<void>
  stop(): Promise<void>
}

/** A minimal stand-in for an SDK application publishing itself over a unix socket. */
export async function fakeService(
  root: string,
  serviceId: string,
  options: { name?: string; icon?: string } = {},
): Promise<FakeService> {
  const directory = path.join(root, serviceId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const socketPath = path.join(directory, 'a2ui.sock')
  const history: unknown[] = []
  const connections = new Set<Socket>()
  const received: unknown[] = []
  const waiters: Array<(message: unknown) => void> = []
  let server: Server | null = null

  const listen = async () => {
    await rm(socketPath, { force: true })
    const next = createServer((socket) => {
      connections.add(socket)
      socket.on('close', () => connections.delete(socket))
      socket.on('error', () => connections.delete(socket))
      for (const message of history) socket.write(`${JSON.stringify(message)}\n`)
      createInterface({ input: socket, crlfDelay: Infinity }).on('line', (line) => {
        if (!line.trim()) return
        const value: unknown = JSON.parse(line)
        const waiter = waiters.shift()
        if (waiter) waiter(value)
        else received.push(value)
      })
    })
    await new Promise<void>((resolveListen) => next.listen(socketPath, () => resolveListen()))
    server = next
  }

  const stopListening = async () => {
    for (const socket of connections) socket.destroy()
    connections.clear()
    const current = server
    server = null
    if (!current) return
    await new Promise<void>((resolveClose) => current.close(() => resolveClose()))
  }

  await listen()
  // The manifest is published only once the socket accepts connections, so any
  // manifest a discovery pass can read is already connectable.
  const manifest: Record<string, unknown> = { name: options.name ?? serviceId, socket: 'a2ui.sock' }
  if (options.icon !== undefined) manifest.icon = options.icon
  await writeManifest(directory, manifest)

  return {
    directory,
    push(message) {
      history.push(message)
      const encoded = `${JSON.stringify(message)}\n`
      for (const socket of connections) socket.write(encoded)
    },
    next() {
      const message = received.shift()
      return message ? Promise.resolve(message) : new Promise((resolvePromise) => waiters.push(resolvePromise))
    },
    disconnect: stopListening,
    async restart() {
      history.length = 0
      await listen()
    },
    async stop() {
      await stopListening()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
