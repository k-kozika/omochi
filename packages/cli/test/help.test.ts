import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@omochi-ui/core/testing'

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))

test('overview and command help exit successfully without creating runtime or config state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omochi-help-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const env = { ...process.env, XDG_CONFIG_HOME: join(directory, 'config'), XDG_RUNTIME_DIR: join(directory, 'runtime') }
  const cases = [
    [], ['--help'], ['-h'], ['help'],
    ['dev', '--help'], ['up', '--help'], ['hub', '-h'], ['gateway', '--help'],
    ['id', '--help'], ['pair', '--help'],
    ['trust', '--help'], ['trust', 'list', '--help'], ['trust', 'forget', '--help'],
    ['generate', '--help'], ['generate', 'catalog', '--help'],
    ['help', 'hub'], ['help', 'generate', 'catalog'], ['help', 'trust', 'forget'],
  ]
  for (const args of cases) {
    const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.error, undefined, args.join(' '))
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
    assert.match(result.stdout, /Usage:/)
    assert.equal(result.stderr, '')
  }
  assert.deepEqual(await readdir(directory), [])
})

test('usage errors are nonzero and do not create identity or trust files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omochi-usage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const env = { ...process.env, XDG_CONFIG_HOME: join(directory, 'config'), XDG_RUNTIME_DIR: join(directory, 'runtime') }
  const cases = [
    ['unknown'], ['unknown', '--help'], ['help', 'unknown'], ['help', 'hub', 'extra'],
    ['trust', 'unknown', '--help'], ['generate', 'unknown', '--help'],
    ['dev'], ['dev', '--port', '65536', '--', process.execPath], ['up', 'one.toml', 'two.toml'],
    ['hub', '--port', '-1'], ['gateway', '--pair'], ['gateway', '--advertise'],
    ['trust', 'unknown'], ['trust', 'list', 'extra'], ['trust', 'forget'],
    ['trust', 'forget', 'one', 'two'],
  ]
  for (const args of cases) {
    const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.error, undefined, args.join(' '))
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /\[omochi-ui\].*\n\n[\s\S]*Usage:/)
  }
  assert.deepEqual(await readdir(directory), [])
})

test('dev forwards child help flags and prints the actual bridge in the preview URL', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omochi-child-help-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const marker = join(directory, 'args.json')
  const script = 'require("node:fs").writeFileSync(process.env.OMOCHI_HELP_MARKER, JSON.stringify(process.argv.slice(1)))'
  const result = spawnSync(process.execPath, [cli, 'dev', '--port', '0', '--', process.execPath, '-e', script, '--', '--help', '-h'], {
    env: { ...process.env, OMOCHI_HELP_MARKER: marker },
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), ['--help', '-h'])
  const bridge = result.stderr.match(/bridge: (ws:\/\/127\.0\.0\.1:\d+\/ws)/)?.[1]
  assert.ok(bridge, result.stderr)
  const preview = result.stderr.match(/Open: (http:\/\/\S+)/)?.[1]
  assert.ok(preview, result.stderr)
  assert.equal(new URL(preview).searchParams.get('ws'), bridge)
  assert.equal(new URL(preview).port, '5173')
  assert.match(result.stderr, /bun run --filter @omochi-ui\/dev-server dev/)
})
