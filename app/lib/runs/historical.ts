import "server-only"

import { sql } from "drizzle-orm"

import { getDb } from "@/lib/db"

/**
 * The candidate query for the historical-trend block (Requirements 18.4, 18.5, 18.6).
 *
 * Returns up to 200 prior runs for the same template row and subscription, each
 * joined to its **latest** verification via a `LEFT JOIN LATERAL`.
 *
 * ## Why `tv.template_id`, not `r.template_version_id`
 *
 * A template version is immutable: editing a template creates a new version. Keying
 * on the identical version id would **empty every trend on the next template edit**.
 * The cost — two points may have been compiled from different definitions — is what
 * the eligibility filters in `compile/historical.py` catch wherever that difference
 * reaches a plotted value (criteria 18.13, 18.14).
 *
 * ## Why `LIMIT 200`, not `LIMIT $lookback`
 *
 * The eligibility filters run **after** the bound, so bounding at the lookback would
 * let an ineligible newer run displace an eligible older one. 200 with
 * `lookback <= 24` leaves room for 176 ineligible candidates. Residual: a template
 * with more than 200 prior runs against one subscription of which at least 177 of
 * the newest 200 are ineligible loses an eligible run to the bound — sixteen years
 * at one run per month, seven months at one run per day.
 *
 * ## Why `LEFT JOIN LATERAL … ORDER BY rv.created_at DESC, rv.id DESC LIMIT 1`
 *
 * `report_verifications` deliberately carries no `UNIQUE (run_id)` because a
 * re-verification appends. "The latest" is criterion 18.6's tie-break expressed
 * in the query rather than re-derived in the selector.
 */

// ---------------------------------------------------------------------------

/**
 * One candidate row from the query.
 *
 * `verificationId` through `verificationSnapshotSha256` are `null` when the run
 * carries no verification row — which is the `LEFT JOIN` doing its job: a run
 * with no verification is a candidate the selector will exclude as
 * `verification_not_passed`.
 */
export interface HistoricalCandidate {
  readonly id: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly timezone: string
  readonly status: string
  readonly verificationId: string | null
  readonly verificationStatus: string | null
  readonly verificationCreatedAt: string | null
  readonly verificationSnapshotSha256: string | null
}

/**
 * Fetch historical-trend candidates for a generating run.
 *
 * @param userId           — the owner (row-level isolation)
 * @param templateId       — the template **row** id (any version of that template)
 * @param subscriptionId   — the connected subscription
 * @param excludeRunId     — the run being compiled (excluded from its own trend)
 * @param periodEndBefore  — the compiling period's start date (ISO `YYYY-MM-DD`);
 *                           only runs whose period ended strictly before are eligible
 */
export async function fetchHistoricalCandidates(
  userId: string,
  templateId: string,
  subscriptionId: string,
  excludeRunId: string,
  periodEndBefore: string
): Promise<readonly HistoricalCandidate[]> {
  const result = await getDb().execute<{
    id: string
    period_start: string
    period_end: string
    timezone: string
    status: string
    verification_id: string | null
    verification_status: string | null
    verification_created_at: string | null
    verification_snapshot_sha256: string | null
  }>(sql`
    SELECT r.id,
           r.period_start,
           r.period_end,
           r.timezone,
           r.status,
           v.id                AS verification_id,
           v.status            AS verification_status,
           v.created_at        AS verification_created_at,
           v.snapshot_sha256   AS verification_snapshot_sha256
      FROM report_runs r
      JOIN report_template_versions tv ON tv.id = r.template_version_id
      LEFT JOIN LATERAL (
            SELECT rv.id, rv.status, rv.created_at, rv.snapshot_sha256
              FROM report_verifications rv
             WHERE rv.run_id = r.id
             ORDER BY rv.created_at DESC, rv.id DESC
             LIMIT 1
      ) v ON TRUE
     WHERE r.user_id = ${userId}
       AND tv.template_id = ${templateId}
       AND r.connected_subscription_id = ${subscriptionId}
       AND r.id <> ${excludeRunId}
       AND r.period_end < ${periodEndBefore}
     ORDER BY r.period_end DESC, v.created_at DESC, r.id DESC
     LIMIT 200
  `)

  return result.rows.map((row) => ({
    id: row.id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    timezone: row.timezone,
    status: row.status,
    verificationId: row.verification_id,
    verificationStatus: row.verification_status,
    verificationCreatedAt: row.verification_created_at,
    verificationSnapshotSha256: row.verification_snapshot_sha256,
  }))
}
