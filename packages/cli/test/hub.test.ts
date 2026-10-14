import assert from 'node:assert/strict'
import path from 'node:path'
import process from 'node:process'
import { test } from '@omochi-ui/core/testing'
import { fileURLToPath } from 'node:url'

import { actionMessage, createSurface, messageQueue, opened, waitFor } from '@omochi-ui/core/testing'
import type { ServiceView } from '@omochi-ui/core'
import { certificateFingerprint, createStaticLocator, createXdgManifestProvider, gatewayEndpointKey, loadNodeIdentity, openTrustStore, probeGateway, startGateway } from '@omochi-ui/discovery'
import { fakeService, tempRuntimeRoot } from '@omochi-ui/discovery/testing'
import { WebSocket } from 'ws'

import { startFakeGateway, type FakeGateway } from './fake-gateway.js'
import { superviseLocalGateway } from '../src/hub/gateway-supervisor.js'
import { startHub, type HubHandle } from '../src/hub/hub.js'

/** Bun runs the source entrypoint, so the supervisor tests spawn a real gateway. */
const gatewayBin = fileURLToPath(new URL('../src/cli.js', import.meta.url))

const NODE_A = 'aaaaaaaaaaaaaaaa'
const NODE_B = 'bbbbbbbbbbbbbbbb'

const NOTHING = Symbol('no message arrived')

/**
 * Reads until a message matches, with its own deadline.
 *
 * `waitFor` cannot be used to poll a message queue: it awaits its condition, so a queue
 * that never delivers would hang instead of failing.
 */
async function untilMessage(
  next: () => Promise<unknown>,
  matches: (message: Record<string, unknown>) => boolean,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const message = await Promise.race([
      next(),
      new Promise((resolveTimer) => setTimeout(() => resolveTimer(NOTHING), Math.max(0, deadline - Date.now()))),
    ])
    if (message === NOTHING) break
    if (matches(message as Record<string, unknown>)) return
  }
  throw new Error('timed out waiting for a matching message')
}

function connected(id: string, name = id): ServiceView {
  return { id, name, status: 'connected' }
}

async function startTestHub(
  gateways: FakeGateway[],
  options: { allowOrigins?: string[] } = {},
): Promise<HubHandle> {
  return startHub({
    port: 0,
    allowOrigins: options.allowOrigins ?? [],
    autoGateway: false,
    gateways: [createStaticLocator(gateways.map((gateway) => gateway.endpoint))],
  })
}

async function services(hub: HubHandle): Promise<ServiceView[]> {
  const response = await fetch(`${hub.httpUrl}/services`)
  return response.json() as Promise<ServiceView[]>
}

test('namespaces every node into one A2UI stream', async (t) => {
  const alpha = await startFakeGateway(t, { nodeId: NODE_A, name: 'desktop' })
  const beta = await startFakeGateway(t, { nodeId: NODE_B, name: 'laptop' })
  alpha.setServices([connected('mic', 'Mic')])
  beta.setServices([{ ...connected('mic', 'Mic'), icon: '🎤' }])
  alpha.push('mic', createSurface('main'))
  beta.push('mic', createSurface('main'))

  const hub = await startTestHub([alpha, beta])
  t.after(() => hub.close())
  await waitFor(async () => (await services(hub)).length === 2)

  const socket = new WebSocket(hub.url)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())

  const surfaceIds = new Set<string>()
  for (let index = 0; index < 2; index += 1) {
    const message = (await next()) as { createSurface: { surfaceId: string } }
    surfaceIds.add(message.createSurface.surfaceId)
  }
  assert.deepEqual([...surfaceIds].sort(), [`${NODE_A}~mic/main`, `${NODE_B}~mic/main`])

  const listed = (await services(hub)).sort((left, right) => left.id.localeCompare(right.id))
  assert.deepEqual(listed, [
    { id: `${NODE_A}~mic`, name: 'Mic', status: 'connected', node: { id: NODE_A, name: 'desktop', local: false } },
    { id: `${NODE_B}~mic`, name: 'Mic', status: 'connected', icon: '🎤', node: { id: NODE_B, name: 'laptop', local: false } },
  ])
})

