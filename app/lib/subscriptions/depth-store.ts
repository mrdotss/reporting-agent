import "server-only"

import { and, desc, eq, isNull } from "drizzle-orm"

import { getDb } from "@/lib/db"
import { reportRuns, type ReportRun } from "@/lib/db/schema"
import { readRunGapList } from "@/lib/runs/gaps"
import type { DepthGap } from "@/lib/subscriptions/depth"
import { accessWhere } from "@/lib/workspaces/access"

export type DepthEvidence = {
  /** The latest completed run's gaps, or `null` when there is no such run or its snapshot could not be read. */
  readonly gaps: readonly DepthGap[] | null
  /** The run the gaps were read from, so the panel can link to it. */
  readonly runId: string | null
  readonly periodStart: string | null
}

/**
 * The gaps the data-depth coach reads: the latest completed run on this connector that
 * collected its own snapshot. A run that reused another's snapshot is skipped, because
 * its gaps are that other run's, from an older collection.
 */
export async function readDepthEvidence(
  userId: string,
  connectedSubscriptionId: string
): Promise<DepthEvidence> {
  const rows = await getDb()
    .select()
    .from(reportRuns)
    .where(
      and(
        accessWhere(reportRuns, userId),
        eq(reportRuns.connectedSubscriptionId, connectedSubscriptionId),
        eq(reportRuns.status, "completed"),
        isNull(reportRuns.reuseSnapshotRunId)
      )
    )
    .orderBy(desc(reportRuns.createdAt))
    .limit(1)

  const run = rows[0] as ReportRun | undefined
  if (run === undefined) return { gaps: null, runId: null, periodStart: null }

  const gaps = await readRunGapList(run)
  return {
    gaps: gaps === null ? null : gaps.map((gap) => ({ gapType: gap.gapType, resourceId: gap.resourceId })),
    runId: gaps === null ? null : run.id,
    periodStart: gaps === null ? null : run.periodStart,
  }
}
