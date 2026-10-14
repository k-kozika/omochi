import { certificateFingerprint } from '../src/auth/certificate.js'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import type { TestContext } from '@omochi-ui/core/testing'

import { loadNodeIdentity, type NodeIdentity } from '../src/auth/identity.js'
import { openTrustStore, type TrustStore } from '../src/auth/trust-store.js'

export interface TestNode {
  identity: NodeIdentity
  trust: TrustStore
  configRoot: string
}

export async function makeNode(t: TestContext, name: string): Promise<TestNode> {
  const configRoot = await mkdtemp(path.join('/tmp', 'omochi-node-'))
  t.after(() => rm(configRoot, { recursive: true, force: true }))
  const identity = await loadNodeIdentity({ root: configRoot, name })
  const trust = await openTrustStore(configRoot)
  return { identity, trust, configRoot }
}

/**
 * Pins two nodes to each other without running the pairing protocol.
 *
 * Keeping the transport tests independent of pairing means a bug in pairing shows up as
 * one red test rather than every remote test at once.
 */
export async function pairDirectly(hub: TestNode, gateway: TestNode): Promise<void> {
  const pairedAt = new Date().toISOString()
  for (const [owner, other, role] of [[gateway, hub, 'hub'], [hub, gateway, 'gateway']] as const) {
    await owner.trust.put({ nodeId: other.identity.nodeId, certificate: other.identity.certificate, fingerprint: certificateFingerprint(other.identity.certificate), name: other.identity.name, role, pairedAt })
  }
}