test('routes an action to one node and scopes the client data model across nodes', async (t) => {
  // Both machines run a service called `mic`; without the node prefix they collide.
  const alpha = await startFakeGateway(t, { nodeId: NODE_A })
  const beta = await startFakeGateway(t, { nodeId: NODE_B })
  alpha.setServices([connected('mic')])
  beta.setServices([connected('mic')])
  alpha.push('mic', createSurface('main'))
  beta.push('mic', createSurface('main'))

  const hub = await startTestHub([alpha, beta])
  t.after(() => hub.close())
  await waitFor(async () => (await services(hub)).length === 2)

  const socket = new WebSocket(hub.url)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())
  await next()
  await next()

  socket.send(JSON.stringify(actionMessage(`${NODE_B}~mic/main`, {
    [`${NODE_A}~mic/main`]: { $local: { form: { draft: 'typed on the other machine' } } },
    [`${NODE_B}~mic/main`]: { count: 1 },
  })))

  // The gateway receives exactly what a renderer attached straight to it would send.
  assert.deepEqual(await beta.next(), {
    version: 'v0.9',
    action: { name: 'run', surfaceId: 'mic/main', sourceComponentId: 'root', timestamp: '2026-08-12T00:00:00.000Z', context: {} },
    metadata: { a2uiClientDataModel: { version: 'v0.9', surfaces: { 'mic/main': { count: 1 } } } },
  })

  const alphaReceived = await Promise.race([
    alpha.next().then(() => true),
    new Promise((resolveTimer) => setTimeout(() => resolveTimer(false), 150)),
  ])
  assert.equal(alphaReceived, false, 'the other node must not observe the action')
})

test('retracts a whole node when it disappears and leaves the others intact', async (t) => {
  const alpha = await startFakeGateway(t, { nodeId: NODE_A })
  const beta = await startFakeGateway(t, { nodeId: NODE_B })
  alpha.setServices([connected('mic')])
  beta.setServices([connected('cam')])
  alpha.push('mic', createSurface('main'))

  const hub = await startTestHub([alpha, beta])
  t.after(() => hub.close())
  const socket = new WebSocket(hub.url)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())
  assert.deepEqual(await next(), createSurface(`${NODE_A}~mic/main`))

  beta.push('cam', createSurface('main'))
  assert.deepEqual(await next(), createSurface(`${NODE_B}~cam/main`))

  await beta.stop()
  assert.deepEqual(await next(), { version: 'v0.9', deleteSurface: { surfaceId: `${NODE_B}~cam/main` } })
  await waitFor(async () => (await services(hub)).some((service) => service.node?.id === NODE_B && service.status !== 'connected'))

  // The surviving node is untouched by its neighbour going away.
  alpha.push('mic', { version: 'v0.9', updateComponents: { surfaceId: 'main', components: [{ id: 'root', component: 'Text', text: 'alive' }] } })
  assert.deepEqual(await next(), {
    version: 'v0.9',
    updateComponents: { surfaceId: `${NODE_A}~mic/main`, components: [{ id: 'root', component: 'Text', text: 'alive' }] },
  })
})

test('retracts on a dropped gateway and re-attaches when it comes back', async (t) => {
  const alpha = await startFakeGateway(t, { nodeId: NODE_A })
  alpha.setServices([connected('mic')])
  alpha.push('mic', createSurface('main'))

  const hub = await startTestHub([alpha])
  t.after(() => hub.close())
  const socket = new WebSocket(hub.url)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())
  assert.deepEqual(await next(), createSurface(`${NODE_A}~mic/main`))

  alpha.drop()
  assert.deepEqual(await next(), { version: 'v0.9', deleteSurface: { surfaceId: `${NODE_A}~mic/main` } })
  await waitFor(async () => (await services(hub)).some((service) => service.status !== 'connected'))

  // The gateway is still bound, so the hub's backoff reattaches on its own.
  await waitFor(async () => (await services(hub)).every((service) => service.status === 'connected'))
  alpha.push('mic', createSurface('other'))
  await untilMessage(next, (message) => {
    const body = message.createSurface as { surfaceId?: string } | undefined
    return body?.surfaceId === `${NODE_A}~mic/other`
  })
})

