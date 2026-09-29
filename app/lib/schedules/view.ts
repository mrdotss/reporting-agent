import type { RunSchedule } from "@/lib/db/schema"
import { formatSlot, nextScheduledRun, ordinalDay } from "@/lib/schedules/due"

/**
 * A schedule as the browser sees it. Every field is the customer's own configuration;
 * `userId` (who saved it) stays on the server.
 */
export type ScheduleView = {
  readonly id: string
  readonly connectedSubscriptionId: string
  readonly templateId: string
  readonly regions: readonly string[]
  readonly dayOfMonth: number
  readonly hour: number
  readonly timezone: string
  readonly enabled: boolean
  /** "on the 1st at 02:00 WIB" */
  readonly cadence: string
  /** "1 Oct, 02:00" — when the next run starts. */
  readonly next: string
  readonly lastRunId: string | null
  readonly lastError: string | null
}

export function scheduleCadence(dayOfMonth: number, hour: number): string {
  return `on the ${ordinalDay(dayOfMonth)} at ${String(hour).padStart(2, "0")}:00 WIB`
}

export function toScheduleView(row: RunSchedule, now: Date): ScheduleView {
  return {
    id: row.id,
    connectedSubscriptionId: row.connectedSubscriptionId,
    templateId: row.templateId,
    regions: row.regions ?? [],
    dayOfMonth: row.dayOfMonth,
    hour: row.hour,
    timezone: row.timezone,
    enabled: row.enabled,
    cadence: scheduleCadence(row.dayOfMonth, row.hour),
    next: formatSlot(nextScheduledRun(row, row.lastAttemptMonth, now)),
    lastRunId: row.lastRunId,
    lastError: row.lastError,
  }
}
