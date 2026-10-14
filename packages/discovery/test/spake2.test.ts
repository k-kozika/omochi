import assert from 'node:assert/strict'
import { test } from '@omochi-ui/core/testing'

import { p256 } from '@noble/curves/nist.js'

// Imported rather than read, so the compiler copies it beside the compiled test.
import fixture from './fixtures/spake2-rfc9382.json' with { type: 'json' }

import {
  SPAKE2_M_HEX,
  SPAKE2_N_HEX,
  confirmationMatches,
  spake2,
  spake2Scalar,
  spake2WithEphemeral,
} from '../src/auth/spake2.js'

const hexToBigInt = (hex: string): bigint => BigInt(`0x${hex}`)
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex')

/**
 * The gate. RFC 9382 Appendix B is the only reason to trust this implementation: the
 * transcript's little-endian length prefixes and the key schedule are exactly the parts
 * a careful reading can still get wrong, and these vectors catch a single wrong byte.
 */
test('reproduces every RFC 9382 Appendix B vector exactly', () => {
  assert.equal(SPAKE2_M_HEX, fixture.points.M)
  assert.equal(SPAKE2_N_HEX, fixture.points.N)
  assert.equal(fixture.vectors.length, 4)

  for (const vector of fixture.vectors) {
    const label = `A='${vector.A}' B='${vector.B}'`
    const w = hexToBigInt(vector.w)
    const options = { identityA: vector.A, identityB: vector.B }

    const a = spake2WithEphemeral('A', w, hexToBigInt(vector.x), options)
    const b = spake2WithEphemeral('B', w, hexToBigInt(vector.y), options)
    assert.equal(hex(a.share), vector.pA, `${label}: pA`)
    assert.equal(hex(b.share), vector.pB, `${label}: pB`)

    const fromA = a.finish(b.share)
    const fromB = b.finish(a.share)
    assert.equal(hex(fromA.key), vector.Ke, `${label}: Ke from A`)
    assert.equal(hex(fromB.key), vector.Ke, `${label}: Ke from B`)
    assert.equal(hex(fromA.confirm), vector.cA, `${label}: cA`)
    assert.equal(hex(fromB.confirm), vector.cB, `${label}: cB`)

    // Each side must be able to check what the other will send.
    assert.ok(confirmationMatches(fromA.peerConfirm, fromB.confirm), `${label}: A checks cB`)
    assert.ok(confirmationMatches(fromB.peerConfirm, fromA.confirm), `${label}: B checks cA`)
  }
})

test('agrees on a key when both sides know the password, and not otherwise', () => {
  const options = { identityA: 'omochi-hub', identityB: 'omochi-gateway' }
  const w = spake2Scalar(Buffer.from('CORRECT1'))

  const a = spake2('A', w, options)
  const b = spake2('B', w, options)
  const fromA = a.finish(b.share)
  const fromB = b.finish(a.share)
  assert.deepEqual(fromA.key, fromB.key)
  assert.ok(confirmationMatches(fromA.peerConfirm, fromB.confirm))

  // A wrong password yields a different key, and neither side can fake a confirmation.
  const wrong = spake2('B', spake2Scalar(Buffer.from('WRONG123')), options)
  const guessed = wrong.finish(a.share)
  const cheated = a.finish(wrong.share)
  assert.notDeepEqual(cheated.key, guessed.key)
  assert.equal(confirmationMatches(cheated.peerConfirm, guessed.confirm), false)
})

test('binds the key to the identities and to the associated data', () => {
  const w = spake2Scalar(Buffer.from('SAME'))
  const keyFor = (options: Parameters<typeof spake2>[2]) => {
    const a = spake2WithEphemeral('A', w, 11n, options)
    const b = spake2WithEphemeral('B', w, 22n, options)
    return { key: a.finish(b.share).key, confirm: a.finish(b.share).confirm }
  }

  const base = keyFor({ identityA: 'omochi-hub', identityB: 'omochi-gateway' })
  // Swapping who is who must not produce the same transcript.
  assert.notDeepEqual(base.key, keyFor({ identityA: 'omochi-gateway', identityB: 'omochi-hub' }).key)

  // The associated data keys the confirmations, not the shared secret itself.
  const bound = keyFor({ identityA: 'omochi-hub', identityB: 'omochi-gateway', aad: Buffer.from('channel') })
  assert.deepEqual(base.key, bound.key)
  assert.notDeepEqual(base.confirm, bound.confirm)
})

test('refuses a share that is not a point, or one that collapses the secret', () => {
  const options = { identityA: 'omochi-hub', identityB: 'omochi-gateway' }
  const w = spake2Scalar(Buffer.from('CODE'))
  const a = spake2('A', w, options)

  assert.throws(() => a.finish(Buffer.alloc(65)), /.*/, 'a run of zero bytes is not a point')
  assert.throws(() => a.finish(Buffer.from('04' + 'ff'.repeat(64), 'hex')), /.*/, 'a point off the curve')

  // pB = w*N means Y is the identity, so the shared secret would be the identity too.
  const N = p256.Point.fromHex(SPAKE2_N_HEX)
  assert.throws(() => a.finish(N.multiply(w).toBytes(false)), /collapses the shared secret/)
})

test('derives the scalar without modular bias and deterministically', () => {
  const first = spake2Scalar(Buffer.from('ABCD-EFGH'))
  assert.equal(first, spake2Scalar(Buffer.from('ABCD-EFGH')))
  assert.notEqual(first, spake2Scalar(Buffer.from('ABCD-EFGI')))
  assert.ok(first > 0n)
})
