import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from '@omochi-ui/core/testing'
import { WebSocket } from 'ws'
import { createStaticLocator } from '@omochi-ui/discovery'
import { actionMessage, createSurface, messageQueue, opened, waitFor } from '@omochi-ui/core/testing'
import { startFakeGateway } from './fake-gateway.js'
import { startHub } from '../src/hub/hub.js'
import { startSshGateway, validateSshTarget } from '../src/hub/ssh-gateway.js'

async function fakeSsh(t: TestContext, remote: string, mode = 'forward') {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const log = path.join(directory, 'args.jsonl')
  const script = path.join(directory, 'ssh.cjs')
  await writeFile(script, `
    const net = require('node:net');
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
    if (${JSON.stringify(mode)} === 'fail') process.exit(255);
    if (${JSON.stringify(mode)} === 'wait') { setInterval(() => {}, 1000); }
    else if (!args.includes('-N')) console.log(${JSON.stringify(remote)});
    else {
      fs.writeFileSync(${JSON.stringify(log + '.pid')}, String(process.pid));
      const [local, remote] = args[args.indexOf('-L') + 1].split(':');
      const server = net.createServer(socket => {
        if (${JSON.stringify(mode)} === 'silent') return;
        const target = net.connect(remote);
        socket.on('error', () => target.destroy());
        target.on('error', () => socket.destroy());
        socket.on('close', () => target.destroy());
        target.on('close', () => socket.destroy());
        socket.pipe(target).pipe(socket);
      });
      server.listen(local);
    }
  `)
  return { command: [process.execPath, script], log }
}

