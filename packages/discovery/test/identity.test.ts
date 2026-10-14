import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, type TestContext } from '@omochi-ui/core/testing'
import { identityPath, loadNodeIdentity } from '../src/auth/identity.js'
import { omochiConfigRoot } from '../src/auth/config-dir.js'
import { openTrustStore, trustStorePath, type TrustedPeer } from '../src/auth/trust-store.js'
import { certificateFingerprint, createDeviceCredentials } from '../src/auth/certificate.js'

async function tempConfigRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp('/tmp/omochi-config-'); t.after(() => rm(root, { recursive: true, force: true })); return root
}
async function peer(nodeId: string): Promise<TrustedPeer> {
  const credentials = await createDeviceCredentials(nodeId)
  return { nodeId, name: nodeId, certificate: credentials.certificate, fingerprint: certificateFingerprint(credentials.certificate), role: 'gateway', pairedAt: new Date().toISOString() }
}
test('resolves the config root', () => {
  assert.equal(omochiConfigRoot({ XDG_CONFIG_HOME: '/x/config' }), '/x/config/omochi')
  assert.ok(omochiConfigRoot({}).endsWith(path.join('.config', 'omochi')))
})
test('keeps private device credentials across concurrent loads and restarts', async t => {
  const root = await tempConfigRoot(t)
  const [first, second] = await Promise.all([loadNodeIdentity({ root }), loadNodeIdentity({ root })])
  assert.equal(first.nodeId, second.nodeId); assert.equal(first.privateKey, second.privateKey)
  assert.equal(first.certificate, (await loadNodeIdentity({ root })).certificate)
  assert.equal((await stat(identityPath(root))).mode & 0o777, 0o600)
  assert.equal((await stat(root)).mode & 0o777, 0o700)
  assert.equal((await loadNodeIdentity({ root, name: 'desktop' })).name, 'desktop')
  assert.equal((await loadNodeIdentity({ root })).name, 'desktop')
})
test('upgrades a legacy identity without trusting its old peers', async t => {
  const root = await tempConfigRoot(t)
  await writeFile(identityPath(root), JSON.stringify({ version: 1, nodeId: 'aaaaaaaaaaaaaaaa' }))
  const identity = await loadNodeIdentity({ root })
  assert.equal(identity.nodeId, 'aaaaaaaaaaaaaaaa'); assert.ok(identity.privateKey)
  await writeFile(trustStorePath(root), JSON.stringify({ version: 1, peers: [{ nodeId: 'bbbbbbbbbbbbbbbb', psk: 'old-secret' }] }))
  const store = await openTrustStore(root)
  assert.equal(store.legacy, true); assert.deepEqual(store.list(), [])
})
test('pins, lists, and forgets certificates across independent stores', async t => {
  const root = await tempConfigRoot(t), store = await openTrustStore(root), other = await openTrustStore(root)
  const device = await peer('aaaaaaaaaaaaaaaa')
  await store.put(device)
  assert.equal(other.get(device.nodeId)?.fingerprint, device.fingerprint)
  await other.forget(device.nodeId)
  assert.equal(store.get(device.nodeId), null)
  assert.equal((await stat(trustStorePath(root))).mode & 0o777, 0o600)
  await assert.rejects(store.put({ ...device, nodeId: 'nope' }), /not a node id/)
  await assert.rejects(store.put({ ...device, fingerprint: 'wrong' }), /fingerprint/)
})
test('serializes writes from different stores and never resurrects a forgotten peer on touch', async t => {
  const root = await tempConfigRoot(t), a = await openTrustStore(root), b = await openTrustStore(root)
  const first = await peer('aaaaaaaaaaaaaaaa'), second = await peer('bbbbbbbbbbbbbbbb')
  await Promise.all([a.put(first), b.put(second)])
  assert.equal(a.list().length, 2)
  await b.forget(first.nodeId); await a.touch(first.nodeId)
  assert.equal(a.get(first.nodeId), null)
  await a.touch(second.nodeId, '127.0.0.1:5556')
  assert.deepEqual(b.get(second.nodeId)?.addresses, ['127.0.0.1:5556'])
  assert.equal(JSON.parse(await readFile(trustStorePath(root), 'utf8')).version, 2)
})
test('rejects malformed state and incomplete credentials instead of recovering trust silently', async t => {
  const root = await tempConfigRoot(t), store = await openTrustStore(root)
  await writeFile(store.file, '{ invalid')
  assert.throws(() => store.list(), /cannot read trust store/)
  await writeFile(identityPath(root), '{ invalid')
  await assert.rejects(loadNodeIdentity({ root }), /cannot read device identity/)
  await writeFile(identityPath(root), JSON.stringify({ nodeId: 'aaaaaaaaaaaaaaaa', privateKey: 'broken' }))
  await assert.rejects(loadNodeIdentity({ root }), /incomplete/)
})


test('an acknowledgement failure is an error even though removal is persisted', async t => {
  const root = await tempConfigRoot(t), store = await openTrustStore(root)
  const device = await peer('aaaaaaaaaaaaaaaa')
  await store.put(device)
  let fail = false
  const unsubscribe = await store.subscribe(() => { if (fail) throw new Error('could not reload authorization') })
  t.after(unsubscribe)
  fail = true
  await assert.rejects(store.forget(device.nodeId), /persisted.*did not acknowledge/)
  assert.equal((await openTrustStore(root)).get(device.nodeId), null)
})
