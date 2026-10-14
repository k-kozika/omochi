import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { once } from 'node:events'
import { sign } from 'node:crypto'
import { request } from 'node:https'
import { WebSocket } from '@omochi-ui/core/websocket'
import { test, opened, type TestContext } from '@omochi-ui/core/testing'
import { formatPairingCode, generatePairingCode, normalizePairingCode, openPairingWindow, pairWithGateway, pairingContext, type PairingWindow, type PairingHello } from '../src/auth/pairing.js'
import { spake2, spake2Scalar } from '../src/auth/spake2.js'
import { mtlsClientOptions } from '../src/auth/tls.js'
import { probeGateway } from '../src/gateway/client.js'
import { startGateway } from '../src/gateway/server.js'
import { createXdgManifestProvider } from '../src/app/xdg-manifest.js'
import { tempRuntimeRoot } from '../src/testing.js'
import { certificateFingerprint } from '../src/auth/certificate.js'
import { makeNode, pairDirectly, type TestNode } from './identity-helpers.js'

async function setup(t: TestContext, pairing = {}) {
  const hub = await makeNode(t, 'hub'), node = await makeNode(t, 'gateway'), root = await tempRuntimeRoot(t)
  const gateway = await startGateway({ root, identity: node.identity, nodeId: node.identity.nodeId, trust: node.trust, listen: { host: '127.0.0.1', port: 0 }, pairing, discovery: createXdgManifestProvider({ root, debounceMs: 20, rescanMs: 100 }) })
  t.after(() => gateway.close())
  return { hub, node, gateway, endpoint: { kind: 'tcp' as const, ...gateway.pairingAddress! } }
}
function exchange(window: PairingWindow, hub: TestNode, tamper: (hello: PairingHello) => PairingHello = hello => hello) {
  const hello = window.hello(), context = pairingContext(tamper(hello), hub.identity)
  const session = spake2('A', spake2Scalar(Buffer.from(window.code)), context)
  const offer = window.begin({ session: hello.session, nodeId: hub.identity.nodeId, name: hub.identity.name, certificate: hub.identity.certificate, share: session.share.toString('base64') })
  const share = Buffer.from(offer.share, 'base64'), result = session.finish(share)
  const proof = sign('sha256', Buffer.concat([Buffer.from('omochi-device-possession-v1\0'), Buffer.from(context.aad!), session.share, share]), hub.identity.privateKey)
  return { hello, result, proof, offer }
}
async function post(host: string, port: number, path: string, tls = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host, port, path, method: 'POST', rejectUnauthorized: false, ...tls, agent: false }, response => { response.resume(); resolve(response.statusCode ?? 0) })
    outgoing.on('error', reject); outgoing.end('{}')
  })
}
test('normalizes readable forty-bit pairing codes', () => {
  const code = generatePairingCode()
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{8}$/)
  assert.equal(normalizePairingCode(formatPairingCode(code).toLowerCase()), code)
  assert.equal(normalizePairingCode('0oi1l234'), '00111234')
  assert.equal(normalizePairingCode('UUUUUUUU'), null)
  assert.equal(normalizePairingCode('short'), null)
})
test('pairs certificate pins on a separate random port and establishes mTLS', async t => {
  const { hub, node, gateway, endpoint } = await setup(t)
  assert.notEqual(gateway.address!.port, endpoint.port)
  const peer = await pairWithGateway(endpoint, { identity: hub.identity, trust: hub.trust, code: gateway.pairing!.display })
  assert.equal(peer.fingerprint, certificateFingerprint(node.identity.certificate))
  assert.equal(node.trust.get(hub.identity.nodeId)?.fingerprint, certificateFingerprint(hub.identity.certificate))
  assert.deepEqual(peer.addresses, [`127.0.0.1:${gateway.address!.port}`])
  assert.equal(await gateway.pairing!.ended, 'paired')
  assert.equal((await probeGateway({ kind: 'tcp', ...gateway.address! }, { tls: mtlsClientOptions(hub.identity, peer) }))?.nodeId, node.identity.nodeId)
})
test('pairing listener exposes no normal HTTP or WSS routes, even to a paired device', async t => {
  const { hub, node, gateway, endpoint } = await setup(t)
  await pairDirectly(hub, node)
  for (const path of ['/v1/node', '/v1/services']) assert.equal(await post(endpoint.host, endpoint.port, path), 404)
  const socket = new WebSocket(`wss://${endpoint.host}:${endpoint.port}/v1/a2ui`, { rejectUnauthorized: false })
  await assert.rejects(opened(socket))
  const tls = mtlsClientOptions(hub.identity, hub.trust.get(node.identity.nodeId)!)
  assert.equal(await post(gateway.address!.host, gateway.address!.port, '/v1/pair/start', tls), 404)
})
test('wrong and malformed codes do not register either device', async t => {
  const { hub, node, gateway, endpoint } = await setup(t)
  await assert.rejects(pairWithGateway(endpoint, { identity: hub.identity, trust: hub.trust, code: 'nope' }), /not a pairing code/)
  assert.equal(gateway.pairing!.attempts, 0)
  await assert.rejects(pairWithGateway(endpoint, { identity: hub.identity, trust: hub.trust, code: generatePairingCode() }), /did not accept that code/)
  assert.equal(gateway.pairing!.attempts, 1)
  assert.deepEqual(hub.trust.list(), []); assert.deepEqual(node.trust.list(), [])
})
test('counts abandoned starts and permits success on the last allowed attempt', async t => {
  const { hub, gateway, endpoint } = await setup(t, { maxAttempts: 2, attemptFloorMs: 0 })
  await assert.rejects(pairWithGateway(endpoint, { identity: hub.identity, trust: hub.trust, code: generatePairingCode() }))
  await pairWithGateway(endpoint, { identity: hub.identity, trust: hub.trust, code: gateway.pairing!.code })
  assert.equal(gateway.pairing!.attempts, 2)
})
test('exhausting the attempt budget closes the window and the temporary listener', async t => {
  const { hub, gateway, endpoint } = await setup(t, { maxAttempts: 1, attemptFloorMs: 0 })
  for (let i = 0; i < 2; i++) await assert.rejects(pairWithGateway(endpoint, { identity: hub.identity, trust: hub.trust, code: generatePairingCode() }))
  assert.equal(await gateway.pairing!.ended, 'too many attempts')
  assert.equal(gateway.pairing!.open, false)
})
test('expiry has a timer and does not need a subsequent request', async t => {
  const { gateway } = await setup(t, { ttlMs: 50 })
  assert.equal(await gateway.pairing!.ended, 'expired')
  assert.equal(gateway.pairing!.open, false)
})
test('binds device identity, certificate and service port into SPAKE2 confirmations', async t => {
  const hub = await makeNode(t, 'hub'), node = await makeNode(t, 'gateway')
  for (const tamper of [
    (hello: PairingHello) => ({ ...hello, nodeId: 'aaaaaaaaaaaaaaaa' }),
    (hello: PairingHello) => ({ ...hello, certificate: hub.identity.certificate }),
    (hello: PairingHello) => ({ ...hello, port: hello.port + 1 }),
    (hello: PairingHello) => ({ ...hello, session: 'different-session' }),
  ]) {
    const window = openPairingWindow({ identity: node.identity, trust: node.trust, port: 5556, attemptFloorMs: 0 })
    t.after(() => window.close('test complete'))
    const { hello, result, proof, offer } = exchange(window, hub, tamper)
    assert.notDeepEqual(result.peerConfirm, Buffer.from(offer.confirm, 'base64'))
    await assert.rejects(window.finish(hello.session, result.confirm, proof), /confirmation/)
  }
  assert.deepEqual(node.trust.list(), [])
})
test('requires possession of the enrolled private key and consumes failed sessions', async t => {
  const hub = await makeNode(t, 'hub'), node = await makeNode(t, 'gateway')
  const window = openPairingWindow({ identity: node.identity, trust: node.trust, port: 5556 })
  t.after(() => window.close('done'))
  const { hello, result } = exchange(window, hub)
  await assert.rejects(window.finish(hello.session, result.confirm, Buffer.alloc(72)), /possession/)
  await assert.rejects(window.finish(hello.session, result.confirm, Buffer.alloc(72)), /no pairing/)
  assert.deepEqual(node.trust.list(), [])
})
test('only one concurrent completion can commit, including when the response is lost', async t => {
  const hub = await makeNode(t, 'hub'), node = await makeNode(t, 'gateway')
  const window = openPairingWindow({ identity: node.identity, trust: node.trust, port: 5556 })
  t.after(() => window.close('done'))
  const { hello, result, proof } = exchange(window, hub)
  const results = await Promise.allSettled([window.finish(hello.session, result.confirm, proof), window.finish(hello.session, result.confirm, proof)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(node.trust.list().length, 1)
  assert.equal(hub.trust.list().length, 0, 'a lost receipt must not create client-side trust')
  await assert.rejects(window.finish(hello.session, result.confirm, proof), /closed/)
})
test('rate limits by source before consuming an attempt', async t => {
  const hub = await makeNode(t, 'hub'), node = await makeNode(t, 'gateway')
  let clock = 0
  const window = openPairingWindow({ identity: node.identity, trust: node.trust, port: 5556, now: () => clock })
  t.after(() => window.close('done'))
  exchange(window, hub)
  assert.throws(() => exchange(window, hub), /wait a moment/)
  assert.equal(window.attempts, 1)
  clock = 1000; exchange(window, hub)
  assert.equal(window.attempts, 2)
})


test('expiry closes a pending TLS handshake as well as the pairing listener', async t => {
  const { gateway, endpoint } = await setup(t, { ttlMs: 150 })
  const socket = createConnection({ host: endpoint.host, port: endpoint.port })
  t.after(() => socket.destroy())
  socket.on('error', () => {})
  await once(socket, 'connect')
  const closed = once(socket, 'close')
  assert.equal(await gateway.pairing!.ended, 'expired')
  await closed
})
