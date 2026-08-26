import "server-only"

import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"

import { getDb } from "@/lib/db"
import { reportProfileAuthoredMatches } from "@/lib/db/schema"

/**
 * The write side of `report_profile_authored_matches` (task 3.10, Requirement
 * 9.5).
 *
 * **Not yet called by the publish path.** Wiring this into
 * `publishTemplateVersion` needs a `scanId` — which subscription scan the
 * consultant was looking at while authoring the profile — and there is
 * currently no mechanism anywhere in the wizard that tracks one: templates are
 * subscription-agnostic (`report_templates` carries no subscription
 * reference), and neither `StepSections` (task 3.7) nor the emit estimator
 * (task 3.8) receives a scan today. That is a real, undecided design question
 * (does the wizard gain an explicit scan/subscription picker, or auto-select
 * the most recently completed scan across the user's subscriptions?) rather
 * than an oversight, and it was asked about twice with no answer during this
 * session. This module ships the schema, the upsert semantics, and the
 * projection guard now — all independently correct and independently
 * testable — so the only remaining step, once the scan-source decision is
 * made, is a call to {@link writeAuthoredMatches} from the publish path with a
 * real `scanId` in hand.
 *
 * ## Why an upsert, not a plain insert
 *
 * `insertVersion` (in `lib/templates/store.ts`) may return an **existing**
 * version when the submitted digest equals the current highest version's — a
 * save that changed nothing creates no new version row. Republishing an
 * unchanged definition against a freshly re-scanned estate still needs its
 * authored-matches rows to reflect the CURRENT scan, even though no new
 * version was created to hold them. `unique(template_version_id, section_id)`
 * is the pair the upsert conflicts on for exactly that reason.
 */
export type AuthoredSectionMatch = {
  readonly sectionId: string
  readonly matchedCount: number
  readonly matchedResourceIds: readonly string[]
}

/**
 * Upsert one row per section in `matches`, all against the same
 * `templateVersionId` and `scanId`.
 *
 * Every existing row for `templateVersionId` whose `sectionId` is NOT in
 * `matches` is left untouched rather than deleted — a section removed from the
 * definition between one publish and the next is a definition edit, which
 * creates its own new version with its own fresh row set; this function never
 * reaches across versions to clean up a prior one's rows.
 */
export async function writeAuthoredMatches(
  templateVersionId: string,
  scanId: string,
  matches: readonly AuthoredSectionMatch[]
): Promise<void> {
  if (matches.length === 0) return

  const db = getDb()

  for (const match of matches) {
    await db
      .insert(reportProfileAuthoredMatches)
      .values({
        id: randomUUID(),
        templateVersionId,
        scanId,
        sectionId: match.sectionId,
        matchedCount: match.matchedCount,
        matchedResourceIds: [...match.matchedResourceIds],
      })
      .onConflictDoUpdate({
        target: [
          reportProfileAuthoredMatches.templateVersionId,
          reportProfileAuthoredMatches.sectionId,
        ],
        set: {
          scanId,
          matchedCount: match.matchedCount,
          matchedResourceIds: [...match.matchedResourceIds],
          updatedAt: new Date(),
        },
      })
  }
}

/** Every authored-match row for one template version, for the coverage
 * appendix (task 3.11) to compare against a fresh resolution. Never exported
 * for browser use — see the schema's own "not projected" docstring and
 * `test/authored-matches-projection.static.test.ts`. */
export async function readAuthoredMatches(
  templateVersionId: string
): Promise<readonly AuthoredSectionMatch[]> {
  const db = getDb()

  const rows = await db
    .select({
      sectionId: reportProfileAuthoredMatches.sectionId,
      matchedCount: reportProfileAuthoredMatches.matchedCount,
      matchedResourceIds: reportProfileAuthoredMatches.matchedResourceIds,
    })
    .from(reportProfileAuthoredMatches)
    .where(eq(reportProfileAuthoredMatches.templateVersionId, templateVersionId))

  return rows.map((row) => ({
    sectionId: row.sectionId,
    matchedCount: row.matchedCount,
    matchedResourceIds: row.matchedResourceIds as readonly string[],
  }))
}
