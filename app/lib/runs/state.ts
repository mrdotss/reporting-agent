import "server-only"

import { and, desc, eq } from "drizzle-orm"

import { getDb } from "@/lib/db"
import {
  reportRuns,
  reportVerifications,
  runErrorCode,
  type ReportRun,
  type RunErrorCode,
  type RunStatus,
} from "@/lib/db/schema"

/**
 * The run state machine (Requirement 36) — the transition table, the phase
 * deadline budgets, and every user-scoped read and write of `report_runs`.
 *
 * `import "server-only"` is the first line: this module opens a connection and
 * reads a table carrying `progress_token_hash`, which is a credential.
 *
 * ## Why the transitions are a table
 *
 * Three writers move a run: the enqueue inserts `queued`, the reaper writes
 * `claimed` and the `TIMEOUT` sweep, and the progress endpoint writes everything
 * the agent reports. A rule enforced in three places is a rule enforced in two,
 * so the legal edges are declared **once**, as data, and every writer consults
 * the same declaration. {@link DRIVEN} is that declaration.
 *
 * `compiling`, `rendering` and `verifying` appear in it with **empty** target
 * lists, and no other status names them (Requirement 36.2). They are defined,
 * undriven and unreachable — the pipeline in this spec stops at the snapshot.
 * Declaring them anyway is what keeps the enum and the table one design rather
 * than two migrations.
 *
 * ## Why every helper takes a user id
 *
 * Requirements 36.10 and 36.11: a read or write on behalf of a signed-in user is
 * restricted to rows whose `user_id` equals that user's id, and a row belonging
 * to somebody else resolves as **not found** — not as forbidden — with no write
 * applied and no field disclosed, including its `status` and its `error_code`.
 * There is therefore no exported function here that reaches a run by primary key
 * alone, and the `AND user_id` predicate lives inside the statement rather than
 * in a check beside it, so there is no ordering in which the check passes and the
 * write lands anyway.
 *
 * The two writers that are **not** acting on behalf of a signed-in user — the
 * progress endpoint, authorized by a run-scoped HMAC, and the reaper, authorized
 * by a bearer secret — own their own statements. They are documented where they
 * live; this module's helpers are the user-scoped half.
 */

// --- The transition table ---------------------------------------------------

/**
 * The transitions this spec drives (Requirement 36.2).
 *
 * Read as "from this status, these targets are reachable". Every entry is
 * present, including the terminal and undriven ones, so a lookup can never be
 * `undefined` and a caller never needs a fallback that would quietly admit a
 * status the table does not mention.
 *
 * `queued → claimed` is the reaper's, and the reaper's alone. It is listed here
 * because the table describes the machine rather than one writer, and the
 * progress endpoint separately refuses a presented `claimed`: an agent claiming
 * to have done the claiming is a callback that should never be honoured.
 *
 * The three failure edges — `queued → failed`, `claimed → failed`,
 * `collecting → failed` — are restricted to the codes {@link ROW_ERROR_CODES}
 * declares, which is Requirement 36.6 and is also enforced in the database by
 * `report_runs_error_code_ck`.
 */
export const DRIVEN: Readonly<Record<RunStatus, readonly RunStatus[]>> =
  Object.freeze({
    queued: Object.freeze(["claimed", "failed"] as const),
    claimed: Object.freeze(["collecting", "failed"] as const),
    // `collecting → completed` stays alongside the new `collecting → compiling`
    // edge, because a snapshot-only invocation is still a legal run shape and
    // the foundation's own tests describe it. Removing it would break them for
    // no gain: a run that produced a snapshot and no document did complete.
    collecting: Object.freeze(["compiling", "completed", "failed"] as const),
    compiling: Object.freeze(["rendering", "failed"] as const),
    rendering: Object.freeze(["verifying", "failed"] as const),
    // `verifying → completed` is the one transition with a precondition beyond
    // this table: the endpoint reads a `report_verifications` row for the run
    // with `status` `pass` **in the same transaction** as the update, so no
    // ordering exists in which a run reports success before its proof is stored
    // (Requirement 41.1). A table cannot express that, so the endpoint does.
    verifying: Object.freeze(["completed", "failed"] as const),
    // Terminal: every subsequent transition is rejected (Requirement 38.8).
    completed: Object.freeze([] as const),
    failed: Object.freeze([] as const),
  })

