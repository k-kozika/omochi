import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@omochi-ui/core/testing'

test('default gateway command starts from an installation containing URL-sensitive characters', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'omochi-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const installation = path.join(root, 'space percent%')
  await mkdir(installation)
  await cp(fileURLToPath(new URL('../dist', import.meta.url)), path.join(installation, 'dist'), { recursive: true })
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(installation, 'node_modules'), 'dir')
  const runtime = path.join(root, 'run')
  const socketPath = path.join(runtime, 'omochi/gateway.sock')
  const supervisor = path.join(installation, 'dist/hub/gateway-supervisor.js')
  const code = `
    import assert from 'node:assert/strict';
    import { superviseLocalGateway } from ${JSON.stringify(supervisor)};
    import { probeGateway } from '@omochi-ui/discovery';
    const socket = ${JSON.stringify(socketPath)};
    const gateway = await superviseLocalGateway(socket);
    try {
      assert.equal(gateway.spawned, true);
      assert.ok(await probeGateway({ kind: 'unix', socketPath: socket }));
    } finally { await gateway.close(); }
    for (let n = 0; n < 80 && await probeGateway({ kind: 'unix', socketPath: socket }); n++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(await probeGateway({ kind: 'unix', socketPath: socket }), null);
    console.log('started and stopped');
  `
  const child = spawn(process.execPath, ['--eval', code], {
    cwd: installation,
    env: { ...process.env, XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: path.join(root, 'config') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const [codeResult] = await once(child, 'close')
  assert.equal(codeResult, 0, stderr)
  assert.match(stdout, /started and stopped/)
})
