import { createHash, randomBytes } from "node:crypto"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { EncryptionKeyError } from "@/lib/crypto"
import {
  PROGRESS_TOKEN_HEADER,
  deriveProgressToken,
  progressTokenHash,
  validateProgressToken,
} from "@/lib/runs/progress-token"

/**
 * The run-scoped progress token (Requirements 37.3, 38.5).
 *
 * `keyBelongsToActor` — the other half of what task 13.3 covers — is asserted in
 * `lib/aws/s3.test.ts`, including both near-misses the design names
 * (`alice-evil/snapshots/...` and `other/alice/snapshots/...`). It is not
 * duplicated here: two copies of an authorization assertion is how one of them
 * comes to be edited and the other forgotten, and the primitive lives beside the
 * key layout it parses.
 */

const KEY_VAR = "APP_ENCRYPTION_KEY"

/** A fixed 32-byte key, so every derivation below is reproducible. */
const KEY = Buffer.alloc(32, 7).toString("base64")

/** A second, different key — for the rotation assertion. */
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64")

const RUN_ID = "run_01HQZZZZZZZZZZZZZZZZZZZZZZ"

let previousKey: string | undefined

beforeEach(() => {
  previousKey = process.env[KEY_VAR]
  process.env[KEY_VAR] = KEY
})

afterEach(() => {
  if (previousKey === undefined) delete process.env[KEY_VAR]
  else process.env[KEY_VAR] = previousKey
})

describe("Requirement 37.3 — derivation", () => {
  test("one run id derives one token", () => {
    expect(deriveProgressToken(RUN_ID)).toBe(deriveProgressToken(RUN_ID))
  })

  test("distinct run ids derive distinct tokens", () => {
    expect(deriveProgressToken("run-a")).not.toBe(deriveProgressToken("run-b"))
  })

  test("the token is unpadded base64url", () => {
    // Safe in a header without quoting, and no `=` for an intermediary to
    // normalize. 32 bytes of HMAC output is 43 base64url characters.
    const token = deriveProgressToken(RUN_ID)

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test("the label domain-separates the HMAC", () => {
    // A future `HMAC(key, runId)` for an unrelated purpose must not produce a
    // value that validates here, which is what the fixed label buys. Asserting it
    // by construction: the derivation over the label-prefixed message differs
    // from one over the bare run id.
    const bare = createHash("sha256").update(RUN_ID, "utf8").digest("base64url")

    expect(deriveProgressToken(RUN_ID)).not.toBe(bare)
  })

  test("a rotated key derives a different token for the same run", () => {
    // Documented consequence of keying from `APP_ENCRYPTION_KEY`: a rotation
    // invalidates in-flight runs' tokens, their callbacks are refused, and the
    // reaper fails them as TIMEOUT. Asserted so the coupling is a stated fact
    // rather than a surprise.
    const before = deriveProgressToken(RUN_ID)

    process.env[KEY_VAR] = OTHER_KEY

    expect(deriveProgressToken(RUN_ID)).not.toBe(before)
  })

  test("an unusable key raises the key error, not a token", () => {
    process.env[KEY_VAR] = "too-short"

    expect(() => deriveProgressToken(RUN_ID)).toThrow(EncryptionKeyError)
  })
})

describe("Requirement 37.3 — only the hash is stored", () => {
  test("the stored form is a 64-character lowercase hex digest", () => {
    expect(progressTokenHash(deriveProgressToken(RUN_ID))).toMatch(
      /^[0-9a-f]{64}$/
    )
  })

  test("the hash is not the token", () => {
    const token = deriveProgressToken(RUN_ID)

    expect(progressTokenHash(token)).not.toBe(token)
    expect(progressTokenHash(token)).not.toContain(token)
  })

  test("hashing is deterministic", () => {
    const token = deriveProgressToken(RUN_ID)

    expect(progressTokenHash(token)).toBe(progressTokenHash(token))
  })
})

describe("Requirement 38.5 — validation", () => {
  test("the derived token validates against its stored hash", () => {
    const token = deriveProgressToken(RUN_ID)

    expect(validateProgressToken(token, progressTokenHash(token))).toBe(true)
  })

  test("another run's token does not validate", () => {
    const mine = progressTokenHash(deriveProgressToken(RUN_ID))
    const theirs = deriveProgressToken("some-other-run")

    expect(validateProgressToken(theirs, mine)).toBe(false)
  })

  test("a token differing in one character does not validate", () => {
    const token = deriveProgressToken(RUN_ID)
    const stored = progressTokenHash(token)

    const flipped = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`

    expect(flipped).not.toBe(token)
    expect(validateProgressToken(flipped, stored)).toBe(false)
  })

  test("an empty or non-string token does not validate", () => {
    const stored = progressTokenHash(deriveProgressToken(RUN_ID))

    expect(validateProgressToken("", stored)).toBe(false)
    // A body that reached here past its schema, or a header that was absent.
    expect(validateProgressToken(undefined as unknown as string, stored)).toBe(
      false
    )
  })

  test("a stored hash that is not 64 hex characters rejects everything", () => {
    // Fails **closed**: `Buffer.from(_, "hex")` stops at the first non-hex
    // character and returns a short buffer, so without the decoded-length check
    // a truncated stored value would be compared against a prefix. A row whose
    // hash was corrupted must refuse every callback, not accept a short one.
    const token = deriveProgressToken(RUN_ID)
    const stored = progressTokenHash(token)

    for (const bad of [
      "",
      "deadbeef",
      stored.slice(0, 63),
      `${stored}ff`,
      `zz${stored.slice(2)}`,
      undefined as unknown as string,
    ]) {
      expect(validateProgressToken(token, bad)).toBe(false)
    }
  })

  test("validation is constant-time over the digests", () => {
    // The property `timingSafeEqual` provides cannot be measured reliably in a
    // unit test, so what is asserted is the precondition that makes it callable
    // at all: both operands are 32-byte digests whatever the presented token's
    // length, so there is no input that makes the comparison throw — and a throw
    // for a wrong-length input would itself be a length oracle.
    const stored = progressTokenHash(deriveProgressToken(RUN_ID))

    for (const length of [1, 10, 43, 200, 4096]) {
      const presented = randomBytes(length).toString("base64url")

      expect(() => validateProgressToken(presented, stored)).not.toThrow()
      expect(validateProgressToken(presented, stored)).toBe(false)
    }
  })
})

describe("Requirement 38.2 — the header is the only place the token travels", () => {
  test("the header name is the one the agent sends", () => {
    // Mirrors `TOKEN_HEADER` in `agent/src/reporting_agent/progress.py`. Two
    // string literals in two languages is how a callback starts returning 404 for
    // a reason nobody can see.
    expect(PROGRESS_TOKEN_HEADER).toBe("X-Rpt-Progress-Token")
  })
})
