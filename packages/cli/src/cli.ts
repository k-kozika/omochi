#!/usr/bin/env bun
import { hostname, networkInterfaces } from 'node:os'
import process from 'node:process'

import {
  createStaticLocator,
  gatewayEndpointKey,
  loadNodeIdentity,
  omochiConfigRoot,
  openTrustStore,
  pairWithGateway,
  parseGatewayTarget,
  startGateway,
  type GatewayEndpoint,
  type GatewayLocator,
} from '@omochi-ui/discovery'

import { generateCatalog, type GenerateCatalogOptions } from './catalog-codegen.js'
import { helpText, helpTopic } from './help.js'
import { startHub } from './hub/hub.js'
import { startSshGateway, validateSshTarget, type SshGateway } from './hub/ssh-gateway.js'
import { startStdioWebSocketBridge } from './stdio-websocket-bridge.js'
import { loadComposition, openBrowser, startCompositionServices } from './up.js'

/**
 * An address another machine could actually dial.
 *
 * A wildcard bind is what the gateway listens on, not somewhere anyone can connect to,
 * so printing it back would send a person to `0.0.0.0`.
 */
function reachableHost(bound: string): string {
  if (bound !== '0.0.0.0' && bound !== '::' && bound !== '') return bound
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return hostname()
}

function usage(message = 'Invalid or incomplete arguments.'): never {
  process.stderr.write(`[omochi-ui] ${message}\n\n${helpText(topic) ?? helpText()}`)
  process.exit(2)
}

const args = process.argv.slice(2)
// Stop scanning at -- so e.g. `dev -- python app.py --help` reaches the app.
const separatorIndex = args.indexOf('--')
const ownArgs = separatorIndex < 0 ? args : args.slice(0, separatorIndex)
const explicitHelp = ownArgs[0] === 'help'
const helpArgs = explicitHelp ? ownArgs.slice(1) : ownArgs
const topic = helpTopic(helpArgs.filter((arg) => arg !== '--help' && arg !== '-h'))
if (!args.length || explicitHelp || ownArgs.some((arg) => arg === '--help' || arg === '-h')) {
  const text = helpText(topic)
  if (text === undefined || (explicitHelp && helpArgs.length > (topic.includes(' ') ? 2 : 1))) {
    usage(`Unknown help topic: ${helpArgs.join(' ')}`)
  }
  process.stdout.write(text)
  process.exit(0)
}
const commandName = args.shift()

if (commandName === 'generate') {
  if (args.shift() !== 'catalog') usage()
  const options: GenerateCatalogOptions = { catalog: '' }
  while (args.length) {
    const option = args.shift()!
    if (option === '--check') { options.check = true; continue }
    const value = args.shift()
    if (!value) usage()
    if (option === '--catalog') options.catalog = value
    else if (option === '--name') options.name = value
    else if (option === '--typescript') options.typescript = value
    else if (option === '--python') options.python = value
    else if (option === '--rust') options.rust = value
    else usage()
  }
  if (!options.catalog) usage()
  await generateCatalog(options)
  process.exit(0)
}

if (commandName === 'id') {
  let nodeName: string | undefined
  while (args.length) {
    const option = args.shift()!
    const value = args.shift()
    if (!value || option !== '--node-name') usage()
    nodeName = value
  }
  const identity = await loadNodeIdentity(nodeName === undefined ? {} : { name: nodeName })
  process.stdout.write(`${identity.nodeId}\t${identity.name}\n`)
  process.stderr.write(`[omochi-ui] identity stored in ${omochiConfigRoot()}\n`)
  process.exit(0)
}

