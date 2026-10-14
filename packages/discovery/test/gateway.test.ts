import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { test } from '@omochi-ui/core/testing'

import { actionMessage, createSurface, messageQueue, opened, waitFor } from '@omochi-ui/core/testing'

import { fakeService, tempRuntimeRoot, writeManifest } from '../src/testing.js'
import { createXdgManifestProvider } from '../src/app/xdg-manifest.js'
import { startGateway } from '../src/gateway/server.js'
import { GATEWAY_PROTOCOL } from '../src/gateway/protocol.js'
import { connectA2ui, connectControl, gatewayGet, services, startTestGateway } from './helpers.js'

test('namespaces every discovered service into one A2UI stream', async (t) => {
  const root = await tempRuntimeRoot(t)
  const alpha = await fakeService(root, 'alpha', { name: 'Alpha', icon: '🅰️' })
  const beta = await fakeService(root, 'beta', { name: 'Beta' })
  t.after(() => alpha.stop())
  t.after(() => beta.stop())
  alpha.push(createSurface('main'))
  beta.push(createSurface('main'))

  const gateway = await startTestGateway(t, root)
  await waitFor(async () => (await services(gateway)).filter((service) => service.status === 'connected').length === 2)

  const socket = connectA2ui(gateway)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())

  const surfaceIds = new Set<string>()
  for (let index = 0; index < 2; index += 1) {
    const message = (await next()) as { createSurface: { surfaceId: string } }
    surfaceIds.add(message.createSurface.surfaceId)
  }
  assert.deepEqual([...surfaceIds].sort(), ['alpha/main', 'beta/main'])

  const listed = (await services(gateway)).sort((left, right) => left.id.localeCompare(right.id))
  assert.deepEqual(listed, [
    { id: 'alpha', name: 'Alpha', icon: '🅰️', status: 'connected' },
    { id: 'beta', name: 'Beta', status: 'connected' },
  ])
})

test('routes an action to one backend and scopes the client data model to it', async (t) => {
  const root = await tempRuntimeRoot(t)
  const alpha = await fakeService(root, 'alpha')
  const beta = await fakeService(root, 'beta')
  t.after(() => alpha.stop())
  t.after(() => beta.stop())
  alpha.push(createSurface('main'))
  beta.push(createSurface('main'))

  const gateway = await startTestGateway(t, root)
  await waitFor(async () => (await services(gateway)).filter((service) => service.status === 'connected').length === 2)

  const socket = connectA2ui(gateway)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())
  await next()
  await next()

  socket.send(JSON.stringify(actionMessage('beta/main', {
    'alpha/main': { $local: { form: { draft: 'still typing in alpha' } } },
    'beta/main': { count: 1 },
  })))

  assert.deepEqual(await beta.next(), {
    version: 'v0.9',
    action: { name: 'run', surfaceId: 'main', sourceComponentId: 'root', timestamp: '2026-08-12T00:00:00.000Z', context: {} },
    metadata: { a2uiClientDataModel: { version: 'v0.9', surfaces: { main: { count: 1 } } } },
  })

  const alphaReceived = await Promise.race([
    alpha.next().then(() => true),
    new Promise((resolveTimer) => setTimeout(() => resolveTimer(false), 150)),
  ])
  assert.equal(alphaReceived, false, 'the other service must not observe the action')
})

test('adds and retracts services while renderers stay connected', async (t) => {
  const root = await tempRuntimeRoot(t)
  const alpha = await fakeService(root, 'alpha')
  t.after(() => alpha.stop())
  alpha.push(createSurface('main'))

  const gateway = await startTestGateway(t, root)
  const socket = connectA2ui(gateway)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())
  assert.deepEqual(await next(), createSurface('alpha/main'))

  const beta = await fakeService(root, 'beta')
  t.after(() => beta.stop())
  beta.push(createSurface('main'))
  assert.deepEqual(await next(), createSurface('beta/main'))

  await beta.stop()
  assert.deepEqual(await next(), { version: 'v0.9', deleteSurface: { surfaceId: 'beta/main' } })
  await waitFor(async () => (await services(gateway)).every((service) => service.id !== 'beta'))

  // The surviving service is untouched by its neighbour disappearing.
  alpha.push({ version: 'v0.9', updateComponents: { surfaceId: 'main', components: [{ id: 'root', component: 'Text', text: 'alive' }] } })
  assert.deepEqual(await next(), {
    version: 'v0.9',
    updateComponents: { surfaceId: 'alpha/main', components: [{ id: 'root', component: 'Text', text: 'alive' }] },
  })
})

