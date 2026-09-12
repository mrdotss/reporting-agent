import { describe, expect, test } from "vitest"

import { relativeInstant } from "./presentation"

/**
 * The field that tells five identical rows apart.
 *
 * The dashboard lists five recent runs; for a consultant running one profile against
 * one connection for one period, those five rows differ in exactly one value. It was
 * the value the compact table had dropped.
 */
const NOW = new Date("2026-09-12T12:00:00.000Z")

describe("relativeInstant", () => {
  test.each([
    ["2026-09-12T11:59:30.000Z", "just now"],
    ["2026-09-12T11:48:00.000Z", "12 min ago"],
    ["2026-09-12T09:00:00.000Z", "3 h ago"],
    ["2026-09-10T12:00:00.000Z", "2 d ago"],
    ["2026-09-01T08:30:00.000Z", "2026-09-01"],
  ])("%s reads as %s", (iso, expected) => {
    expect(relativeInstant(iso, NOW)).toBe(expected)
  })

  test("the boundaries land on the coarser unit, not the finer one", () => {
    // 59 minutes is minutes; 60 is hours. A function that reads its own clock cannot be
    // tested here at all, which is why `now` is a parameter.
    expect(relativeInstant("2026-09-12T11:01:00.000Z", NOW)).toBe("59 min ago")
    expect(relativeInstant("2026-09-12T11:00:00.000Z", NOW)).toBe("1 h ago")
    expect(relativeInstant("2026-09-11T12:00:00.000Z", NOW)).toBe("1 d ago")
    expect(relativeInstant("2026-09-05T12:00:00.000Z", NOW)).toBe("2026-09-05")
  })

  test("a clock skew is not reported as the future", () => {
    // The server's clock and the row's can disagree by a second. "in 3 seconds" would
    // be a true statement about two clocks and a nonsense one about a report.
    expect(relativeInstant("2026-09-12T12:00:03.000Z", NOW)).toBe("just now")
  })

  test("an unparseable instant says nothing rather than NaN", () => {
    expect(relativeInstant("not a date", NOW)).toBe("")
  })
})
