import "server-only"

import { randomUUID } from "node:crypto"

import { and, desc, eq, isNotNull, isNull, ne, or } from "drizzle-orm"

import { EnqueueRejectedError, enqueueRun } from "@/lib/actions/runs"
import { DeliveryInputError, approveAndSend } from "@/lib/delivery/store"
import type { sendMail } from "@/lib/mail/mailtrap"
import { getDb } from "@/lib/db"
import {
  connectedSubscriptions,
  reportDeliveries,
  reportRuns,
  reportTemplates,
  reportVerifications,
  runSchedules,
  type RunSchedule,
} from "@/lib/db/schema"
import { normalizeRegions } from "@/lib/runs/regions"
import { SCHEDULE_TIMEZONE, isScheduleDue, schedulePeriodKey, type ScheduleCadence } from "@/lib/schedules/due"
import { toScheduleView, type ScheduleView } from "@/lib/schedules/view"
import { WorkspaceAccessError, accessWhere, requireProject } from "@/lib/workspaces/access"

/**
 * Schedules: at most one monthly and one weekly per customer, saved from the run form,
 * started by the cron tick.
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
  readonly hour: number
  /** Email each run to the customer's contacts once it passes verification. */
  readonly autoSend?: boolean
} & (
    | { readonly cadence?: "monthly"; readonly dayOfMonth: number }
    | { readonly cadence: "weekly"; readonly dayOfWeek: number }
  )

const scopeWhere = (scope: ScheduleScope, cadence?: ScheduleCadence) =>
  and(
    eq(runSchedules.workspaceId, scope.workspaceId),
    eq(runSchedules.projectId, scope.projectId),
    cadence === undefined ? undefined : eq(runSchedules.cadence, cadence)
  )

/** This customer's schedules, monthly first, for a member who can read the customer. */
export async function readSchedules(userId: string, scope: ScheduleScope, now: Date = new Date()): Promise<readonly ScheduleView[]> {
  await requireProject(userId, scope, "read")
  const rows = await getDb().select().from(runSchedules).where(scopeWhere(scope))
  return rows
    .sort((a, b) => (a.cadence === b.cadence ? 0 : a.cadence === "monthly" ? -1 : 1))
    .map((row) => toScheduleView(row, now))
}

/** This customer's schedule of one cadence (monthly unless named). */
export async function readSchedule(
  userId: string,
  scope: ScheduleScope,
  now: Date = new Date(),
  cadence: ScheduleCadence = "monthly"
): Promise<ScheduleView | null> {
  return (await readSchedules(userId, scope, now)).find((view) => view.kind === cadence) ?? null
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

  const cadence: ScheduleCadence = input.cadence === "weekly" ? "weekly" : "monthly"
  const dayOfMonth = input.cadence === "weekly" ? null : input.dayOfMonth
  const dayOfWeek = input.cadence === "weekly" ? input.dayOfWeek : null
  const timing = { cadence, dayOfMonth, dayOfWeek, hour: input.hour, timezone: SCHEDULE_TIMEZONE }
  // Already due this month or week means the slot has passed: start with the next one.
  const lastAttemptMonth = isScheduleDue(timing, null, now) ? schedulePeriodKey(timing, now) : null
  const regions = normalizeRegions(input.regions)
  const values = {
    userId,
    connectedSubscriptionId: input.connectedSubscriptionId,
    templateId: input.templateId,
    regions: regions.length > 0 ? regions : null,
    cadence,
    dayOfMonth,
    dayOfWeek,
    hour: input.hour,
    timezone: SCHEDULE_TIMEZONE,
    enabled: true,
    autoSend: input.autoSend === true,
    lastAttemptMonth,
    lastError: null,
    lastSendError: null,
    updatedAt: now,
  }

  const [row] = await db
    .insert(runSchedules)
    .values({ id: randomUUID(), workspaceId: scope.workspaceId, projectId: scope.projectId, createdAt: now, ...values })
    .onConflictDoUpdate({ target: [runSchedules.projectId, runSchedules.cadence], set: values })
    .returning()
  return toScheduleView(row as RunSchedule, now)
}

/**
 * Stop this customer's schedule of one cadence (monthly unless named). Needs edit on the
 * customer; stopping none is not an error.
 */
export async function deleteSchedule(userId: string, scope: ScheduleScope, cadence: ScheduleCadence = "monthly"): Promise<void> {
  await requireProject(userId, scope, "edit")
  await getDb().delete(runSchedules).where(scopeWhere(scope, cadence))
}

export type ScheduleAttempt =
  | { readonly scheduleId: string; readonly runId: string; readonly deduplicated: boolean }
  | { readonly scheduleId: string; readonly error: string }