test('retracts surfaces on a crash and re-attaches after the service returns', async (t) => {
  const root = await tempRuntimeRoot(t)
  const alpha = await fakeService(root, 'alpha')
  t.after(() => alpha.stop())
  alpha.push(createSurface('main'))

  const gateway = await startTestGateway(t, root)
  const socket = connectA2ui(gateway)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())
  assert.deepEqual(await next(), createSurface('alpha/main'))

  await alpha.disconnect()
  assert.deepEqual(await next(), { version: 'v0.9', deleteSurface: { surfaceId: 'alpha/main' } })
  await waitFor(async () => (await services(gateway)).some((service) => service.id === 'alpha' && service.status !== 'connected'))

  await alpha.restart()
  alpha.push(createSurface('other'))
  assert.deepEqual(await next(), createSurface('alpha/other'))
})

test('sends a merged prefixed snapshot to a renderer that joins late', async (t) => {
  const root = await tempRuntimeRoot(t)
  const alpha = await fakeService(root, 'alpha')
  const beta = await fakeService(root, 'beta')
  t.after(() => alpha.stop())
  t.after(() => beta.stop())
  alpha.push(createSurface('main'))
  alpha.push({ version: 'v0.9', updateDataModel: { surfaceId: 'main', path: '/', value: { count: 0 } } })
  alpha.push({ version: 'v0.9', updateDataModel: { surfaceId: 'main', path: '/count', value: 7 } })
  beta.push(createSurface('main'))

  const gateway = await startTestGateway(t, root)
  await waitFor(async () => (await services(gateway)).filter((service) => service.status === 'connected').length === 2)

  const socket = connectA2ui(gateway)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())

  const replay: unknown[] = []
  for (let index = 0; index < 3; index += 1) replay.push(await next())
  assert.ok(replay.some((message) => JSON.stringify(message) === JSON.stringify(createSurface('alpha/main'))))
  assert.ok(replay.some((message) => JSON.stringify(message) === JSON.stringify(createSurface('beta/main'))))
  assert.ok(replay.some((message) => JSON.stringify(message) === JSON.stringify({
    version: 'v0.9',
    updateDataModel: { surfaceId: 'alpha/main', path: '/', value: { count: 7 } },
  })))
})

test('ignores manifests that are invalid or would escape the service directory', async (t) => {
  const root = await tempRuntimeRoot(t)
  const healthy = await fakeService(root, 'healthy')
  t.after(() => healthy.stop())
  healthy.push(createSurface('main'))

  const escaping = await fakeService(root, 'escaping')
  t.after(() => escaping.stop())
  await writeManifest(escaping.directory, { name: 'Escaping', socket: '../healthy/a2ui.sock' })

  const broken = await fakeService(root, 'broken')
  t.after(() => broken.stop())
  await writeManifest(broken.directory, { socket: 'a2ui.sock' })

  const gateway = await startTestGateway(t, root)
  await waitFor(async () => (await services(gateway)).some((service) => service.id === 'healthy' && service.status === 'connected'))
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  assert.deepEqual((await services(gateway)).map((service) => service.id), ['healthy'])
})

test('survives a manifest that points at a socket with no listener', async (t) => {
  const root = await tempRuntimeRoot(t)
  const healthy = await fakeService(root, 'healthy')
  t.after(() => healthy.stop())
  healthy.push(createSurface('main'))

  // A service killed without cleanup leaves its manifest beside a dead socket file.
  const dead = await fakeService(root, 'dead')
  t.after(() => dead.stop())
  await dead.disconnect()

  const gateway = await startTestGateway(t, root)
  const socket = connectA2ui(gateway)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())
  assert.deepEqual(await next(), createSurface('healthy/main'))

  await waitFor(async () => {
    const listed = await services(gateway)
    return listed.some((service) => service.id === 'dead' && service.status !== 'connected')
      && listed.some((service) => service.id === 'healthy' && service.status === 'connected')
  })

  // The gateway keeps serving the reachable service while retrying the dead one.
  healthy.push({ version: 'v0.9', updateComponents: { surfaceId: 'main', components: [{ id: 'root', component: 'Text', text: 'alive' }] } })
  assert.deepEqual(await next(), {
    version: 'v0.9',
    updateComponents: { surfaceId: 'healthy/main', components: [{ id: 'root', component: 'Text', text: 'alive' }] },
  })
})

