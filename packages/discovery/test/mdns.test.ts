import assert from 'node:assert/strict'
import { test } from '@omochi-ui/core/testing'

import {
  advertiseGateway,
  createMdnsLocator,
  encodeGatewayTxt,
  parseGatewayTxt,
  preferredAddress,
} from '../src/gateway/mdns.js'
import { GATEWAY_PROTOCOL } from '../src/gateway/protocol.js'
import type { GatewayCandidate } from '../src/gateway/locator.js'

const NODE_A = 'aaaaaaaaaaaaaaaa'

test('publishes only what is needed to start an authenticated connection', () => {
  const txt = encodeGatewayTxt(NODE_A)
  assert.deepEqual(txt, { v: String(GATEWAY_PROTOCOL), id: NODE_A, p: '/v1' })

  // Everything in a TXT record is readable by everyone on the link.
  const encoded = JSON.stringify(txt)
  assert.ok(!/psk|secret|token|icon/i.test(encoded), encoded)
  assert.ok(Object.entries(txt).reduce((total, [key, value]) => total + key.length + value.length + 2, 0) < 255)

  assert.deepEqual(parseGatewayTxt(txt), { protocol: GATEWAY_PROTOCOL, nodeId: NODE_A, basePath: '/v1' })
})

test('reads a TXT record whose values arrive as bytes', () => {
  // Some responders hand back Buffers rather than decoded strings.
  const asBytes = Object.fromEntries(
    Object.entries(encodeGatewayTxt(NODE_A)).map(([key, value]) => [key, Buffer.from(value, 'utf8')]),
  )
  assert.deepEqual(parseGatewayTxt(asBytes), { protocol: GATEWAY_PROTOCOL, nodeId: NODE_A, basePath: '/v1' })
})

test('refuses a TXT record it could not act on, and ignores what it does not know', () => {
  assert.equal(parseGatewayTxt(null), null)
  assert.equal(parseGatewayTxt('nope'), null)
  assert.equal(parseGatewayTxt([]), null)
  assert.equal(parseGatewayTxt({ id: NODE_A, p: '/v1' }), null, 'a missing version')
  assert.equal(parseGatewayTxt({ v: 'x', id: NODE_A, p: '/v1' }), null, 'a version that is not a number')
  assert.equal(parseGatewayTxt({ v: '0', id: NODE_A, p: '/v1' }), null)
  assert.equal(parseGatewayTxt({ v: '1', p: '/v1' }), null, 'a missing node id')
  assert.equal(parseGatewayTxt({ v: '1', id: 'TOO-SHORT', p: '/v1' }), null)
  assert.equal(parseGatewayTxt({ v: '1', id: NODE_A, p: 'v1' }), null, 'a base path that is not a path')

  // An unknown key is a newer gateway saying more, not a reason to ignore it.
  assert.deepEqual(
    parseGatewayTxt({ ...encodeGatewayTxt(NODE_A), future: 'whatever' }),
    { protocol: GATEWAY_PROTOCOL, nodeId: NODE_A, basePath: '/v1' },
  )
  // A newer protocol still parses; refusing it is the hub's decision at handshake time.
  assert.equal(parseGatewayTxt({ v: '2', id: NODE_A, p: '/v2' })?.protocol, 2)
})

test('prefers a numeric address over a name that needs a resolver', () => {
  assert.equal(preferredAddress(['fe80::1', '192.168.1.42']), '192.168.1.42')
  assert.equal(preferredAddress(['fe80::1']), 'fe80::1')
  assert.equal(preferredAddress([]), null)
  assert.equal(preferredAddress(undefined), null)
})

test('browses the local link and finds an advertised gateway', { skip: !process.env.OMOCHI_MDNS_TEST }, async (t) => {
  const port = 5623
  const advertisement = await advertiseGateway({ nodeId: NODE_A, name: `omochi-test-${process.pid}`, port })
  t.after(() => advertisement.close())

  const found: GatewayCandidate[] = []
  const lost: string[] = []
  const locator = createMdnsLocator()
  t.after(() => locator.close())
  await locator.start({ found: (candidate) => found.push(candidate), lost: (key) => lost.push(key) })

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !found.some((candidate) => candidate.nodeId === NODE_A)) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  const candidate = found.find((entry) => entry.nodeId === NODE_A)
  assert.ok(candidate, 'the advertised gateway was discovered')
  assert.equal(candidate.source, 'mdns')
  assert.equal(candidate.endpoint.kind === 'tcp' && candidate.endpoint.port, port)

  await advertisement.close()
  const goodbye = Date.now() + 10_000
  while (Date.now() < goodbye && !lost.includes(candidate.key)) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  assert.ok(lost.includes(candidate.key), 'withdrawing the advertisement is reported')
})

test('ignores this machine\'s own gateway, which is already reachable locally', { skip: !process.env.OMOCHI_MDNS_TEST }, async (t) => {
  const advertisement = await advertiseGateway({ nodeId: NODE_A, name: `omochi-self-${process.pid}`, port: 5624 })
  t.after(() => advertisement.close())

  const found: GatewayCandidate[] = []
  const locator = createMdnsLocator({ selfNodeId: NODE_A })
  t.after(() => locator.close())
  await locator.start({ found: (candidate) => found.push(candidate), lost: () => {} })

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 3000))
  assert.equal(found.some((candidate) => candidate.nodeId === NODE_A), false)
})