test('sends a merged prefixed snapshot to a renderer that joins late', async (t) => {
  const alpha = await startFakeGateway(t, { nodeId: NODE_A })
  const beta = await startFakeGateway(t, { nodeId: NODE_B })
  alpha.setServices([connected('mic')])
  beta.setServices([connected('cam')])
  alpha.push('mic', createSurface('main'))
  alpha.push('mic', { version: 'v0.9', updateDataModel: { surfaceId: 'main', path: '/', value: { count: 0 } } })
  alpha.push('mic', { version: 'v0.9', updateDataModel: { surfaceId: 'main', path: '/count', value: 7 } })
  beta.push('cam', createSurface('main'))

  const hub = await startTestHub([alpha, beta])
  t.after(() => hub.close())
  await waitFor(async () => (await services(hub)).length === 2)

  const socket = new WebSocket(hub.url)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())

  const replay: unknown[] = []
  for (let index = 0; index < 3; index += 1) replay.push(await next())
  assert.ok(replay.some((message) => JSON.stringify(message) === JSON.stringify(createSurface(`${NODE_A}~mic/main`))))
  assert.ok(replay.some((message) => JSON.stringify(message) === JSON.stringify(createSurface(`${NODE_B}~cam/main`))))
  assert.ok(replay.some((message) => JSON.stringify(message) === JSON.stringify({
    version: 'v0.9',
    updateDataModel: { surfaceId: `${NODE_A}~mic/main`, path: '/', value: { count: 7 } },
  })))
})

test('keeps serving reachable nodes while an unreachable one is retried', async (t) => {
  const healthy = await startFakeGateway(t, { nodeId: NODE_A })
  healthy.setServices([connected('mic')])
  healthy.push('mic', createSurface('main'))

  // A gateway that was advertised but is not listening: nothing answers its socket.
  const dead = await startFakeGateway(t, { nodeId: NODE_B })
  await dead.stop()

  const hub = await startHub({
    port: 0,
    autoGateway: false,
    gateways: [createStaticLocator([healthy.endpoint, dead.endpoint])],
  })
  t.after(() => hub.close())

  const socket = new WebSocket(hub.url)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())
  assert.deepEqual(await next(), createSurface(`${NODE_A}~mic/main`))

  // The dead node never completes a handshake, so it contributes no rows at all.
  await waitFor(async () => (await services(hub)).length === 1)
  healthy.push('mic', { version: 'v0.9', updateComponents: { surfaceId: 'main', components: [{ id: 'root', component: 'Text', text: 'alive' }] } })
  assert.deepEqual(await next(), {
    version: 'v0.9',
    updateComponents: { surfaceId: `${NODE_A}~mic/main`, components: [{ id: 'root', component: 'Text', text: 'alive' }] },
  })
})

test('reports why a node was dropped instead of letting it vanish', async (t) => {
  const healthy = await startFakeGateway(t, { nodeId: NODE_A })
  const broken = await startFakeGateway(t, { nodeId: NODE_B })
  healthy.setServices([connected('mic')])
  broken.setServices([connected('mic')])
  healthy.push('mic', createSurface('main'))
  broken.push('mic', createSurface('main'))

  const hub = await startTestHub([healthy, broken])
  t.after(() => hub.close())
  const socket = new WebSocket(hub.url)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())
  await waitFor(async () => (await services(hub)).filter((service) => service.status === 'connected').length === 2)
  await next()
  await next()

  // A duplicate createSurface is a protocol violation the hub's own snapshot rejects.
  broken.push('mic', createSurface('main'))
  assert.deepEqual(await next(), { version: 'v0.9', deleteSurface: { surfaceId: `${NODE_B}~mic/main` } })
  await waitFor(async () => {
    const entry = (await services(hub)).find((service) => service.node?.id === NODE_B)
    return entry?.status === 'error' && /already exists/.test(entry.detail ?? '')
  })

  // The healthy node keeps streaming while its neighbour is in error.
  healthy.push('mic', { version: 'v0.9', updateComponents: { surfaceId: 'main', components: [{ id: 'root', component: 'Text', text: 'alive' }] } })
  await untilMessage(next, (message) => {
    const body = message.updateComponents as { surfaceId?: string } | undefined
    return body?.surfaceId === `${NODE_A}~mic/main`
  })
})

