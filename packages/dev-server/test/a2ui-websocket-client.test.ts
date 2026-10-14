import assert from 'node:assert/strict'
import { test } from '@omochi-ui/core/testing'

import {
  resolveWebSocketUrl,
} from '../src/a2ui-websocket-client.js'
import { createActionMessage, isA2uiMessage } from '@omochi-ui/renderer'
test('resolves and validates the SPA WebSocket URL', () => {
  assert.equal(resolveWebSocketUrl({ protocol: 'http:', host: 'localhost:5173', search: '' }), 'ws://localhost:5173/ws')
  assert.equal(
    resolveWebSocketUrl({ protocol: 'http:', host: 'localhost:5173', search: '?ws=ws://127.0.0.1:5555/ws' }),
    'ws://127.0.0.1:5555/ws',
  )
  assert.throws(
    () => resolveWebSocketUrl({ protocol: 'http:', host: 'localhost:5173', search: '?ws=https://example.com' }),
    /must use ws:/,
  )
  assert.equal(isA2uiMessage({ version: 'v0.9', deleteSurface: { surfaceId: 'main' } }), true)
  assert.equal(isA2uiMessage({ kind: 'not-a2ui' }), false)
})

test('creates a raw A2UI action message with the current client model', () => {
  const action = {
    name: 'run',
    surfaceId: 'main',
    sourceComponentId: 'button',
    context: {},
    timestamp: '2026-08-12T00:00:00.000Z',
  }
  assert.deepEqual(createActionMessage(action, { version: 'v0.9', surfaces: { main: { value: 42 } } }), {
    version: 'v0.9',
    action,
    metadata: {
      a2uiClientDataModel: { version: 'v0.9', surfaces: { main: { value: 42 } } },
    },
  })
})
