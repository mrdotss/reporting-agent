import "server-only"

import { randomUUID } from "node:crypto"

import { and, count, desc, eq } from "drizzle-orm"
import { z } from "zod"

import { getDb } from "@/lib/db"
import {
  reportVerifications,
  type NewReportVerification,
  type ReportVerification,
  type VerificationStatus,
} from "@/lib/db/schema"
import type { VerificationResult } from "@/lib/verifications/result"

/**
 * Every read and write of `report_verifications` (Requirements 36.1, 36.2,
 * 36.3, 36.5, 36.6, 36.7, 36.8).
 *
 * `import "server-only"` is the first line and stays there, matching every
 * other connection-opening module in this codebase (`lib/templates/store.ts`,
 * `lib/runs/state.ts`): this module opens a connection, and a client component
 * importing it should be a build error rather than a review comment.
 *
 * ## The one invariant this module exists to hold
 *
 * **A `report_verifications` row is written once and never again** (Req
 * 36.2). This module exposes exactly one write — {@link insertVerification} —
 * and no operation that updates or deletes a row. `run_id` carries no UNIQUE
 * on the table (a re-verification **appends**, Req 36.1, 36.7), so the
 * immutability guarantee here is not "one row per run" but "a row, once
 * written, is never the target of a later write" — every read in this module
 * only ever selects.
 *
 * ## No `user_id` scoping, and why that is not an oversight
 *
 * Unlike `lib/templates/store.ts` and `lib/runs/state.ts`, no function here
 * takes a `userId` argument. `report_verifications` carries no `user_id`
 * column of its own — ownership is transitive, through `run_id` →
 * `report_runs.user_id` — and this module does not re-derive that ownership
 * by joining back to `report_runs` on every call.
 *
 * That mirrors how `lib/runs/gaps.ts` is written: it takes an already-read
 * `ReportRun` row (scoped by `user_id` by whoever read it) and trusts that the
 * caller proved ownership before calling in. This module makes the same
 * assumption about `runId` for the same reason — every caller in this spec's
 * design already holds an owned run before it ever needs a verification
 * result:
 *
 *   * `readLatestVerificationStatus` is read by the download gate
 *     (`download-card.tsx`, task 13.8) and by the `verifying → completed`
 *     transition's precondition (task 11.5) — both of which operate on a
 *     `runId` reached only after `lib/runs/state.ts#readOwnedRun` (or the
 *     token-authorized progress-endpoint path, which is authorized by the
 *     run-scoped HMAC rather than a session and is stronger than a user
 *     scope) has already resolved it.
 *   * `insertVerification` is called from the internal verification callback
 *     route (task 11.5), authorized by the same run-scoped HMAC
 *     `progress_token` the progress endpoint uses — again, not a signed-in
 *     user, so a `userId` parameter here would have nothing to check it
 *     against.
 *
 * A `userId`-scoped variant would therefore have to accept a `userId` no
 * caller in this design actually has at the call site, or would have to
 * derive it by joining to `report_runs` and then throw away the very row that
 * join reads — paying a query to re-prove a fact the caller already
 * established. If a future caller reaches this module holding only a bare
 * `runId` **without** having proved ownership first, that caller is the bug:
 * it must resolve the run through `lib/runs/state.ts`'s owned reads (or the
 * token-authorized path) before it ever calls in here, exactly as
 * `lib/runs/gaps.ts` requires of its own callers.
 *
 * ## Redaction, matching `lib/templates/store.ts`
 *
 * Write failures are re-thrown redacted, for the same reason every other
 * store in this codebase redacts its own: drizzle wraps a driver failure in a
 * `DrizzleQueryError` whose message carries the statement *and its bound
 * parameters* — here, the full `findings` and `counts` jsonb blobs on every
 * insert, which can quote document text. Re-throwing that verbatim writes a
 * customer's report content into a server log.
 */

// --- Errors ---------------------------------------------------------------

/**
 * No verification row exists for that run.
 *
 * Returned as `undefined` by the read helpers below rather than thrown —
 * "this run carries no verification yet" is an ordinary state for a run that
 * has not reached `verifying`, not a fault. This class exists for symmetry
 * with the rest of the codebase's naming and is not currently thrown by any
 * exported function; it is kept alongside the others in case a future caller
 * needs a thrown form of the same fact.
 */
export class VerificationNotFoundError extends Error {
  constructor() {
    super("That run carries no verification result.")
    this.name = "VerificationNotFoundError"
  }
}

// --- Driver errors ----------------------------------------------------------

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505"

/**
 * The constraint drizzle-kit generated for `(run_id, attempt_id)` — see
 * `lib/db/schema.ts`'s `report_verifications_run_id_attempt_id_uq`.
 *
 * Matching on SQLSTATE alone would map any future unique violation on this
 * table to "this attempt was already recorded", which is a false statement
 * about a different failure.
 */
const ATTEMPT_ID_CONSTRAINT = "report_verifications_run_id_attempt_id_uq"

/** The two fields read off a node-postgres error; neither carries a value. */
const driverErrorSchema = z.object({
  code: z.string().optional(),
  constraint: z.string().optional(),
})

