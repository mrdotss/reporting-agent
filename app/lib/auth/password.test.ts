import { describe, expect, test } from "vitest"

import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  PasswordPolicyError,
  hashPassword,
  verifyPassword,
} from "@/lib/auth/password"

/**
 * `lib/auth/password.ts` — Requirements 1.3, 1.4 and 1.6.
 *
 * argon2 itself is a third party and is not what these tests are about. What
 * varies, and what a plausible implementation gets wrong, is **how a password's
 * length is measured** and **what happens to a stored hash that cannot be
 * parsed**:
 *
 *  * length is counted in **Unicode code points** (Req 1.3), so the emoji cases
 *    below are the ones that fail against `plaintext.length` — an 11-emoji
 *    passphrase is 22 UTF-16 units and a naive check accepts it, and a
 *    200-emoji one is 400 units and a naive check rejects it;
 *  * a malformed stored hash resolves to `false` and never raises (Req 1.6),
 *    because one corrupted row otherwise becomes a 500 that is distinguishable
 *    from an ordinary wrong password.
 *
 * **Real hashes, at the real cost.** Requirement 1.10 pins argon2id to 19456 KiB
 * and 2 iterations, so nothing here lowers the parameters to go faster — that
 * would leave the shipped cost untested. Each accepted case therefore costs one
 * genuine hash, the count of them is kept small on purpose, and the timeout
 * below is generous rather than tight.
 */

/**
 * Comfortably above the cost of the handful of argon2 operations in any one
 * test, so a slow or loaded machine reports a real failure rather than a
 * timeout. Vitest's 5s default is not enough headroom for that.
 */
const ARGON2_TIMEOUT_MS = 30_000

/** Requirements 1.3 and 1.4, hard-coded — see the first test. */
const MIN = 12
const MAX = 256

/**
 * The PHC prefix Requirements 1.2 and 1.10 require of every stored hash. The
 * parameter order is `m,p,t` because that is the order this library emits;
 * `design.md` writes the same three as `m=19456,t=2,p=1`, and both parse.
 */
const ARGON2ID_PHC = /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/

/** A 12-code-point passphrase of astral characters — 24 UTF-16 code units. */
const EMOJI_12 = "👍".repeat(12)

/** 11 code points, 22 UTF-16 code units: rejected here, accepted by `.length`. */
const EMOJI_11 = "👍".repeat(11)

/** 200 code points, 400 UTF-16 code units: accepted here, rejected by `.length`. */
const EMOJI_200 = "👍".repeat(200)

/** Code points, the unit Requirement 1.3 measures in. */
function codePoints(value: string): number {
  return [...value].length
}

/**
 * Every assertion about a produced hash, in one place: it is a real argon2id
 * digest at the pinned parameters, and it carries no trace of the password
 * (Req 1.12).
 */
async function expectStorableHash(
  plaintext: string,
  encoded: string
): Promise<void> {
  expect(encoded).toMatch(ARGON2ID_PHC)
  expect(encoded).not.toBe(plaintext)
  expect(encoded).not.toContain(plaintext)
  expect(await verifyPassword(encoded, plaintext)).toBe(true)
}

describe("the password policy — Requirements 1.3, 1.4", () => {
  test("the accepted range is 12 to 256 code points", () => {
    // Hard-coded rather than derived, so the boundaries below can be built from
    // the exported constants without the whole suite moving silently if one of
    // them changes.
    expect(PASSWORD_MIN).toBe(MIN)
    expect(PASSWORD_MAX).toBe(MAX)
  })

  test(
    "11 code points is rejected and 12 is accepted",
    async () => {
      const tooShort = "a".repeat(PASSWORD_MIN - 1)
      const shortest = "a".repeat(PASSWORD_MIN)

      expect(codePoints(tooShort)).toBe(11)
      expect(codePoints(shortest)).toBe(12)

      await expect(hashPassword(tooShort)).rejects.toBeInstanceOf(
        PasswordPolicyError
      )
      await expectStorableHash(shortest, await hashPassword(shortest))
    },
    ARGON2_TIMEOUT_MS
  )

  test(
    "256 code points is accepted and 257 is rejected",
    async () => {
      const longest = "a".repeat(PASSWORD_MAX)
      const tooLong = "a".repeat(PASSWORD_MAX + 1)

      expect(codePoints(longest)).toBe(256)
      expect(codePoints(tooLong)).toBe(257)

      await expectStorableHash(longest, await hashPassword(longest))
      await expect(hashPassword(tooLong)).rejects.toBeInstanceOf(
        PasswordPolicyError
      )
    },
    ARGON2_TIMEOUT_MS
  )

  test("the empty password is rejected", async () => {
    await expect(hashPassword("")).rejects.toBeInstanceOf(PasswordPolicyError)
  })

  test("the rejection states the accepted range and excludes the value", async () => {
    // Requirement 1.4 wants the range stated; Requirement 1.12 wants the
    // submitted value and its length kept out of every message. A password
    // echoed back into an error reaches a log aggregator on the next 500.
    const submitted = "correct horse battery staple".repeat(20)
    const length = String(codePoints(submitted))

    expect(codePoints(submitted)).toBeGreaterThan(PASSWORD_MAX)

    // Captured rather than asserted through `rejects.toThrow`, so the message
    // is one string this test can make several independent claims about.
    const message = await hashPassword(submitted).then(
      () => "the policy accepted a 560-character password",
      (error: unknown) =>
        error instanceof Error ? error.message : String(error)
    )

    expect(message).toContain(String(PASSWORD_MIN))
    expect(message).toContain(String(PASSWORD_MAX))
    expect(message).not.toContain("correct horse")
    expect(message).not.toContain("staple")
    expect(message).not.toContain(length)
  })

  test(
    "a 12-code-point emoji passphrase is accepted",
    async () => {
      // The case that kills a `.length` implementation from the other side:
      // 12 code points, 24 UTF-16 units, comfortably inside the range either
      // way — so it is asserted alongside the 11-emoji rejection below, which is
      // the half a naive check gets wrong.
      expect(codePoints(EMOJI_12)).toBe(PASSWORD_MIN)
      expect(EMOJI_12.length).toBe(PASSWORD_MIN * 2)

      await expectStorableHash(EMOJI_12, await hashPassword(EMOJI_12))
    },
    ARGON2_TIMEOUT_MS
  )

  test("an 11-code-point emoji passphrase is rejected", async () => {
    // 22 UTF-16 units, so `plaintext.length >= 12` accepts it. It is one
    // character short of the policy.
    expect(codePoints(EMOJI_11)).toBe(PASSWORD_MIN - 1)
    expect(EMOJI_11.length).toBeGreaterThanOrEqual(PASSWORD_MIN)

    await expect(hashPassword(EMOJI_11)).rejects.toBeInstanceOf(
      PasswordPolicyError
    )
  })

  test(
    "a 200-code-point emoji passphrase is accepted",
    async () => {
      // 400 UTF-16 units, so `plaintext.length <= 256` rejects a password that
      // is well inside the policy — the same miscount, in the direction that
      // locks a user out of registering rather than letting a weak one through.
      expect(codePoints(EMOJI_200)).toBe(200)
      expect(EMOJI_200.length).toBeGreaterThan(PASSWORD_MAX)

      await expectStorableHash(EMOJI_200, await hashPassword(EMOJI_200))
    },
    ARGON2_TIMEOUT_MS
  )
})

