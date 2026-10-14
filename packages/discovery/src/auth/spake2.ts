import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

import { p256 } from '@noble/curves/nist.js'

/**
 * SPAKE2 (RFC 9382) over P-256, ciphersuite SPAKE2-P256-SHA256-HKDF-HMAC.
 *
 * What it buys over using the pairing code directly as a TLS pre-shared key: a party
 * that guesses wrong learns *nothing*. Each run tests exactly one password, online, so
 * the only way to attack a code is to keep guessing at the gateway — which the window's
 * attempt budget already stops. That is what makes a code short enough to read aloud
 * safe; without it, an active attacker could recover a short code offline from a single
 * failed handshake.
 *
 * P-256 is chosen for one reason: RFC 9382 Appendix B publishes test vectors for it, and
 * `test/spake2.test.ts` refuses to let this file ship unless it reproduces them exactly.
 * Every group operation comes from `@noble/curves`; nothing here invents cryptography.
 */
const Point = p256.Point

/** Fixed points from RFC 9382 Table 1, as compressed SEC1. */
export const SPAKE2_M_HEX = '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f'
export const SPAKE2_N_HEX = '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49'

const M = Point.fromHex(SPAKE2_M_HEX)
const N = Point.fromHex(SPAKE2_N_HEX)
const ORDER = Point.Fn.ORDER
const SCALAR_BYTES = 32

export type Spake2Role = 'A' | 'B'

export interface Spake2Options {
  /** Identity strings baked into the transcript, so neither side can be confused about who it spoke to. */
  identityA: string
  identityB: string
  /** Associated data both sides must already agree on; it keys the confirmations. */
  aad?: Uint8Array
}

export interface Spake2Result {
  /** The shared secret, `Ke` in the RFC. */
  key: Buffer
  /** This side's confirmation, to send. */
  confirm: Buffer
  /** What the peer's confirmation must equal. */
  peerConfirm: Buffer
}

export interface Spake2Session {
  /** This side's public share, to send. */
  readonly share: Buffer
  finish(peerShare: Uint8Array): Spake2Result
}

function osToBigInt(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(`0x${Buffer.from(bytes).toString('hex')}`)
}

function scalarToBytes(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(SCALAR_BYTES * 2, '0'), 'hex')
}

/** Eight-byte little-endian length prefixes, per RFC 9382 §3.2. */
function lengthPrefixed(value: Uint8Array): Buffer {
  const prefix = Buffer.alloc(8)
  prefix.writeBigUInt64LE(BigInt(value.length))
  return Buffer.concat([prefix, Buffer.from(value)])
}

/**
 * Derives the SPAKE2 scalar from a password. RFC 9382 leaves this to the protocol.
 *
 * Sampling 64 bits more than the order and reducing removes the modular bias, as
 * NIST SP 800-56A recommends. The RFC also suggests a memory-hard hash to slow brute
 * force, which this deliberately skips: SPAKE2 leaves no offline attack to slow down,
 * and guessing online is already bounded by the pairing window's attempt budget.
 */
export function spake2Scalar(password: Uint8Array): bigint {
  const wide = hkdfSync('sha256', password, 'omochi-spake2-v1', 'w', SCALAR_BYTES + 8)
  return osToBigInt(new Uint8Array(wide)) % ORDER
}

/**
 * Starts one side of the exchange.
 *
 * `A` uses M and `B` uses N; the roles must be agreed in advance, which they are here —
 * the hub is always A and the gateway always B.
 */
export function spake2(role: Spake2Role, w: bigint, options: Spake2Options): Spake2Session {
  const scalar = osToBigInt(p256.utils.randomSecretKey()) % ORDER
  // A zero scalar would publish the mask alone; rejecting it is cheaper than reasoning
  // about whether it matters.
  return spake2WithEphemeral(role, w, scalar === 0n ? 1n : scalar, options)
}

/**
 * The same exchange with the ephemeral scalar supplied.
 *
 * Only `spake2` should be used in production — reusing an ephemeral across runs breaks
 * the protocol outright. This exists so the RFC 9382 test vectors, which fix `x` and
 * `y`, can drive the real code path rather than a copy of it.
 */
export function spake2WithEphemeral(
  role: Spake2Role,
  w: bigint,
  ephemeral: bigint,
  options: Spake2Options,
): Spake2Session {
  const mask = role === 'A' ? M : N
  const own = mask.multiply(w).add(Point.BASE.multiply(ephemeral))
  const share = Buffer.from(own.toBytes(false))

  return {
    share,
    finish(peerShare) {
      const peer = Point.fromBytes(peerShare)
      peer.assertValidity()
      const peerMask = role === 'A' ? N : M
      // The cofactor of P-256 is 1, so no clearing step is needed here.
      const shared = peer.subtract(peerMask.multiply(w)).multiply(ephemeral)
      if (shared.is0()) throw new Error('the peer sent a share that collapses the shared secret')

      const pA = role === 'A' ? share : Buffer.from(peerShare)
      const pB = role === 'A' ? Buffer.from(peerShare) : share
      const transcript = Buffer.concat([
        lengthPrefixed(Buffer.from(options.identityA, 'utf8')),
        lengthPrefixed(Buffer.from(options.identityB, 'utf8')),
        lengthPrefixed(pA),
        lengthPrefixed(pB),
        lengthPrefixed(shared.toBytes(false)),
        lengthPrefixed(scalarToBytes(w)),
      ])

      const digest = createHash('sha256').update(transcript).digest()
      const key = digest.subarray(0, 16)
      const ka = digest.subarray(16)
      const info = Buffer.concat([Buffer.from('ConfirmationKeys'), Buffer.from(options.aad ?? new Uint8Array())])
      const confirmationKeys = Buffer.from(hkdfSync('sha256', ka, Buffer.alloc(0), info, 32))
      const kcA = confirmationKeys.subarray(0, 16)
      const kcB = confirmationKeys.subarray(16)
      const cA = createHmac('sha256', kcA).update(transcript).digest()
      const cB = createHmac('sha256', kcB).update(transcript).digest()

      return role === 'A'
        ? { key, confirm: cA, peerConfirm: cB }
        : { key, confirm: cB, peerConfirm: cA }
    },
  }
}

/** Compares confirmations without leaking where they first differ. */
export function confirmationMatches(expected: Buffer, received: Uint8Array): boolean {
  const candidate = Buffer.from(received)
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(expected, candidate)
}