/** The two statuses no transition leaves (Requirement 38.8). */
export const TERMINAL_STATUSES = Object.freeze(
  new Set<RunStatus>(["completed", "failed"])
)

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/**
 * The targets a row currently at `status` may be moved to — `{status} ∪
 * DRIVEN[status]` (Requirement 38.10).
 *
 * The current status is included because a same-status callback is **not** an
 * error: it is a progress refresh inside one phase, and Requirement 38.13 says
 * it applies no `status` change while still writing the presented counts. A
 * terminal row admits nothing at all, not even a repeat of the terminal status it
 * already carries (Requirement 38.8), which is why the terminal check comes
 * first rather than relying on `DRIVEN` being empty.
 */
export function acceptedTargets(status: RunStatus): readonly RunStatus[] {
  if (isTerminalStatus(status)) return []

  return [status, ...DRIVEN[status]]
}

/**
 * The terminal codes a `failed` row may carry — Requirement 36.6's ten plus
 * Requirement 41.2's six — read **from the Postgres enum itself**.
 *
 * Derived rather than restated, so a value added to `run_error_code` cannot
 * disagree with this set, and — more to the point — a code the enum does *not*
 * have can never reach a column whose CHECK would reject it at write time, on the
 * one path where the write is how a run failure gets recorded.
 *
 * That derivation is why the six document-phase codes — `TEMPLATE_INVALID`,
 * `COMPILE_FAILED`, `RENDER_FAILED`, `PDF_CONVERSION_FAILED`,
 * `VERIFICATION_FAILED` and `REPLAY_MISMATCH` — arrive here from the one edit
 * that appended them to the enum, and why all six are terminal without a second
 * declaration saying so: this set *is* the terminal set, and there is no
 * non-terminal member of it to distinguish them from.
 *
 * `PARTIAL_COVERAGE` is absent because it is absent from the enum: it is an
 * *event* code carried on a run that **completes** with recorded gaps, never a
 * failed row's code.
 */
export const ROW_ERROR_CODES: ReadonlySet<RunErrorCode> = Object.freeze(
  new Set<RunErrorCode>(runErrorCode.enumValues)
)

/**
 * The codes the **app** writes, which the agent may therefore not present.
 *
 * `TIMEOUT` is the reaper's alone (Requirement 39.8): by the time a deadline has
 * passed the run's container may already be gone, so there is no stream left to
 * carry an `error` event and nothing else may claim to have observed one.
 * `SECRET_UNREADABLE` is the tick's, written when `client_secret_enc` fails to
 * decrypt while the invoke payload is being built (Requirement 41.10) — a failure
 * that happens in the app, before the agent exists for that run.
 *
 * Mirrors `agent/src/reporting_agent/errors.py#APP_WRITTEN_CODES`. The agent
 * drops these from a callback body rather than spending a request to be refused,
 * and the endpoint refuses them anyway (Requirement 38.11) — belt and braces,
 * because only the endpoint's refusal is authoritative.
 */
export const APP_WRITTEN_CODES: ReadonlySet<RunErrorCode> = Object.freeze(
  new Set<RunErrorCode>(["TIMEOUT", "SECRET_UNREADABLE"])
)

/** The codes a progress callback may present on a `failed` transition. */
export const AGENT_ERROR_CODES: ReadonlySet<RunErrorCode> = Object.freeze(
  new Set<RunErrorCode>(
    [...ROW_ERROR_CODES].filter((code) => !APP_WRITTEN_CODES.has(code))
  )
)

// --- Phase deadline budgets -------------------------------------------------

/**
 * Requirement 36.9 — the seconds added to the write instant when a row enters
 * each non-terminal phase.
 *
 * | phase | budget | why |
 * |---|---|---|
 * | `queued` | 900 | the reaper runs at most every 60 seconds, so this tolerates 14 consecutive missed ticks (Requirement 39.12) before a queued run is failed |
 * | `claimed` | 300 | claimed-but-not-collecting means the container never started; five minutes covers a cold start on an arm64 image |
 * | `collecting` | 1800 | the 8-to-12-minute p99 run duration plus at least 900 seconds of headroom, so an ordinary slow month is not reaped mid-flight |
 * | `compiling` | 300 | pure computation over a snapshot already in memory; five minutes is generous for 200 blocks |
 * | `rendering` | 600 | LibreOffice conversion is bounded at 300 seconds on its own, and the emit precedes it |
 * | `verifying` | 600 | the verifier reads the whole document twice, and replay re-runs the aggregation over the raw archive |
 *
 * Every non-terminal status now carries a budget, so a row can no longer sit in
 * a phase the reaper has no deadline for. The two terminal statuses are absent
 * on purpose — {@link phaseDeadlineFor} returns `null` for them, which is
 * Requirement 38.12's "clear `phase_deadline`": a finished run must never be
 * swept.
 */
