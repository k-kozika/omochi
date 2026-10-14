import { createHmac, createPrivateKey, randomBytes, sign, verify } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import type { TLSSocket } from 'node:tls'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isValidNodeId } from '@omochi-ui/core'
import { confirmationMatches, spake2, spake2Scalar, type Spake2Options } from './spake2.js'
import type { GatewayEndpoint } from '../gateway/protocol.js'
import { GATEWAY_PROTOCOL } from '../gateway/protocol.js'
import type { NodeIdentity } from './identity.js'
import { TLS_MIN_VERSION } from './tls.js'
import type { TrustStore, TrustedPeer } from './trust-store.js'
import { certificateFingerprint, validateCertificate } from './certificate.js'

export const PAIRING_HELLO_PATH = '/v1/pair/hello'
export const PAIRING_START_PATH = '/v1/pair/start'
export const PAIRING_FINISH_PATH = '/v1/pair/finish'
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const WRONG_CODE = 'the gateway did not accept that code — it may be wrong, expired, or already used'
export function generatePairingCode(): string { return Array.from(randomBytes(8), byte => ALPHABET[byte % 32]).join('') }
export function formatPairingCode(code: string): string { return `${code.slice(0, 4)}-${code.slice(4)}` }
export function normalizePairingCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  return code.length === 8 && [...code].every(character => ALPHABET.includes(character)) ? code : null
}
export interface PairingHello {
  protocol: number; session: string; nodeId: string; name: string; certificate: string; port: number
}
export interface PairingStart { session: string; nodeId: string; name: string; certificate: string; share: string }
export interface PairingOffer { session: string; share: string; confirm: string }
interface Pending { hello: PairingHello; request?: PairingStart; expected?: Buffer; receipt?: string; proofData?: Buffer }
export interface PairingWindowOptions {
  identity: NodeIdentity; trust: TrustStore; port: number
  ttlMs?: number; maxAttempts?: number; attemptFloorMs?: number; now?: () => number
}
export interface PairingWindow {
  readonly code: string; readonly display: string; readonly expiresAt: number; readonly open: boolean; readonly attempts: number
  hello(): PairingHello
  begin(request: PairingStart, address?: string): PairingOffer
  finish(session: string, confirm: Uint8Array, proof: Uint8Array): Promise<string>
  close(reason: string): void
  readonly ended: Promise<string>
}
/** Fixed arrays give both implementations one unambiguous, domain-separated encoding. */
export function pairingContext(hello: PairingHello, hub: Pick<PairingStart, 'nodeId' | 'name' | 'certificate'>): Spake2Options {
  return { identityA: `omochi-hub:${hub.nodeId}`, identityB: `omochi-gateway:${hello.nodeId}`,
    aad: Buffer.from(JSON.stringify(['omochi-pair-mtls-v1', hello.protocol, hello.session, hub.nodeId, hello.nodeId,
      hub.name, hello.name, certificateFingerprint(hub.certificate), certificateFingerprint(hello.certificate), hello.port, '/v1'])) }
}
function proofData(context: Spake2Options, shareA: Uint8Array, shareB: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from('omochi-device-possession-v1\0'), Buffer.from(context.aad!), Buffer.from(shareA), Buffer.from(shareB)])
}
function receipt(key: Buffer, context: Spake2Options): string {
  return createHmac('sha256', key).update('omochi-pair-committed-v1\0').update(context.aad!).digest('base64')
}
export function openPairingWindow(options: PairingWindowOptions): PairingWindow {
  const now = options.now ?? Date.now
  const code = generatePairingCode()
  const expiresAt = now() + (options.ttlMs ?? 180_000)
  const pending = new Map<string, Pending>()
  const lastAttempt = new Map<string, number>()
  let open = true, attempts = 0, committing = false
  let settle!: (reason: string) => void
  const ended = new Promise<string>(resolve => { settle = resolve })
  const close = (reason: string) => {
    if (!open) return
    open = false; pending.clear(); clearTimeout(timer); settle(reason)
  }
  const timer = setTimeout(() => close('expired'), options.ttlMs ?? 180_000)
  timer.unref()
  const check = () => {
    if (!committing && now() >= expiresAt) close('expired')
    if (!open || committing) throw new Error('the pairing window is closed')
  }
  return {
    code, display: formatPairingCode(code), expiresAt,
    get open() { if (!committing && now() >= expiresAt) close('expired'); return open && !committing },
    get attempts() { return attempts }, ended, close,
    hello() {
      check()
      while (pending.size >= 8) pending.delete(pending.keys().next().value!)
      const hello: PairingHello = { protocol: GATEWAY_PROTOCOL, session: randomBytes(32).toString('hex'), nodeId: options.identity.nodeId, name: options.identity.name, certificate: options.identity.certificate, port: options.port }
      pending.set(hello.session, { hello }); return hello
    },
    begin(request, address = 'unknown') {
      check()
      const waiting = pending.get(request.session)
      if (!waiting || waiting.request) throw new Error('no pairing is waiting for that session')
      const previous = lastAttempt.get(address)
      if (previous !== undefined && now() - previous < (options.attemptFloorMs ?? 1000)) throw new Error('too many pairing attempts; wait a moment and try again')
      // Global memory is bounded by the attempt budget, even with arbitrary source IPs.
      if (lastAttempt.size >= 64) lastAttempt.delete(lastAttempt.keys().next().value!)
      lastAttempt.set(address, now())
      attempts += 1
      if (attempts > (options.maxAttempts ?? 5)) { close('too many attempts'); throw new Error('the pairing window is closed') }
      pending.delete(request.session)
      if (!isValidNodeId(request.nodeId) || request.nodeId === options.identity.nodeId || !request.name || request.name.length > 256) throw new Error('invalid pairing identity')
      validateCertificate(request.certificate, request.nodeId)
      const context = pairingContext(waiting.hello, request)
      const gateway = spake2('B', spake2Scalar(Buffer.from(code)), context)
      const share = decode(request.share, 65)
      const result = gateway.finish(share)
      pending.set(request.session, { ...waiting, request, expected: result.peerConfirm, receipt: receipt(result.key, context), proofData: proofData(context, share, gateway.share) })
      return { session: request.session, share: gateway.share.toString('base64'), confirm: result.confirm.toString('base64') }
    },
    async finish(session, confirm, proof) {
      check()
      const waiting = pending.get(session)
      pending.delete(session)
      if (!waiting?.request || !waiting.expected || !waiting.proofData || !waiting.receipt) throw new Error('no pairing is waiting for that session')
      if (!confirmationMatches(waiting.expected, confirm)) throw new Error('the pairing confirmation did not match')
      const certificate = validateCertificate(waiting.request.certificate, waiting.request.nodeId)
      if (!verify('sha256', waiting.proofData, certificate.publicKey, proof)) throw new Error('device did not prove possession of its private key')
      // Reserve the only successful completion before the first asynchronous write.
      committing = true
      clearTimeout(timer)
      try {
        const hub = waiting.request
        await options.trust.put({ nodeId: hub.nodeId, name: hub.name, certificate: hub.certificate, fingerprint: certificateFingerprint(hub.certificate), role: 'hub', pairedAt: new Date(now()).toISOString() })
        close('paired'); return waiting.receipt
      } catch (error) { close('registration failed'); throw error }
    },
  }
}
function decode(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || value.length > 16384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('invalid base64')
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value || (length !== undefined && decoded.length !== length)) throw new Error('invalid base64 length')
  return decoded
}