test('drops a node that sends a surface id it never namespaced', async (t) => {
  const rogue = await startFakeGateway(t, { nodeId: NODE_A })
  rogue.setServices([connected('mic')])

  const hub = await startTestHub([rogue])
  t.after(() => hub.close())
  await waitFor(async () => (await services(hub)).length === 1)

  rogue.pushRaw(createSurface('main'))
  await waitFor(async () => {
    const entry = (await services(hub)).find((service) => service.node?.id === NODE_A)
    return entry?.status === 'error' && /namespaced/.test(entry.detail ?? '')
  })
})

test('answers /services for loopback origins and refuses foreign ones', async (t) => {
  const hub = await startTestHub([])
  t.after(() => hub.close())

  const allowed = await fetch(`${hub.httpUrl}/services`, { headers: { Origin: 'http://localhost:5173' } })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173')
  assert.equal(allowed.headers.get('vary'), 'Origin')

  const refused = await fetch(`${hub.httpUrl}/services`, { headers: { Origin: 'https://evil.example' } })
  assert.equal(refused.status, 403)

  const unknown = await fetch(`${hub.httpUrl}/nope`)
  assert.equal(unknown.status, 404)
})

test('refuses a WebSocket upgrade from an origin that is not allowed', async (t) => {
  const hub = await startTestHub([], { allowOrigins: ['https://studio.example'] })
  t.after(() => hub.close())

  const refused = new WebSocket(hub.url, { headers: { Origin: 'https://evil.example' } })
  refused.on('error', () => {})
  const rejectedStatus = await new Promise<number>(resolve => refused.once('unexpected-response', (_request, response) => resolve(response.statusCode!)))
  assert.equal(rejectedStatus, 403)

  const allowed = new WebSocket(hub.url, { headers: { Origin: 'https://studio.example' } })
  await opened(allowed)
  allowed.close()
})

test('streams the service list over SSE and still shuts down promptly', async (t) => {
  const alpha = await startFakeGateway(t, { nodeId: NODE_A })
  alpha.setServices([connected('mic', 'Mic')])

  const hub = await startTestHub([alpha])
  const events = await fetch(`${hub.httpUrl}/events`, { headers: { Origin: 'http://127.0.0.1:5173' } })
  assert.equal(events.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  const reader = events.body!.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const readEvent = async (): Promise<string> => {
    while (!buffered.includes('\n\n')) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('the event stream ended')
      buffered += decoder.decode(chunk.value, { stream: true })
    }
    const [frame, ...rest] = buffered.split('\n\n')
    buffered = rest.join('\n\n')
    return frame!
  }

  let frame = await readEvent()
  while (!frame.includes(`${NODE_A}~mic`)) frame = await readEvent()

  alpha.setServices([])
  let removal = await readEvent()
  while (!removal.startsWith('event: services') || !removal.includes('data: []')) removal = await readEvent()

  // An open SSE response would otherwise keep http.Server.close() pending forever.
  await Promise.race([
    hub.close(),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('hub.close() did not settle')), 3000)),
  ])
})

test('merges a real gateway end to end, from application socket to renderer', async (t) => {
  const root = await tempRuntimeRoot(t)
  const app = await fakeService(root, 'mic', { name: 'Mic', icon: '🎤' })
  t.after(() => app.stop())
  app.push(createSurface('main'))

  const gateway = await startGateway({ root, nodeId: NODE_A, name: 'desktop' })
  t.after(() => gateway.close())

  const hub = await startHub({
    port: 0,
    autoGateway: false,
    gateways: [createStaticLocator([{ kind: 'unix', socketPath: gateway.socketPath }])],
  })
  t.after(() => hub.close())

  const socket = new WebSocket(hub.url)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())
  assert.deepEqual(await next(), createSurface(`${NODE_A}~mic/main`))

  await waitFor(async () => {
    const listed = await services(hub)
    return listed.length === 1 && listed[0]!.id === `${NODE_A}~mic` && listed[0]!.status === 'connected'
  })
  assert.deepEqual((await services(hub))[0], {
    id: `${NODE_A}~mic`,
    name: 'Mic',
    icon: '🎤',
    status: 'connected',
    node: { id: NODE_A, name: 'desktop', local: false },
  })

  // An action travels renderer -> hub -> gateway -> application socket.
  socket.send(JSON.stringify(actionMessage(`${NODE_A}~mic/main`, { [`${NODE_A}~mic/main`]: { count: 1 } })))
  assert.deepEqual(await app.next(), {
    version: 'v0.9',
    action: { name: 'run', surfaceId: 'main', sourceComponentId: 'root', timestamp: '2026-08-12T00:00:00.000Z', context: {} },
    metadata: { a2uiClientDataModel: { version: 'v0.9', surfaces: { main: { count: 1 } } } },
  })
})