/** Just enough of an error to walk one link of the `cause` chain. */
const causeSchema = z.object({ cause: z.unknown() })

/** Depth bound, so a self-referential `cause` cannot spin. */
const MAX_CAUSE_DEPTH = 5

/**
 * The Postgres error code and constraint from a thrown value, or `undefined`.
 *
 * Walks the `cause` chain because drizzle 0.45 wraps every driver failure in
 * a `DrizzleQueryError` and puts the original underneath — the code is never
 * on the frame that is thrown. Structural, via zod, rather than
 * `instanceof DatabaseError`, matching `lib/templates/store.ts`'s own copy of
 * this walk and for the same reason: an `instanceof` against a class imported
 * here fails silently if the driver instance differs, and that failure mode
 * is a UNIQUE violation escaping as a 500 on the one path
 * {@link insertVerification}'s idempotency depends on.
 *
 * A fifth implementation of the same walk (`lib/actions/auth.ts`,
 * `lib/actions/runs.ts`, `lib/subscriptions/store.ts` and
 * `lib/templates/store.ts` have the others). The duplication is imposed, not
 * chosen — factoring it out would couple unrelated stores to one shared
 * module for eight lines.
 */
function driverError(
  thrown: unknown
): { code: string; constraint: string | undefined } | undefined {
  let frame: unknown = thrown

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    const fields = driverErrorSchema.safeParse(frame)
    if (fields.success && fields.data.code !== undefined) {
      return { code: fields.data.code, constraint: fields.data.constraint }
    }

    const wrapper = causeSchema.safeParse(frame)
    if (!wrapper.success) return undefined

    frame = wrapper.data.cause
    if (frame === undefined || frame === null) return undefined
  }

  return undefined
}

/** Requirement 41.5 — the insert collided with an already-recorded attempt. */
function isDuplicateAttempt(thrown: unknown): boolean {
  const error = driverError(thrown)

  return (
    error?.code === UNIQUE_VIOLATION &&
    error.constraint === ATTEMPT_ID_CONSTRAINT
  )
}

/**
 * A replacement error carrying the operation and the SQLSTATE code and
 * **nothing else** — matching `lib/templates/store.ts#redactedWriteError`.
 *
 * The original is dropped rather than attached as `cause`: `DrizzleQueryError`'s
 * message is `Failed query: <sql> params: <params>`, and the parameters of
 * the insert below include the `findings` jsonb blob, which can quote
 * document text or a service error. The SQLSTATE code names the class of
 * failure without carrying a value.
 */
function redactedWriteError(operation: string, thrown: unknown): Error {
  const code = driverError(thrown)?.code
  const suffix = code === undefined ? "" : ` (postgres ${code})`

  return new Error(`[verifications] ${operation} failed${suffix}`)
}

// --- Insert -----------------------------------------------------------------

/**
 * What inserting a verification row needs: the validated artifact plus the
 * one field the artifact does not itself carry — the S3 key it was read from.
 *
 * `artifactKey` is separate from {@link VerificationResult} rather than a
 * field this store expects the caller to have merged in beforehand, because
 * the artifact is a **pointer target**, not a self-describing object that
 * knows its own address (Requirement 41.5's callback design: the callback
 * carries the key, and the app fetches and parses the object the key names).
 */
export type InsertVerificationInput = {
  readonly result: VerificationResult
  readonly artifactKey: string
}

/**
 * Every NOT NULL column the table declares, taken from the validated result.
 *
 * A free function rather than inlined into {@link insertVerification}, so the
 * mapping from the artifact's snake_case wire shape to the table's camelCase
 * columns is one visible list rather than scattered across an object
 * literal's construction — and so a column added to the table later shows up
 * here as a missing field rather than as a silently absent one.
 *
 * `ledger_sha256` is read from `result` and **not** passed through: see
 * `lib/verifications/result.ts`'s module docstring for why the artifact
 * carries a fourth digest the table has no column for. Dropping it here,
 * once, in the one function that maps artifact to row, is what keeps that
 * reconciliation in a single place rather than something every future caller
 * has to remember on its own.
 */
function rowValues(input: InsertVerificationInput): NewReportVerification {
  const { result, artifactKey } = input

  return {
    id: randomUUID(),
    runId: result.run_id,
    attemptId: result.attempt_id,
    templateVersionId: result.template_version_id,
    status: result.status,
    figureCount: result.figure_count,
    snapshotSha256: result.snapshot_sha256,
    docxSha256: result.docx_sha256,
    pdfSha256: result.pdf_sha256,
    replay: result.replay,
    driftSample: result.drift_sample,
    findings: result.findings,
    counts: result.counts,
    artifactKey,
  }
}

