import fc from "fast-check"
import { describe, expect, test } from "vitest"

import {
  FAILED_THRESHOLD,
  WINDOW_MINUTES,
  isLockedOutFromFailures,
} from "@/lib/auth/lockout"

/**
 * `lib/auth/lockout.ts` — Requirements 3.2, 3.4 and 3.5.
 *
 * Everything below runs against {@link isLockedOutFromFailures}, and that is the
 * point of Requirement 3.5: lockout is **one pure predicate over a list of
 * timestamps and an instant**, so its edges are assertable directly rather than
 * inferred from rows in a table. No database, no clock, no fixtures.
 *
 * Two things this file cannot assert, and where they live instead:
 *
 *  * **Successes are excluded** (Req 3.4) is *structural* here — the predicate's
 *    only input is a list of **failure** timestamps, so a success has no
 *    representation to be counted from. What has to be checked is the `SELECT`
 *    that fills that list, which filters `success = false`; that is
 *    `isLockedOut`, and it is exercised against a real `login_attempts` table by
 *    the integration suite of task 3.8. Asserting it here would mean asserting
 *    against a fake of the very query in question.
 *  * **Failing closed** on an unreadable table (Req 3.8) is likewise a property
 *    of `isLockedOut`, not of the predicate.
 */

/** Requirement 3.2's numbers, hard-coded — see the first test. */
const THRESHOLD = 5
const WINDOW = 15

const MS_PER_MINUTE = 60_000

/** A fixed instant to measure from. Nothing here reads the wall clock. */
const NOW = new Date("2026-08-01T03:07:30.000Z")

/** A failure `minutes` before {@link NOW}. Fractions allowed, for the edges. */
function minutesAgo(minutes: number, now: Date = NOW): Date {
  return new Date(now.getTime() - minutes * MS_PER_MINUTE)
}

/** A failure `ms` before {@link NOW}. */
function msAgo(ms: number, now: Date = NOW): Date {
  return new Date(now.getTime() - ms)
}

/** `count` failures spread over the window, all comfortably inside it. */
function recentFailures(count: number): Date[] {
  return Array.from({ length: count }, (_, index) =>
    minutesAgo(index + 1)
  ).reverse()
}

describe("isLockedOutFromFailures — Requirement 3.2", () => {
  test("the threshold is 5 failures and the window is 15 minutes", () => {
    // Hard-coded rather than derived. Every case below is built from the
    // exported constants so that a deliberate policy change moves the whole
    // suite at once — which is exactly why the constants themselves need one
    // assertion that does not move with them.
    expect(FAILED_THRESHOLD).toBe(THRESHOLD)
    expect(WINDOW_MINUTES).toBe(WINDOW)
  })

  test("four in-window failures do not lock the email out", () => {
    const failures = recentFailures(FAILED_THRESHOLD - 1)

    expect(failures).toHaveLength(4)
    expect(isLockedOutFromFailures(failures, NOW)).toBe(false)
  })

  test("five in-window failures lock the email out", () => {
    const failures = recentFailures(FAILED_THRESHOLD)

    expect(failures).toHaveLength(5)
    expect(isLockedOutFromFailures(failures, NOW)).toBe(true)
  })

  test("no failures at all does not lock the email out", () => {
    expect(isLockedOutFromFailures([], NOW)).toBe(false)
  })

  test("more than five in-window failures stay locked out", () => {
    expect(
      isLockedOutFromFailures(recentFailures(FAILED_THRESHOLD + 20), NOW)
    ).toBe(true)
  })

  test("a failure at the current instant counts", () => {
    // The upper bound is inclusive too: an attempt recorded by this very
    // request is in the window it is being measured against.
    const failures = [...recentFailures(FAILED_THRESHOLD - 1), new Date(NOW)]

    expect(isLockedOutFromFailures(failures, NOW)).toBe(true)
  })
})

