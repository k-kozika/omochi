import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { probeGateway } from '@omochi-ui/discovery'

// Fixed shell program: no user input is interpolated into a remote command.
const RESOLVE_SOCKET = 'if [ -n "$XDG_RUNTIME_DIR" ]; then printf "%s/omochi/gateway.sock\\n" "${XDG_RUNTIME_DIR%/}"; else printf "%s/omochi-%s/omochi/gateway.sock\\n" "${TMPDIR:-${TMP:-${TEMP:-/tmp}}}" "$(id -u)"; fi'

export function validateSshTarget(host: string, socket?: string): void {
  if (!host || host.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(host)) {
    throw new Error('SSH target must be a host alias or user@host, not SSH options')
  }
  if (socket !== undefined && (!socket.startsWith('/') || /[:\x00-\x1f\x7f]/.test(socket))) {
    throw new Error('SSH socket must be an absolute path without colons or control characters')
  }
}

export interface SshGateway {
  readonly socketPath: string
  /** Resolves even if SSH exits before the caller starts watching it. */
  readonly exited: Promise<Error>
  close(): Promise<void>
}

export interface SshGatewayOptions {
  host: string
  remoteSocket?: string
  signal?: AbortSignal
  /** Injectable executable for tests. */
  command?: string[]
  startTimeoutMs?: number
}

export async function startSshGateway(options: SshGatewayOptions): Promise<SshGateway> {
  validateSshTarget(options.host, options.remoteSocket)
  options.signal?.throwIfAborted()
  const directory = await mkdtemp(path.join(tmpdir(), 'omochi-ssh-'))
  const socketPath = path.join(directory, 'gateway.sock')
  const command = options.command ?? ['ssh']
  let child: ChildProcess | undefined
  let finished: Promise<Error> = Promise.resolve(new Error('SSH not started'))
  let failure: Error | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    options.signal?.removeEventListener('abort', abort)
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const timer = setTimeout(() => child?.kill('SIGKILL'), 1000)
      await finished
      clearTimeout(timer)
    }
    await rm(directory, { recursive: true, force: true })
  })()
  const abort = () => { void close() }
  options.signal?.addEventListener('abort', abort, { once: true })
  const launch = (args: string[], capture: boolean) => {
    options.signal?.throwIfAborted()
    failure = undefined
    child = spawn(command[0]!, [...command.slice(1), ...args], {
      stdio: ['inherit', capture ? 'pipe' : 'ignore', 'inherit'],
    })
    finished = new Promise<Error>((resolve) => {
      child!.once('error', (error) => { failure = error; resolve(error) })
      child!.once('close', (code, signal) => {
        const error = new Error(`SSH to ${options.host} exited (${signal ?? code})`)
        failure = error
        resolve(error)
      })
    })
    return child
  }
  try {
    let remoteSocket = options.remoteSocket
    if (remoteSocket === undefined) {
      const resolver = launch(['-T', '-o', 'ControlMaster=no', options.host, `sh -c '${RESOLVE_SOCKET}'`], true)
      let output = ''
      resolver.stdout!.setEncoding('utf8').on('data', (data: string) => {
        output += data
        if (output.length > 16384) resolver.kill('SIGTERM')
      })
      const error = await finished
      options.signal?.throwIfAborted()
      if (resolver.exitCode !== 0) throw error
      remoteSocket = output.trimEnd()
      validateSshTarget(options.host, remoteSocket)
    }
    launch([
      '-N', '-T', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3', '-L', `${socketPath}:${remoteSocket}`, options.host,
    ], false)
    // OpenSSH creates the listener after authentication; do not time out a prompt.
    while (!(await stat(socketPath).catch(() => null))?.isSocket()) {
      options.signal?.throwIfAborted()
      if (failure) throw failure
      await delay(50)
    }
    const deadline = Date.now() + (options.startTimeoutMs ?? 10000)
    while (true) {
      options.signal?.throwIfAborted()
      if (failure) throw failure
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`gateway at ${options.host}:${remoteSocket} did not answer within the connection timeout`)
      let timer: ReturnType<typeof setTimeout> | undefined
      const ready = await Promise.race([
        probeGateway({ kind: 'unix', socketPath }),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining) }),
      ]).finally(() => clearTimeout(timer))
      if (ready) break
      await delay(50)
    }
    options.signal?.throwIfAborted()
    if (failure) throw failure
    return { socketPath, exited: finished, close }
  } catch (error) {
    await close()
    throw error
  }
}
