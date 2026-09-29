/**
 * When a monthly schedule is due. **Pure**, and not `server-only`: the run form and the
 * Close Board say when the next run is with the same rule the tick uses to start it.
 *
 * A schedule runs once per calendar month, in its own timezone, on its day at its hour —
 * and at any tick after that within the month, so a tick missed at 02:00 still starts the
 * run at 02:01. `lastAttemptMonth` is what makes it once: the tick claims the month before
 * it enqueues, and a month already claimed is never due again, whatever happened to the
 * attempt. A run that could not start is shown to the consultant rather than retried
 * every minute.
 *
 * The day stops at 28 so every month has it.
 */

export const MIN_SCHEDULE_DAY = 1
export const MAX_SCHEDULE_DAY = 28
export const SCHEDULE_TIMEZONE = "Asia/Jakarta"

export type ScheduleTiming = {
  readonly dayOfMonth: number
  readonly hour: number
  readonly timezone: string
}

type LocalParts = { readonly year: number; readonly month: number; readonly day: number; readonly hour: number }

function localParts(now: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now)
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") }
}

const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`

/** The schedule's current calendar month, `YYYY-MM`, in its own timezone. */
export function scheduleMonth(now: Date, timezone: string): string {
  const { year, month } = localParts(now, timezone)
  return monthKey(year, month)
}

/** Whether a tick at `now` should start this schedule's run for the current month. */
export function isScheduleDue(
  timing: ScheduleTiming,
  lastAttemptMonth: string | null,
  now: Date
): boolean {
  const local = localParts(now, timing.timezone)
  if (lastAttemptMonth === monthKey(local.year, local.month)) return false
  return local.day > timing.dayOfMonth || (local.day === timing.dayOfMonth && local.hour >= timing.hour)
}

/**
 * The next local day and hour this schedule runs, as `{ year, month, day, hour }` in its
 * timezone — this month's slot if it has not been attempted and is still ahead, otherwise
 * next month's.
 */
export function nextScheduledRun(
  timing: ScheduleTiming,
  lastAttemptMonth: string | null,
  now: Date
): { readonly year: number; readonly month: number; readonly day: number; readonly hour: number } {
  const local = localParts(now, timing.timezone)
  const attempted = lastAttemptMonth === monthKey(local.year, local.month)
  const ahead = local.day < timing.dayOfMonth || (local.day === timing.dayOfMonth && local.hour < timing.hour)
  if (!attempted && ahead) return { year: local.year, month: local.month, day: timing.dayOfMonth, hour: timing.hour }
  if (!attempted && !ahead) {
    // Due now: the next tick starts it.
    return { year: local.year, month: local.month, day: local.day, hour: local.hour }
  }
  const month = local.month === 12 ? 1 : local.month + 1
  const year = local.month === 12 ? local.year + 1 : local.year
  return { year, month, day: timing.dayOfMonth, hour: timing.hour }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "1 Oct, 02:00" for a slot from {@link nextScheduledRun}. */
export function formatSlot(slot: { readonly month: number; readonly day: number; readonly hour: number }): string {
  return `${slot.day} ${MONTHS[slot.month - 1]}, ${String(slot.hour).padStart(2, "0")}:00`
}

/** "1st", "2nd", "3rd", "4th" … "28th", for "on the 1st of each month". */
export function ordinalDay(day: number): string {
  const tens = day % 100
  if (tens >= 11 && tens <= 13) return `${day}th`
  return `${day}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th"}`
}
