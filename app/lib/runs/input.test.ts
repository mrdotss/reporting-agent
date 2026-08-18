import { describe, expect, test } from "vitest"

import {
  isSupportedTimeZone,
  localDateIn,
  localDaySpan,
  runCreateInputSchema,
  runIdParamSchema,
} from "@/lib/runs/input"

/**
 * The run boundary schemas, and the calendar primitives they re-export
 * (Requirement 7.7).
 *
 * Each case is chosen to fail on a specific wrong implementation: a UTC comparison
 * for `localDateIn`, and an exclusive day count for `localDaySpan`.
 *
 * The `checkPeriod` and `runScopeSchema` suites that used to sit between them are
 * gone with the surfaces they tested — task 13.1 moved the period and the scope
 * into the pinned template version, so no submission carries either. What they
 * asserted is covered more strictly by `lib/templates/period.ts`'s own suite and
 * its property tests, and newly by `test/db/enqueue-pinning.integration.test.ts`.
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

describe("Requirement 7.7 — runCreateInputSchema", () => {
  // The whole accepted body since task 13.1: the period and the scope come
  // from the pinned template version (Requirements 3.3, 4.3), so neither is a
  // field here and `.strict()` refuses both.
  const BODY = {
    connectedSubscriptionId: "sub-row-1",
    templateId: "tpl-row-1",
  }

  test("timezone defaults to Asia/Jakarta", () => {
    // Defaulted rather than required, because leaving it out is the common case —
    // and an absent zone must not silently become UTC, which would shift every
    // local day boundary by seven hours.
    expect(runCreateInputSchema.parse(BODY).timezone).toBe(JAKARTA)
  })

  test("a template id is required", () => {
    expect(
      runCreateInputSchema.safeParse({
        connectedSubscriptionId: BODY.connectedSubscriptionId,
      }).success
    ).toBe(false)
    expect(
      runCreateInputSchema.safeParse({ ...BODY, templateId: "   " }).success
    ).toBe(false)
  })

  test("a submitted period or scope is refused outright", () => {
    // Not ignored — refused. `.strict()` is what turns "this field moved into
    // the template" into a rejection a caller can see, rather than a value
    // silently dropped while the run collects something else.
    for (const extra of [
      { periodStart: "2026-07-01" },
      { periodEnd: "2026-07-31" },
      { scope: { resource_types: ["Microsoft.Compute/virtualMachines"] } },
    ]) {
      expect(
        runCreateInputSchema.safeParse({ ...BODY, ...extra }).success
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
