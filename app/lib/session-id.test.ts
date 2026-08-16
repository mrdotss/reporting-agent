import { describe, expect, test } from "vitest"
import fc from "fast-check"

import {
  newSessionId,
  sessionIdForRun,
  sessionIdForThread,
} from "@/lib/session-id"

/**
 * `lib/session-id.ts` — Requirements 8.1, 8.2, 8.3, 8.6 and 8.7, plus the
 * base64url shape of a fresh id (8.4).
 *
 * `InvokeAgentRuntime` rejects a `runtimeSessionId` outside 33–128 characters,
 * so the bound is asserted directly rather than trusted to the digest width.
 * The module is pure, so these tests need no environment and no fixtures.
 */

/** The bound `InvokeAgentRuntime` enforces (Requirement 8.1). */
const MIN_LENGTH = 33
const MAX_LENGTH = 128

/** A SHA-256 digest, hex encoded, lower case only (Requirements 8.1, 8.3). */
const LOWERCASE_HEX_64 = /^[0-9a-f]{64}$/

/** 48 random bytes as base64url is 64 unpadded characters (Requirement 8.4). */
const BASE64URL_64 = /^[A-Za-z0-9_-]{64}$/

const RANDOM_BYTES = 48

/**
 * Inputs a thread or run id realistically takes, plus the ones that break a
 * length-dependent or encoding-dependent implementation: nothing at all, a
 * value that is only whitespace, characters outside the Basic Multilingual
 * Plane, and an input far longer than any id.
 */
const EDGE_INPUTS = [
  "",
  " ",
  "0",
  "thread-1",
  "01J9Z4Q0000000000000000000",
  "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  "  padded  ",
  "ünïcodé-ثread",
  "\u{1f9ea}\u{1d11e}",
  "line\nbreak\tand\ttabs",
  "x".repeat(4096),
] as const

const DERIVATIONS = [
  { name: "sessionIdForThread", derive: sessionIdForThread },
  { name: "sessionIdForRun", derive: sessionIdForRun },
] as const

/** Arbitrary ids, including astral characters, kept short enough to shrink. */
const anyId = fc.string({ unit: "binary", maxLength: 64 })

describe.each(DERIVATIONS)(
  "$name — Requirements 8.1, 8.2, 8.3",
  ({ derive }) => {
    test.each(EDGE_INPUTS)("%j derives a 64-char lowercase-hex id", (input) => {
      const id = derive(input)

      expect(id).toMatch(LOWERCASE_HEX_64)
      expect(id).toBe(id.toLowerCase())
      expect(id.length).toBe(64)
      expect(id.length).toBeGreaterThanOrEqual(MIN_LENGTH)
      expect(id.length).toBeLessThanOrEqual(MAX_LENGTH)
    })

    test.each(EDGE_INPUTS)("%j derives the same id on every call", (input) => {
      expect(derive(input)).toBe(derive(input))
      expect(derive(input)).toBe(derive(input))
    })

    test("every generated id holds the bound and the alphabet", () => {
      fc.assert(
        fc.property(anyId, (input) => {
          const id = derive(input)

          expect(id).toMatch(LOWERCASE_HEX_64)
          expect(id.length).toBeGreaterThanOrEqual(MIN_LENGTH)
          expect(id.length).toBeLessThanOrEqual(MAX_LENGTH)
        })
      )
    })

    test("derivation is deterministic for every generated id", () => {
      fc.assert(
        fc.property(anyId, (input) => {
          expect(derive(input)).toBe(derive(input))
        })
      )
    })
  }
)

describe("Requirement 8.6 — the namespace separates thread ids from run ids", () => {
  test.each(EDGE_INPUTS)("%j derives a different id per kind", (value) => {
    // A thread id and a run id carrying the same string must not share a
    // session, or one conversation's memory becomes another run's context.
    expect(sessionIdForThread(value)).not.toBe(sessionIdForRun(value))
  })

  test("no generated value collides across the two namespaces", () => {
    fc.assert(
      fc.property(anyId, (value) => {
        expect(sessionIdForThread(value)).not.toBe(sessionIdForRun(value))
      })
    )
  })

  test("no id derived from a set of values is shared between the kinds", () => {
    // Stronger than the per-value check: the two namespaces must not overlap at
    // all, so thread(a) may not equal run(b) for different a and b either.
    fc.assert(
      fc.property(
        fc.uniqueArray(anyId, { minLength: 2, maxLength: 8 }),
        (values) => {
          const threadIds = new Set(values.map(sessionIdForThread))
          const runIds = values.map(sessionIdForRun)

          for (const runId of runIds) {
            expect(threadIds.has(runId)).toBe(false)
          }
        }
      )
    )
  })
})

describe("Requirement 8.7 — distinct ids in, distinct ids out", () => {
  test("two distinct thread ids derive distinct session ids", () => {
    expect(sessionIdForThread("thread-1")).not.toBe(
      sessionIdForThread("thread-2")
    )
  })

  test("inputs differing only in a namespace-looking prefix stay distinct", () => {
    // The derivation concatenates its namespace with the value, so a value that
    // itself looks like a prefixed one must not land on the same digest.
    expect(sessionIdForThread("rpt:session:thread:v1:x")).not.toBe(
      sessionIdForThread("x")
    )
  })

  test.each(DERIVATIONS)(
    "$name maps a set of distinct values to as many distinct ids",
    ({ derive }) => {
      // `uniqueArray` guarantees the inputs differ, so the property needs no
      // precondition and rejects no generated case.
      fc.assert(
        fc.property(
          fc.uniqueArray(anyId, { minLength: 2, maxLength: 16 }),
          (values) => {
            const ids = new Set(values.map(derive))

            expect(ids.size).toBe(values.length)
          }
        )
      )
    }
  )
})

describe("newSessionId — Requirements 8.1, 8.4", () => {
  test("is 64 base64url characters decoding back to 48 bytes", () => {
    const id = newSessionId()

    expect(id).toMatch(BASE64URL_64)
    expect(id.length).toBeGreaterThanOrEqual(MIN_LENGTH)
    expect(id.length).toBeLessThanOrEqual(MAX_LENGTH)
    expect(Buffer.from(id, "base64url")).toHaveLength(RANDOM_BYTES)
    // base64url, not base64: neither the padding nor the two substituted
    // characters may appear.
    expect(id).not.toContain("=")
    expect(id).not.toContain("+")
    expect(id).not.toContain("/")
  })

  test("every id in a batch is fresh", () => {
    const ids = new Set(Array.from({ length: 256 }, () => newSessionId()))

    expect(ids.size).toBe(256)
    for (const id of ids) expect(id).toMatch(BASE64URL_64)
  })
})
