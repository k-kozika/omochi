import { jest } from 'bun:test'
import assert from 'node:assert/strict'
import { test } from '@omochi-ui/core/testing'

import {
  createActionMessage,
  isA2uiMessage,
  A2uiWebSocketClient,
  type Processor,
} from '../src/client.js'
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


test('sessions accept surface updates, recover after disconnect, and stop retrying on disposal', t => {
  jest.useFakeTimers();
  t.after(() => { jest.useRealTimers(); });
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { reason: string }) => void) | null = null;
    closed = false;
    constructor() { sockets.push(this); }
    close() { this.closed = true; }
    send() {}
    push(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  const state: { processor: Processor | null; error: string | null; status: string } = { processor: null, error: null, status: '' };
  const client = new A2uiWebSocketClient('ws://localhost/ws', {
    onProcessor: processor => { state.processor = processor; },
    onError: error => { state.error = error; }, onStatus: status => { state.status = status; },
  });
  const create = (id: string) => ({ version: 'v0.9', createSurface: { surfaceId: id, catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json' } });
  client.connect(); client.connect();
  assert.equal(sockets.length, 1);
  sockets[0]!.onopen!();
  sockets[0]!.push(create('one'));
  sockets[0]!.push({ invalid: true });
  assert.match(state.error!, /expected one A2UI/);
  sockets[0]!.push(create('two'));
  assert.deepEqual([...state.processor!.model.surfacesMap.keys()], ['one', 'two']);
  sockets[0]!.push({ version: 'v0.9', deleteSurface: { surfaceId: 'one' } });
  assert.deepEqual([...state.processor!.model.surfacesMap.keys()], ['two']);
  assert.equal(isA2uiMessage(create('valid')), true);
  sockets[0]!.onclose!({ reason: 'restart' });
  assert.equal(state.processor, null);
  assert.match(state.status, /Disconnected/);
  jest.advanceTimersByTime(1000);
  assert.equal(sockets.length, 2);
  sockets[1]!.onopen!();
  assert.equal(state.error, null);
  assert.equal(state.processor!.model.surfacesMap.size, 0);
  sockets[1]!.onclose!({ reason: 'again' });
  client.close();
  jest.advanceTimersByTime(1000);
  assert.equal(sockets.length, 2);
});