export const PHASE_DEADLINE_SECONDS: Readonly<
  Partial<Record<RunStatus, number>>
> = Object.freeze({
  queued: 900,
  claimed: 300,
  collecting: 1800,
  compiling: 300,
  rendering: 600,
  verifying: 600,
})

/**
 * The `phase_deadline` a row entering `status` at `now` should carry, or `null`.
 *
 * `null` for a terminal status, which is Requirement 38.12's "clear
 * `phase_deadline`": a finished run must never be swept. `null` also for the
 * undriven phases, so a hypothetical future writer gets no invented budget.
 *
 * Pure — `now` is a parameter, never `Date.now()` — because the reaper's sweep
 * and the progress endpoint's write both have to be assertable at an instant a
 * test picks, and because a run whose deadline was computed from a second clock
 * read is a run whose deadline is off by the width of the handler.
 */
export function phaseDeadlineFor(status: RunStatus, now: Date): Date | null {
  const seconds = PHASE_DEADLINE_SECONDS[status]
  if (seconds === undefined) return null

  return new Date(now.getTime() + seconds * 1000)
}

// --- Not found --------------------------------------------------------------

/**
 * No run with that id belongs to that user (Requirements 36.10, 36.11).
 *
 * One error for two situations that must be **indistinguishable**: the row does
 * not exist, and the row exists and belongs to somebody else. The message names
 * no id, no user and no field, so it is safe to log verbatim and discloses
 * nothing when a handler turns it into a 404.
 */
export class RunNotFoundError extends Error {
  constructor() {
    super("No report run with that id belongs to the signed-in user.")
    this.name = "RunNotFoundError"
  }
}

// --- User-scoped reads ------------------------------------------------------

/**
 * One run row, scoped to its owner (Requirements 36.10, 36.11).
 *
 * Both ids are required arguments; there is no overload that resolves a row by
 * primary key alone. Returns the full row rather than a `RunView`, because the
 * callers are server-side — the relay, the run detail page, the gap loader — and
 * projecting is the last step before a response rather than a step in the middle.
 */
export async function readOwnedRun(
  userId: string,
  runId: string
): Promise<ReportRun> {
  const [row] = await getDb()
    .select()
    .from(reportRuns)
    .where(and(eq(reportRuns.id, runId), eq(reportRuns.userId, userId)))
    .limit(1)

  if (row === undefined) throw new RunNotFoundError()

  return row
}

/**
 * One run row, or `undefined` — the same scoped read without the throw.
 *
 * For the two callers that have a non-exceptional answer for "no such run": the
 * relay, which resolves it as not found before opening a stream, and the enqueue,
 * which reads back the winner of a `dedupe_key` race.
 */
export async function findOwnedRun(
  userId: string,
  runId: string
): Promise<ReportRun | undefined> {
  const [row] = await getDb()
    .select()
    .from(reportRuns)
    .where(and(eq(reportRuns.id, runId), eq(reportRuns.userId, userId)))
    .limit(1)

  return row
}

/** How many runs the list surfaces render at once. */
export const RUN_LIST_LIMIT = 50

/**
 * This user's runs, newest first (Requirement 36.10).
 *
 * `created_at DESC` then `id DESC`: the id breaks a tie so two rows written in
 * the same transaction do not swap places between renders, which on a list whose
 * rows carry counts would read as data changing when nothing did.
 */
export async function listOwnedRuns(
  userId: string,
  limit: number = RUN_LIST_LIMIT
): Promise<ReportRun[]> {
  return await getDb()
    .select()
    .from(reportRuns)
    .where(eq(reportRuns.userId, userId))
    .orderBy(desc(reportRuns.createdAt), desc(reportRuns.id))
    .limit(limit)
}

// --- User-scoped writes -----------------------------------------------------

