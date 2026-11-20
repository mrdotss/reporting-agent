/**
 * When a monthly or weekly schedule is due. **Pure**, and not `server-only`: the run form and the
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
 *
 * A **weekly** schedule works the same way over ISO weeks (Monday to Sunday) in its
 * timezone: it runs once a week on its weekday (1 Monday … 7 Sunday) at its hour, and the
 * claim key is the ISO week, `YYYY-Www`, kept in the same `lastAttemptMonth` column. A
 * Monday 08:00 run of a `last_7d` preset covers the Monday-to-Sunday week just ended.
 */

export const MIN_SCHEDULE_DAY = 1
export const MAX_SCHEDULE_DAY = 28
export const MIN_SCHEDULE_WEEKDAY = 1
export const MAX_SCHEDULE_WEEKDAY = 7
export const SCHEDULE_TIMEZONE = "Asia/Jakarta"
export const SCHEDULE_CADENCES = ["monthly", "weekly"] as const
export type ScheduleCadence = (typeof SCHEDULE_CADENCES)[number]
/** The weekly default: Monday 08:00, so the week just ended is in the inbox at the start of the next. */
export const WEEKLY_DEFAULT = { dayOfWeek: 1, hour: 8 } as const

export type ScheduleTiming = {
  /** Absent reads as monthly, the only cadence before weekly schedules. */
  readonly cadence?: string
  readonly dayOfMonth: number | null
  readonly dayOfWeek?: number | null
  readonly hour: number
  readonly timezone: string
}

type LocalParts = {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  /** 1 Monday … 7 Sunday. */
  readonly weekday: number
}

export type ScheduleSlot = { readonly year: number; readonly month: number; readonly day: number; readonly hour: number }

const isWeekly = (timing: ScheduleTiming): boolean => timing.cadence === "weekly"

const DAY_MS = 86_400_000

/** The civil date `days` after `year-month-day`, through UTC so no timezone shifts it. */
function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const moved = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS)
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() }
}

function weekdayOf(year: number, month: number, day: number): number {
  const sundayFirst = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return sundayFirst === 0 ? 7 : sundayFirst
}

/** The ISO week of a civil date, `YYYY-Www`: the week's Thursday decides its year. */
export function isoWeekKey(year: number, month: number, day: number): string {
  const thursday = addDays(year, month, day, 4 - weekdayOf(year, month, day))
  const firstOfYear = Date.UTC(thursday.year, 0, 1)
  const week = Math.floor((Date.UTC(thursday.year, thursday.month - 1, thursday.day) - firstOfYear) / DAY_MS / 7) + 1
  return `${thursday.year}-W${String(week).padStart(2, "0")}`
}

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
  const [year, month, day] = [get("year"), get("month"), get("day")]
  return { year, month, day, hour: get("hour"), weekday: weekdayOf(year, month, day) }
}

const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`

/** The schedule's current calendar month, `YYYY-MM`, in its own timezone. */
export function scheduleMonth(now: Date, timezone: string): string {
  const { year, month } = localParts(now, timezone)
  return monthKey(year, month)
}

/**
 * The key a tick claims for this schedule at `now`: the local month, `YYYY-MM`, for a
 * monthly schedule, the local ISO week, `YYYY-Www`, for a weekly one.
 */
export function schedulePeriodKey(timing: ScheduleTiming, now: Date): string {
  const local = localParts(now, timing.timezone)
  return isWeekly(timing) ? isoWeekKey(local.year, local.month, local.day) : monthKey(local.year, local.month)
}

function periodKeyOf(timing: ScheduleTiming, local: LocalParts): string {
  return isWeekly(timing) ? isoWeekKey(local.year, local.month, local.day) : monthKey(local.year, local.month)
}

/** Whether `now` is at or past this month's or week's slot. */
function pastSlot(timing: ScheduleTiming, local: LocalParts): boolean {
  const [current, slot] = isWeekly(timing)
    ? [local.weekday, timing.dayOfWeek ?? WEEKLY_DEFAULT.dayOfWeek]
    : [local.day, timing.dayOfMonth ?? MIN_SCHEDULE_DAY]
  return current > slot || (current === slot && local.hour >= timing.hour)
}

/** Whether a tick at `now` should start this schedule's run for the current month or week. */
export function isScheduleDue(
  timing: ScheduleTiming,
  lastAttemptMonth: string | null,
  now: Date
): boolean {
  const local = localParts(now, timing.timezone)
  if (lastAttemptMonth === periodKeyOf(timing, local)) return false
  return pastSlot(timing, local)
}

/**
 * The next local day and hour this schedule runs, as `{ year, month, day, hour }` in its
 * timezone — this period's slot if it has not been attempted and is still ahead, otherwise
 * the next month's or week's.
 */
export function nextScheduledRun(
  timing: ScheduleTiming,
  lastAttemptMonth: string | null,
  now: Date
): ScheduleSlot {
  const local = localParts(now, timing.timezone)
  const attempted = lastAttemptMonth === periodKeyOf(timing, local)
  const ahead = !pastSlot(timing, local)
  if (!attempted && !ahead) {
    // Due now: the next tick starts it.
    return { year: local.year, month: local.month, day: local.day, hour: local.hour }
  }
  if (isWeekly(timing)) {
    const weekday = timing.dayOfWeek ?? WEEKLY_DEFAULT.dayOfWeek
    const offset = weekday - local.weekday + (attempted ? 7 : 0)
    return { ...addDays(local.year, local.month, local.day, offset), hour: timing.hour }
  }
  const day = timing.dayOfMonth ?? MIN_SCHEDULE_DAY
  if (!attempted) return { year: local.year, month: local.month, day, hour: timing.hour }
  const month = local.month === 12 ? 1 : local.month + 1
  const year = local.month === 12 ? local.year + 1 : local.year
  return { year, month, day, hour: timing.hour }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "1 Oct, 02:00" for a slot from {@link nextScheduledRun}. */
export function formatSlot(slot: { readonly month: number; readonly day: number; readonly hour: number }): string {
  return `${slot.day} ${MONTHS[slot.month - 1]}, ${String(slot.hour).padStart(2, "0")}:00`
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

/** "Monday" … "Sunday" for an ISO weekday 1 … 7. */
export function weekdayName(weekday: number): string {
  return WEEKDAYS[weekday - 1] ?? WEEKDAYS[0]
}

/** "1st", "2nd", "3rd", "4th" … "28th", for "on the 1st of each month". */
export function ordinalDay(day: number): string {
  const tens = day % 100
  if (tens >= 11 && tens <= 13) return `${day}th`
  return `${day}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th"}`
}
