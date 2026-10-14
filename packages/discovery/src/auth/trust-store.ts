import path from 'node:path'
import { readFileSync } from 'node:fs'
import { readdir, rm, chmod, lstat, readFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { isValidNodeId } from '@omochi-ui/core'
import { ensureConfigRoot, omochiConfigRoot, writeJsonFile } from './config-dir.js'
import { certificateFingerprint, validateCertificate } from './certificate.js'
import { withStateLock } from './state-lock.js'
import { ensureRuntimeRoot, omochiRuntimeRoot } from '../runtime-dir.js'

export interface TrustedPeer {
  nodeId: string; certificate: string; fingerprint: string; name: string; role: 'gateway' | 'hub'; pairedAt: string
  lastSeenAt?: string; addresses?: string[]
}
export interface TrustStore {
  readonly file: string
  readonly legacy: boolean
  list(): TrustedPeer[]
  get(nodeId: string): TrustedPeer | null
  put(peer: TrustedPeer): Promise<void>
  forget(nodeId: string): Promise<boolean>
  touch(nodeId: string, address?: string): Promise<void>
  subscribe(changed: () => void | Promise<void>): Promise<() => Promise<void>>
}
export function trustStorePath(root: string): string { return path.join(root, 'peers.json') }
function load(file: string): { version: number; peers: TrustedPeer[] } {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'))
    if (record.version === 1) return { version: 1, peers: [] }
    if (record.version !== 2) throw new Error('unsupported trust store version')
    if (!Array.isArray(record.peers)) throw new Error('invalid trust store')
    return { version: 2, peers: record.peers.filter((peer: TrustedPeer) => {
      try {
        if (!isValidNodeId(peer.nodeId) || typeof peer.name !== 'string' || !['hub', 'gateway'].includes(peer.role) || typeof peer.pairedAt !== 'string') return false
        validateCertificate(peer.certificate, peer.nodeId)
        return certificateFingerprint(peer.certificate) === peer.fingerprint
      } catch { return false }
    }) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, peers: [] }
    throw new Error(`cannot read trust store ${file}`, { cause: error })
  }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** An acknowledgement means all existing connections have been re-authorized. */
async function notify(directory: string, namespace: string): Promise<void> {
  const failures: unknown[] = []
  await Promise.all((await readdir(directory)).map(async entry => {
    if (!/^\d+-[a-f0-9]+\.json$/.test(entry)) return
    const recordPath = path.join(directory, entry)
    const pid = Number(entry.split('-')[0])
    try {
      if (!alive(pid)) { await rm(recordPath, { force: true }); return }
      const record = JSON.parse(await readFile(recordPath, 'utf8'))
      const socketPath = record.socket
      if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || path.basename(path.dirname(socketPath)) !== namespace || path.basename(socketPath) !== entry.replace(/\.json$/, '.sock')) throw new Error('invalid trust listener registration')
      const parent = await lstat(path.dirname(socketPath)), socketFile = await lstat(socketPath)
      if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || !socketFile.isSocket() || (typeof process.getuid === 'function' && (parent.uid !== process.getuid() || socketFile.uid !== process.getuid()))) throw new Error('unsafe trust listener registration')
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(socketPath)
        let result = ''
        socket.setTimeout(5000, () => socket.destroy(new Error('trust update acknowledgement timed out')))
        socket.on('connect', () => socket.end('refresh\n'))
        socket.on('data', chunk => { result += chunk.toString(); if (result.length > 32) socket.destroy(new Error('invalid trust acknowledgement')) })
        socket.on('error', reject)
        socket.on('end', () => result === 'ok\n' ? resolve() : reject(new Error('a running process could not apply the trust update')))
      })
    } catch (error) { failures.push(error) }
  }))
  if (failures.length) throw new AggregateError(failures, 'trust update persisted, but a running process did not acknowledge it')
}
export async function openTrustStore(root: string = omochiConfigRoot()): Promise<TrustStore> {
  await ensureConfigRoot(root)
  const file = trustStorePath(root)
  const namespace = `auth-${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16)}`
  const directory = path.join(omochiRuntimeRoot(), namespace)
  const registrations = path.join(root, '.auth-listeners')
  await ensureRuntimeRoot(directory)
  await ensureConfigRoot(registrations)
  const update = async <T>(change: (peers: Map<string, TrustedPeer>) => T): Promise<T> => withStateLock(file, async () => {
    const peers = new Map(load(file).peers.map(peer => [peer.nodeId, peer]))
    const result = change(peers)
    await writeJsonFile(file, { version: 2, peers: [...peers.values()] })
    await notify(registrations, namespace)
    return result
  })
  return {
    file,
    get legacy() { return load(file).version === 1 },
    list: () => load(file).peers,
    get: nodeId => load(file).peers.find(peer => peer.nodeId === nodeId) ?? null,
    async put(peer) {
      if (!isValidNodeId(peer.nodeId)) throw new Error(`not a node id: ${peer.nodeId}`)
      validateCertificate(peer.certificate, peer.nodeId)
      if (certificateFingerprint(peer.certificate) !== peer.fingerprint) throw new Error('certificate fingerprint mismatch')
      await update(peers => { peers.set(peer.nodeId, peer) })
    },
    forget: nodeId => update(peers => peers.delete(nodeId)),
    async touch(nodeId, address) {
      await update(peers => {
        const peer = peers.get(nodeId)
        if (!peer) return
        peers.set(nodeId, { ...peer, lastSeenAt: new Date().toISOString(), ...(address ? { addresses: [address, ...(peer.addresses ?? []).filter(entry => entry !== address)].slice(0, 4) } : {}) })
      })
    },
    async subscribe(changed) {
      const id = `${process.pid}-${randomBytes(5).toString('hex')}`
      const socketPath = path.join(directory, `${id}.sock`)
      const registration = path.join(registrations, `${id}.json`)
      const server = createServer({ allowHalfOpen: true }, socket => {
        let input = ''
        socket.setTimeout(5000, () => socket.destroy())
        socket.on('data', chunk => { input += chunk; if (input.length > 32) socket.destroy() })
        socket.on('end', () => {
          if (input !== 'refresh\n') { socket.destroy(); return }
          Promise.resolve().then(changed).then(() => socket.end('ok\n'), () => socket.end('error\n'))
        })
        socket.on('error', () => {})
      })
      try {
        await withStateLock(file, async () => {
          await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
          await chmod(socketPath, 0o600)
          await changed()
          await writeJsonFile(registration, { socket: socketPath })
        })
      } catch (error) {
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
        await rm(socketPath, { force: true })
        await rm(registration, { force: true })
        throw error
      }
      return async () => {
        await withStateLock(file, () => rm(registration, { force: true }))
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        await rm(socketPath, { force: true })
      }
    },
  }
}