/**
 * The columns a user-scoped write may set.
 *
 * `updatedAt` is **absent on purpose**: {@link updateOwnedRun} sets it itself, so
 * there is no argument through which a caller could write another column while
 * leaving `updated_at` stale (Requirement 36.3). `userId`, `id`, `dedupeKey` and
 * `progressTokenHash` are absent for the same structural reason — none of them is
 * a thing a later write may change.
 */
export type RunStateWrite = Partial<
  Pick<
    ReportRun,
    | "status"
    | "claimedAt"
    | "claimedBy"
    | "phaseDeadline"
    | "errorCode"
    | "errorMessage"
    | "progressCurrent"
    | "progressTotal"
    | "progressLabel"
    | "snapshotId"
    | "resourceCount"
    | "gapCount"
  >
>

/**
 * Apply a scoped write and return the updated row (Requirements 36.3, 36.10,
 * 36.11).
 *
 * `updated_at` is set to `now` here rather than left to the schema's `$onUpdate`
 * hook, and the reason is not redundancy: the hook fires for writes issued
 * through Drizzle's query builder, and the reaper's sweep and claim are raw
 * `UPDATE` statements that bypass it entirely. One explicit assignment on the
 * path that has a `now` in hand keeps the rule true on every path rather than on
 * most of them — and it makes the instant the caller's, so a test can pin it.
 *
 * Throws {@link RunNotFoundError} when the statement matched no row, which covers
 * both an absent id and another user's. No write lands in either case: the `AND
 * user_id` predicate is inside the statement.
 */
export async function updateOwnedRun(
  userId: string,
  runId: string,
  values: RunStateWrite,
  now: Date
): Promise<ReportRun> {
  const [row] = await getDb()
    .update(reportRuns)
    .set({ ...values, updatedAt: now })
    .where(and(eq(reportRuns.id, runId), eq(reportRuns.userId, userId)))
    .returning()

  if (row === undefined) throw new RunNotFoundError()

  return row
}

// --- Terminal writes --------------------------------------------------------

/**
 * The write that fails a run, as a value rather than as three assignments at each
 * call site.
 *
 * It exists because the CHECK constraint pairs `status` and `error_code` in both
 * directions — a `failed` row must carry a code and a non-`failed` row must not —
 * and three writers fail runs: the enqueue's pre-insert rejections never reach a
 * row, but the reaper's gate, the reaper's sweep and the progress endpoint all do.
 * Building the write once means none of them can produce the half of the pair the
 * constraint rejects.
 *
 * `phaseDeadline`, `progressCurrent`, `progressTotal` and `progressLabel` are all
 * cleared (Requirements 36.12, 38.12): a terminal row is never swept and carries
 * no stale in-flight count.
 */
export function failedRunWrite(
  code: RunErrorCode,
  message: string
): RunStateWrite {
  return {
    status: "failed",
    errorCode: code,
    errorMessage: message,
    phaseDeadline: null,
    progressCurrent: null,
    progressTotal: null,
    progressLabel: null,
  }
}

/**
 * The write that completes a run (Requirement 38.12).
 *
 * `errorCode` and `errorMessage` are set to `null` explicitly rather than left
 * alone. A `collecting` row cannot be carrying either — the CHECK forbids it —
 * but stating it here means the completed row is written whole, and a future
 * non-terminal phase that recorded a non-fatal note could not leak it into a
 * success.
 */
export function completedRunWrite(a: {
  snapshotId: string
  resourceCount: number
  gapCount: number
}): RunStateWrite {
  return {
    status: "completed",
    errorCode: null,
    errorMessage: null,
    snapshotId: a.snapshotId,
    resourceCount: a.resourceCount,
    gapCount: a.gapCount,
    phaseDeadline: null,
    progressCurrent: null,
    progressTotal: null,
    progressLabel: null,
  }
}

// --- Token-authorized access (the progress endpoint's half) -----------------

/**
 * One run row by id, **not** scoped to a user.
 *
 * The exception to this module's rule, and it is named as an exception rather than
 * offered as a convenience. The progress endpoint is authorized by the run-scoped
 * HMAC `progress_token`, not by a session: the caller is the agent container, which
 * has no user and no cookie. So the authorization is "you hold the token whose hash
 * is on this row", which is *stronger* than a user scope — it names one run rather
 * than one user's runs — and it is applied by the endpoint before this is called.
 *
 * Returns `undefined` for an unknown id. The endpoint answers an unknown id and a
 * bad token with **one identical response** (Requirement 38.6), so the absence has
 * to be a value it can branch on without the branch being visible from outside.
 *
 * Every other read in this module takes a user id. If a third caller ever wants
 * this one, it needs its own authorization story written down first.
 */