/**
 * Insert one `report_verifications` row from a validated verification result
 * (Requirements 36.1, 36.2, 36.3).
 *
 * **Idempotent on `(run_id, attempt_id)`** (Requirement 41.5's framing of the
 * progress callback as a fire-and-forget POST that may be retried): when the
 * insert collides with an attempt already recorded for that run, this
 * function does **not** raise. It re-reads and returns the row that already
 * exists for that `(run_id, attempt_id)` pair — the same row a first,
 * successful delivery of that callback would have produced — so a retried
 * callback resolves exactly as if it had landed once, without inflating the
 * count of verification attempts {@link latestForRun} reports for that run.
 *
 * A **duplicate `attempt_id` for the same run** is therefore not an error the
 * caller has to handle; a **genuine re-verification**, which mints a fresh
 * `attempt_id` (Requirement 36.7), is unaffected — it inserts a new row and
 * every earlier row for that run survives unchanged, because nothing here
 * updates or deletes.
 *
 * No `userId` parameter — see the module docstring's section on ownership
 * scoping. The caller is the internal verification-callback route,
 * authorized by the run-scoped HMAC rather than a session.
 */
export async function insertVerification(
  input: InsertVerificationInput
): Promise<ReportVerification> {
  try {
    const [row] = await getDb()
      .insert(reportVerifications)
      .values(rowValues(input))
      .returning()

    // Unreachable through the driver — an `INSERT ... RETURNING` that raised
    // nothing returned the row — but the caller needs a row rather than a
    // `row!`, and an assertion here would be a claim this module cannot back.
    if (row === undefined) {
      throw new Error("[verifications] the insert returned no row")
    }

    return row
  } catch (thrown) {
    if (isDuplicateAttempt(thrown)) {
      const existing = await readByRunAndAttempt(
        input.result.run_id,
        input.result.attempt_id
      )
      // The row that just lost the UNIQUE race is, by definition, present —
      // this read cannot legitimately miss it. Falling through to the
      // redacted error rather than asserting is what keeps this path honest
      // if that invariant is ever violated by something outside this
      // function's control (a concurrent delete outside this module's own
      // write surface, for instance).
      if (existing !== undefined) return existing
    }
    throw redactedWriteError("inserting a verification result", thrown)
  }
}

/** One row by its `(run_id, attempt_id)` pair, or `undefined`. Module-private. */
async function readByRunAndAttempt(
  runId: string,
  attemptId: string
): Promise<ReportVerification | undefined> {
  const [row] = await getDb()
    .select()
    .from(reportVerifications)
    .where(
      and(
        eq(reportVerifications.runId, runId),
        eq(reportVerifications.attemptId, attemptId)
      )
    )
    .limit(1)

  return row
}

// --- Reads --------------------------------------------------------------

/**
 * The row carrying the greatest `created_at` for a run, plus the total count
 * of rows recorded for that run (Requirement 36.7).
 *
 * `undefined` for `latest` when the run carries no verification yet — an
 * ordinary state for a run that has not reached `verifying`, not an error.
 * `count` is always the true row count even when `latest` is `undefined` (it
 * is then `0`), so a caller never has to special-case "no rows" against "one
 * field of the one row is missing".
 *
 * Two queries rather than one `SELECT * ... ORDER BY ... LIMIT 1` plus a
 * window function: `report_verifications` rows are read here for the
 * Verification_Panel, which needs the **count** as a fact about the run
 * ("this is attempt 3") independent of which row is latest, and asking
 * Postgres for both in one round trip via `COUNT(*) OVER ()` would tie every
 * future caller of this function to a query shape a plain `count` aggregate
 * cannot express as cleanly. Two small, indexed queries against
 * `report_verifications_run_id_idx` cost less than the one thing a single
 * query would save.
 */
export async function latestForRun(runId: string): Promise<{
  readonly latest: ReportVerification | undefined
  readonly count: number
}> {
  const [[latestRow], [countRow]] = await Promise.all([
    getDb()
      .select()
      .from(reportVerifications)
      .where(eq(reportVerifications.runId, runId))
      .orderBy(desc(reportVerifications.createdAt))
      .limit(1),
    getDb()
      .select({ value: count() })
      .from(reportVerifications)
      .where(eq(reportVerifications.runId, runId)),
  ])

  return {
    latest: latestRow,
    count: countRow?.value ?? 0,
  }
}

/**
 * The status of the latest verification attempt for a run, or `undefined`
 * when the run carries none yet.
 *
 * The thin read the download gate and the `verifying → completed` transition
 * precondition both use (Requirements 36.4, 40.1, 41.9 — the latter wired in
 * task 11.5): neither caller needs the finding list, the digests or the
 * counts, only "does a `pass` exist right now for this run," so this
 * deliberately does not build on {@link latestForRun} and pay for the second
 * `count` query every caller here does not need.
 *
 * Returns the **status alone**, not a boolean, because "carries no
 * verification yet" and "carries one whose status is `fail`" are both real
 * and distinct answers a caller must be able to tell apart — collapsing
 * either into the other is exactly the ambiguity the download gate and the
 * completion precondition both exist to refuse under.
 */
export async function readLatestVerificationStatus(
  runId: string
): Promise<VerificationStatus | undefined> {
  const [row] = await getDb()
    .select({ status: reportVerifications.status })
    .from(reportVerifications)
    .where(eq(reportVerifications.runId, runId))
    .orderBy(desc(reportVerifications.createdAt))
    .limit(1)

  return row?.status
}
