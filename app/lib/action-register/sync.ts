import "server-only"

import { randomUUID } from "node:crypto"

import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"

import { getSnapshotJson } from "@/lib/aws/s3"
import { getDb } from "@/lib/db"
import { actionItems, type ActionItem, type ReportRun } from "@/lib/db/schema"

/**
 * The Action register's sync: after a verified run completes, fold the findings the runtime
 * stored beside its report (`actions.json`) into the register for that connector.
 *
 * - A finding the register does not hold is added as **open**.
 * - A finding the register holds is seen again: its title and `last_seen_run_id` update,
 *   and one that was **resolved** reopens.
 * - An open, accepted or won't-do item the run **checked and found clear** is **resolved**,
 *   citing the run and its snapshot. The runtime decides "checked" (`compile/actions.py`
 *   `checked_keys` and `advisor_answered`), so the report and the register cannot disagree
 *   about what was resolved. An item this run did not check keeps its status.
 *
 * Never throws: the register is supporting information, and a report that completed must
 * stay completed whatever happens here.
 */

const bundleSchema = z.object({
  schema_version: z.literal(1),
  findings: z
    .array(
      z.object({
        key: z.string().min(1).max(600),
        kind: z.string().min(1).max(40),
        resource_id: z.string().min(1).max(500),
        title: z.string().min(1).max(240),
      })
    )
    .max(5000),
  checked: z.array(z.string().max(600)).max(20000).default([]),
  advisor_answered: z.boolean().default(false),
})

export type ActionsBundle = z.output<typeof bundleSchema>

export function actionsArtifactKey(userId: string, runId: string): string {
  return `${userId}/reports/${runId}/actions.json`
}

/** What a sync decides, before it writes. **Pure**, so the rules are tested without a database. */
export function planSync(
  existing: readonly Pick<ActionItem, "findingKey" | "status">[],
  bundle: ActionsBundle
): { add: ActionsBundle["findings"]; seen: string[]; resolve: string[] } {
  const byKey = new Map(existing.map((item) => [item.findingKey, item]))
  const current = new Set(bundle.findings.map((finding) => finding.key))
  const checked = new Set(bundle.checked)
  return {
    add: bundle.findings.filter((finding) => !byKey.has(finding.key)),
    seen: bundle.findings.filter((finding) => byKey.has(finding.key)).map((finding) => finding.key),
    resolve: existing
      .filter(
        (item) =>
          item.status !== "resolved" &&
          !current.has(item.findingKey) &&
          (checked.has(item.findingKey) || (bundle.advisor_answered && item.findingKey.startsWith("advisor:")))
      )
      .map((item) => item.findingKey),
  }
}

export async function syncActionRegister(run: ReportRun, now: Date = new Date()): Promise<void> {
  const { workspaceId, projectId } = run
  if (workspaceId === null || projectId === null) return
  try {
    const parsed = bundleSchema.safeParse(await getSnapshotJson(actionsArtifactKey(run.userId, run.id)))
    if (!parsed.success) {
      console.error(`[action-register] run ${run.id}: actions.json did not parse; the register is unchanged`)
      return
    }
    const bundle = parsed.data
    const db = getDb()
    await db.transaction(async (tx) => {
      const existing = await tx
        .select({ findingKey: actionItems.findingKey, status: actionItems.status })
        .from(actionItems)
        .where(eq(actionItems.connectedSubscriptionId, run.connectedSubscriptionId))
      const plan = planSync(existing, bundle)
      const titles = new Map(bundle.findings.map((finding) => [finding.key, finding.title]))

      if (plan.add.length > 0) {
        await tx.insert(actionItems).values(
          plan.add.map((finding) => ({
            id: randomUUID(),
            workspaceId,
            projectId,
            connectedSubscriptionId: run.connectedSubscriptionId,
            findingKey: finding.key,
            kind: finding.kind,
            resourceId: finding.resource_id,
            title: finding.title,
            status: "open",
            firstSeenRunId: run.id,
            firstSeenPeriod: run.periodStart,
            lastSeenRunId: run.id,
            createdAt: now,
            updatedAt: now,
          }))
        )
      }
      for (const key of plan.seen) {
        const item = existing.find((entry) => entry.findingKey === key)
        await tx
          .update(actionItems)
          .set({
            title: titles.get(key) ?? key,
            lastSeenRunId: run.id,
            updatedAt: now,
            ...(item?.status === "resolved" ? { status: "open", resolvedRunId: null, resolvedSnapshotId: null } : {}),
          })
          .where(and(eq(actionItems.connectedSubscriptionId, run.connectedSubscriptionId), eq(actionItems.findingKey, key)))
      }
      if (plan.resolve.length > 0) {
        await tx
          .update(actionItems)
          .set({ status: "resolved", resolvedRunId: run.id, resolvedSnapshotId: run.snapshotId, updatedAt: now })
          .where(
            and(
              eq(actionItems.connectedSubscriptionId, run.connectedSubscriptionId),
              inArray(actionItems.findingKey, plan.resolve)
            )
          )
      }
    })
  } catch (thrown) {
    console.error(
      `[action-register] run ${run.id}: the register could not be synced ` +
        `(${thrown instanceof Error ? thrown.name : typeof thrown}); it is unchanged`
    )
  }
}

/**
 * The register's state for a run's invoke payload, as `compile/actions.py` reads it: key,
 * title, owner, status and the month it was first seen.
 */
export async function registerForConnector(
  connectedSubscriptionId: string
): Promise<{ key: string; title: string; owner: string | null; status: string; since: string }[]> {
  const rows = await getDb()
    .select()
    .from(actionItems)
    .where(eq(actionItems.connectedSubscriptionId, connectedSubscriptionId))
  const month = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })
  return rows
    .map((row) => ({
      key: row.findingKey,
      title: row.title,
      owner: row.owner,
      status: row.status,
      since: month.format(new Date(`${row.firstSeenPeriod}T00:00:00Z`)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
}