/**
 * Start every schedule due at `now`. Called by the cron tick, before it claims work, so a
 * run enqueued here is claimed in the same tick.
 *
 * Each due row is **claimed** for its month or week by a conditional update before it is enqueued,
 * so two ticks that both see it due start it once. An attempt that is rejected keeps its
 * reason and is not retried: the Close Board shows it and the consultant requests the run.
 */
export async function startDueSchedules(now: Date = new Date()): Promise<readonly ScheduleAttempt[]> {
  const db = getDb()
  const candidates = await db.select().from(runSchedules).where(eq(runSchedules.enabled, true))
  const attempts: ScheduleAttempt[] = []

  for (const schedule of candidates) {
    if (!isScheduleDue(schedule, schedule.lastAttemptMonth, now)) continue
    const month = schedulePeriodKey(schedule, now)
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


export type SendAttempt =
  | { readonly scheduleId: string; readonly runId: string; readonly status: "sent" | "partial" | "failed" }
  | { readonly scheduleId: string; readonly runId: string; readonly error: string }

/**
 * Email every scheduled run that has passed verification, for schedules that send on their
 * own. Called by the cron tick after {@link startDueSchedules}.
 *
 * It is the same approve-and-send a member presses on the report page, approved as the
 * member who saved the schedule, so it needs that member to still manage the customer and
 * the customer to have contacts. A run still collecting is left for a later tick; a run
 * that failed or did not verify is never sent. Each run is **claimed** before it is sent
 * (`lastSentRunId`), so two ticks send it once, and a run already sent by hand is not sent
 * again. A refusal is kept on the row for the run form and not retried.
 */
export async function sendScheduledReports(
  now: Date = new Date(),
  { send }: { send?: typeof sendMail } = {}
): Promise<readonly SendAttempt[]> {
  const db = getDb()
  const candidates = await db
    .select()
    .from(runSchedules)
    .where(
      and(
        eq(runSchedules.enabled, true),
        eq(runSchedules.autoSend, true),
        isNotNull(runSchedules.lastRunId),
        or(isNull(runSchedules.lastSentRunId), ne(runSchedules.lastSentRunId, runSchedules.lastRunId))
      )
    )
  const attempts: SendAttempt[] = []

  for (const schedule of candidates) {
    const runId = schedule.lastRunId as string
    const [run] = await db.select({ status: reportRuns.status }).from(reportRuns).where(eq(reportRuns.id, runId)).limit(1)
    if (run === undefined) continue
    const [verification] = await db
      .select({ status: reportVerifications.status })
      .from(reportVerifications)
      .where(eq(reportVerifications.runId, runId))
      .orderBy(desc(reportVerifications.createdAt))
      .limit(1)
    const finished = run.status === "completed" && verification?.status === "pass"
    const ended = run.status === "completed" || run.status === "failed"
    if (!ended) continue

    const claimed = await db
      .update(runSchedules)
      .set({ lastSentRunId: runId, updatedAt: now })
      .where(
        and(
          eq(runSchedules.id, schedule.id),
          eq(runSchedules.lastRunId, runId),
          or(isNull(runSchedules.lastSentRunId), ne(runSchedules.lastSentRunId, runId))
        )
      )
      .returning({ id: runSchedules.id })
    if (claimed.length === 0 || !finished) continue

    const [sent] = await db.select({ id: reportDeliveries.id }).from(reportDeliveries).where(eq(reportDeliveries.runId, runId)).limit(1)
    if (sent !== undefined) continue

    try {
      const delivery = await approveAndSend(schedule.userId, runId, send === undefined ? { now } : { now, send })
      await db
        .update(runSchedules)
        .set({ lastSendError: delivery.status === "failed" ? "The email could not be sent to any contact." : null })
        .where(eq(runSchedules.id, schedule.id))
      attempts.push({ scheduleId: schedule.id, runId, status: delivery.status })
    } catch (thrown) {
      const known = thrown instanceof DeliveryInputError || thrown instanceof WorkspaceAccessError
      const error = known
        ? thrown instanceof WorkspaceAccessError
          ? "The member who saved this schedule can no longer send reports for this customer."
          : thrown.message
        : "The report could not be emailed. Send it from the report page."
      if (!known) {
        console.error(
          `[schedules] schedule ${schedule.id} failed to send run ${runId}: ` +
            `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
        )
      }
      await db.update(runSchedules).set({ lastSendError: error }).where(eq(runSchedules.id, schedule.id))
      attempts.push({ scheduleId: schedule.id, runId, error })
    }
  }
  return attempts
}
