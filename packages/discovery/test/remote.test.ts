import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { certificateFingerprint, createDeviceCredentials } from '../src/auth/certificate.js'
import { openTrustStore } from '../src/auth/trust-store.js'
import { request } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { test } from '@omochi-ui/core/testing'

import { createSurface, opened, waitFor } from '@omochi-ui/core/testing'
import { WebSocket } from '@omochi-ui/core/websocket'

import { mtlsClientOptions } from '../src/auth/tls.js'
import { connectGateway, probeGateway } from '../src/gateway/client.js'
import { GATEWAY_A2UI_PATH, gatewayWsUrl, type GatewayEndpoint } from '../src/gateway/protocol.js'
import { createXdgManifestProvider } from '../src/app/xdg-manifest.js'
import { startGateway, type GatewayHandle } from '../src/gateway/server.js'
import { fakeService, tempRuntimeRoot } from '../src/testing.js'
import { makeNode, pairDirectly, type TestNode } from './identity-helpers.js'

async function startRemoteGateway(t: Parameters<typeof makeNode>[0], node: TestNode, root: string): Promise<GatewayHandle> {
  const gateway = await startGateway({
    root,
    identity: node.identity,
    nodeId: node.identity.nodeId,
    name: node.identity.name,
    trust: node.trust,
    // Port 0 and loopback: a test never opens a listener the network can reach.
    listen: { host: '127.0.0.1', port: 0 },
    discovery: createXdgManifestProvider({ root, debounceMs: 20, rescanMs: 100 }),
  })
  t.after(() => gateway.close())
  return gateway
}

function endpointOf(gateway: GatewayHandle): GatewayEndpoint {
  assert.ok(gateway.address, 'the gateway is listening on TCP')
  return { kind: 'tcp', host: gateway.address.host, port: gateway.address.port }
}

test('relays A2UI to a paired hub over TLS, end to end', async (t) => {
  const root = await tempRuntimeRoot(t)
  const app = await fakeService(root, 'mic', { name: 'Mic' })
  t.after(() => app.stop())
  app.push(createSurface('main'))

  const hub = await makeNode(t, 'hub')
  const node = await makeNode(t, 'gateway')
  await pairDirectly(hub, node)
  const gateway = await startRemoteGateway(t, node, root)

  const tls = mtlsClientOptions(hub.identity, hub.trust.get(node.identity.nodeId)!)
  const info = await probeGateway(endpointOf(gateway), { tls })
  assert.equal(info?.nodeId, node.identity.nodeId)
  assert.equal(await probeGateway(endpointOf(gateway), { tls, expectedNodeId: 'aaaaaaaaaaaaaaaa' }), null)

  const messages: unknown[] = []
  let failure = ""
  const client = connectGateway(endpointOf(gateway), {
    onOpen: () => {},
    onServices: () => {},
    onMessage: (message) => messages.push(message),
    onClose: detail => { failure = detail },
  }, { tls })
  t.after(() => client.close())

  await waitFor(() => messages.length > 0 || !!failure)
  assert.equal(failure, "")
  assert.deepEqual(messages[0], createSurface('mic/main'))
})

test('refuses an unpaired hub before it can send anything', async (t) => {
  const root = await tempRuntimeRoot(t)
  const node = await makeNode(t, 'gateway')
  const stranger = await makeNode(t, 'stranger')
  const gateway = await startRemoteGateway(t, node, root)

  // The stranger presents a device certificate that nobody pinned.
  const tls = mtlsClientOptions(stranger.identity, {
    nodeId: node.identity.nodeId,
    certificate: node.identity.certificate,
    fingerprint: certificateFingerprint(node.identity.certificate),
    name: 'gateway',
    role: 'gateway',
    pairedAt: new Date().toISOString(),
  })
  assert.equal(await probeGateway(endpointOf(gateway), { tls }), null)

  const socket = new WebSocket(gatewayWsUrl(endpointOf(gateway), GATEWAY_A2UI_PATH), tls)
  await assert.rejects(opened(socket), /.*/)
})

test('refuses a paired hub whose certificate no longer matches', async (t) => {
  const root = await tempRuntimeRoot(t)
  const hub = await makeNode(t, 'hub')
  const node = await makeNode(t, 'gateway')
  await pairDirectly(hub, node)
  const gateway = await startRemoteGateway(t, node, root)

  // The gateway was re-paired with someone else; the hub's copy is stale.
  const replacement = await createDeviceCredentials(hub.identity.nodeId)
  await node.trust.put({ ...node.trust.get(hub.identity.nodeId)!, certificate: replacement.certificate, fingerprint: certificateFingerprint(replacement.certificate) })

  const tls = mtlsClientOptions(hub.identity, hub.trust.get(node.identity.nodeId)!)
  assert.equal(await probeGateway(endpointOf(gateway), { tls }), null)
})

