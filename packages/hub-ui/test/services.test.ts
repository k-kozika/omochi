import assert from 'node:assert/strict';
import { test } from '@omochi-ui/core/testing';
import {
  nextSelection,
  parseServices,
  resolveHubOrigin,
  splitSurfaceId,
  surfacesForService,
} from '../src/services.js'

test('derives the hub HTTP origin from the renderer WebSocket endpoint', () => {
  assert.equal(resolveHubOrigin('ws://127.0.0.1:5555/ws'), 'http://127.0.0.1:5555')
  assert.equal(resolveHubOrigin('wss://example.com/ws'), 'https://example.com')
  assert.equal(resolveHubOrigin('ws://localhost:5173/a2ui'), 'http://localhost:5173')
})

test('splits a namespaced surface id on its first separator only', () => {
  assert.deepEqual(splitSurfaceId('mic/main'), { channelId: 'mic', surfaceId: 'main' })
  assert.deepEqual(splitSurfaceId('mic/a/b'), { channelId: 'mic', surfaceId: 'a/b' })
  assert.deepEqual(splitSurfaceId('main'), { channelId: null, surfaceId: 'main' })
  assert.deepEqual(splitSurfaceId('mic/'), { channelId: null, surfaceId: 'mic/' })
})

test('shows every surface without a hub and only the selected service with one', () => {
  const surfaces = [{ id: 'mic/main' }, { id: 'llm/main' }, { id: 'plain' }]
  assert.deepEqual(surfacesForService(surfaces, null), surfaces)
  assert.deepEqual(surfacesForService(surfaces, 'llm'), [{ id: 'llm/main' }])
  assert.deepEqual(surfacesForService(surfaces, 'gone'), [])
  // A hub that spans machines namespaces by `<nodeId>~<serviceId>`; the renderer treats
  // the whole channel as opaque, so the same split keeps working.
  assert.deepEqual(splitSurfaceId('aaaaaaaaaaaaaaaa~mic/a/b'), { channelId: 'aaaaaaaaaaaaaaaa~mic', surfaceId: 'a/b' })
  assert.deepEqual(
    surfacesForService([{ id: 'aaaaaaaaaaaaaaaa~mic/main' }, { id: 'bbbbbbbbbbbbbbbb~mic/main' }], 'bbbbbbbbbbbbbbbb~mic'),
    [{ id: 'bbbbbbbbbbbbbbbb~mic/main' }],
  )
})

test('keeps the selection unless the selected service disappears', () => {
  const services = parseServices([
    { id: 'mic', name: 'Mic', status: 'connected' },
    { id: 'llm', name: 'LLM', status: 'disconnected', icon: '🧠' },
  ])!
  assert.equal(services.length, 2)
  assert.equal(services[1]!.icon, '🧠')
  assert.equal(nextSelection(services, 'llm'), 'llm')
  assert.equal(nextSelection(services, 'gone'), 'mic')
  assert.equal(nextSelection(services, null), 'mic')
  assert.equal(nextSelection([], 'mic'), null)
})

test('rejects a service list that does not match the hub contract', () => {
  assert.equal(parseServices({}), null)
  assert.equal(parseServices([{ id: 'mic', name: 'Mic', status: 'unknown' }]), null)
  assert.equal(parseServices([{ id: 'mic', status: 'connected' }]), null)
})
