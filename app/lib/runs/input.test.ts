import { describe, expect, test } from "vitest"

import {
  MAX_PERIOD_DAYS,
  checkPeriod,
  isSupportedTimeZone,
  localDateIn,
  localDaySpan,
  runCreateInputSchema,
  runIdParamSchema,
  runScopeSchema,
} from "@/lib/runs/input"

/**
 * The run boundary schemas and the pure period check (Requirements 7.7, 37.10).
 *
 * The period check is where a plausible implementation is silently wrong, so each
 * case below is chosen to fail on a specific wrong implementation: a UTC comparison
 * for the future check, an exclusive day count for the length check, and a
 * regex-only validation for `2026-02-31`.
 */

const JAKARTA = "Asia/Jakarta"

describe("localDaySpan — inclusive, and exact at 31", () => {
  test("one day is a span of 1", () => {
    expect(localDaySpan("2026-07-01", "2026-07-01")).toBe(1)
  })

  test("a full 31-day month is a span of 31", () => {
    // The number the collector's memory budget was measured against. An exclusive
    // count would report 30 here and admit a 32-day period.
    expect(localDaySpan("2026-07-01", "2026-07-31")).toBe(31)
  })

  test("a 30-day month is a span of 30", () => {
    expect(localDaySpan("2026-06-01", "2026-06-30")).toBe(30)
  })

  test("February in a leap year is a span of 29", () => {
    expect(localDaySpan("2028-02-01", "2028-02-29")).toBe(29)
  })

  test("an inverted range is a span below 1", () => {
    expect(localDaySpan("2026-07-31", "2026-07-01")).toBeLessThan(1)
  })

  test("a span across a year boundary is counted correctly", () => {
    expect(localDaySpan("2026-12-25", "2027-01-05")).toBe(12)
  })
})

describe("isSupportedTimeZone", () => {
  test.each([
    ["Asia/Jakarta", true],
    ["UTC", true],
    ["Europe/London", true],
    ["Asia/Kathmandu", true],
    ["Mars/Olympus_Mons", false],
    ["", false],
    ["Asia/Jakartaa", false],
  ] as const)("%s → %s", (timezone, expected) => {
    expect(isSupportedTimeZone(timezone)).toBe(expected)
  })
})

describe("localDateIn — the run's own zone decides 'today'", () => {
  test("Jakarta is a day ahead of UTC in the evening", () => {
    // 2026-08-15T18:00Z is 2026-08-16T01:00 in Jakarta. A UTC comparison would
    // call 2026-08-16 "the future" for seven hours of every day.
    const at = new Date("2026-08-15T18:00:00Z")

    expect(localDateIn("UTC", at)).toBe("2026-08-15")
    expect(localDateIn(JAKARTA, at)).toBe("2026-08-16")
  })

  test("a single-digit month and day are zero-padded", () => {
    expect(localDateIn("UTC", new Date("2026-01-05T12:00:00Z"))).toBe(
      "2026-01-05"
    )
  })
})

describe("Requirement 37.10 — checkPeriod", () => {
  /** Comfortably after every period below, in every zone. */
  const NOW = new Date("2026-08-15T12:00:00Z")

  test("a full month in the past is accepted", () => {
    expect(
      checkPeriod(
        {
          periodStart: "2026-07-01",
          periodEnd: "2026-07-31",
          timezone: JAKARTA,
        },
        NOW
      )
    ).toBeNull()
  })

  test("a single day is accepted", () => {
    expect(
      checkPeriod(
        {
          periodStart: "2026-07-15",
          periodEnd: "2026-07-15",
          timezone: JAKARTA,
        },
        NOW
      )
    ).toBeNull()
  })

  test("an inverted range is refused", () => {
    expect(
      checkPeriod(
        {
          periodStart: "2026-07-31",
          periodEnd: "2026-07-01",
          timezone: JAKARTA,
        },
        NOW
      )
    ).toBe("inverted")
  })

  test(`exactly ${MAX_PERIOD_DAYS} days is accepted and one more is refused`, () => {
    // The boundary, from both sides. An off-by-one here is how a 32-day window
    // reaches a collector sized for 31.
    expect(
      checkPeriod(
        {
          periodStart: "2026-07-01",
          periodEnd: "2026-07-31",
          timezone: JAKARTA,
        },
        NOW
      )
    ).toBeNull()

    expect(
      checkPeriod(
        {
          periodStart: "2026-07-01",
          periodEnd: "2026-08-01",
          timezone: JAKARTA,
        },
        NOW
      )
    ).toBe("too_long")
  })

  test("a date that matches the format but names no day is refused", () => {
    // The case a regex-only validation admits. `2026-02-31` would otherwise reach
    // the collector as a window ending on a day that does not exist.
    expect(
      checkPeriod(
        {
          periodStart: "2026-02-01",
          periodEnd: "2026-02-31",
          timezone: JAKARTA,
        },
        NOW
      )
    ).toBe("malformed")

    expect(
      checkPeriod(
        {
          periodStart: "2027-02-29",
          periodEnd: "2027-02-29",
          timezone: JAKARTA,
        },
        NOW
      )
    ).toBe("malformed")
  })

  test("an unresolvable timezone is refused", () => {
    expect(
      checkPeriod(
        {
          periodStart: "2026-07-01",
          periodEnd: "2026-07-31",
          timezone: "Mars/Olympus_Mons",
        },
        NOW
      )
    ).toBe("malformed")
  })

  test("a period ending tomorrow is refused", () => {
    expect(
      checkPeriod(
        {
          periodStart: "2026-08-16",
          periodEnd: "2026-08-16",
          timezone: JAKARTA,
        },
        new Date("2026-08-15T12:00:00Z")
      )
    ).toBe("ends_in_future")
  })

  test("the future check is made in the run's zone, not in UTC", () => {
    // 2026-08-15T18:00Z is already 2026-08-16 in Jakarta, so a report ending
    // 2026-08-16 is ending *today* there and is accepted — while the same
    // submission at the same instant in UTC ends tomorrow and is refused. A UTC
    // comparison would refuse both, which is the naive implementation this kills.
    const at = new Date("2026-08-15T18:00:00Z")
    const period = { periodStart: "2026-08-16", periodEnd: "2026-08-16" }

    expect(checkPeriod({ ...period, timezone: JAKARTA }, at)).toBeNull()
    expect(checkPeriod({ ...period, timezone: "UTC" }, at)).toBe(
      "ends_in_future"
    )
  })

  test("a period ending today in the run's zone is accepted", () => {
    expect(
      checkPeriod(
        {
          periodStart: "2026-08-01",
          periodEnd: "2026-08-15",
          timezone: JAKARTA,
        },
        new Date("2026-08-15T06:00:00Z")
      )
    ).toBeNull()
  })
})

