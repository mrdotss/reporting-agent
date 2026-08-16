import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import fc from "fast-check"

import {
  CiphertextError,
  decryptSecret,
  encryptSecret,
  resolveEncryptionKey,
} from "@/lib/crypto"

/**
 * Properties for `lib/crypto.ts` (Requirements 4.3, 4.4, 4.5, 4.6, 42.1).
 *
 * The round trip is the statement Requirement 4.4 makes directly — *for all*
 * UTF-8 strings — so it is generated rather than exemplified. The other three
 * are written as properties too, because each names a class of inputs rather
 * than one input: every plaintext must produce a fresh initialization vector,
 * every bit of the tag must fail verification when flipped, and every decoded
 * length below 28 must be rejected as too short.
 *
 * The envelope layout is restated here as three local constants rather than
 * imported. A test that reads its expectations from the module under test
 * agrees with that module by construction; these numbers come from
 * Requirement 4.1, and the assertions below are what tie the implementation to
 * them.
 */

const IV_BYTES = 12
const TAG_BYTES = 16
const ENVELOPE_HEADER_BYTES = IV_BYTES + TAG_BYTES

/**
 * Obviously not a credential, and fixed rather than random so a reported
 * counterexample reproduces. Exactly 32 bytes of ASCII, offered as base64,
 * which is the shape `resolveEncryptionKey` prefers.
 */
const FAKE_KEY_TEXT = "fake-test-key-not-a-real-secret1"
const FAKE_KEY_BYTES = Buffer.from(FAKE_KEY_TEXT, "utf8")
const FAKE_KEY_BASE64 = FAKE_KEY_BYTES.toString("base64")

/**
 * `unit: "binary"` draws any code point in 0000–10FFFF except a half surrogate,
 * so generated strings reach the astral planes, combining marks, control
 * characters and NUL — where a UTF-8 round trip actually breaks. ASCII-only
 * generation would prove almost nothing here. `maxLength` counts code points,
 * not UTF-16 units, so a 256-unit string can carry 512 characters.
 */
const utf8Text = fc.string({ unit: "binary", maxLength: 256 })

/**
 * Long enough that its appearance in an error message could not be a
 * coincidence, which is what makes the exclusion assertions in the
 * Requirement 4.10 property evidence rather than noise.
 */
const secretShapedText = fc.string({
  unit: "binary",
  minLength: 16,
  maxLength: 128,
})

/** Requirement 4.4 names both of these; 4096 code points, not UTF-16 units. */
const LONG_ASCII = "a".repeat(4096)
const LONG_ASTRAL = "\u{1F431}".repeat(4096)

/** One string mixing the classes a naive implementation handles unequally. */
const MIXED_UNICODE =
  "\u0000\u001f azAZ09 \u00e9\u0301 \u4e2d\u6587 \u05d0\u0631 \u{1d11e}\u{10ffff}"

const ROUND_TRIP_EXAMPLES: [string][] = [
  [""],
  [LONG_ASCII],
  [LONG_ASTRAL],
  [MIXED_UNICODE],
]

const FRESH_IV_EXAMPLES: [string][] = [[""], [LONG_ASCII]]

/** The first and last bit of the tag region, at both plaintext extremes. */
const TAMPERED_TAG_EXAMPLES: [string, number, number][] = [
  ["", 0, 0],
  ["", TAG_BYTES - 1, 7],
  [MIXED_UNICODE, TAG_BYTES - 1, 7],
]

/** Nothing at all, and one byte short of a header. */
const SHORT_ENVELOPE_EXAMPLES: [Uint8Array][] = [
  [new Uint8Array(0)],
  [new Uint8Array(ENVELOPE_HEADER_BYTES - 1)],
]

/**
 * Every property below declares `numRuns: 128` as a literal.
 *
 * fast-check draws declared examples from the same budget as generated ones —
 * `SourceValuesIterator` takes at most `numRuns` values and the examples are
 * yielded first — so a property carrying four examples at the global floor of
 * 100 would generate only 96. Declaring 128 keeps at least 100 *generated*
 * cases (Requirement 42.1) with the declared cases of Requirement 4.4 on top.
 */

beforeAll(() => {
  vi.stubEnv("APP_ENCRYPTION_KEY", FAKE_KEY_BASE64)
})

afterAll(() => {
  vi.unstubAllEnvs()
})

/**
 * Run something expected to throw and hand back the error, narrowed. Written as
 * a helper because `expect(...).toThrow(...)` cannot then assert on the
 * message, and because a call that *returns* where it should throw — a
 * decryption that accepted a tampered tag — has to fail loudly rather than fall
 * through to an assertion that never runs.
 */
function captureError(run: () => unknown): Error {
  try {
    run()
  } catch (thrown) {
    if (thrown instanceof Error) return thrown
    throw new Error(`Expected an Error, received ${typeof thrown}`)
  }
  throw new Error("Expected the call to throw, but it returned a value")
}