describe("the window edge — Requirements 3.2, 3.4", () => {
  test("a failure exactly 15 minutes old is counted", () => {
    // The inclusive lower bound, and the case that fails on an exclusive one:
    // four recent failures plus one dated exactly at `now - 15min` is five.
    const failures = [
      ...recentFailures(FAILED_THRESHOLD - 1),
      minutesAgo(WINDOW_MINUTES),
    ]

    expect(failures).toHaveLength(5)
    expect(isLockedOutFromFailures(failures, NOW)).toBe(true)
  })

  test("a failure one millisecond older than the window is not counted", () => {
    // One millisecond either side of the bound decides this, so the two tests
    // together pin the comparison rather than merely agreeing with it.
    const failures = [
      ...recentFailures(FAILED_THRESHOLD - 1),
      msAgo(WINDOW_MINUTES * MS_PER_MINUTE + 1),
    ]

    expect(failures).toHaveLength(5)
    expect(isLockedOutFromFailures(failures, NOW)).toBe(false)
  })

  test("five failures of which only four are in the window do not lock out", () => {
    // The behaviour Requirement 3.4 is really about: an email unlocks itself
    // as its failures age out, with no stored lock to expire and nothing to run
    // at the moment it lapses.
    const failures = [
      minutesAgo(WINDOW_MINUTES + 1),
      ...recentFailures(FAILED_THRESHOLD - 1),
    ]

    expect(failures).toHaveLength(5)
    expect(isLockedOutFromFailures(failures, NOW)).toBe(false)
  })

  test("an email locked at one instant is unlocked 15 minutes after its last failure", () => {
    // The same list, read at two instants. Nothing was cleared in between.
    const failures = recentFailures(FAILED_THRESHOLD)
    const lastFailure = new Date(
      Math.max(...failures.map((failure) => failure.getTime()))
    )
    const justAfter = new Date(
      lastFailure.getTime() + WINDOW_MINUTES * MS_PER_MINUTE + 1
    )

    expect(isLockedOutFromFailures(failures, NOW)).toBe(true)
    expect(isLockedOutFromFailures(failures, justAfter)).toBe(false)
  })

  test("a failure dated after the current instant is not counted", () => {
    // Clock skew between two app instances. A future timestamp is outside the
    // trailing window Requirement 3.2 bounds by the current instant, so it must
    // not contribute — and it must not throw either.
    const failures = [
      ...recentFailures(FAILED_THRESHOLD - 1),
      new Date(NOW.getTime() + 1),
    ]

    expect(isLockedOutFromFailures(failures, NOW)).toBe(false)
  })

  test("an invalid date is ignored rather than counted", () => {
    // `NaN` is neither below the lower bound nor above the upper one, so the
    // negated form of the window test (`at < lower || at > upper`) counts it.
    const failures = [
      ...recentFailures(FAILED_THRESHOLD - 1),
      new Date(Number.NaN),
    ]

    expect(isLockedOutFromFailures(failures, NOW)).toBe(false)
  })
})

describe("the predicate is a pure count over the window", () => {
  /**
   * Offsets from `now`, in milliseconds, spread either side of the bound: from
   * 5 minutes in the future to 30 minutes ago. Generated in the units the edge
   * actually turns on, so a case landing exactly on `now - 15min` or one
   * millisecond off it is reachable rather than astronomically unlikely.
   */
  const offsetMs = fc.oneof(
    {
      arbitrary: fc.integer({ min: -5 * 60_000, max: 30 * 60_000 }),
      weight: 3,
    },
    {
      // Clustered on the boundary itself.
      arbitrary: fc
        .integer({ min: -2, max: 2 })
        .map((delta) => WINDOW * MS_PER_MINUTE + delta),
      weight: 1,
    }
  )

  const failureLists = fc.array(offsetMs, { maxLength: 12 })

  test("locked out exactly when at least five failures fall in the inclusive window", () => {
    // The independent restatement of Requirement 3.2: count the timestamps
    // inside `[now - 15min, now]` here in the test, and compare. Order,
    // duplicates and out-of-window noise are all generated, so the predicate
    // cannot pass by looking at a sorted prefix or at the list's length.
    fc.assert(
      fc.property(failureLists, (offsets) => {
        const failures = offsets.map((offset) => msAgo(offset))
        const lower = NOW.getTime() - WINDOW * MS_PER_MINUTE
        const inWindow = failures.filter(
          (failure) =>
            failure.getTime() >= lower && failure.getTime() <= NOW.getTime()
        )

        expect(isLockedOutFromFailures(failures, NOW)).toBe(
          inWindow.length >= THRESHOLD
        )
      })
    )
  })

  test("the answer does not depend on the order of the failures", () => {
    fc.assert(
      fc.property(failureLists, (offsets) => {
        const failures = offsets.map((offset) => msAgo(offset))
        const shuffled = [...failures].sort(
          (left, right) => left.getTime() - right.getTime()
        )
        const reversed = [...shuffled].reverse()

        const expected = isLockedOutFromFailures(failures, NOW)
        expect(isLockedOutFromFailures(shuffled, NOW)).toBe(expected)
        expect(isLockedOutFromFailures(reversed, NOW)).toBe(expected)
      })
    )
  })

  test("the predicate reads no clock and mutates no input", () => {
    // Purity, as far as a test can observe it: the same arguments give the same
    // answer, and the caller's array comes back untouched.
    fc.assert(
      fc.property(failureLists, (offsets) => {
        const failures = offsets.map((offset) => msAgo(offset))
        const before = failures.map((failure) => failure.getTime())

        const first = isLockedOutFromFailures(failures, NOW)
        const second = isLockedOutFromFailures(failures, NOW)

        expect(second).toBe(first)
        expect(failures.map((failure) => failure.getTime())).toEqual(before)
      })
    )
  })
})
