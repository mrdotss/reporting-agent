import { describe, expect, test } from "vitest"

import {
  localToday,
  presetWindow,
  windowLabel,
  windowProblem,
} from "@/lib/live-metrics/window"

// 2026-09-15 16:00 in Jakarta (UTC+7).
const NOW = new Date("2026-09-15T09:00:00Z")

describe("live metrics windows — whole Jakarta days", () => {
  test("today is the Jakarta date, not the UTC one", () => {
    expect(localToday(new Date("2026-09-15T18:30:00Z"))).toBe("2026-09-16")
  })

  test("presets end yesterday", () => {
    expect(presetWindow("yesterday", NOW)).toEqual({ start: "2026-09-14", end: "2026-09-14" })
    expect(presetWindow("last_7_days", NOW)).toEqual({ start: "2026-09-08", end: "2026-09-14" })
    expect(presetWindow("month_to_date", NOW)).toEqual({ start: "2026-09-01", end: "2026-09-14" })
  })

  test("month to date on the 1st is that one day", () => {
    expect(presetWindow("month_to_date", new Date("2026-09-01T03:00:00Z"))).toEqual({
      start: "2026-09-01",
      end: "2026-09-01",
    })
  })

  test.each([
    [{ start: "2026-09-01", end: "2026-09-07" }, null],
    [{ start: "2026-09-07", end: "2026-09-01" }, "The start date is after the end date."],
    [{ start: "2026-09-10", end: "2026-09-16" }, "The window can't end after today."],
    [{ start: "", end: "2026-09-07" }, "Choose a start and an end date."],
  ])("%j → %s", (window, problem) => {
    expect(windowProblem(window, NOW)).toBe(problem)
  })

  test("a start past Azure Monitor retention is refused with the earliest allowed date", () => {
    expect(windowProblem({ start: "2026-06-01", end: "2026-06-30" }, NOW)).toMatch(
      /on or after 2026-06-15/
    )
    expect(windowProblem({ start: "2026-06-15", end: "2026-06-30" }, NOW)).toBeNull()
  })

  test("labels read like dates, not ranges of ISO strings", () => {
    expect(windowLabel({ start: "2026-09-01", end: "2026-09-07" })).toBe("1–7 Sept 2026")
    expect(windowLabel({ start: "2026-09-14", end: "2026-09-14" })).toBe("14 Sept 2026")
    expect(windowLabel({ start: "2026-08-28", end: "2026-09-03" })).toBe("28 Aug – 3 Sept 2026")
  })
})
