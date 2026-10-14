import assert from 'node:assert/strict'
import { test } from '../src/testing.js'

import {
  isValidServiceId,
  joinRouteId,
  joinSurfaceId,
  prefixClientMessage,
  prefixServerMessage,
  readdressServerMessage,
  routeClientMessage,
  splitRouteId,
  splitSurfaceId,
} from '../src/index.js'

const NODE_A = 'aaaaaaaaaaaaaaaa'
const NODE_B = 'bbbbbbbbbbbbbbbb'

test('rejects service ids that would escape or collapse the service directory', () => {
  assert.equal(isValidServiceId('mic'), true)
  assert.equal(isValidServiceId('a.b_c-1'), true)
  assert.equal(isValidServiceId('.'), false)
  assert.equal(isValidServiceId('..'), false)
  assert.equal(isValidServiceId(''), false)
  assert.equal(isValidServiceId('a/b'), false)
  assert.equal(isValidServiceId('a b'), false)
  // A `~` in a service id would make the node/service split ambiguous.
  assert.equal(isValidServiceId('a~b'), false)
  assert.equal(isValidServiceId('x'.repeat(65)), false)
})

test('splits on the first separator so backend surface ids may contain slashes', () => {
  assert.deepEqual(splitSurfaceId('mic/main'), { channelId: 'mic', surfaceId: 'main' })
  assert.deepEqual(splitSurfaceId('mic/a/b'), { channelId: 'mic', surfaceId: 'a/b' })
  assert.deepEqual(splitSurfaceId(`${NODE_A}~mic/a/b`), { channelId: `${NODE_A}~mic`, surfaceId: 'a/b' })
  assert.equal(joinSurfaceId(joinRouteId(NODE_A, 'mic'), 'a/b'), `${NODE_A}~mic/a/b`)
  assert.equal(splitSurfaceId('main'), null)
  assert.equal(splitSurfaceId('/main'), null)
  assert.equal(splitSurfaceId('mic/'), null)
  assert.equal(splitSurfaceId('../main'), null)
  assert.equal(joinSurfaceId('mic', 'a/b'), 'mic/a/b')
})

test('prefixes every server surface id and leaves surface-local fields alone', () => {
  assert.deepEqual(
    prefixServerMessage('mic', { version: 'v0.9', createSurface: { surfaceId: 'main', catalogId: 'test', sendDataModel: true } }),
    { version: 'v0.9', createSurface: { surfaceId: 'mic/main', catalogId: 'test', sendDataModel: true } },
  )
  assert.deepEqual(
    prefixServerMessage('mic', { version: 'v0.9', updateComponents: { surfaceId: 'main', components: [{ id: 'root', component: 'Text' }] } }),
    { version: 'v0.9', updateComponents: { surfaceId: 'mic/main', components: [{ id: 'root', component: 'Text' }] } },
  )
  assert.deepEqual(
    prefixServerMessage('mic', { version: 'v0.9', updateDataModel: { surfaceId: 'main', path: '/$local/form/temperature', value: 20 } }),
    { version: 'v0.9', updateDataModel: { surfaceId: 'mic/main', path: '/$local/form/temperature', value: 20 } },
  )
  assert.deepEqual(
    prefixServerMessage(joinRouteId(NODE_A, 'mic'), { version: 'v0.9', deleteSurface: { surfaceId: 'main' } }),
    { version: 'v0.9', deleteSurface: { surfaceId: `${NODE_A}~mic/main` } },
  )
})

test('routes an action and scopes the client data model to its own service', () => {
  const routed = routeClientMessage({
    version: 'v0.9',
    action: { name: 'run', surfaceId: 'beta/main', sourceComponentId: 'root', timestamp: '2026-08-12T00:00:00.000Z', context: {} },
    metadata: {
      a2uiClientDataModel: {
        version: 'v0.9',
        surfaces: { 'alpha/main': { $local: { form: { secret: 'typed into alpha' } } }, 'beta/main': { count: 1 } },
      },
      trace: 'kept',
    },
  })
  assert.deepEqual(routed, {
    channelId: 'beta',
    message: {
      version: 'v0.9',
      action: { name: 'run', surfaceId: 'main', sourceComponentId: 'root', timestamp: '2026-08-12T00:00:00.000Z', context: {} },
      metadata: {
        a2uiClientDataModel: { version: 'v0.9', surfaces: { main: { count: 1 } } },
        trace: 'kept',
      },
    },
  })
})

