import "server-only"

import { z } from "zod"

/**
 * The verification callback's body — a **pointer**, not a copy (Requirement 41.5).
 *
 * The obvious design sends the verification result itself. It does not survive
 * contact with the numbers: the result carries up to 1,000 findings, each with a
 * 200-character excerpt, so a failing run's result reaches several hundred
 * kilobytes. That would be a several-hundred-kilobyte fire-and-forget POST from a
 * container that abandons the send after five seconds — the delivery most likely
 * to fail is the one carrying the most findings, which is exactly backwards.
 *
 * So the callback carries the artifact key and the app fetches the object. The
 * artifact is the record anyway (Requirement 36.3): it is written before this
 * callback is sent, on both the passing and the failing path, and a panel built
 * from the stored object and a panel built from an event must be identical.
 *
 * The four scalars alongside it are not redundant. They let the endpoint reject a
 * callback whose key names an artifact describing a *different* run or attempt
 * before it spends an S3 read — and they are what the log line says when the fetch
 * then fails.
 */
export const verificationCallbackSchema = z
  .object({
    run_id: z.string().min(1),
    attempt_id: z.string().min(1).max(128),
    status: z.enum(["pass", "fail"]),
    figure_count: z.number().int().nonnegative(),
    snapshot_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    docx_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    pdf_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /**
     * The result artifact's own S3 key. Positional, like every other report
     * artifact key, and validated as such at the endpoint: a key whose first
     * segment is not this run's actor is a key this app will not read.
     */
    artifact_key: z.string().min(1).max(1024),
  })
  .strict()

export type VerificationCallback = z.infer<typeof verificationCallbackSchema>

/**
 * Whether a stored result describes the run and attempt the callback claimed.
 *
 * The callback and the artifact are two statements about one verification,
 * delivered separately, and the failure this catches is not exotic: a retried
 * callback whose key was built from a stale attempt id would otherwise insert a
 * row whose `attempt_id` column and whose artifact disagree — and every later
 * reader of that row would follow the pointer to the wrong object.
 *
 * The three digests are compared too. They are the cheapest possible check that
 * the artifact is the one this callback was minted from, and they cost nothing:
 * the endpoint has both values in hand already.
 */
export function describesSameAttempt(
  callback: VerificationCallback,
  result: {
    readonly run_id: string
    readonly attempt_id: string
    readonly status: string
    readonly figure_count: number
    readonly snapshot_sha256: string
    readonly docx_sha256: string
    readonly pdf_sha256: string
  }
): boolean {
  return (
    result.run_id === callback.run_id &&
    result.attempt_id === callback.attempt_id &&
    result.status === callback.status &&
    result.figure_count === callback.figure_count &&
    result.snapshot_sha256 === callback.snapshot_sha256 &&
    result.docx_sha256 === callback.docx_sha256 &&
    result.pdf_sha256 === callback.pdf_sha256
  )
}
