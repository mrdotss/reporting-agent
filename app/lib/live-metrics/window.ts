/**
 * The window a live metrics pull collects (ask-chat Req 8.3).
 *
 * Whole local days in the report timezone, because the collector resolves a half-open
 * window from local dates exactly as a report run does. Bounded by Azure Monitor's 93-day
 * retention for platform metrics, and ending no later than today, since a pull over days
 * that have not happened measures nothing.
 *
 * Pure and secret-free, so deliberately not `server-only`: the attach dialog computes the
 * presets with the same functions the route validates with.
 */

export const LIVE_TIMEZONE = "Asia/Jakarta"
export const RETENTION_DAYS = 93
export const MAX_LIVE_RESOURCES = 20

export type LivePreset = "yesterday" | "last_7_days" | "month_to_date"

export type LiveWindow = { readonly start: string; readonly end: string }

export const PRESET_LABEL: Readonly<Record<LivePreset, string>> = {
  yesterday: "Yesterday",
  last_7_days: "Last 7 days",
  month_to_date: "Month to date",
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

/** Today's local date, `YYYY-MM-DD`, in {@link LIVE_TIMEZONE}. */
export function localToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: LIVE_TIMEZONE }).format(now)
}

function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS)
}

export function presetWindow(preset: LivePreset, now: Date = new Date()): LiveWindow {
  const today = localToday(now)
  switch (preset) {
    case "yesterday": {
      const day = shift(today, -1)
      return { start: day, end: day }
    }
    case "last_7_days":
      return { start: shift(today, -7), end: shift(today, -1) }
    case "month_to_date":
      // The 1st's own collection would be an empty day, so "month to date" on the 1st is today.
      return today.endsWith("-01")
        ? { start: today, end: today }
        : { start: `${today.slice(0, 8)}01`, end: shift(today, -1) }
  }
}

/** Why a window cannot be collected, or `null` when it can. */
export function windowProblem(window: LiveWindow, now: Date = new Date()): string | null {
  if (!DATE.test(window.start) || !DATE.test(window.end)) {
    return "Choose a start and an end date."
  }
  if (Number.isNaN(Date.parse(`${window.start}T00:00:00Z`)) || Number.isNaN(Date.parse(`${window.end}T00:00:00Z`))) {
    return "Choose a start and an end date."
  }
  const today = localToday(now)
  if (window.start > window.end) return "The start date is after the end date."
  if (window.end > today) return "The window can't end after today."
  if (daysBetween(window.start, today) > RETENTION_DAYS - 1) {
    return `Azure keeps platform metrics for ${RETENTION_DAYS} days, so the window must start on or after ${shift(today, -(RETENTION_DAYS - 1))}.`
  }
  return null
}

/** `1–7 Sep 2026`, `15 Sep 2026`, or `28 Aug – 3 Sep 2026`. */
export function windowLabel(window: LiveWindow): string {
  const format = (date: string, parts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...parts }).format(
      new Date(`${date}T00:00:00Z`)
    )
  if (window.start === window.end) {
    return format(window.start, { day: "numeric", month: "short", year: "numeric" })
  }
  const sameMonth = window.start.slice(0, 7) === window.end.slice(0, 7)
  const sameYear = window.start.slice(0, 4) === window.end.slice(0, 4)
  if (sameMonth) {
    return `${Number(window.start.slice(8))}–${format(window.end, { day: "numeric", month: "short", year: "numeric" })}`
  }
  return `${format(window.start, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" })} – ${format(window.end, { day: "numeric", month: "short", year: "numeric" })}`
}