test('two hubs racing to start a gateway end up sharing one', async (t) => {
  const root = await tempRuntimeRoot(t)
  const socketPath = path.join(root, 'gateway.sock')
  const command = [process.execPath, gatewayBin, 'gateway', '--socket', socketPath, '--root', root]

  // Both probe an empty socket, both try to start; the loser must reuse the winner's
  // gateway rather than unlink a live socket out from under it.
  const [first, second] = await Promise.all([
    superviseLocalGateway(socketPath, { command }),
    superviseLocalGateway(socketPath, { command }),
  ])
  t.after(() => first.close())
  t.after(() => second.close())

  assert.equal([first.spawned, second.spawned].filter(Boolean).length <= 1 ? 'ok' : 'both spawned', 'ok')
  const info = await probeGateway({ kind: 'unix', socketPath })
  assert.ok(info, 'a gateway is listening after the race')

  // Closing the loser must leave the shared gateway alone.
  const loser = first.spawned ? second : first
  await loser.close()
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  assert.ok(await probeGateway({ kind: 'unix', socketPath }), 'the shared gateway survives the loser exiting')
})

test('reuses a gateway that is already listening instead of starting another', async (t) => {
  const root = await tempRuntimeRoot(t)
  const gateway = await startGateway({ root, nodeId: NODE_B, name: 'existing' })
  t.after(() => gateway.close())

  const supervisor = await superviseLocalGateway(gateway.socketPath)
  t.after(() => supervisor.close())
  assert.equal(supervisor.spawned, false)

  // The gateway it found is not its to stop.
  await supervisor.close()
  const info = await probeGateway({ kind: 'unix', socketPath: gateway.socketPath })
  assert.equal(info?.nodeId, NODE_B)
})


test('forget retracts a remote gateway from a running hub and stops reconnecting', async t => {
  const root = await tempRuntimeRoot(t)
  const app = await fakeService(root, 'mic', { name: 'Mic' })
  t.after(() => app.stop())
  app.push(createSurface('main'))
  const hubConfig = await tempRuntimeRoot(t), gatewayConfig = await tempRuntimeRoot(t)
  const identity = await loadNodeIdentity({ root: hubConfig })
  const remoteIdentity = await loadNodeIdentity({ root: gatewayConfig })
  const trust = await openTrustStore(hubConfig), remoteTrust = await openTrustStore(gatewayConfig)
  for (const [store, peer, role] of [[trust, remoteIdentity, 'gateway'], [remoteTrust, identity, 'hub']] as const) {
    await store.put({ nodeId: peer.nodeId, name: peer.name, certificate: peer.certificate, fingerprint: certificateFingerprint(peer.certificate), role, pairedAt: new Date().toISOString() })
  }
  const gateway = await startGateway({ root, identity: remoteIdentity, trust: remoteTrust, listen: { host: '127.0.0.1', port: 0 }, discovery: createXdgManifestProvider({ root }) })
  t.after(() => gateway.close())
  const endpoint = { kind: 'tcp' as const, ...gateway.address! }
  const hub = await startHub({ port: 0, autoGateway: false, identity, trust, configRoot: hubConfig, gateways: [createStaticLocator([endpoint], new Map([[gatewayEndpointKey(endpoint), remoteIdentity.nodeId]]))] })
  t.after(() => hub.close())
  await waitFor(() => hub.nodeCount === 1)
  const socket = new WebSocket(hub.url)
  const next = messageQueue(socket)
  t.after(() => socket.close())
  await opened(socket)
  assert.deepEqual(await next(), createSurface(`${remoteIdentity.nodeId}~mic/main`))
  await (await openTrustStore(hubConfig)).forget(remoteIdentity.nodeId)
  assert.equal(hub.nodeCount, 0)
  assert.deepEqual(await next(), { version: 'v0.9', deleteSurface: { surfaceId: `${remoteIdentity.nodeId}~mic/main` } })
  assert.deepEqual(await services(hub), [])
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(hub.nodeCount, 0)
})
