import { describe, expect, test } from "vitest"

import {
  closePeriod,
  monthName,
  normalizeCloseDay,
  trailingMonths,
} from "./period"

const JAKARTA = "Asia/Jakarta"

describe("closePeriod", () => {
  test("mid-close: the previous month is open, due on the close day", () => {
    const period = closePeriod(new Date("2026-09-13T03:00:00Z"), 15, JAKARTA)

    expect(period.month).toBe("2026-08")
    expect(period.start).toBe("2026-08-01")
    expect(period.end).toBe("2026-08-31")
    expect(period.due).toBe("2026-09-15")
    expect(period.today).toBe("2026-09-13")
    expect(period.daysLeft).toBe(2)
  })

  test("the tick strip runs from the 1st to the close day", () => {
    const { ticks } = closePeriod(new Date("2026-09-13T03:00:00Z"), 15, JAKARTA)

    expect(ticks).toHaveLength(15)
    expect(ticks.slice(0, 12).every((tick) => tick === "past")).toBe(true)
    expect(ticks[12]).toBe("today")
    expect(ticks[13]).toBe("ahead")
    expect(ticks[14]).toBe("due")
  })

  test("on the close day itself, today and the due date are the same tick", () => {
    const period = closePeriod(new Date("2026-09-15T03:00:00Z"), 15, JAKARTA)

    expect(period.daysLeft).toBe(0)
    expect(period.ticks[14]).toBe("today")
    expect(period.ticks).not.toContain("due")
  })

  test("after the close day the same month stays open, and overdue", () => {
    const period = closePeriod(new Date("2026-09-20T03:00:00Z"), 15, JAKARTA)

    expect(period.month).toBe("2026-08")
    expect(period.daysLeft).toBe(-5)
  })

  test("local dates, not UTC: 18:00 UTC on the 31st is already the 1st in Jakarta", () => {
    const period = closePeriod(new Date("2026-08-31T18:00:00Z"), 15, JAKARTA)

    expect(period.today).toBe("2026-09-01")
    expect(period.month).toBe("2026-08")
  })

  test("January reports on December of the previous year", () => {
    const period = closePeriod(new Date("2027-01-05T03:00:00Z"), 10, JAKARTA)

    expect(period.month).toBe("2026-12")
    expect(period.end).toBe("2026-12-31")
    expect(period.due).toBe("2027-01-10")
  })

  test("a February period ends on its real last day", () => {
    expect(closePeriod(new Date("2028-03-02T03:00:00Z"), 15, JAKARTA).end).toBe(
      "2028-02-29"
    )
    expect(closePeriod(new Date("2027-03-02T03:00:00Z"), 15, JAKARTA).end).toBe(
      "2027-02-28"
    )
  })
})

describe("normalizeCloseDay", () => {
  test("clamps into 1..28 and falls back to the default for nonsense", () => {
    expect(normalizeCloseDay(28)).toBe(28)
    expect(normalizeCloseDay(31)).toBe(28)
    expect(normalizeCloseDay(0)).toBe(1)
    expect(normalizeCloseDay(Number.NaN)).toBe(15)
    expect(normalizeCloseDay(2.5)).toBe(15)
  })
})

describe("trailingMonths", () => {
  test("returns the months ending at the given one, oldest first, across a year", () => {
    expect(trailingMonths("2026-08", 6)).toEqual([
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
    ])
    expect(trailingMonths("2027-02", 3)).toEqual(["2026-12", "2027-01", "2027-02"])
  })
})

describe("monthName", () => {
  test("names a month long with its year, or short without", () => {
    expect(monthName("2026-08")).toBe("August 2026")
    expect(monthName("2026-08", "short")).toBe("Aug")
  })
})