test("the fake key resolves to 32 bytes", () => {
  // Without this, a mis-stubbed environment fails every property below with the
  // same key error and the reason sits one layer away from the failure.
  const key = resolveEncryptionKey()

  expect(key.length).toBe(32)
  expect(key.equals(FAKE_KEY_BYTES)).toBe(true)
})

describe("Requirement 4.4 — the round trip holds for every UTF-8 string", () => {
  test("decrypting an encryption yields the original string", () => {
    fc.assert(
      fc.property(utf8Text, (plaintext) => {
        expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext)
      }),
      { numRuns: 128, examples: ROUND_TRIP_EXAMPLES }
    )
  })
})

describe("Requirement 4.3 — a fresh initialization vector on every call", () => {
  test("two encryptions of one plaintext differ and both decrypt to it", () => {
    fc.assert(
      fc.property(utf8Text, (plaintext) => {
        const first = Buffer.from(encryptSecret(plaintext), "base64")
        const second = Buffer.from(encryptSecret(plaintext), "base64")

        // The whole envelope differs, and it differs *in the IV* — a
        // deterministic IV would make the two identical, ciphertext and tag
        // included, for the same key and plaintext.
        expect(first.equals(second)).toBe(false)
        expect(
          first.subarray(0, IV_BYTES).equals(second.subarray(0, IV_BYTES))
        ).toBe(false)

        // The empty string is the case that matters most: with no ciphertext to
        // differ, only a fresh IV can separate the two envelopes.
        expect(decryptSecret(first.toString("base64"))).toBe(plaintext)
        expect(decryptSecret(second.toString("base64"))).toBe(plaintext)
      }),
      { numRuns: 128, examples: FRESH_IV_EXAMPLES }
    )
  })
})

describe("Requirement 4.5 — a tag that does not verify yields no plaintext", () => {
  test("flipping any bit of the tag raises CiphertextError", () => {
    fc.assert(
      fc.property(
        utf8Text,
        fc.nat({ max: TAG_BYTES - 1 }),
        fc.nat({ max: 7 }),
        (plaintext, tagOffset, bit) => {
          const envelope = Buffer.from(encryptSecret(plaintext), "base64")

          // Requirements 4.1 and 4.2 — the layout the tamper below depends on.
          // Asserted rather than assumed, so a changed layout fails here
          // instead of silently making the tamper hit the ciphertext.
          expect(envelope.length).toBe(
            ENVELOPE_HEADER_BYTES + Buffer.byteLength(plaintext, "utf8")
          )

          // A flipped bit, not an assigned byte: assigning could write the
          // value that was already there and prove nothing.
          envelope[IV_BYTES + tagOffset] ^= 1 << bit

          const error = captureError(() =>
            decryptSecret(envelope.toString("base64"))
          )

          expect(error).toBeInstanceOf(CiphertextError)
          // Requirement 4.11 — and it is the authentication failure, not the
          // length rejection, that fired.
          expect(error.message).toMatch(/authentication/i)
        }
      ),
      { numRuns: 128, examples: TAMPERED_TAG_EXAMPLES }
    )
  })
})

describe("Requirement 4.6 — an envelope too short to hold its own header", () => {
  test("every decoded length below 28 is rejected as too short", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: ENVELOPE_HEADER_BYTES - 1 }),
        (bytes) => {
          const error = captureError(() =>
            decryptSecret(Buffer.from(bytes).toString("base64"))
          )

          expect(error).toBeInstanceOf(CiphertextError)
          expect(error.message).toMatch(/too short/i)

          // The message names the input, and names it as short rather than as
          // unauthenticated. Without this, an implementation that dropped the
          // length check would still pass: a truncated envelope reaches the
          // GCM path and fails there, with the wrong error for the cause.
          expect(error.message).toMatch(/value|input/i)
          expect(error.message).not.toMatch(/tag does not verify/i)
        }
      ),
      { numRuns: 128, examples: SHORT_ENVELOPE_EXAMPLES }
    )
  })
})

describe("Requirement 4.10 — no error message carries the value it rejected", () => {
  test("neither failure path echoes plaintext, ciphertext or key material", () => {
    fc.assert(
      fc.property(secretShapedText, (plaintext) => {
        const envelope = Buffer.from(encryptSecret(plaintext), "base64")

        const tampered = Buffer.from(envelope)
        tampered[IV_BYTES] ^= 0x01

        const truncated = envelope.subarray(0, ENVELOPE_HEADER_BYTES - 1)

        const errors = [
          captureError(() => decryptSecret(tampered.toString("base64"))),
          captureError(() => decryptSecret(truncated.toString("base64"))),
        ]

        for (const { message } of errors) {
          expect(message).not.toContain(plaintext)
          expect(message).not.toContain(envelope.toString("base64"))
          expect(message).not.toContain(
            envelope.subarray(ENVELOPE_HEADER_BYTES).toString("base64")
          )
          expect(message).not.toContain(FAKE_KEY_TEXT)
          expect(message).not.toContain(FAKE_KEY_BASE64)
          expect(message).not.toContain(FAKE_KEY_BYTES.toString("hex"))
        }
      })
    )
  })
})
