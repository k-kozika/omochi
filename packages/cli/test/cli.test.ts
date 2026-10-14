import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from '@omochi-ui/core/testing'

import { WebSocket } from 'ws'

import { A2uiSnapshot } from '@omochi-ui/core'
import { messageQueue, opened } from '@omochi-ui/core/testing'

import { generateCatalog } from '../src/catalog-codegen.js'
import { startStdioWebSocketBridge } from '../src/stdio-websocket-bridge.js'


test('broadcasts one shared A2UI stream and sends a compact snapshot to late clients', async (t) => {
  const childScript = String.raw`
    const readline = require("node:readline");
    console.log(JSON.stringify({version:"v0.9",createSurface:{surfaceId:"main",catalogId:"test",sendDataModel:true}}));
    console.log(JSON.stringify({version:"v0.9",updateComponents:{surfaceId:"main",components:[{id:"root",component:"Text",text:"Ready"}]}}));
    console.log(JSON.stringify({version:"v0.9",updateDataModel:{surfaceId:"main",path:"/",value:{count:0,obsolete:true}}}));
    readline.createInterface({input:process.stdin}).on("line", line => {
      const value = JSON.parse(line);
      console.log(JSON.stringify({version:"v0.9",updateComponents:{surfaceId:"main",components:[{id:"root",component:"Text",text:"Updated"}]}}));
      console.log(JSON.stringify({version:"v0.9",updateDataModel:{surfaceId:"main",path:"/count",value:1}}));
      console.log(JSON.stringify({version:"v0.9",updateDataModel:{surfaceId:"main",path:"/obsolete"}}));
    });
  `
  const server = await startStdioWebSocketBridge({
    command: [process.execPath, '-e', childScript],
    port: 0,
  })
  t.after(() => server.close())

  const response = await fetch(server.url.replace('ws:', 'http:').replace('/ws', '/'))
  assert.equal(response.status, 404)

  const firstSocket = new WebSocket(server.url)
  const nextFirst = messageQueue(firstSocket)
  await opened(firstSocket)
  t.after(() => firstSocket.close())
  assert.ok('createSurface' in (await nextFirst() as object))
  assert.ok('updateComponents' in (await nextFirst() as object))
  assert.ok('updateDataModel' in (await nextFirst() as object))

  const secondSocket = new WebSocket(server.url)
  const nextSecond = messageQueue(secondSocket)
  await opened(secondSocket)
  t.after(() => secondSocket.close())
  assert.ok('createSurface' in (await nextSecond() as object))
  assert.ok('updateComponents' in (await nextSecond() as object))
  assert.ok('updateDataModel' in (await nextSecond() as object))

  firstSocket.send(JSON.stringify({
    version: 'v0.9',
    action: {
      name: 'run',
      surfaceId: 'main',
      sourceComponentId: 'root',
      timestamp: '2026-08-12T00:00:00.000Z',
      context: {},
    },
    metadata: {
      a2uiClientDataModel: { version: 'v0.9', surfaces: { main: { count: 0 } } },
    },
  }))
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await nextFirst() as { version: string }).version, 'v0.9')
    assert.equal((await nextSecond() as { version: string }).version, 'v0.9')
  }

  const lateSocket = new WebSocket(server.url)
  const nextLate = messageQueue(lateSocket)
  await opened(lateSocket)
  t.after(() => lateSocket.close())
  assert.deepEqual(await nextLate(), {
    version: 'v0.9',
    createSurface: { surfaceId: 'main', catalogId: 'test', sendDataModel: true },
  })
  assert.deepEqual(await nextLate(), {
    version: 'v0.9',
    updateComponents: { surfaceId: 'main', components: [{ id: 'root', component: 'Text', text: 'Updated' }] },
  })
  assert.deepEqual(await nextLate(), {
    version: 'v0.9',
    updateDataModel: { surfaceId: 'main', path: '/', value: { count: 1 } },
  })
})

