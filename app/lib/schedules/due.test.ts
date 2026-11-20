import { describe, expect, test } from "vitest"

import {
  formatSlot,
  isScheduleDue,
  isoWeekKey,
  nextScheduledRun,
  ordinalDay,
  scheduleMonth,
  schedulePeriodKey,
  weekdayName,
} from "@/lib/schedules/due"

const ON_THE_1ST_AT_2 = { dayOfMonth: 1, hour: 2, timezone: "Asia/Jakarta" }

describe("when a monthly schedule is due", () => {
  test("in its own timezone: 1 Oct 02:00 WIB is 30 Sep 19:00 UTC", () => {
    expect(isScheduleDue(ON_THE_1ST_AT_2, "2026-09", new Date("2026-09-30T18:59:00Z"))).toBe(false)
    expect(isScheduleDue(ON_THE_1ST_AT_2, "2026-09", new Date("2026-09-30T19:00:00Z"))).toBe(true)
    expect(scheduleMonth(new Date("2026-09-30T19:00:00Z"), "Asia/Jakarta")).toBe("2026-10")
  })

  test("once a month: a month already attempted is never due again", () => {
    expect(isScheduleDue(ON_THE_1ST_AT_2, "2026-10", new Date("2026-10-20T00:00:00Z"))).toBe(false)
  })

  test("a missed slot is still due later in the month", () => {
    expect(isScheduleDue(ON_THE_1ST_AT_2, "2026-09", new Date("2026-10-03T05:00:00Z"))).toBe(true)
    expect(isScheduleDue({ ...ON_THE_1ST_AT_2, dayOfMonth: 5 }, null, new Date("2026-10-03T05:00:00Z"))).toBe(false)
  })

  test("the next run is this month's slot, a due one now, or next month's", () => {
    const ahead = nextScheduledRun({ ...ON_THE_1ST_AT_2, dayOfMonth: 5 }, null, new Date("2026-10-03T05:00:00Z"))
    expect(formatSlot(ahead)).toBe("5 Oct, 02:00")
    const attempted = nextScheduledRun(ON_THE_1ST_AT_2, "2026-12", new Date("2026-12-10T00:00:00Z"))
    expect(attempted).toEqual({ year: 2027, month: 1, day: 1, hour: 2 })
  })

  test("days read as ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(ordinalDay)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "28th",
    ])
  })
})

const MONDAY_AT_8 = { cadence: "weekly", dayOfMonth: null, dayOfWeek: 1, hour: 8, timezone: "Asia/Jakarta" }

describe("when a weekly schedule is due", () => {
  test("ISO weeks: the week's Thursday decides its year", () => {
    expect(isoWeekKey(2026, 11, 23)).toBe("2026-W48")
    expect(isoWeekKey(2026, 11, 29)).toBe("2026-W48")
    expect(isoWeekKey(2027, 1, 1)).toBe("2026-W53")
    expect(isoWeekKey(2024, 12, 30)).toBe("2025-W01")
  })

  test("Monday 08:00 WIB is Monday 01:00 UTC, once per ISO week", () => {
    expect(isScheduleDue(MONDAY_AT_8, "2026-W47", new Date("2026-11-23T00:59:00Z"))).toBe(false)
    expect(isScheduleDue(MONDAY_AT_8, "2026-W47", new Date("2026-11-23T01:00:00Z"))).toBe(true)
    expect(schedulePeriodKey(MONDAY_AT_8, new Date("2026-11-23T01:00:00Z"))).toBe("2026-W48")
    expect(isScheduleDue(MONDAY_AT_8, "2026-W48", new Date("2026-11-25T01:00:00Z"))).toBe(false)
  })

  test("a missed Monday is still due later that week, and Sunday night is still the old week", () => {
    expect(isScheduleDue(MONDAY_AT_8, "2026-W47", new Date("2026-11-26T05:00:00Z"))).toBe(true)
    // Sunday 29 Nov 23:00 WIB.
    expect(isScheduleDue({ ...MONDAY_AT_8, dayOfWeek: 7, hour: 23 }, "2026-W47", new Date("2026-11-29T16:00:00Z"))).toBe(true)
    expect(schedulePeriodKey(MONDAY_AT_8, new Date("2026-11-29T16:00:00Z"))).toBe("2026-W48")
  })

  test("the next run is this week's slot, a due one now, or next week's", () => {
    // Saturday 21 Nov: next Monday.
    expect(formatSlot(nextScheduledRun(MONDAY_AT_8, "2026-W47", new Date("2026-11-21T03:00:00Z")))).toBe("23 Nov, 08:00")
    // Wednesday 25 Nov, already sent this week: the Monday after, across a month end.
    expect(nextScheduledRun(MONDAY_AT_8, "2026-W48", new Date("2026-11-25T03:00:00Z"))).toEqual({
      year: 2026, month: 11, day: 30, hour: 8,
    })
    expect(nextScheduledRun(MONDAY_AT_8, "2026-W53", new Date("2026-12-31T03:00:00Z"))).toEqual({
      year: 2027, month: 1, day: 4, hour: 8,
    })
    expect(weekdayName(1)).toBe("Monday")
    expect(weekdayName(7)).toBe("Sunday")
  })

  test("a monthly row with no cadence reads as monthly", () => {
    expect(schedulePeriodKey(ON_THE_1ST_AT_2, new Date("2026-09-30T19:00:00Z"))).toBe("2026-10")
  })
})
