import "server-only"

import { randomUUID } from "node:crypto"

import { and, eq, isNull, ne, or } from "drizzle-orm"

import { EnqueueRejectedError, enqueueRun } from "@/lib/actions/runs"
import { getDb } from "@/lib/db"
import {
  connectedSubscriptions,
  reportTemplates,
  runSchedules,
  type RunSchedule,
} from "@/lib/db/schema"
import { normalizeRegions } from "@/lib/runs/regions"
import { SCHEDULE_TIMEZONE, isScheduleDue, scheduleMonth } from "@/lib/schedules/due"
import { toScheduleView, type ScheduleView } from "@/lib/schedules/view"
import { WorkspaceAccessError, accessWhere, requireProject } from "@/lib/workspaces/access"

/**
 * Monthly schedules: one per customer, saved from the run form, started by the cron tick.
 *
 * A schedule holds no authority of its own. The tick enqueues it through `enqueueRun` as
 * the member who saved it, so a schedule whose member lost edit access, or whose connector
 * stopped verifying, fails to start with the same rejection a request by hand would get —
 * and that reason is kept on the row for the Close Board.
 */

export type ScheduleScope = { readonly workspaceId: string; readonly projectId: string }

export type SaveScheduleInput = ScheduleScope & {
  readonly connectedSubscriptionId: string
  readonly templateId: string
  readonly regions?: readonly string[]
  readonly dayOfMonth: number
  readonly hour: number
}

/** This customer's schedule, for a member who can read the customer. */
export async function readSchedule(userId: string, scope: ScheduleScope, now: Date = new Date()): Promise<ScheduleView | null> {
  await requireProject(userId, scope, "read")
  const [row] = await getDb()
    .select()
    .from(runSchedules)
    .where(and(eq(runSchedules.workspaceId, scope.workspaceId), eq(runSchedules.projectId, scope.projectId)))
    .limit(1)
  return row === undefined ? null : toScheduleView(row, now)
}

/**
 * Create or replace this customer's schedule. Needs edit on the customer, and a connector
 * and a preset that belong to it. The first run is the next slot still ahead: saving on the
 * 15th a schedule for the 1st starts next month, not a minute from now.
 */
export async function saveSchedule(userId: string, input: SaveScheduleInput, now: Date = new Date()): Promise<ScheduleView> {
  const scope = { workspaceId: input.workspaceId, projectId: input.projectId }
  await requireProject(userId, scope, "edit")

  const db = getDb()
  const [connector] = await db
    .select({ id: connectedSubscriptions.id })
    .from(connectedSubscriptions)
    .where(and(eq(connectedSubscriptions.id, input.connectedSubscriptionId), accessWhere(connectedSubscriptions, userId, "edit", scope)))
    .limit(1)
  const [template] = await db
    .select({ id: reportTemplates.id })
    .from(reportTemplates)
    .where(and(eq(reportTemplates.id, input.templateId), accessWhere(reportTemplates, userId, "edit", scope)))
    .limit(1)
  if (connector === undefined || template === undefined) throw new WorkspaceAccessError()

  const timing = { dayOfMonth: input.dayOfMonth, hour: input.hour, timezone: SCHEDULE_TIMEZONE }
  const month = scheduleMonth(now, SCHEDULE_TIMEZONE)
  // Already due this month means the slot has passed: start with next month's.
  const lastAttemptMonth = isScheduleDue(timing, null, now) ? month : null
  const regions = normalizeRegions(input.regions)
  const values = {
    userId,
    connectedSubscriptionId: input.connectedSubscriptionId,
    templateId: input.templateId,
    regions: regions.length > 0 ? regions : null,
    dayOfMonth: input.dayOfMonth,
    hour: input.hour,
    timezone: SCHEDULE_TIMEZONE,
    enabled: true,
    lastAttemptMonth,
    lastError: null,
    updatedAt: now,
  }

  const [row] = await db
    .insert(runSchedules)
    .values({ id: randomUUID(), workspaceId: scope.workspaceId, projectId: scope.projectId, createdAt: now, ...values })
    .onConflictDoUpdate({ target: runSchedules.projectId, set: values })
    .returning()
  return toScheduleView(row as RunSchedule, now)
}

/** Stop this customer's schedule. Needs edit on the customer; stopping none is not an error. */
export async function deleteSchedule(userId: string, scope: ScheduleScope): Promise<void> {
  await requireProject(userId, scope, "edit")
  await getDb()
    .delete(runSchedules)
    .where(and(eq(runSchedules.workspaceId, scope.workspaceId), eq(runSchedules.projectId, scope.projectId)))
}

export type ScheduleAttempt =
  | { readonly scheduleId: string; readonly runId: string; readonly deduplicated: boolean }
  | { readonly scheduleId: string; readonly error: string }

/**
 * Start every schedule due at `now`. Called by the cron tick, before it claims work, so a
 * run enqueued here is claimed in the same tick.
 *
 * Each due row is **claimed** for its month by a conditional update before it is enqueued,
 * so two ticks that both see it due start it once. An attempt that is rejected keeps its
 * reason and is not retried: the Close Board shows it and the consultant requests the run.
 */
export async function startDueSchedules(now: Date = new Date()): Promise<readonly ScheduleAttempt[]> {
  const db = getDb()
  const candidates = await db.select().from(runSchedules).where(eq(runSchedules.enabled, true))
  const attempts: ScheduleAttempt[] = []

  for (const schedule of candidates) {
    if (!isScheduleDue(schedule, schedule.lastAttemptMonth, now)) continue
    const month = scheduleMonth(now, schedule.timezone)
    const claimed = await db
      .update(runSchedules)
      .set({ lastAttemptMonth: month, lastAttemptAt: now, updatedAt: now })
      .where(
        and(
          eq(runSchedules.id, schedule.id),
          or(isNull(runSchedules.lastAttemptMonth), ne(runSchedules.lastAttemptMonth, month))
        )
      )
      .returning({ id: runSchedules.id })
    if (claimed.length === 0) continue

    try {
      const { run, deduplicated } = await enqueueRun(
        schedule.userId,
        {
          workspaceId: schedule.workspaceId,
          projectId: schedule.projectId,
          connectedSubscriptionId: schedule.connectedSubscriptionId,
          templateId: schedule.templateId,
          timezone: schedule.timezone,
          regions: schedule.regions ?? undefined,
        },
        now
      )
      await db.update(runSchedules).set({ lastRunId: run.id, lastError: null }).where(eq(runSchedules.id, schedule.id))
      attempts.push({ scheduleId: schedule.id, runId: run.id, deduplicated })
    } catch (thrown) {
      const error =
        thrown instanceof EnqueueRejectedError || thrown instanceof WorkspaceAccessError
          ? thrown.message
          : "The scheduled run could not be started. Request it from the run form."
      if (!(thrown instanceof EnqueueRejectedError || thrown instanceof WorkspaceAccessError)) {
        console.error(
          `[schedules] schedule ${schedule.id} failed to enqueue: ` +
            `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
        )
      }
      await db.update(runSchedules).set({ lastError: error }).where(eq(runSchedules.id, schedule.id))
      attempts.push({ scheduleId: schedule.id, error })
    }
  }
  return attempts
}