describe("Requirement 7.7 — runScopeSchema", () => {
  test("resource types are required and non-empty", () => {
    expect(runScopeSchema.safeParse({ resource_types: [] }).success).toBe(false)
    expect(runScopeSchema.safeParse({}).success).toBe(false)
  })

  test("groups and tags default to empty, so the persisted shape is complete", () => {
    // Every stored `scope` carries all three keys whether the body named them or
    // not, so the compiler that later reads one never meets an absent field.
    const parsed = runScopeSchema.parse({ resource_types: ["A"] })

    expect(parsed).toEqual({
      resource_types: ["A"],
      resource_groups: [],
      tag_filters: {},
    })
  })

  test("entries are trimmed and a blank entry is refused", () => {
    expect(
      runScopeSchema.parse({ resource_types: ["  A  "] }).resource_types
    ).toEqual(["A"])

    expect(runScopeSchema.safeParse({ resource_types: ["   "] }).success).toBe(
      false
    )
  })

  test("an unrecognized key is a rejection, not something dropped", () => {
    // `.strict()`. A body carrying `top_n` expresses an expectation this spec does
    // not honour, and answering it with an unfiltered run would look like the
    // filter had been applied.
    expect(
      runScopeSchema.safeParse({ resource_types: ["A"], top_n: 10 }).success
    ).toBe(false)
  })
})

describe("Requirement 7.7 — runCreateInputSchema", () => {
  const BODY = {
    connectedSubscriptionId: "sub-row-1",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    scope: { resource_types: ["Microsoft.Compute/virtualMachines"] },
  }

  test("timezone defaults to Asia/Jakarta", () => {
    // Defaulted rather than required, because leaving it out is the common case —
    // and an absent zone must not silently become UTC, which would shift every
    // local day boundary by seven hours.
    expect(runCreateInputSchema.parse(BODY).timezone).toBe(JAKARTA)
  })

  test("a loose date is refused", () => {
    for (const periodStart of [
      "2026-7-1",
      "07/01/2026",
      "2026-07-01T00:00:00Z",
    ]) {
      expect(
        runCreateInputSchema.safeParse({ ...BODY, periodStart }).success
      ).toBe(false)
    }
  })

  test("there is no field for a user id, a dedupe key or a token", () => {
    // All three are derived server-side. `.strict()` is what makes their absence a
    // rejection rather than a value quietly ignored — a submitted `dedupeKey`
    // would be a way to opt out of the idempotency guard.
    for (const extra of [
      { userId: "someone-else" },
      { dedupeKey: "deadbeef" },
      { progressToken: "t" },
      { status: "completed" },
      { id: "chosen-run-id" },
    ]) {
      expect(
        runCreateInputSchema.safeParse({ ...BODY, ...extra }).success
      ).toBe(false)
    }
  })
})

describe("Requirement 7.7 — runIdParamSchema", () => {
  test("a bounded non-empty string is accepted", () => {
    expect(runIdParamSchema.parse({ runId: " run-1 " }).runId).toBe("run-1")
  })

  test("a blank or whitespace-only segment is refused", () => {
    expect(runIdParamSchema.safeParse({ runId: "" }).success).toBe(false)
    expect(runIdParamSchema.safeParse({ runId: "   " }).success).toBe(false)
  })

  test("a uuid shape is not required", () => {
    // `report_runs.id` is a `text` primary key. A boundary asserting more than the
    // column does starts rejecting valid rows the day an id is minted any other
    // way.
    expect(runIdParamSchema.safeParse({ runId: "run_01HQZZ" }).success).toBe(
      true
    )
  })
})