test('SSH socket carries gateway snapshots and actions through a hub, then cleans up', { timeout: 10000 }, async (t) => {
  const gateway = await startFakeGateway(t)
  gateway.setServices([{ id: 'app', name: 'App', status: 'connected' }])
  gateway.push('app', createSurface('main'))
  const fake = await fakeSsh(t, gateway.socketPath)
  const tunnel = await startSshGateway({ host: 'user@alias', command: fake.command })
  t.after(() => tunnel.close())
  assert.equal((await stat(path.dirname(tunnel.socketPath))).mode & 0o777, 0o700)
  const hub = await startHub({ port: 0, autoGateway: false, gateways: [createStaticLocator([{ kind: 'unix', socketPath: tunnel.socketPath }])] })
  t.after(() => hub.close())
  await waitFor(() => hub.nodeCount === 1)
  const socket = new WebSocket(hub.url)
  const next = messageQueue(socket)
  await opened(socket)
  const message = await next() as { createSurface: { surfaceId: string } }
  assert.equal(message.createSurface.surfaceId, `${gateway.nodeId}~app/main`)
  socket.send(JSON.stringify(actionMessage(`${gateway.nodeId}~app/main`, {})))
  assert.deepEqual(await gateway.next(), actionMessage('app/main', {}))
  socket.terminate()
  await hub.close()
  const calls = (await readFile(fake.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
  assert.equal(calls.length, 2)
  assert.ok(calls[1].includes('ExitOnForwardFailure=yes'))
  assert.equal(calls[1].at(-1), 'user@alias')
  await tunnel.close()
  await tunnel.close()
  await assert.rejects(stat(path.dirname(tunnel.socketPath)), { code: 'ENOENT' })
})

test('explicit path skips resolution and SSH exit is observable', async (t) => {
  const gateway = await startFakeGateway(t)
  const fake = await fakeSsh(t, gateway.socketPath)
  const tunnel = await startSshGateway({ host: 'alias', remoteSocket: gateway.socketPath, command: fake.command })
  t.after(() => tunnel.close())
  assert.equal((await readFile(fake.log, 'utf8')).trim().split('\n').length, 1)
  await tunnel.close()
  assert.match((await tunnel.exited).message, /SSH to alias exited/)
})

test('reports SSH failures and missing executables', async (t) => {
  const fake = await fakeSsh(t, '/unused', 'fail')
  await assert.rejects(startSshGateway({ host: 'alias', command: fake.command }), /255/)
  await assert.rejects(startSshGateway({ host: 'alias', remoteSocket: '/unused', command: fake.command }), /255/)
  await assert.rejects(startSshGateway({ host: 'alias', command: ['/nonexistent/ssh'] }), /ENOENT/)
})

test('times out a silent gateway and removes its forwarded socket', async (t) => {
  const fake = await fakeSsh(t, '/unused', 'silent')
  await assert.rejects(startSshGateway({ host: 'alias', remoteSocket: '/unused', command: fake.command, startTimeoutMs: 100 }), /alias:\/unused.*timeout/)
  const args: string[] = JSON.parse((await readFile(fake.log, 'utf8')).trim())
  const local = args[args.indexOf('-L') + 1].split(':')[0]
  await assert.rejects(stat(path.dirname(local)), { code: 'ENOENT' })
})

test('cancels while SSH is waiting for authentication', async (t) => {
  const fake = await fakeSsh(t, '/unused', 'wait')
  const controller = new AbortController()
  const pending = startSshGateway({ host: 'alias', command: fake.command, signal: controller.signal })
  await waitFor(async () => (await stat(fake.log).catch(() => null)) !== null)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('rejects option injection and unsupported socket paths', () => {
  for (const host of ['-oProxyCommand=bad', 'host\nother', 'host -p 22', '']) {
    assert.throws(() => validateSshTarget(host))
  }
  for (const socket of ['relative.sock', '/tmp/a:b', '/tmp/a\nb']) {
    assert.throws(() => validateSshTarget('alias', socket))
  }
  validateSshTarget('user@alias', '/tmp/a b.sock')
})

test('CLI rejects invalid SSH option combinations', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
  for (const args of [
    ['--ssh-socket', '/tmp/gateway.sock'],
    ['--ssh', 'one', '--ssh', 'two'],
    ['--ssh', 'one', '--ssh-socket', '/one', '--ssh-socket', '/two'],
    ['--ssh', '-oProxyCommand=bad'],
  ]) {
    const result = spawnSync(process.execPath, [cli, 'hub', ...args], { encoding: 'utf8', timeout: 3000 })
    assert.ok(result.status !== 0 && result.status !== null, result.stderr)
  }
})

for (const termination of ['SIGTERM', 'ssh-exit'] as const) test(`CLI combines gateways, skips local startup, and cleans up on ${termination}`, { timeout: 15000 }, async (t) => {
  const { spawn } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const gateway = await startFakeGateway(t)
  const other = await startFakeGateway(t, { nodeId: 'bbbbbbbbbbbbbbbb' })
  const fake = await fakeSsh(t, gateway.socketPath)
  const directory = path.dirname(fake.log)
  await writeFile(path.join(directory, 'ssh'), '#!/usr/bin/env bun\n' + await readFile(fake.command[1], 'utf8'), { mode: 0o700 })
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'hub', '--port', '0', '--ssh', 'alias', '--gateway', other.socketPath], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, XDG_RUNTIME_DIR: directory },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  t.after(() => { child.kill('SIGKILL') })
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
  let output = ''
  child.stderr.setEncoding('utf8').on('data', (data: string) => { output += data })
  await waitFor(() => output.includes('A2UI endpoint:'), 5000)
  await assert.rejects(stat(path.join(directory, 'omochi', 'gateway.sock')), { code: 'ENOENT' })
  assert.ok(output.includes(other.socketPath))
  const calls = (await readFile(fake.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
  const args = calls[1]
  const local = args[args.indexOf('-L') + 1].split(':')[0]
  if (termination === 'SIGTERM') child.kill('SIGTERM')
  else process.kill(Number(await readFile(fake.log + '.pid', 'utf8')), 'SIGTERM')
  assert.equal(await exited, termination === 'SIGTERM' ? 143 : 1)
  await assert.rejects(stat(path.dirname(local)), { code: 'ENOENT' })
})
