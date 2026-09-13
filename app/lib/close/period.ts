/**
 * The close: which month is being reported on right now, and when it is due.
 *
 * A consultant's month runs on one rule. On the 1st, the previous month becomes the
 * open period, and every customer's report for it has to be delivered by the
 * workspace's close day. The close board, the sidebar's period chip and the "Not
 * requested" state all read from this one function so they cannot disagree.
 *
 * Pure: it takes the instant, the close day and the timezone, and does no I/O. Dates
 * are local calendar dates in `timeZone`, never UTC days, so a close in Asia/Jakarta
 * does not flip a day early at 17:00 the evening before.
 */

/** The last close day a workspace may choose. Every month has a 28th. */
export const MAX_CLOSE_DAY = 28

export const DEFAULT_CLOSE_DAY = 15

export type ClosePeriod = Readonly<{
  /** `YYYY-MM`, the month being reported on. */
  month: string
  /** First and last local date of that month, `YYYY-MM-DD`. */
  start: string
  end: string
  /** The local date the close is due, `YYYY-MM-DD`, in the month after `month`. */
  due: string
  /** Today's local date, `YYYY-MM-DD`. */
  today: string
  /** Whole local days from today to the due date. Negative once the close has passed. */
  daysLeft: number
  /** One entry per day from the 1st to the close day, for the period chip. */
  ticks: readonly CloseTick[]
}>

export type CloseTick = "past" | "today" | "due" | "ahead"

/** The local calendar date of `instant` in `timeZone`. */
export function localDate(
  instant: Date,
  timeZone: string
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant)
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value)
  return { year: value("year"), month: value("month"), day: value("day") }
}

const pad = (n: number) => String(n).padStart(2, "0")

const iso = (year: number, month: number, day: number) =>
  `${year}-${pad(month)}-${pad(day)}`

/** Days in a 1-based month. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Whole days between two calendar dates, ignoring any clock. */
function dayDifference(
  from: { year: number; month: number; day: number },
  to: { year: number; month: number; day: number }
): number {
  const a = Date.UTC(from.year, from.month - 1, from.day)
  const b = Date.UTC(to.year, to.month - 1, to.day)
  return Math.round((b - a) / 86_400_000)
}

/** Clamps a stored close day into the range every month can honour. */
export function normalizeCloseDay(closeDay: number): number {
  if (!Number.isInteger(closeDay)) return DEFAULT_CLOSE_DAY
  return Math.min(MAX_CLOSE_DAY, Math.max(1, closeDay))
}

export function closePeriod(
  instant: Date,
  closeDay: number,
  timeZone: string
): ClosePeriod {
  const day = normalizeCloseDay(closeDay)
  const today = localDate(instant, timeZone)

  // The open period is always the previous full month. The close that is due this
  // month is for last month's usage — including after the close day has passed, when
  // the board keeps showing what is overdue rather than jumping ahead to a month that
  // cannot be reported on yet.
  const periodYear = today.month === 1 ? today.year - 1 : today.year
  const periodMonth = today.month === 1 ? 12 : today.month - 1

  const due = { year: today.year, month: today.month, day }

  const ticks: CloseTick[] = []
  for (let d = 1; d <= day; d += 1) {
    if (d === today.day && d !== day) ticks.push("today")
    else if (d === day) ticks.push(d === today.day ? "today" : "due")
    else ticks.push(d < today.day ? "past" : "ahead")
  }

  return {
    month: `${periodYear}-${pad(periodMonth)}`,
    start: iso(periodYear, periodMonth, 1),
    end: iso(periodYear, periodMonth, daysInMonth(periodYear, periodMonth)),
    due: iso(due.year, due.month, due.day),
    today: iso(today.year, today.month, today.day),
    daysLeft: dayDifference(today, due),
    ticks,
  }
}

/** `YYYY-MM` for the `count` months ending at `month`, oldest first. */
export function trailingMonths(month: string, count: number): string[] {
  const [year, m] = month.split("-").map(Number)
  const months: string[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const index = year * 12 + (m - 1) - offset
    months.push(`${Math.floor(index / 12)}-${pad((index % 12) + 1)}`)
  }
  return months
}

/** "August 2026" for `2026-08`, in English. */
export function monthName(month: string, style: "long" | "short" = "long"): string {
  const [year, m] = month.split("-").map(Number)
  const label = new Intl.DateTimeFormat("en-GB", {
    month: style,
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, m - 1, 1)))
  return style === "long" ? `${label} ${year}` : label
}
