import { describe, expect, test } from "vitest"

import { CLAIM_LIMIT, SWEEP_LIMIT, bearerMatches } from "@/lib/runs/claim"

/**
 * The reaper's bearer comparison (Requirements 39.1, 39.2, 39.3).
 *
 * This is the **only** protection on an endpoint that can claim work and invoke the
 * runtime, so the two properties below are the ones worth machine-checking:
 *
 *   * it **fails closed** on an unset or empty `RPT_CRON_SECRET`, because an
 *     unconfigured deployment defaulting to open is a denial-of-wallet hole;
 *   * it is **callable for every input**, because `timingSafeEqual` throws on
 *     unequal lengths and a throw is itself a length oracle.
 *
 * The claim and sweep statements are exercised against real Postgres in
 * `test/db/runs-orchestration.integration.test.ts` — `SKIP LOCKED` disjointness and
 * the pre-update `status` in the sweep's `SET` expression are properties of the
 * engine, and a fake would assert them of the fake.
 */

const SECRET = "0123456789abcdef0123456789abcdef"

describe("Requirement 39.2 — it fails closed", () => {
  test.each([undefined, "", "   ", "\t\n"])(
    "an expected secret of %j rejects a matching presentation",
    (expected) => {
      // The direction that matters. A deployment that has not set the variable must
      // not accept the empty string, and must not accept anything else either.
      expect(bearerMatches(`Bearer ${expected ?? ""}`, expected)).toBe(false)
      expect(bearerMatches(`Bearer ${SECRET}`, expected)).toBe(false)
    }
  )
})

describe("Requirement 39.1, 39.3 — what is accepted and what is not", () => {
  test("the exact secret with the Bearer scheme is accepted", () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true)
  })

  test("an absent header is rejected", () => {
    expect(bearerMatches(null, SECRET)).toBe(false)
  })

  test.each([
    ["the bare secret with no scheme", SECRET],
    ["a lower-case scheme", `bearer ${SECRET}`],
    ["a different scheme", `Basic ${SECRET}`],
    ["the scheme with no value", "Bearer "],
    ["the scheme alone", "Bearer"],
    ["an empty header", ""],
  ] as const)("%s is rejected", (_label, presented) => {
    expect(bearerMatches(presented, SECRET)).toBe(false)
  })

  test("a secret differing in one character is rejected", () => {
    expect(bearerMatches(`Bearer ${SECRET.slice(0, -1)}0`, SECRET)).toBe(false)
  })

  test("a correct prefix is not enough", () => {
    // The property the digest comparison buys: a prefix match is worth exactly as
    // much as no match at all, and the duration does not distinguish them.
    for (const length of [1, 8, 16, 31]) {
      expect(bearerMatches(`Bearer ${SECRET.slice(0, length)}`, SECRET)).toBe(
        false
      )
    }
  })

  test("a longer value carrying the secret as a prefix is rejected", () => {
    expect(bearerMatches(`Bearer ${SECRET}extra`, SECRET)).toBe(false)
  })

  test("surrounding whitespace is not tolerated", () => {
    // A secret with a stray trailing space is a configuration mistake, and trimming
    // would mean two different strings both authorize.
    expect(bearerMatches(`Bearer ${SECRET} `, SECRET)).toBe(false)
    expect(bearerMatches(`Bearer  ${SECRET}`, SECRET)).toBe(false)
  })
})

describe("Requirement 39.1 — the comparison never throws", () => {
  test("every presented length is a rejection rather than an error", () => {
    // `timingSafeEqual` throws on unequal-length buffers, so a comparison over the
    // raw strings would throw here — and a throw for a wrong-length input is a
    // length oracle. Hashing both sides first makes the operands always 32 bytes.
    for (const length of [1, 2, 31, 32, 33, 1000, 100_000]) {
      const presented = `Bearer ${"x".repeat(length)}`

      expect(() => bearerMatches(presented, SECRET)).not.toThrow()
      expect(bearerMatches(presented, SECRET)).toBe(false)
    }
  })

  test("a very long expected secret is compared without throwing", () => {
    const long = "y".repeat(10_000)

    expect(bearerMatches(`Bearer ${long}`, long)).toBe(true)
    expect(bearerMatches(`Bearer ${SECRET}`, long)).toBe(false)
  })

  test("a multi-byte secret is compared by bytes, not by code units", () => {
    // The digest is taken over UTF-8, so a non-ASCII secret works and a
    // canonically-different-but-visually-similar one does not.
    const emoji = "🔑".repeat(10)

    expect(bearerMatches(`Bearer ${emoji}`, emoji)).toBe(true)
    expect(bearerMatches(`Bearer ${"🔒".repeat(10)}`, emoji)).toBe(false)
  })
})

describe("the per-request limits", () => {
  test("the sweep bound exceeds the claim bound", () => {
    // The sweep is bookkeeping — one `UPDATE`, no follow-on work — while every
    // claimed row costs an invocation with a 10-second start budget. Sizing them the
    // same would either throttle the sweep or put a hundred concurrent
    // `InvokeAgentRuntime` calls in one request.
    expect(SWEEP_LIMIT).toBe(100)
    expect(CLAIM_LIMIT).toBe(10)
    expect(SWEEP_LIMIT).toBeGreaterThan(CLAIM_LIMIT)
  })
})
