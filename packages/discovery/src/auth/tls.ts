import { constants } from 'node:crypto'
import type { ConnectionOptions, TlsOptions, TLSSocket } from 'node:tls'
import type { NodeIdentity } from './identity.js'
import type { TrustStore, TrustedPeer } from './trust-store.js'
import { certificateFingerprint, deviceHostname, validateCertificate } from './certificate.js'

export const TLS_MIN_VERSION = 'TLSv1.3' as const
const versions = { minVersion: TLS_MIN_VERSION, maxVersion: TLS_MIN_VERSION, secureOptions: constants.SSL_OP_NO_TICKET, allowPartialTrustChain: true }

export function mtlsServerOptions(identity: NodeIdentity, trust: TrustStore): TlsOptions {
  return { ...versions, key: identity.privateKey, cert: identity.certificate,
    // Empty lists must not fall back to system roots. The local cert is never authorized.
    ca: trust.list().filter(peer => peer.role === 'hub').map(peer => peer.certificate).concat(identity.certificate),
    requestCert: true, rejectUnauthorized: true,
  }
}
export function authenticatedPeer(socket: TLSSocket, trust: TrustStore, role: TrustedPeer['role']): TrustedPeer | null {
  if (!socket.authorized || typeof socket.getPeerCertificate !== 'function') return null
  const raw = socket.getPeerCertificate()?.raw
  if (!raw) return null
  const fingerprint = certificateFingerprint(raw)
  const peer = trust.list().find(peer => peer.fingerprint === fingerprint && peer.role === role) ?? null
  return peer
}
export function mtlsClientOptions(identity: NodeIdentity, peer: TrustedPeer): ConnectionOptions {
  validateCertificate(peer.certificate, peer.nodeId)
  const options: ConnectionOptions = { ...versions, key: identity.privateKey, cert: identity.certificate, ca: [peer.certificate],
    servername: deviceHostname(peer.nodeId), rejectUnauthorized: true,
    checkServerIdentity: (_host, certificate) => {
      try {
        if (!certificate.raw || certificateFingerprint(certificate.raw) !== peer.fingerprint) return new Error('gateway certificate pin does not match')
        validateCertificate(peer.certificate, peer.nodeId)
        return undefined
      } catch (error) { return error as Error }
    },
  }
  return options
}
