import "server-only"

import { and, desc, eq } from "drizzle-orm"

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
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export async function readProof(runId: string): Promise<Proof | null> {
  if (!RUN_ID.test(runId)) return null
  const db = getDb()
  const [run] = await db
    .select({
      id: reportRuns.id,
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
  }
}
