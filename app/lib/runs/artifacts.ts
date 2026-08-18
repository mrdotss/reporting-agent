import type { ReportRun } from "@/lib/db/schema"
import { snapshotArtifactKey } from "@/lib/db/views"

/**
 * Every artifact key a run **recorded**, as a set (Requirement 40.5).
 *
 * **Pure, and deliberately not `server-only`.** It derives keys from a row's own
 * fields and reaches nothing.
 *
 * ## Why this exists rather than a shape test
 *
 * Requirement 40.5: a download naming "an artifact key that is not one of the
 * artifact keys recorded on that run's row" resolves as not found, with **no
 * storage call**. A key can be well-formed, carry the right actor prefix, and
 * name a run the caller owns, and still be a key that run never wrote — the
 * caller invented the leaf, or named a chart sidecar, or guessed at a file the
 * pipeline writes for a different run.
 *
 * A shape test cannot tell those apart, because they have the right shape. The
 * recorded set can, and the difference matters: without it this route is a
 * bucket probe for anybody with one valid run, answering "does
 * `alice/reports/<myRun>/anything.json` exist" through the latency of a
 * `GetObject`.
 *
 * ## Derived rather than stored
 *
 * The keys are computed from `userId`, `id` and `status` rather than read from
 * columns, because that is how the pipeline computes them too — `artifacts.py`'s
 * `reports_key(actor_id, run_id, name)`. Two derivations of one template, and
 * they have to agree; a stored list would be a third thing, written at a
 * different moment, able to disagree with both.
 *
 * The leaf names are the ones `write_report_artifacts` writes. Only the two
 * **downloadable** ones are here: the ledger, the AST, the prose and the emitted
 * HTML are written for re-verification and for the in-app reading view, and no
 * `report_file` event names them, so no download control should reach them
 * either.
 */

/** The two artifacts a consultant may download, as `artifacts.py` names them. */
export const DOWNLOADABLE_LEAF_NAMES = ["report.docx", "report.pdf"] as const

export function reportArtifactKey(
  userId: string,
  runId: string,
  leaf: (typeof DOWNLOADABLE_LEAF_NAMES)[number]
): string {
  return `${userId}/reports/${runId}/${leaf}`
}

/**
 * The keys this run recorded, or an empty set.
 *
 * Empty for any status other than `completed`: a run that did not complete wrote
 * no report artifact, so there is nothing it could have recorded — and returning
 * an empty set rather than a speculative one means Requirement 40.4's "present
 * no download control, mint no presigned URL" holds through this function too,
 * without the caller needing a second status check.
 */
export function recordedArtifactKeys(
  run: Pick<ReportRun, "id" | "userId" | "status">
): ReadonlySet<string> {
  if (run.status !== "completed") return new Set()

  return new Set([
    snapshotArtifactKey(run.userId, run.id),
    ...DOWNLOADABLE_LEAF_NAMES.map((leaf) =>
      reportArtifactKey(run.userId, run.id, leaf)
    ),
  ])
}