describe("the password is hashed exactly as submitted — Requirement 1.1", () => {
  test(
    "a password bearing leading and trailing whitespace round-trips",
    async () => {
      const submitted = "  spaced secret \t"
      const trimmed = submitted.trim()

      expect(submitted).not.toBe(trimmed)
      expect(codePoints(trimmed)).toBeGreaterThanOrEqual(PASSWORD_MIN)

      const encoded = await hashPassword(submitted)

      // It verifies as submitted...
      expect(await verifyPassword(encoded, submitted)).toBe(true)
      // ...and not against its trimmed form. Trimming anywhere on this path
      // would silently change which secret was registered, and the difference
      // would only surface on a client that submits whitespace differently.
      expect(await verifyPassword(encoded, trimmed)).toBe(false)
    },
    ARGON2_TIMEOUT_MS
  )
})

describe("verifyPassword — Requirements 1.5, 1.6", () => {
  /**
   * Stored values that cannot be parsed as an argon2 digest. The library throws
   * on each; the caller must see `false`.
   */
  const MALFORMED = [
    { label: "the empty string", hash: "" },
    { label: "whitespace only", hash: "   " },
    { label: "garbage", hash: "not-a-hash-at-all" },
    { label: "a bcrypt digest", hash: "$2b$12$abcdefghijklmnopqrstuv" },
    { label: "a bare variant marker", hash: "$argon2id$" },
    {
      label: "a truncated PHC string",
      hash: "$argon2id$v=19$m=19456,p=1,t=2$",
    },
    {
      label: "a PHC string with no digest segment",
      hash: "$argon2id$v=19$m=19456,p=1,t=2$Hc4TaNSqED+3/gBs5a7oRQ",
    },
    {
      label: "a PHC string whose digest is not base64",
      hash: "$argon2id$v=19$m=19456,p=1,t=2$Hc4TaNSqED+3/gBs5a7oRQ$***",
    },
    {
      label: "a PHC string with an unparseable parameter",
      hash: "$argon2id$v=19$m=x,p=1,t=2$Hc4TaNSqED+3/gBs5a7oRQ$m2ddX68xpid8909VDAvsSOmPK9aAK99AKpvCoqy0crI",
    },
  ] as const

  test.each(MALFORMED)(
    "$label resolves to false rather than raising",
    async ({ hash }) => {
      const result = await verifyPassword(hash, "a".repeat(PASSWORD_MIN))

      expect(result).toBe(false)
      expect(typeof result).toBe("boolean")
    }
  )

  test(
    "a valid hash still distinguishes the right password from a wrong one",
    async () => {
      // Non-vacuity for every `false` above: a `verifyPassword` that always
      // returned `false` would satisfy the malformed cases and nothing else.
      const plaintext = "a".repeat(PASSWORD_MIN)
      const encoded = await hashPassword(plaintext)

      expect(await verifyPassword(encoded, plaintext)).toBe(true)
      expect(await verifyPassword(encoded, `${plaintext}x`)).toBe(false)
      expect(await verifyPassword(encoded, plaintext.toUpperCase())).toBe(false)
    },
    ARGON2_TIMEOUT_MS
  )
})