test('routes client error messages, which also carry a surface id', () => {
  assert.deepEqual(
    routeClientMessage({ version: 'v0.9', error: { code: 'VALIDATION_FAILED', surfaceId: 'mic/main', path: '/x', message: 'bad' } }),
    {
      channelId: 'mic',
      message: { version: 'v0.9', error: { code: 'VALIDATION_FAILED', surfaceId: 'main', path: '/x', message: 'bad' } },
    },
  )
})

test('refuses messages that carry no routable surface id', () => {
  assert.equal(routeClientMessage({ version: 'v0.9', action: { name: 'run', surfaceId: 'main', sourceComponentId: 'root', timestamp: '', context: {} } }), null)
  assert.equal(routeClientMessage({ version: 'v0.9' }), null)
  assert.equal(routeClientMessage('nope'), null)
})

test('scopes the client data model across nodes running the same service', () => {
  // Two machines both publish `mic`. Without the node prefix these collide, and one
  // backend would receive the other's surfaces, including unsent `$local` drafts.
  const routed = routeClientMessage({
    version: 'v0.9',
    action: { name: 'run', surfaceId: `${NODE_B}~mic/main`, sourceComponentId: 'root', timestamp: '', context: {} },
    metadata: {
      a2uiClientDataModel: {
        version: 'v0.9',
        surfaces: {
          [`${NODE_A}~mic/main`]: { $local: { form: { secret: 'typed on the other machine' } } },
          [`${NODE_B}~mic/main`]: { count: 1 },
        },
      },
    },
  })
  assert.equal(routed?.channelId, `${NODE_B}~mic`)
  assert.deepEqual(routed?.message.metadata, {
    a2uiClientDataModel: { version: 'v0.9', surfaces: { main: { count: 1 } } },
  })
})

test('joins and splits route ids', () => {
  assert.equal(joinRouteId(NODE_A, 'mic'), `${NODE_A}~mic`)
  assert.deepEqual(splitRouteId(`${NODE_A}~mic`), { nodeId: NODE_A, serviceId: 'mic' })
  assert.deepEqual(splitRouteId(`${NODE_A}~a.b_c-1`), { nodeId: NODE_A, serviceId: 'a.b_c-1' })
  // A bare service id is how a caller tells a gateway channel from a hub channel.
  assert.equal(splitRouteId('mic'), null)
  assert.equal(splitRouteId('aaaaaaaaaaaaaaa~mic'), null, 'a 15-character node id is not a node id')
  assert.equal(splitRouteId(`${NODE_A}~`), null)
  assert.equal(splitRouteId(`~mic`), null)
  // `~` cannot appear in a service id, so the first separator is the only one.
  assert.equal(splitRouteId(`${NODE_A}~a~b`), null)
})

test('re-addresses a gateway stream into the hub namespace', () => {
  assert.deepEqual(
    readdressServerMessage(NODE_A, { version: 'v0.9', createSurface: { surfaceId: 'mic/main', catalogId: 'test' } }),
    { version: 'v0.9', createSurface: { surfaceId: `${NODE_A}~mic/main`, catalogId: 'test' } },
  )
  assert.deepEqual(
    readdressServerMessage(NODE_A, { version: 'v0.9', updateComponents: { surfaceId: 'mic/a/b', components: [] } }),
    { version: 'v0.9', updateComponents: { surfaceId: `${NODE_A}~mic/a/b`, components: [] } },
  )
  // A gateway that failed to namespace would let two nodes' surfaces collide.
  assert.equal(readdressServerMessage(NODE_A, { version: 'v0.9', deleteSurface: { surfaceId: 'main' } }), null)
  // A message with no surface id at all passes through untouched.
  assert.deepEqual(readdressServerMessage(NODE_A, { version: 'v0.9' }), { version: 'v0.9' })
})

test('re-prefixes a client message for the gateway that routes it again', () => {
  const routed = routeClientMessage({
    version: 'v0.9',
    action: { name: 'run', surfaceId: `${NODE_A}~mic/main`, sourceComponentId: 'root', timestamp: '', context: {} },
    metadata: { a2uiClientDataModel: { version: 'v0.9', surfaces: { [`${NODE_A}~mic/main`]: { count: 1 } } } },
  })
  const split = splitRouteId(routed!.channelId)!
  const forGateway = prefixClientMessage(split.serviceId, routed!.message)

  // The gateway sees exactly what a renderer attached straight to it would send.
  assert.deepEqual(forGateway, {
    version: 'v0.9',
    action: { name: 'run', surfaceId: 'mic/main', sourceComponentId: 'root', timestamp: '', context: {} },
    metadata: { a2uiClientDataModel: { version: 'v0.9', surfaces: { 'mic/main': { count: 1 } } } },
  })
  assert.deepEqual(routeClientMessage(forGateway)?.channelId, 'mic')
})
