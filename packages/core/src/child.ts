import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import process from 'node:process'

export interface ChildSession {
  readonly child: ChildProcessWithoutNullStreams
  readonly exited: Promise<number>
  /** True once the child has exited or failed to start. */
  readonly finished: boolean
  writeLine(value: unknown): void
  kill(signal?: NodeJS.Signals): void
}

export interface ChildSessionOptions {
  onExit?(exitCode: number): void
  onError?(error: Error): void
}

export function spawnChildSession(command: string[], options: ChildSessionOptions = {}): ChildSession {
  if (!command.length) throw new Error('a child command is required after --')
  const child = spawn(command[0]!, command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
  child.stderr.pipe(process.stderr)

  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((resolvePromise) => {
    resolveExit = resolvePromise
  })
  let finished = false

  child.once('exit', (code, signal) => {
    finished = true
    const exitCode = code ?? (signal ? 1 : 0)
    options.onExit?.(exitCode)
    resolveExit(exitCode)
  })
  child.once('error', (error) => {
    finished = true
    options.onError?.(error)
    resolveExit(1)
  })

  return {
    child,
    exited,
    get finished() {
      return finished
    },
    writeLine(value) {
      child.stdin.write(`${JSON.stringify(value)}\n`)
    },
    kill(signal) {
      if (child.exitCode === null) child.kill(signal ?? 'SIGTERM')
    },
  }
}