test('reports why a service was dropped instead of letting it vanish', async (t) => {
  const root = await tempRuntimeRoot(t)
  const healthy = await fakeService(root, 'healthy')
  const broken = await fakeService(root, 'broken')
  t.after(() => healthy.stop())
  t.after(() => broken.stop())
  healthy.push(createSurface('main'))
  broken.push(createSurface('main'))

  const gateway = await startTestGateway(t, root)
  const socket = connectA2ui(gateway)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())
  await waitFor(async () => (await services(gateway)).filter((service) => service.status === 'connected').length === 2)
  await next()
  await next()

  // A duplicate createSurface is a protocol violation the snapshot rejects.
  broken.push(createSurface('main'))
  assert.deepEqual(await next(), { version: 'v0.9', deleteSurface: { surfaceId: 'broken/main' } })
  await waitFor(async () => {
    const listed = await services(gateway)
    const entry = listed.find((service) => service.id === 'broken')
    return entry?.status === 'error' && /already exists/.test(entry.detail ?? '')
  })
})

test('answers the identity handshake and refuses an unknown route', async (t) => {
  const root = await tempRuntimeRoot(t)
  const gateway = await startTestGateway(t, root)

  const node = await gatewayGet(gateway.socketPath, '/v1/node')
  assert.equal(node.status, 200)
  assert.deepEqual(
    { ...(node.body as Record<string, unknown>), uptimeMs: 0 },
    { protocol: GATEWAY_PROTOCOL, nodeId: 'aaaaaaaaaaaaaaaa', name: 'test-node', services: 0, uptimeMs: 0 },
  )

  const unknown = await gatewayGet(gateway.socketPath, '/v1/nope')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.text, 'Not found')
})

test('streams the service list over the control channel and answers a ping', async (t) => {
  const root = await tempRuntimeRoot(t)
  const alpha = await fakeService(root, 'alpha', { name: 'Alpha' })
  t.after(() => alpha.stop())

  const gateway = await startTestGateway(t, root)
  const socket = connectControl(gateway)
  const next = messageQueue(socket)
  await opened(socket)
  t.after(() => socket.close())

  // The first frame always carries the whole list, however late the client attached.
  let frame = (await next()) as { t: string; nodeId: string; services: Array<{ id: string; status: string }> }
  while (frame.t !== 'services' || !frame.services.some((service) => service.id === 'alpha' && service.status === 'connected')) {
    frame = (await next()) as typeof frame
  }
  assert.equal(frame.nodeId, 'aaaaaaaaaaaaaaaa')

  socket.send(JSON.stringify({ t: 'ping', id: 7 }))
  let reply = (await next()) as { t: string; id?: number }
  while (reply.t !== 'pong') reply = (await next()) as typeof reply
  assert.equal(reply.id, 7)

  await rm(path.join(root, 'alpha'), { recursive: true, force: true })
  let removal = (await next()) as { t: string; services?: unknown[] }
  while (removal.t !== 'services' || removal.services?.length !== 0) removal = (await next()) as typeof removal
})

test('reports the persisted identity, unchanged across a restart', async (t) => {
  const root = await tempRuntimeRoot(t)
  const configRoot = await tempRuntimeRoot(t)

  const first = await startGateway({ root, configRoot, discovery: createXdgManifestProvider({ root, debounceMs: 20, rescanMs: 100 }) })
  const announced = (await gatewayGet(first.socketPath, '/v1/node')).body as { nodeId: string; name: string }
  assert.equal(announced.nodeId, first.nodeId)
  await first.close()

  // A hub that pinned this node must still recognise it after the gateway restarts.
  const second = await startGateway({ root, configRoot, discovery: createXdgManifestProvider({ root, debounceMs: 20, rescanMs: 100 }) })
  t.after(() => second.close())
  assert.equal(second.nodeId, first.nodeId)
  assert.equal(((await gatewayGet(second.socketPath, '/v1/node')).body as { nodeId: string }).nodeId, first.nodeId)
})
