import "server-only"

import { eq, inArray } from "drizzle-orm"

import { getS3Client } from "@/lib/aws/s3"
import { getDb } from "@/lib/db"
import {
  reportTemplates,
  reportTemplateVersions,
  reportVerifications,
} from "@/lib/db/schema"
import { requireEnv } from "@/lib/env"
import type { ReportRun } from "@/lib/db/schema"
import type { RunViewExtras } from "@/lib/db/views"
import { latestForRun } from "@/lib/verifications/store"

import { GetObjectCommand } from "@aws-sdk/client-s3"

/**
 * The three fields `NO_RUN_VIEW_EXTRAS` stood in for, and the emitted
 * document a report's reading view renders (Requirements 9.9, 37.1, 38.1).
 *
 * That constant existed because no caller could resolve any of the three:
 * `template_version_id` was null until task 13.1 and nothing reached `verifying`
 * until 11.5. Both landed, so this is the join its docstring said would replace
 * it — at one call site, as a visible diff, rather than several structurally
 * identical `null` literals nobody notices.
 */

/**
 * The **pinned** version's name and number, and the latest verification's status.
 *
 * Requirement 9.9 requires the pinned version number "even when a
 * higher-numbered version of that template exists", which is why this reads
 * through `template_version_id` rather than through the template's
 * `current_version_id`. An archived report presented against a newer version
 * than it was rendered from would be a report whose stated provenance is wrong.
 */
export async function resolveRunExtras(run: ReportRun): Promise<RunViewExtras> {
  const [pinned, verification] = await Promise.all([
    run.templateVersionId === null
      ? Promise.resolve(null)
      : readPinnedVersion(run.templateVersionId),
    latestForRun(run.id),
  ])

  return {
    templateName: pinned?.templateName ?? null,
    templateVersion: pinned?.version ?? null,
    // Requirement 39.9 — the stored row, never a received event. A run with no
    // verification carries `null`, which the panel presents as "not verified"
    // rather than as a failure.
    verificationStatus: verification.latest?.status ?? null,
  }
}

export type PinnedVersion = {
  readonly templateName: string
  readonly version: number
  readonly definitionSha256: string
}

/**
 * One version row plus its template's name, by version id.
 *
 * **Not scoped by `user_id`**, and that is safe here for a specific reason
 * rather than by oversight: the only caller passes `run.templateVersionId` off a
 * `report_runs` row it read *with* the `AND user_id` predicate. A version a run
 * pinned is a version that run's owner owned at pin time, and re-deriving
 * ownership from the version would be a weaker check than the one already
 * performed — the same reasoning `getSnapshotJson` records for its own key.
 */
async function readPinnedVersion(
  templateVersionId: string
): Promise<PinnedVersion | null> {
  const [row] = await getDb()
    .select({
      templateName: reportTemplates.name,
      version: reportTemplateVersions.version,
      definitionSha256: reportTemplateVersions.definitionSha256,
    })
    .from(reportTemplateVersions)
    .innerJoin(
      reportTemplates,
      eq(reportTemplateVersions.templateId, reportTemplates.id)
    )
    .where(eq(reportTemplateVersions.id, templateVersionId))
    .limit(1)

  return row ?? null
}

export { readPinnedVersion }

/**
 * The emitted paper rendering for a completed run, or `null`.
 *
 * `reports/<runId>/document.html`, written by the pipeline from the same AST the
 * `.docx` came from (Requirement 38.1). Returns `null` rather than throwing for
 * every failure — an absent object, an unreadable one, a run that predates the
 * artifact — because a report whose reading view is unavailable is still a
 * report: its digests, its gaps, its verification and its `.pdf` are all
 * unaffected, and failing the page over the reading view would turn a cosmetic
 * absence into an apparent run failure.
 *
 * The same reasoning `loadRunGaps` records, and the same shape.
 */
export async function loadRunDocumentHtml(
  run: ReportRun
): Promise<string | null> {
  if (run.status !== "completed") return null

  try {
    const response = await getS3Client().send(
      new GetObjectCommand({
        Bucket: requireEnv("RPT_ARTIFACT_BUCKET"),
        Key: `${run.userId}/reports/${run.id}/document.html`,
      })
    )

    const body = await response.Body?.transformToString("utf-8")

    return body === undefined || body === "" ? null : body
  } catch {
    return null
  }
}

/**
 * {@link resolveRunExtras} for a list, in two queries rather than two per row.
 *
 * A page of fifty runs against a handful of templates is fifty rows and maybe
 * five distinct pinned versions, so the per-row version read is almost entirely
 * repeats — and the verification read is one statement over a run id set rather
 * than fifty. The single-row function stays for the detail page, where there is
 * one row and a join would be ceremony.
 *
 * Ordering is the caller's: the returned map is keyed by run id, so a caller
 * zips it against its own list rather than trusting two orderings to agree.
 */
export async function resolveRunExtrasBatch(
  runs: readonly ReportRun[]
): Promise<ReadonlyMap<string, RunViewExtras>> {
  const extras = new Map<string, RunViewExtras>()
  if (runs.length === 0) return extras

  const versionIds = [
    ...new Set(
      runs
        .map((run) => run.templateVersionId)
        .filter((id): id is string => id !== null)
    ),
  ]

  const [versionRows, verificationRows] = await Promise.all([
    versionIds.length === 0
      ? Promise.resolve([])
      : getDb()
          .select({
            id: reportTemplateVersions.id,
            templateName: reportTemplates.name,
            version: reportTemplateVersions.version,
          })
          .from(reportTemplateVersions)
          .innerJoin(
            reportTemplates,
            eq(reportTemplateVersions.templateId, reportTemplates.id)
          )
          .where(inArray(reportTemplateVersions.id, versionIds)),

    getDb()
      .select({
        runId: reportVerifications.runId,
        status: reportVerifications.status,
        createdAt: reportVerifications.createdAt,
      })
      .from(reportVerifications)
      .where(inArray(reportVerifications.runId, runs.map((run) => run.id))),
  ])

  const versions = new Map(versionRows.map((row) => [row.id, row]))

  // The **latest** per run. A re-verification appends a row (Requirement 36.1),
  // so a run can carry several and the list must show the most recent — taking
  // whichever the query returned first would show a stale verdict on exactly the
  // runs somebody re-verified because they doubted the first one.
  const latest = new Map<string, { status: string; createdAt: Date }>()
  for (const row of verificationRows) {
    const held = latest.get(row.runId)
    if (held === undefined || row.createdAt > held.createdAt) {
      latest.set(row.runId, { status: row.status, createdAt: row.createdAt })
    }
  }

  for (const run of runs) {
    const pinned =
      run.templateVersionId === null
        ? undefined
        : versions.get(run.templateVersionId)

    extras.set(run.id, {
      templateName: pinned?.templateName ?? null,
      templateVersion: pinned?.version ?? null,
      verificationStatus:
        (latest.get(run.id)?.status as RunViewExtras["verificationStatus"]) ??
        null,
    })
  }

  return extras
}