/** Only the dedicated, temporary HTTPS listener installs this handler. */
export function pairingHandler(window: PairingWindow, onPaired: () => void = () => {}): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const path = new URL(request.url ?? '/', 'https://localhost').pathname
    if (![PAIRING_HELLO_PATH, PAIRING_START_PATH, PAIRING_FINISH_PATH].includes(path)) return false
    if (!window.open) { response.writeHead(404).end('pairing is not open'); return true }
    if (request.method !== 'POST') { response.writeHead(405).end('Method not allowed'); return true }
    let body = '', size = 0
    request.setTimeout(10_000, () => request.destroy())
    request.on('data', chunk => { size += chunk.length; if (size > 32_768) request.destroy(); else body += chunk.toString() })
    request.on('error', () => {})
    request.on('end', () => {
      void (async () => {
        const value = JSON.parse(body)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid pairing request')
        let answer: unknown
        if (path === PAIRING_HELLO_PATH) answer = window.hello()
        else if (path === PAIRING_START_PATH) {
          if (typeof value.session !== 'string' || typeof value.nodeId !== 'string' || typeof value.name !== 'string' || typeof value.certificate !== 'string') throw new Error('invalid pairing start')
          answer = window.begin(value, request.socket.remoteAddress)
        } else {
          if (typeof value.session !== 'string') throw new Error('invalid session')
          answer = { receipt: await window.finish(value.session, decode(value.confirm, 32), decode(value.proof)) }
        }
        if (path === PAIRING_FINISH_PATH) response.once('finish', () => setTimeout(onPaired, 0))
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer))
      })().catch((error: Error) => { if (!response.destroyed) response.writeHead(403).end(error.message) })
    })
    return true
  }
}

