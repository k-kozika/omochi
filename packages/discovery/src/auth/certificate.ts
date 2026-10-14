import { createHash, createPrivateKey, randomBytes, X509Certificate } from 'node:crypto'
import { BasicConstraintsExtension, ExtendedKeyUsageExtension, KeyUsagesExtension, KeyUsageFlags, SubjectAlternativeNameExtension, X509CertificateGenerator } from '@peculiar/x509'

export interface DeviceCredentials { certificate: string; privateKey: string }
export function deviceHostname(nodeId: string): string { return `${nodeId}.omochi.invalid` }
export function certificateFingerprint(pem: string | Buffer): string {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex')
}

/** Exact certificate pins are trust anchors, never a shared device CA. */
export function validateCertificate(pem: string, nodeId: string, now = Date.now()): X509Certificate {
  const certificate = new X509Certificate(pem)
  if (!certificate.verify(certificate.publicKey) || certificate.ca || !certificate.checkHost(deviceHostname(nodeId), { wildcards: false })) throw new Error('certificate does not identify this device')
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) throw new Error('device certificate expired or not yet valid; pair again')
  if (certificate.publicKey.asymmetricKeyType !== 'ec' || certificate.publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('device certificate must use P-256')
  return certificate
}
export async function createDeviceCredentials(nodeId: string): Promise<DeviceCredentials> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString('hex'), name: `CN=${deviceHostname(nodeId)}`, keys,
    notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 365 * 86400_000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    extensions: [new BasicConstraintsExtension(false, undefined, true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true), new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']), new SubjectAlternativeNameExtension([{ type: 'dns', value: deviceHostname(nodeId) }])],
  }, crypto)
  const privateKey = createPrivateKey({ key: Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)), format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' }).toString()
  return { certificate: certificate.toString('pem'), privateKey }
}