if (commandName === 'pair') {
  const target = args.shift()
  if (!target) usage()
  const parsed = parseGatewayTarget(target)
  if (!parsed || parsed.endpoint.kind !== 'tcp') usage()
  let code: string | undefined
  while (args.length) {
    const option = args.shift()!
    const value = args.shift()
    if (!value || option !== '--code') usage()
    code = value
  }
  // Reading the code from stdin keeps it out of shell history.
  if (code === undefined) {
    process.stderr.write('[omochi-ui] pairing code: ')
    code = await new Promise<string>((resolvePromise) => {
      let typed = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk: string) => {
        typed += chunk
        const line = typed.indexOf('\n')
        if (line >= 0) {
          process.stdin.pause()
          resolvePromise(typed.slice(0, line))
        }
      })
      process.stdin.on('end', () => resolvePromise(typed))
    })
  }

  const identity = await loadNodeIdentity()
  const trust = await openTrustStore()
  try {
    const peer = await pairWithGateway(parsed.endpoint, { identity, trust, code })
    process.stderr.write(`[omochi-ui] paired with ${peer.nodeId} (${peer.name})\n`)
    process.stderr.write(`[omochi-ui] reach it with: omochi-ui hub --gateway ${peer.nodeId}@${peer.addresses![0]}\n`)
    process.exit(0)
  } catch (error) {
    process.stderr.write(`[omochi-ui] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}

if (commandName === 'trust') {
  const action = args.shift()
  if (action !== 'list' && action !== 'forget') usage('Expected trust list or trust forget <nodeId>.')
  if (action === 'list' && args.length !== 0) usage('trust list takes no arguments.')
  if (action === 'forget' && args.length !== 1) usage('trust forget requires exactly one node ID.')
  const store = await openTrustStore()
  if (action === 'list') {
    const peers = store.list()
    if (store.legacy) process.stderr.write('[omochi-ui] old TLS-PSK pairings are unsupported; pair devices again\n')
    if (!peers.length) process.stderr.write(`[omochi-ui] no paired peers in ${store.file}\n`)
    for (const peer of peers) {
      const seen = peer.lastSeenAt ? ` last seen ${peer.lastSeenAt}` : ''
      process.stdout.write(`${peer.nodeId}\t${peer.role}\t${peer.name}\tpaired ${peer.pairedAt}${seen}\n`)
    }
    process.exit(0)
  }
  if (action === 'forget') {
    const nodeId = args.shift()
    if (!nodeId) usage()
    const forgotten = await store.forget(nodeId)
    process.stderr.write(forgotten
      ? `[omochi-ui] forgot ${nodeId}\n`
      : `[omochi-ui] no paired peer ${nodeId}\n`)
    process.exit(forgotten ? 0 : 1)
  }
  usage()
}

if (commandName === 'gateway') {
  let root: string | undefined
  let socketPath: string | undefined
  let nodeName: string | undefined
  let listen: { host: string; port: number } | undefined
  let pairing: Record<string, never> | undefined
  let advertise = false
  while (args.length) {
    const option = args.shift()!
    // `--lan` is sugar; accepting hubs and advertising stay separate switches.
    if (option === '--lan') { listen = { host: '0.0.0.0', port: 5556 }; advertise = true; continue }
    if (option === '--advertise') { advertise = true; continue }
    if (option === '--pair') { pairing = {}; continue }
    const value = args.shift()
    if (!value) usage()
    if (option === '--root') root = value
    else if (option === '--socket') socketPath = value
    else if (option === '--node-name') nodeName = value
    else if (option === '--listen') {
      const target = parseGatewayTarget(value)
      if (!target || target.endpoint.kind !== 'tcp') usage()
      listen = { host: target.endpoint.host, port: target.endpoint.port }
    }
    else usage()
  }
  if ((pairing || advertise) && !listen) usage('--pair and --advertise require --listen HOST:PORT or --lan.')
  const gateway = await startGateway({ root, socketPath, name: nodeName, listen, pairing, advertise })
    .catch((error: NodeJS.ErrnoException) => {
      // Two gateways on one machine is the common mistake here, and a stack trace is a
      // poor way to say so.
      if (error.code === 'EADDRINUSE' && listen) {
        process.stderr.write(`[omochi-ui] ${listen.host}:${listen.port} is already in use; another gateway may be running\n`)
        process.exit(1)
      }
      if (error.code === 'EADDRINUSE') {
        process.stderr.write('[omochi-ui] a gateway is already listening on this machine\n')
        process.exit(1)
      }
      throw error
    })
  process.stderr.write(`[omochi-ui] gateway ${gateway.nodeId} (${gateway.name})\n[omochi-ui] publishing services from ${gateway.root}\n[omochi-ui] listening on ${gateway.socketPath}\n`)
  if (gateway.address) {
    const peers = (await openTrustStore()).list().filter((peer) => peer.role === 'hub').length
    process.stderr.write(`[omochi-ui] reachable from the local network on ${gateway.address.host}:${gateway.address.port}; ${peers} hub(s) paired\n`)
    if (advertise) process.stderr.write(`[omochi-ui] advertising as _${'omochi-ui'}._tcp\n`)
  }
  if (gateway.pairing) {
    const seconds = Math.round((gateway.pairing.expiresAt - Date.now()) / 1000)
    process.stderr.write([
      `[omochi-ui] pairing code: ${gateway.pairing.display}   (valid ${seconds}s, one use)`,
      `[omochi-ui] on the other machine: omochi-ui pair ${reachableHost(gateway.pairingAddress!.host)}:${gateway.pairingAddress!.port}`,
      '',
    ].join('\n'))
    void gateway.pairing.ended.then((reason) => {
      // The gateway keeps running either way; only the window is over.
      process.stderr.write(`[omochi-ui] pairing window closed: ${reason}\n`)
    })
  }
  const stop = () => void gateway.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
} else if (commandName === 'up') {
  let host = '127.0.0.1'
  let port = 5555
  let shouldOpen = false
  const allowOrigins: string[] = []
  let file = 'omochi.toml'
  let foundFile = false
  while (args.length) {
    const option = args.shift()!
    if (option === '--open') { shouldOpen = true; continue }
    if (!option.startsWith('-')) {
      if (foundFile) usage('up accepts at most one composition file.')
      file = option
      foundFile = true
      continue
    }
    const value = args.shift()
    if (!value) usage()
    if (option === '--host') host = value
    else if (option === '--port' && Number.isInteger(Number(value))) port = Number(value)
    else if (option === '--allow-origin') allowOrigins.push(value)
    else usage()
  }
  if (port < 0 || port > 65535) usage('--port must be an integer from 0 to 65535.')

  let services: ReturnType<typeof startCompositionServices> | undefined
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  let shutdown: Promise<never> | undefined
  const stop = (code = 0): Promise<never> => shutdown ??= (async () => {
    await services?.close()
    await hub?.close()
    process.exit(code)
  })()
  process.on('SIGINT', () => { void stop(130) })
  process.on('SIGTERM', () => { void stop(143) })
  try {
    const identity = await loadNodeIdentity()
    const composition = await loadComposition(file, identity.nodeId)
    services = startCompositionServices(composition.services)
    hub = await startHub({ host, port, allowOrigins, presets: [composition.preset] })
    const url = new URL(hub.httpUrl)
    url.searchParams.set('preset', composition.id)
    process.stderr.write(`[omochi-ui] composition ${composition.id}: ${composition.services.length} services\n[omochi-ui] ${url.toString()}\n`)
    if (shouldOpen) {
      if (['0.0.0.0', '::'].includes(url.hostname)) url.hostname = '127.0.0.1'
      openBrowser(url.toString())
    }
  } catch (error) {
    process.stderr.write(`[omochi-ui] ${error instanceof Error ? error.message : String(error)}\n`)
    await services?.close()
    await hub?.close()
    process.exit(1)
  }
} else if (commandName === 'hub') {
  let host = '127.0.0.1'
  let port = 5555
  let autoGateway = true
  let discoverLan = false
  let sshHost: string | undefined
  let sshSocket: string | undefined
  const peers: GatewayEndpoint[] = []
  const peerIds = new Map<string, string>()
  const allowOrigins: string[] = []
  while (args.length) {
    const option = args.shift()!
    if (option === '--no-auto-gateway') { autoGateway = false; continue }
    if (option === '--discover-lan') { discoverLan = true; continue }
    const value = args.shift()
    if (!value) usage()
    if (option === '--host') host = value
    else if (option === '--port' && Number.isInteger(Number(value))) port = Number(value)
    else if (option === '--ssh') {
      if (sshHost !== undefined) usage()
      sshHost = value
    } else if (option === '--ssh-socket') {
      if (sshSocket !== undefined) usage()
      sshSocket = value
    } else if (option === '--gateway') {
      const target = parseGatewayTarget(value)
      if (!target) usage()
      peers.push(target.endpoint)
      if (target.nodeId) peerIds.set(gatewayEndpointKey(target.endpoint), target.nodeId)
    }
    else if (option === '--allow-origin') allowOrigins.push(value)
    else usage()
  }
  // Naming a gateway replaces the default, so `--gateway` can point at another machine
  // without also picking up whatever happens to be running locally.
  if (sshSocket !== undefined && sshHost === undefined) usage()
  if (port < 0 || port > 65535) usage('--port must be an integer from 0 to 65535.')
  let tunnel: SshGateway | undefined
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  const abort = new AbortController()
  let stopping = false
  let pending: Promise<unknown> | undefined
  let shutdown: Promise<never> | undefined
  const stop = (code = 0): Promise<never> => shutdown ??= (async () => {
    stopping = true
    abort.abort()
    await pending?.catch(() => {})
    await hub?.close()
    await tunnel?.close()
    process.exit(code)
  })()
  // Install these before SSH can prompt, so cancellation also cleans partial startup.
  process.on('SIGINT', () => { void stop(130) })
  process.on('SIGTERM', () => { void stop(143) })
  try {
    if (sshHost !== undefined) {
      validateSshTarget(sshHost, sshSocket)
      tunnel = await (pending = startSshGateway({ host: sshHost, remoteSocket: sshSocket, signal: abort.signal }))
      peers.push({ kind: 'unix', socketPath: tunnel.socketPath })
    }
    const gateways: GatewayLocator[] | undefined = peers.length ? [createStaticLocator(peers, peerIds)] : undefined
    hub = await (pending = startHub({ host, port, allowOrigins, gateways, discoverLan, autoGateway: autoGateway && !peers.length }))
    if (tunnel) void tunnel.exited.then((error) => {
      if (!stopping) {
        process.stderr.write(`[omochi-ui] ${error.message}\n`)
        void stop(1)
      }
    })
  } catch (error) {
    process.stderr.write(`[omochi-ui] ${error instanceof Error ? error.message : error}\n`)
    await stop(1)
    process.exit(1)
  }
  // Connections are still being established, so name the targets rather than count them.
  const named = peers.length
    ? peers.map((peer) => (peer.kind === 'unix' ? peer.socketPath : `${peer.host}:${peer.port}`)).join(', ')
    : 'the local gateway'
  const targets = discoverLan ? `${named} and any gateway on the local link` : named
  process.stderr.write(`[omochi-ui] merging ${targets}\n[omochi-ui] ${hub.httpUrl}\nA2UI endpoint: ${hub.url}\n`)
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    process.stderr.write('[omochi-ui] warning: hub has no authentication or TLS\n')
  }
} else {
  if (commandName !== 'dev') usage(`Unknown command: ${commandName}`)
  const separator = args.indexOf('--')
  if (separator < 0) usage('dev requires -- followed by the application command.')
  const optionArgs = args.slice(0, separator)
  const childCommand = args.slice(separator + 1)
  let host = '127.0.0.1'
  let port = 5555
  for (let index = 0; index < optionArgs.length; index += 1) {
    const option = optionArgs[index]
    const value = optionArgs[index + 1]
    if (option === '--host' && value) host = value
    else if (option === '--port' && value && Number.isInteger(Number(value))) port = Number(value)
    else usage()
    index += 1
  }
  if (!childCommand.length) usage()
  if (port < 0 || port > 65535) usage('--port must be an integer from 0 to 65535.')

  const handle = await startStdioWebSocketBridge({ command: childCommand, host, port })
  process.stderr.write(`[omochi-ui] bridge: ${handle.url}\nStart the browser preview in another terminal: bun run --filter @omochi-ui/dev-server dev\nOpen: http://127.0.0.1:5173/?ws=${encodeURIComponent(handle.url)}\n`)
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') process.stderr.write('[omochi-ui] warning: bridge has no authentication or TLS\n')
  const forward = (signal: NodeJS.Signals) => { if (handle.child.exitCode === null) handle.child.kill(signal) }
  process.on('SIGINT', forward)
  process.on('SIGTERM', forward)
  process.exitCode = await handle.exited
}
