import type { RunSchedule } from "@/lib/db/schema"
import { formatSlot, nextScheduledRun, ordinalDay, weekdayName, type ScheduleCadence } from "@/lib/schedules/due"

/**
 * A schedule as the browser sees it. Every field is the customer's own configuration;
 * `userId` (who saved it) stays on the server.
 */
export type ScheduleView = {
  readonly id: string
  readonly connectedSubscriptionId: string
  readonly templateId: string
  readonly regions: readonly string[]
  readonly kind: ScheduleCadence
  /** The day of the month for a monthly schedule, `null` for a weekly one. */
  readonly dayOfMonth: number | null
  /** 1 Monday … 7 Sunday for a weekly schedule, `null` for a monthly one. */
  readonly dayOfWeek: number | null
  readonly hour: number
  readonly timezone: string
  readonly enabled: boolean
  /** "on the 1st at 02:00 WIB", or "every Monday at 08:00 WIB" */
  readonly cadence: string
  /** "1 Oct, 02:00" — when the next run starts. */
  readonly next: string
  readonly lastRunId: string | null
  readonly lastError: string | null
  /** Whether each run is emailed to the customer's contacts once it passes verification. */
  readonly autoSend: boolean
  /** Why the last automatic email did not go. */
  readonly lastSendError: string | null
}

export function scheduleCadence(dayOfMonth: number, hour: number): string {
  return `on the ${ordinalDay(dayOfMonth)} at ${String(hour).padStart(2, "0")}:00 WIB`
}

export function weeklyCadence(dayOfWeek: number, hour: number): string {
  return `every ${weekdayName(dayOfWeek)} at ${String(hour).padStart(2, "0")}:00 WIB`
}

/** The cadence text for a stored row, whichever kind it is. */
export function cadenceOf(row: Pick<RunSchedule, "cadence" | "dayOfMonth" | "dayOfWeek" | "hour">): string {
  return row.cadence === "weekly"
    ? weeklyCadence(row.dayOfWeek ?? 1, row.hour)
    : scheduleCadence(row.dayOfMonth ?? 1, row.hour)
}

export function toScheduleView(row: RunSchedule, now: Date): ScheduleView {
  return {
    id: row.id,
    connectedSubscriptionId: row.connectedSubscriptionId,
    templateId: row.templateId,
    regions: row.regions ?? [],
    kind: row.cadence === "weekly" ? "weekly" : "monthly",
    dayOfMonth: row.cadence === "weekly" ? null : row.dayOfMonth,
    dayOfWeek: row.cadence === "weekly" ? row.dayOfWeek : null,
    hour: row.hour,
    timezone: row.timezone,
    enabled: row.enabled,
    cadence: cadenceOf(row),
    next: formatSlot(nextScheduledRun(row, row.lastAttemptMonth, now)),
    lastRunId: row.lastRunId,
    lastError: row.lastError,
    autoSend: row.autoSend,
    lastSendError: row.lastSendError,
  }
}