test('materializes surface deletion and recreation without retaining message history', () => {
  const snapshot = new A2uiSnapshot()
  snapshot.apply({ version: 'v0.9', createSurface: { surfaceId: 'main', catalogId: 'first' } })
  snapshot.apply({ version: 'v0.9', updateComponents: { surfaceId: 'main', components: [{ id: 'root', component: 'Text', text: 'Old' }] } })
  snapshot.apply({ version: 'v0.9', deleteSurface: { surfaceId: 'main' } })
  snapshot.apply({ version: 'v0.9', createSurface: { surfaceId: 'main', catalogId: 'second' } })
  snapshot.apply({ version: 'v0.9', updateComponents: { surfaceId: 'main', components: [{ id: 'root', component: 'Text', text: 'New' }] } })
  assert.deepEqual(snapshot.messages(), [
    { version: 'v0.9', createSurface: { surfaceId: 'main', catalogId: 'second' } },
    { version: 'v0.9', updateComponents: { surfaceId: 'main', components: [{ id: 'root', component: 'Text', text: 'New' }] } },
  ])
})

test('closes only a client that sends invalid WebSocket input', async (t) => {
  const childScript = 'setInterval(() => {}, 1000)'
  const server = await startStdioWebSocketBridge({
    command: [process.execPath, '-e', childScript],
    port: 0,
  })
  t.after(() => server.close())

  const invalidJson = new WebSocket(server.url)
  await opened(invalidJson)
  invalidJson.send('not json')
  const invalidJsonClose = await new Promise<number>((resolvePromise) => {
    invalidJson.once('close', (code) => resolvePromise(code))
  })
  assert.equal(invalidJsonClose, 1007)

  const invalidMessage = new WebSocket(server.url)
  await opened(invalidMessage)
  invalidMessage.send('{}')
  const invalidMessageClose = await new Promise<number>((resolvePromise) => {
    invalidMessage.once('close', (code) => resolvePromise(code))
  })
  assert.equal(invalidMessageClose, 1007)

  const binary = new WebSocket(server.url)
  await opened(binary)
  binary.send(Buffer.from('{}'))
  const binaryClose = await new Promise<number>((resolvePromise) => {
    binary.once('close', (code) => resolvePromise(code))
  })
  assert.equal(binaryClose, 1003)
  assert.equal(server.child.exitCode, null)
})

test('closes all clients when child stdout is not A2UI JSONL', async (t) => {
  const childScript = 'console.log(JSON.stringify({version:"v0.9",createSurface:{surfaceId:"main",catalogId:"test"}})); setTimeout(() => console.log("not json"), 50); setInterval(() => {}, 1000)'
  const server = await startStdioWebSocketBridge({
    command: [process.execPath, '-e', childScript],
    port: 0,
  })
  t.after(() => server.close())

  const socket = new WebSocket(server.url)
  const nextMessage = messageQueue(socket)
  await opened(socket)
  assert.deepEqual(await nextMessage(), { version: 'v0.9', createSurface: { surfaceId: 'main', catalogId: 'test' } })
  const closed = await new Promise<{ code: number; reason: string }>((resolvePromise) => {
    socket.once('close', (code, reason) => resolvePromise({ code, reason: reason.toString() }))
  })
  assert.equal(closed.code, 1002)
  assert.match(closed.reason, /child stdout line 2/)
})

test('generates deterministic typed catalog bindings', async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'omochi-catalog-'))
  const catalog = resolve(directory, 'catalog.json')
  const typescript = resolve(directory, 'catalog.ts')
  const python = resolve(directory, 'catalog.py')
  const rust = resolve(directory, 'catalog.rs')
  await writeFile(resolve(directory, 'defs.json'), JSON.stringify({
    $defs: { Meta: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } },
  }))
  await writeFile(catalog, JSON.stringify({
    catalogId: 'urn:test:catalog',
    title: 'Test Catalog',
    components: {
      Badge: {
        type: 'object',
        properties: {
          component: { const: 'Badge' },
          label: { type: 'string' },
          tone: { type: 'string', enum: ['info', 'warning'] },
          meta: { $ref: './defs.json#/$defs/Meta' },
        },
        required: ['component', 'label'],
      },
    },
  }))
  await generateCatalog({ catalog, name: 'TestCatalog', typescript, python, rust })
  assert.match(await readFile(typescript, 'utf8'), /"label": string/)
  assert.match(await readFile(typescript, 'utf8'), /"info" \| "warning"/)
  assert.match(await readFile(typescript, 'utf8'), /"meta"\?: \{ "count": number \}/)
  assert.match(await readFile(python, 'utf8'), /class BadgeProps\(TypedDict/)
  assert.match(await readFile(rust, 'utf8'), /struct BadgeProps/)
  await generateCatalog({ catalog, name: 'TestCatalog', typescript, python, rust, check: true })
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(directory, { recursive: true })
  })
})