function postJson(endpoint: { host: string; port: number }, path: string, payload: unknown, pinned?: string): Promise<{ value: any; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const outgoing = httpsRequest({ host: endpoint.host, port: endpoint.port, path, method: 'POST',
      minVersion: TLS_MIN_VERSION, maxVersion: TLS_MIN_VERSION,
      // Unauthenticated bootstrap only. The observed certificate is bound into SPAKE2.
      rejectUnauthorized: false, agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, response => {
      const raw = (response.socket as TLSSocket).getPeerCertificate()?.raw
      if (!raw) { response.destroy(); reject(new Error('pairing server did not present a certificate')); return }
      const fingerprint = certificateFingerprint(raw)
      if (pinned && fingerprint !== pinned) { response.destroy(); reject(new Error('pairing TLS certificate changed')); return }
      let text = '', bytes = 0
      response.setEncoding('utf8')
      response.on('error', reject)
      response.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 32_768) response.destroy(new Error('pairing response too large')); else text += chunk })
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error(text || WRONG_CODE)); return }
        try { resolve({ value: JSON.parse(text), fingerprint }) } catch (error) { reject(error) }
      })
    })
    outgoing.setTimeout(10_000, () => outgoing.destroy(new Error('pairing timed out')))
    outgoing.on('error', reject); outgoing.end(body)
  })
}
export async function pairWithGateway(endpoint: GatewayEndpoint, options: { identity: NodeIdentity; trust: TrustStore; code: string }): Promise<TrustedPeer> {
  if (endpoint.kind !== 'tcp') throw new Error('pairing needs a gateway reachable over TCP')
  const code = normalizePairingCode(options.code)
  if (!code) throw new Error('that is not a pairing code')
  const initial = await postJson(endpoint, PAIRING_HELLO_PATH, {})
  const hello = initial.value as PairingHello
  if (hello.protocol !== GATEWAY_PROTOCOL || !isValidNodeId(hello.nodeId) || !/^[a-f0-9]{64}$/.test(hello.session) || typeof hello.name !== 'string' || !hello.name || hello.name.length > 256 || !Number.isInteger(hello.port) || hello.port < 1 || hello.port > 65535) throw new Error('unsupported pairing hello')
  validateCertificate(hello.certificate, hello.nodeId)
  if (certificateFingerprint(hello.certificate) !== initial.fingerprint) throw new Error('pairing TLS certificate does not match the exchange')
  const self = options.identity
  const context = pairingContext(hello, self)
  const hub = spake2('A', spake2Scalar(Buffer.from(code)), context)
  const started = await postJson(endpoint, PAIRING_START_PATH, { session: hello.session, nodeId: self.nodeId, name: self.name, certificate: self.certificate, share: hub.share.toString('base64') }, initial.fingerprint)
  const offer = started.value as PairingOffer
  if (offer.session !== hello.session) throw new Error('pairing session changed')
  const share = decode(offer.share, 65)
  const result = hub.finish(share)
  if (!confirmationMatches(result.peerConfirm, decode(offer.confirm, 32))) throw new Error(WRONG_CODE)
  const proof = sign('sha256', proofData(context, hub.share, share), createPrivateKey(self.privateKey)).toString('base64')
  const finished = await postJson(endpoint, PAIRING_FINISH_PATH, { session: hello.session, confirm: result.confirm.toString('base64'), proof }, initial.fingerprint)
  if (!confirmationMatches(Buffer.from(receipt(result.key, context), 'base64'), decode(finished.value.receipt, 32))) throw new Error('pairing completion was not authenticated')
  const peer: TrustedPeer = { nodeId: hello.nodeId, name: hello.name, certificate: hello.certificate, fingerprint: initial.fingerprint, role: 'gateway', pairedAt: new Date().toISOString(), addresses: [`${endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host}:${hello.port}`] }
  await options.trust.put(peer); return peer
}