test('refuses a peer pinned in the wrong role', async (t) => {
  const root = await tempRuntimeRoot(t)
  const hub = await makeNode(t, 'hub')
  const node = await makeNode(t, 'gateway')
  await pairDirectly(hub, node)
  const gateway = await startRemoteGateway(t, node, root)

  // A gateway accepts hubs; a peer recorded as a gateway must not be able to connect.
  await node.trust.put({ ...node.trust.get(hub.identity.nodeId)!, role: 'gateway' })
  const tls = mtlsClientOptions(hub.identity, hub.trust.get(node.identity.nodeId)!)
  assert.equal(await probeGateway(endpointOf(gateway), { tls }), null)
})

test('refuses TLS below 1.3', async (t) => {
  const root = await tempRuntimeRoot(t)
  const hub = await makeNode(t, 'hub')
  const node = await makeNode(t, 'gateway')
  await pairDirectly(hub, node)
  const gateway = await startRemoteGateway(t, node, root)

  const pinned = hub.trust.get(node.identity.nodeId)!
  const downgraded = { ...mtlsClientOptions(hub.identity, pinned), minVersion: 'TLSv1.2' as const, maxVersion: 'TLSv1.2' as const }
  assert.equal(await probeGateway(endpointOf(gateway), { tls: downgraded }), null)
})

test('a connection without a pinned certificate never reaches the gateway', async (t) => {
  const root = await tempRuntimeRoot(t)
  const node = await makeNode(t, 'gateway')
  const gateway = await startRemoteGateway(t, node, root)

  const closed = await new Promise<string>((resolvePromise) => {
    connectGateway(endpointOf(gateway), {
      onOpen: () => resolvePromise('opened'),
      onServices: () => {},
      onMessage: () => {},
      onClose: (detail) => resolvePromise(detail),
    })
  })
  assert.match(closed, /pinned certificate/)
})

test('requires a client certificate even when TLS verification is disabled by the caller', async t => {
  const node = await makeNode(t, 'gateway')
  const gateway = await startRemoteGateway(t, node, await tempRuntimeRoot(t))
  const status = await new Promise<number>((resolve) => {
    const req = request({ host: gateway.address!.host, port: gateway.address!.port, path: '/v1/node', rejectUnauthorized: false, agent: false }, response => { response.resume(); resolve(response.statusCode ?? 0) })
    req.on('error', () => resolve(0)); req.setTimeout(2000, () => req.destroy()); req.end()
  })
  assert.equal(status, 0)
})

test('forget in a separate process closes existing WSS sockets before acknowledging', async t => {
  const hub = await makeNode(t, 'hub'), node = await makeNode(t, 'gateway')
  await pairDirectly(hub, node)
  const gateway = await startRemoteGateway(t, node, await tempRuntimeRoot(t))
  const tls = mtlsClientOptions(hub.identity, hub.trust.get(node.identity.nodeId)!)
  const socket = new WebSocket(gatewayWsUrl(endpointOf(gateway), GATEWAY_A2UI_PATH), tls)
  t.after(() => socket.terminate())
  await opened(socket)
  const closed = once(socket, 'close')
  const module = fileURLToPath(new URL('../src/auth/trust-store.ts', import.meta.url))
  const child = spawn(process.execPath, ['--eval', `import { openTrustStore } from ${JSON.stringify(module)}; const store = await openTrustStore(${JSON.stringify(node.configRoot)}); await store.forget(${JSON.stringify(hub.identity.nodeId)});`], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XDG_RUNTIME_DIR: await tempRuntimeRoot(t) } })
  const output: Buffer[] = []; child.stderr.on('data', chunk => output.push(chunk))
  const [code] = await once(child, 'close')
  assert.equal(code, 0, Buffer.concat(output).toString())
  await closed
  assert.equal((await openTrustStore(node.configRoot)).get(hub.identity.nodeId), null)
  assert.equal(await probeGateway(endpointOf(gateway), { tls }), null)
})


test('forget closes keep-alive HTTPS and denies reuse of its saved TLS session', async t => {
  const hub = await makeNode(t, 'hub'), node = await makeNode(t, 'gateway')
  await pairDirectly(hub, node)
  const gateway = await startRemoteGateway(t, node, await tempRuntimeRoot(t))
  const tls = mtlsClientOptions(hub.identity, hub.trust.get(node.identity.nodeId)!)
  const socket = tlsConnect({ host: gateway.address!.host, port: gateway.address!.port, ...tls })
  t.after(() => socket.destroy())
  socket.on('error', () => {})
  await once(socket, 'secureConnect')
  const response = once(socket, 'data')
  socket.write('GET /v1/node HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n')
  assert.match(String((await response)[0]), /200 OK/)
  const session = socket.getSession()
  assert.ok(session)
  const closed = once(socket, 'close')
  await node.trust.forget(hub.identity.nodeId)
  await closed
  const status = await new Promise<number>(resolve => {
    const retry = tlsConnect({ host: gateway.address!.host, port: gateway.address!.port, ...tls, session })
    retry.on('secureConnect', () => retry.write('GET /v1/node HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'))
    retry.on('data', () => { retry.destroy(); resolve(200) })
    retry.on('error', () => resolve(0))
    retry.on('close', () => resolve(0))
    retry.setTimeout(2000, () => retry.destroy())
  })
  assert.equal(status, 0)
})
