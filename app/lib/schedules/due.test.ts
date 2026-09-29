import { describe, expect, test } from "vitest"

import { formatSlot, isScheduleDue, nextScheduledRun, ordinalDay, scheduleMonth } from "@/lib/schedules/due"

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
