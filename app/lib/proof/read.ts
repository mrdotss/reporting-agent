import "server-only"

import { and, desc, eq } from "drizzle-orm"

import { getObjectSha256 } from "@/lib/aws/s3"
import { getDb } from "@/lib/db"
import { reportRuns, reportVerifications } from "@/lib/db/schema"

/**
 * What the public proof page (`/v/<run id>`) may show about a report: that it was
 * verified, when, over which period, how many figures, and the digests its files must
 * match. No customer name, no resource, no figure — only what proves a file in a
 * reader's hands is the one that was checked.
 *
 * Read without a session, so it is narrowed to exactly those columns, and only for a
 * **completed** run with a **passing** verification.
 */

export type Proof = {
  readonly runId: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly timezone: string
  readonly verifiedAt: string
  readonly figureCount: number
  readonly snapshotSha256: string
  readonly pdfSha256: string
  readonly docxSha256: string
  /** The designed reading copy (`report-styled.pdf`), when this run has one. */
  readonly styledPdfSha256: string | null
}

/**
 * The styled PDF's digest is not in the verification record: the runtime writes that copy
 * after verification, and only when every verified figure was found in its text. So it is
 * hashed from the stored file, once per run. Report files never change after they are
 * written, so the answer is kept; the map is bounded so a long-lived server cannot grow it
 * without limit. A failed read is not kept, so the next view tries again.
 */
const STYLED_DIGESTS = new Map<string, string | null>()
const STYLED_DIGESTS_MAX = 500

async function styledDigest(userId: string, runId: string): Promise<string | null> {
  if (STYLED_DIGESTS.has(runId)) return STYLED_DIGESTS.get(runId) ?? null
  let digest: string | null
  try {
    digest = await getObjectSha256(`${userId}/reports/${runId}/report-styled.pdf`)
  } catch (error) {
    console.error(`[proof] run ${runId}: the styled PDF could not be read (${error instanceof Error ? error.name : "error"})`)
    return null
  }
  if (STYLED_DIGESTS.size >= STYLED_DIGESTS_MAX) {
    const oldest = STYLED_DIGESTS.keys().next().value
    if (oldest !== undefined) STYLED_DIGESTS.delete(oldest)
  }
  STYLED_DIGESTS.set(runId, digest)
  return digest
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export async function readProof(runId: string): Promise<Proof | null> {
  if (!RUN_ID.test(runId)) return null
  const db = getDb()
  const [run] = await db
    .select({
      id: reportRuns.id,
      userId: reportRuns.userId,
      status: reportRuns.status,
      periodStart: reportRuns.periodStart,
      periodEnd: reportRuns.periodEnd,
      timezone: reportRuns.timezone,
    })
    .from(reportRuns)
    .where(eq(reportRuns.id, runId))
    .limit(1)
  if (run === undefined || run.status !== "completed") return null
  const [verification] = await db
    .select({
      createdAt: reportVerifications.createdAt,
      figureCount: reportVerifications.figureCount,
      snapshotSha256: reportVerifications.snapshotSha256,
      pdfSha256: reportVerifications.pdfSha256,
      docxSha256: reportVerifications.docxSha256,
    })
    .from(reportVerifications)
    .where(and(eq(reportVerifications.runId, runId), eq(reportVerifications.status, "pass")))
    .orderBy(desc(reportVerifications.createdAt))
    .limit(1)
  if (verification === undefined) return null
  return {
    runId: run.id,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    timezone: run.timezone,
    verifiedAt: verification.createdAt.toISOString(),
    figureCount: verification.figureCount,
    snapshotSha256: verification.snapshotSha256,
    pdfSha256: verification.pdfSha256,
    docxSha256: verification.docxSha256,
    styledPdfSha256: await styledDigest(run.userId, run.id),
  }
}
