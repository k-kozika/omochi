import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import process from 'node:process'

import { probeGateway } from '@omochi-ui/discovery'

export interface GatewaySupervisor {
  /** True when this hub started the gateway and is therefore responsible for it. */
  readonly spawned: boolean
  close(): Promise<void>
}

export interface SuperviseOptions {
  /** Overridden in tests; defaults to this CLI's own `gateway` command. */
  command?: string[]
  startTimeoutMs?: number
}

const START_TIMEOUT_MS = 10000
const POLL_MS = 50
/**
 * How long to let a child report that it lost the race.
 *
 * The winner starts listening before the loser's bind fails, so a probe can succeed
 * while our own child is still on its way out. Waiting for that exit is what makes
 * `spawned` mean "this hub owns the gateway" rather than "this hub tried".
 */
const EXIT_GRACE_MS = 250

const idle: GatewaySupervisor = { spawned: false, close: async () => {} }

function gatewayCommand(): string[] {
  // `dist/hub/gateway-supervisor.js` sits one directory below `dist/cli.js`.
  return [process.execPath, new URL('../cli.js', import.meta.url).pathname, 'gateway']
}

async function waitForGateway(socketPath: string, deadline: number, child: ChildProcess | null): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await probeGateway({ kind: 'unix', socketPath })) return true
    // A child that exited lost the race for the socket, or failed outright; either way
    // the next probe decides, because the winner is already listening.
    if (child && child.exitCode !== null) return (await probeGateway({ kind: 'unix', socketPath })) !== null
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_MS))
  }
  return false
}

/**
 * Makes sure a gateway is listening on this machine.
 *
 * A gateway already there is reused and left running, because it is not ours to stop and
 * other hubs may be attached to it. Only a socket that refuses a connection is removed,
 * and only then is a gateway started — a live socket is never unlinked, so two hubs
 * racing to start end up sharing the winner's gateway instead of destroying it.
 */
export async function superviseLocalGateway(
  socketPath: string,
  options: SuperviseOptions = {},
): Promise<GatewaySupervisor> {
  if (await probeGateway({ kind: 'unix', socketPath })) return idle

  // Nothing answered, so any socket file here is left over from a gateway that died.
  await rm(socketPath, { force: true })

  const command = options.command ?? gatewayCommand()
  const child = spawn(command[0]!, command.slice(1), { stdio: ['ignore', 'ignore', 'inherit'] })
  child.unref()

  const deadline = Date.now() + (options.startTimeoutMs ?? START_TIMEOUT_MS)
  if (!(await waitForGateway(socketPath, deadline, child))) {
    if (child.exitCode === null) child.kill('SIGTERM')
    throw new Error(`the gateway did not start on ${socketPath}`)
  }

  if (child.exitCode === null) {
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolveGrace) => setTimeout(resolveGrace, EXIT_GRACE_MS)),
    ])
  }

  // Losing the race is normal: another hub bound the socket first and owns that process.
  if (child.exitCode !== null) return idle

  return {
    // Reported live, so a gateway that dies later is never mistaken for ours to stop.
    get spawned() {
      return child.exitCode === null
    },
    async close() {
      if (child.exitCode === null) child.kill('SIGTERM')
    },
  }
}
