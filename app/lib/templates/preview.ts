import "server-only"

import { randomUUID } from "node:crypto"

import { and, desc, eq } from "drizzle-orm"

import { getDb } from "@/lib/db"
import { connectedSubscriptions, reportRuns } from "@/lib/db/schema"

/**
 * Resolving what a real preview renders against (Requirements 14.5, 14.7).
 *
 * ## The one read that decides whether the action is offered at all
 *
 * Requirement 14.5 renders "against the most recent snapshot of a completed run
 * owned by the signed-in user for the selected connected subscription whose
 * `status` is `active`". Every clause is a predicate, and {@link mostRecentSnapshotRun}
 * applies all four in one statement — so a run belonging to somebody else, a run
 * that never completed, and a run against a subscription that has since been
 * disabled all match nothing rather than being read and then filtered.
 *
 * Requirement 14.7 turns an absent answer into a **disabled action carrying the
 * reason**, and explicitly forbids rendering "from fabricated or placeholder
 * data". That is why this returns `null` rather than a sample: a preview built
 * from invented figures is a page a consultant will screenshot, and the numbers
 * on it would be indistinguishable from a real report's.
 */

export type SnapshotRun = {
  readonly runId: string
  readonly snapshotId: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly timezone: string
}

/**
 * The most recent completed run for this user and subscription, or `null`.
 *
 * Ordered by the instant the row last changed rather than by creation — see the
 * comment on the `orderBy` below.
 */
export async function mostRecentSnapshotRun(
  userId: string,
  connectedSubscriptionId: string
): Promise<SnapshotRun | null> {
  const [row] = await getDb()
    .select({
      runId: reportRuns.id,
      snapshotId: reportRuns.snapshotId,
      periodStart: reportRuns.periodStart,
      periodEnd: reportRuns.periodEnd,
      timezone: reportRuns.timezone,
    })
    .from(reportRuns)
    .innerJoin(
      connectedSubscriptions,
      eq(reportRuns.connectedSubscriptionId, connectedSubscriptions.id)
    )
    .where(
      and(
        eq(reportRuns.userId, userId),
        eq(reportRuns.connectedSubscriptionId, connectedSubscriptionId),
        eq(reportRuns.status, "completed"),
        // The subscription's own state, checked here rather than by the caller:
        // Requirement 14.5 names an `active` subscription, and a run whose
        // subscription was disabled since is a run whose credential no longer
        // works — previewing against its snapshot is fine, but offering it under
        // a subscription the consultant can no longer run is misleading.
        eq(connectedSubscriptions.status, "active")
      )
    )
    // `updated_at` rather than `created_at`: two runs enqueued minutes apart can
    // finish in the other order when one collects a much larger scope, and "the
    // most recent snapshot" means the most recently *produced* one. `report_runs`
    // carries no `completed_at`, and `updated_at` is set on every write — so for
    // a terminal row it is the instant it became terminal.
    .orderBy(desc(reportRuns.updatedAt), desc(reportRuns.id))
    .limit(1)

  // A `completed` run with no `snapshot_id` is the snapshot-only path from the
  // foundation spec — it finished without writing one this route could render
  // against. Treated as "no snapshot" rather than as an error, because that is
  // exactly what it is, and Requirement 14.7 already has an answer for it.
  if (row === undefined || row.snapshotId === null) return null

  return {
    runId: row.runId,
    snapshotId: row.snapshotId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    timezone: row.timezone,
  }
}

/** A fresh preview id. Minted per activation, never reused. */
export function newPreviewId(): string {
  return `pv-${randomUUID()}`
}
