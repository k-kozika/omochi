import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from '@omochi-ui/core/testing'

import { waitFor } from '@omochi-ui/core/testing'

import { parseComposition, startCompositionServices } from '../src/up.js'

const NODE_ID = 'aaaaaaaaaaaaaaaa'

test('parses command and utility services and compiles semantic rows', () => {
  const composition = parseComposition(`
version = 1
id = "quickstart"

[services.health]
utility = ["http", "http://127.0.0.1:5173/"]

[services.app]
command = ["node", "app.js"]
cwd = "./backend"
env = { MODE = "demo" }

[dashboard]
name = "Local development"

[[dashboard.rows]]
panels = ["health", "app"]
height = "small"

[[dashboard.rows]]
panels = ["logs"]
height = "large"

[dashboard.panels.health]
title = "Health"
service = "health"

[dashboard.panels.app]
title = "App"
service = "app"
surface = "status"

[dashboard.panels.logs]
title = "Logs"
service = "app"
surface = "logs"
`, '/project/demo/omochi.toml', NODE_ID)

  assert.equal(composition.id, 'quickstart')
  assert.deepEqual(composition.services.map(service => ({ id: service.id, cwd: service.cwd, env: service.env })), [
    { id: 'health', cwd: '/project/demo', env: { OMOCHI_SERVICE: 'health' } },
    { id: 'app', cwd: '/project/demo/backend', env: { MODE: 'demo', OMOCHI_SERVICE: 'app' } },
  ])
  assert.match(composition.services[0]!.command[1]!, /omochi-utils\.js$/)
  assert.deepEqual(composition.services[0]!.command.slice(2), ['http', '--service-id', 'health', 'http://127.0.0.1:5173/'])
  assert.deepEqual(composition.preset.panels.map(panel => ({ id: panel.id, x: panel.x, y: panel.y, w: panel.w, h: panel.h, surface: panel.reference.surfaceId })), [
    { id: 'health', x: 0, y: 0, w: 6, h: 4, surface: 'main' },
    { id: 'app', x: 6, y: 0, w: 6, h: 4, surface: 'status' },
    { id: 'logs', x: 0, y: 4, w: 12, h: 9, surface: 'logs' },
  ])
})

test('rejects ambiguous services and invalid panel placement before starting commands', () => {
  const base = `version=1\nid="bad"\n[services.one]\ncommand=["true"]\n[dashboard]\nname="Bad"\n`
  for (const [suffix, pattern] of [
    ['rows=[]\npanels={}\n', /rows must be a non-empty/],
    ['rows=[{panels=["missing"]}]\n[dashboard.panels.one]\ntitle="One"\nservice="one"\n', /unknown panel/],
    ['rows=[{panels=["one","one"]}]\n[dashboard.panels.one]\ntitle="One"\nservice="one"\n', /more than once/],
    ['rows=[{panels=["one"]}]\n[dashboard.panels.one]\ntitle="One"\nservice="other"\n', /undeclared service/],
  ] as const) assert.throws(() => parseComposition(base + suffix, '/tmp/omochi.toml', NODE_ID), pattern)

  assert.throws(() => parseComposition(`version=1\nid="bad"\n[services.one]\ncommand=["true"]\nutility=["watch","--","true"]\n[dashboard]\nname="Bad"\nrows=[]\npanels={}\n`, '/tmp/omochi.toml', NODE_ID), /exactly one/)
})

test('service failures do not stop siblings and shutdown terminates running groups', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'omochi-up-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const envFile = path.join(directory, 'env')
  const pidFile = path.join(directory, 'pid')
  const supervisor = startCompositionServices([
    { id: 'short', cwd: directory, env: {}, command: [process.execPath, '-e', 'process.exit(7)'] },
    { id: 'long', cwd: directory, env: { OMOCHI_UP_FILE: envFile, OMOCHI_SERVICE: 'long' }, command: [process.execPath, '-e', `require('fs').writeFileSync(process.env.OMOCHI_UP_FILE, process.env.OMOCHI_SERVICE); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`] },
  ])
  t.after(() => supervisor.close())
  await waitFor(async () => (await readFile(envFile, 'utf8').catch(() => '')) === 'long')
  const pid = Number(await readFile(pidFile, 'utf8'))
  assert.doesNotThrow(() => process.kill(pid, 0))
  await supervisor.close()
  await waitFor(() => {
    try { process.kill(pid, 0); return false }
    catch { return true }
  })
})