export async function readRunForTokenHolder(
  runId: string
): Promise<ReportRun | undefined> {
  const [row] = await getDb()
    .select()
    .from(reportRuns)
    .where(eq(reportRuns.id, runId))
    .limit(1)

  return row
}

/**
 * Apply a write to one run **only if its `status` is still what was read**.
 *
 * The `AND status = $expected` predicate is optimistic concurrency, and it closes a
 * window that is small and real: the progress endpoint reads the row, decides the
 * transition against that row's status, and then writes. Between those two
 * statements the reaper's deadline sweep can fail the run, or a retried callback can
 * land the same transition. Without the predicate the second write would apply a
 * decision made against a status the row no longer carries — reopening a swept
 * `failed` row as `collecting`, which is precisely the state the sweep exists to
 * end.
 *
 * Returns `undefined` when the predicate matched nothing, which the endpoint treats
 * as the rejection it would have produced had it read the newer status. It does not
 * retry: a callback is a statement about a phase, and re-deciding it against a row
 * that has moved on is how a terminal row gets reopened by a slow request.
 *
 * `updated_at` is set here rather than by the caller, for the reason
 * {@link updateOwnedRun} sets it: the schema's `$onUpdate` hook does not fire for the
 * raw statements elsewhere in this design, so one explicit assignment per write path
 * keeps Requirement 36.3 true everywhere instead of nearly everywhere.
 */
export async function applyRunWriteIfStatus(
  runId: string,
  expectedStatus: RunStatus,
  values: RunStateWrite,
  now: Date
): Promise<ReportRun | undefined> {
  const [row] = await getDb()
    .update(reportRuns)
    .set({ ...values, updatedAt: now })
    .where(and(eq(reportRuns.id, runId), eq(reportRuns.status, expectedStatus)))
    .returning()

  return row
}

/**
 * Apply a write **only if** the row's status is still what was read **and** a
 * passing verification exists for the run (Requirement 41.1).
 *
 * The only transition with a precondition beyond {@link DRIVEN}, and the reason
 * is worth stating plainly: `completed` is the status the download control keys
 * off. A run that reached it before its proof was stored would present a
 * download for a document nothing had verified — for however long the
 * verification callback took to arrive, and forever if it never did.
 *
 * ## Why one transaction rather than two statements
 *
 * The check and the update run inside `BEGIN … COMMIT`, at Postgres's default
 * `READ COMMITTED`. That is not belt and braces around a check that would
 * usually pass: without it there is a real interleaving where the `SELECT` sees
 * a `pass` row that a concurrent transaction then rolls back, and the `UPDATE`
 * commits `completed` against a verification that no longer exists. One
 * transaction makes the two statements atomic with respect to any other writer.
 *
 * The status predicate rides along for the reason {@link applyRunWriteIfStatus}
 * carries it: the reaper's sweep can fail the row between the endpoint's read
 * and this write, and a decision made against a stale status must not reopen a
 * terminal row.
 *
 * Returns `undefined` for **either** miss, and deliberately does not distinguish
 * them to the caller. Both mean the same thing to the endpoint — this transition
 * does not apply — and a caller that could tell "no passing verification" from
 * "the row moved on" would be a caller tempted to retry one of them.
 */
export async function applyVerifiedCompletion(
  runId: string,
  expectedStatus: RunStatus,
  values: RunStateWrite,
  now: Date
): Promise<ReportRun | undefined> {
  return getDb().transaction(async (tx) => {
    const [proof] = await tx
      .select({ id: reportVerifications.id })
      .from(reportVerifications)
      .where(
        and(
          eq(reportVerifications.runId, runId),
          eq(reportVerifications.status, "pass")
        )
      )
      .limit(1)

    if (proof === undefined) return undefined

    const [row] = await tx
      .update(reportRuns)
      .set({ ...values, updatedAt: now })
      .where(
        and(eq(reportRuns.id, runId), eq(reportRuns.status, expectedStatus))
      )
      .returning()

    return row
  })
}
