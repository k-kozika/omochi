import { hostname } from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { createPrivateKey } from 'node:crypto'
import { isValidNodeId } from '@omochi-ui/core'
import { randomNodeId } from '../gateway/protocol.js'
import { ensureConfigRoot, omochiConfigRoot, writeJsonFile } from './config-dir.js'
import { createDeviceCredentials, validateCertificate, type DeviceCredentials } from './certificate.js'
import { withStateLock } from './state-lock.js'

export interface NodeIdentity extends DeviceCredentials { nodeId: string; name: string }
export interface LoadIdentityOptions { root?: string; name?: string }
export function identityPath(root: string): string { return path.join(root, 'node.json') }

export async function loadNodeIdentity(options: LoadIdentityOptions = {}): Promise<NodeIdentity> {
  const root = options.root ?? omochiConfigRoot()
  await ensureConfigRoot(root)
  return withStateLock(identityPath(root), async () => {
    let stored: (Partial<NodeIdentity> & { version?: number }) | null = null
    try {
      stored = JSON.parse(await readFile(identityPath(root), 'utf8'))
      if (!stored || typeof stored.nodeId !== 'string' || !isValidNodeId(stored.nodeId) || ![1, 2].includes(stored.version ?? 1)) throw new Error('invalid device identity')
      if (stored.name !== undefined && typeof stored.name !== 'string') throw new Error('invalid device name')
      if (stored.version === 2 && (!stored.certificate || !stored.privateKey)) throw new Error('incomplete device credentials')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('cannot read device identity; restore it or explicitly reset it', { cause: error })
    }
    const nodeId = stored?.nodeId ?? randomNodeId()
    const name = options.name ?? stored?.name ?? hostname()
    let credentials: DeviceCredentials
    if (stored?.certificate || stored?.privateKey) {
      if (!stored.certificate || !stored.privateKey) throw new Error('incomplete device credentials; restore them or explicitly reset the identity')
      const certificate = validateCertificate(stored.certificate, nodeId)
      if (!certificate.checkPrivateKey(createPrivateKey(stored.privateKey))) throw new Error('device private key does not match its certificate')
      credentials = { certificate: stored.certificate, privateKey: stored.privateKey }
    } else credentials = await createDeviceCredentials(nodeId)
    const identity = { nodeId, name, ...credentials }
    if (!stored?.certificate || options.name !== undefined) {
      await writeJsonFile(identityPath(root), { version: 2, nodeId, ...(options.name ?? stored?.name ? { name } : {}), ...credentials })
    }
    return identity
  })
}
