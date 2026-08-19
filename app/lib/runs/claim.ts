import "server-only"

import { createHash, timingSafeEqual } from "node:crypto"

import { sql } from "drizzle-orm"

import { getDb } from "@/lib/db"
import type { RunScope, RunStatus } from "@/lib/db/schema"
import { isTerminalStatus, PHASE_DEADLINE_SECONDS } from "@/lib/runs/state"

/**
 * The reaper's two statements and its bearer comparison (Requirement 39).
 *
 * `import "server-only"` is the first line: this module reads `RPT_CRON_SECRET` and
 * issues the two writes that move runs without a session behind them.
 *
 * ## Why these are raw SQL
 *
 * Both statements need `FOR UPDATE SKIP LOCKED` inside a subquery, and the sweep
 * additionally needs to read the **pre-update** `status` inside its own `SET`
 * expression. Neither is expressible through Drizzle's query builder, and expressing
 * them approximately would lose the exact property each one exists for:
 *
 *   * `SKIP LOCKED` is what makes overlapping ticks claim **disjoint** sets
 *     (Requirement 39.5). Without it the second tick blocks on the first's row locks
 *     and then re-reads rows the first has already claimed — so two ticks would
 *     invoke one run twice.
 *   * The sweep has to name the phase that **expired** (Requirement 39.7), which
 *     means reading `status` before the same statement overwrites it. A `SET`
 *     expression reads the old value; `RETURNING` reads the new one. Both the stored
 *     message and the returned value therefore come from a CTE that captured the old
 *     status — see {@link sweepExpiredRuns}, where the measured behaviour and the
 *     bug it corrects are written out. A two-step read-then-write would name the
 *     phase from a row that has since moved.
 *
 * So the SQL is written out, with the budgets and the limits interpolated from
 * constants rather than typed twice, and every value that comes from outside is a
 * bound parameter.
 */

// --- The bearer secret ------------------------------------------------------

/** The `Authorization` scheme the tick expects. */
const BEARER_PREFIX = "Bearer "

/**
 * Does the presented bearer match `RPT_CRON_SECRET` (Requirements 39.1, 39.2)?
 *
 * **Fails closed**: an unset or empty `RPT_CRON_SECRET` rejects every request. That
 * direction is the whole point — this endpoint can claim work and invoke the
 * runtime, so an unconfigured deployment defaulting to *open* would be a
 * denial-of-wallet hole reachable by anybody who found the URL.
 *
 * ## Why both sides are hashed before comparing
 *
 * `timingSafeEqual` throws on buffers of unequal length, and a throw for a
 * wrong-length input is itself a length oracle — a caller could learn the secret's
 * length by binary-searching the length at which the response changes shape.
 * Hashing both sides first makes the operands **always** 32 bytes, so the comparison
 * is callable for every input and its duration depends on neither the number of
 * matching leading characters nor the secret's length.
 *
 * A cheap SHA-256 rather than a password hash, for the reason the session and
 * progress tokens get the same treatment: the input is a high-entropy random secret,
 * so there is no dictionary to slow down, and a work factor would only add latency
 * to a path a scheduler hits every 60 seconds.
 *
 * The comparison is over the **raw presented value** after the scheme prefix is
 * stripped, with no trimming. A secret with a stray trailing space is a
 * configuration mistake, and silently accepting it would mean two different strings
 * both authorize.
 */
export function bearerMatches(
  presented: string | null,
  expected: string | undefined
): boolean {
  // Requirement 39.2 — fail closed, before anything else.
  if (expected === undefined || expected.trim().length === 0) return false
  if (presented === null) return false
  if (!presented.startsWith(BEARER_PREFIX)) return false

  const offered = presented.slice(BEARER_PREFIX.length)
  if (offered.length === 0) return false

  return timingSafeEqual(digest(offered), digest(expected))
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest()
}

// --- Limits -----------------------------------------------------------------

/**
 * Requirement 39.7 — at most 100 rows swept per request.
 *
 * A bound rather than "all of them", so one tick cannot turn a backlog into a
 * multi-minute statement holding locks on every stuck row in the table. A backlog
 * larger than this drains over consecutive ticks, and the next one is 60 seconds
 * away.
 */
export const SWEEP_LIMIT = 100

/**
 * Requirement 39.4 — at most 10 rows claimed per request.
 *
 * Lower than the sweep limit because a claim is followed by real work: ten
 * invocations, each with a 10-second start budget, has to fit inside the 10-second
 * response budget of Requirement 39.9 — which it does because they are started
 * concurrently and none is awaited to completion. Claiming a hundred would put a
 * hundred concurrent `InvokeAgentRuntime` calls in one request.
 */
export const CLAIM_LIMIT = 10

/**
 * The statuses the deadline sweep considers (Requirements 39.7, 41.5).
 *
 * **Derived, not restated.** Every non-terminal status carries a budget in
 * {@link PHASE_DEADLINE_SECONDS}, and a status with a budget and no sweep is a
 * row that can sit past its deadline forever — which is the exact failure this
 * sweep exists to prevent, reintroduced by a list somebody forgot to extend when
 * the document phases landed. Deriving it means the two cannot disagree.
 *
 * Sorted so the emitted `IN (…)` list is stable across processes; a statement
 * whose text depends on object iteration order is a statement whose query plan
 * cache key does.
 */
export const SWEEPABLE: readonly RunStatus[] = Object.freeze(
  (Object.keys(PHASE_DEADLINE_SECONDS) as RunStatus[])
    .filter((status) => !isTerminalStatus(status))
    .sort()
)

// --- The deadline sweep -----------------------------------------------------

/** One row the sweep failed, with the phase it was in when it expired. */
export type SweptRun = {
  readonly id: string
  /** The **pre-update** status — the phase that ran out of time. */
  readonly expiredPhase: RunStatus
}

/**
 * Fail every non-terminal row past its `phase_deadline` as `TIMEOUT`
 * (Requirements 39.7, 39.8).
 *
 * **Without this, one crashed container leaves rows stuck forever.** A run whose
 * agent died mid-collection has no stream left to carry an `error` event and no
 * later callback to correct its row, so `collecting` is where it stays — and the run
 * list shows a report that is still being worked on, indefinitely. This statement is
 * the only thing that ends that, which is why it is foundation rather than a
 * follow-up.
 *
 * ## Why the expired phase comes from a CTE
 *
 * The expired phase has to be read **before** the update overwrites it, and the two
 * places it could come from behave differently:
 *
 *   * `status` on the right-hand side of a `SET` **does** see the old row value, so
 *     `error_message = 'Phase ' || status || ' …'` names the phase correctly.
 *   * `RETURNING status` does **not**. `RETURNING` evaluates against the row *as
 *     updated*, so it would return `'failed'` for every row — measured against
 *     Postgres 17, not assumed. An earlier version of this function returned that
 *     value as `expiredPhase`, which made every reaper log line say the same
 *     uninformative thing.
 *
 * So the due rows are selected into a CTE that captures `status` alongside `id`, the
 * `UPDATE` joins against it, and `RETURNING due.status` returns the pre-update value
 * because it is the CTE's column rather than the target's. The `SET` expression reads
 * from the CTE too, so both the stored message and the returned value come from one
 * source and cannot disagree.
 *
 * `FOR UPDATE SKIP LOCKED` sits in the CTE so two overlapping ticks sweep disjoint
 * sets rather than one blocking on the other. Ordered by `phase_deadline` so the
 * longest-overdue rows are dealt with first when there are more than
 * {@link SWEEP_LIMIT} of them.
 *
 * `now()` rather than an injected instant: this is one statement, and letting
 * Postgres read its own clock means the comparison and the write cannot straddle two
 * different times. The `updated_at` it sets is therefore the database's instant,
 * which is also what makes it consistent with the claim below.
 */
export async function sweepExpiredRuns(): Promise<readonly SweptRun[]> {
  const statuses = sql.join(
    SWEEPABLE.map((status) => sql`${status}`),
    sql`, `
  )

  const result = await getDb().execute<{
    id: string
    expired_phase: RunStatus
  }>(sql`
    WITH due AS (
      SELECT id, status FROM report_runs
       WHERE status IN (${statuses})
         AND phase_deadline IS NOT NULL
         AND phase_deadline < now()
       ORDER BY phase_deadline
       FOR UPDATE SKIP LOCKED
       LIMIT ${SWEEP_LIMIT})
    UPDATE report_runs AS r
       SET status = 'failed',
           error_code = 'TIMEOUT',
           error_message = 'Phase ' || due.status || ' exceeded its deadline. '
             || 'The run was failed by the reaper, so no further progress '
             || 'callback for it will be accepted.',
           phase_deadline = NULL,
           progress_current = NULL,
           progress_total = NULL,
           progress_label = NULL,
           updated_at = now()
      FROM due
     WHERE r.id = due.id
    RETURNING r.id, due.status AS expired_phase
  `)

  return result.rows.map((row) => ({
    id: row.id,
    expiredPhase: row.expired_phase,
  }))
}

// --- The atomic claim -------------------------------------------------------

/**
 * One claimed run — everything the invocation needs, and nothing else.
 *
 * The subscription's credentials are **not** here: they are resolved separately, per
 * row, and decrypted at invoke time (Requirement 41.3). A claim result carrying a
 * plaintext Azure secret would be a plaintext Azure secret sitting in an array for
 * as long as the slowest invocation takes.
 */
export type ClaimedRun = {
  readonly id: string
  readonly userId: string
  readonly connectedSubscriptionId: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly timezone: string
  readonly scope: RunScope
  /**
   * The template version this run pinned at enqueue (Requirement 9.6), or `null`
   * for a foundation-era row that pins none.
   *
   * Carried on the claim because the invocation needs it: `generate_report` sends
   * the pinned version's id **and its definition inline**, and a run with no
   * definition is a snapshot-only run by the runtime's own contract. So a claim
   * that dropped this column would invoke every run as snapshot-only and no
   * document would ever be produced.
   *
   * `null` rather than absent, so "this row pins no version" is a value the
   * invocation branches on rather than a missing property it has to infer.
   */
  readonly templateVersionId: string | null
}

/**
 * Claim up to {@link CLAIM_LIMIT} `queued` rows for this tick (Requirements 39.4,
 * 39.5, 39.11).
 *
 * `FOR UPDATE SKIP LOCKED` is what makes concurrent ticks safe: the second tick
 * *steps over* rows the first has locked instead of waiting for them, so the two
 * claim disjoint sets and neither invokes a run the other already started. A plain
 * `SELECT … LIMIT 10` would hand both ticks the same ten rows.
 *
 * Rows the sweep just failed are excluded **by construction** rather than by a second
 * predicate: they no longer match `status = 'queued'`. That is why Requirement 39.11
 * orders the sweep before the claim — a `queued` row past its deadline must be failed
 * rather than claimed, and running the claim first would start an invocation for a
 * run that is about to be timed out.
 *
 * `claimedBy` is minted once per tick request by the caller (Requirement 39.4), so
 * every row in one claim carries the same value and a claim is attributable to a
 * claimer.
 *
 * `phase_deadline` is set in the **same statement**, from
 * {@link PHASE_DEADLINE_SECONDS}, so there is no window in which a claimed row has
 * no deadline and is therefore unsweepable.
 */
export async function claimQueuedRuns(
  claimedBy: string
): Promise<readonly ClaimedRun[]> {
  const claimedBudget = PHASE_DEADLINE_SECONDS.claimed
  if (claimedBudget === undefined) {
    // Unreachable — `claimed` is a key of that record — but the alternative is a
    // non-null assertion, which would be a claim this module cannot back.
    throw new Error(
      "[runs/claim] no phase deadline budget is declared for 'claimed'"
    )
  }

  const result = await getDb().execute<{
    id: string
    user_id: string
    connected_subscription_id: string
    period_start: string
    period_end: string
    timezone: string
    scope: RunScope
    template_version_id: string | null
  }>(sql`
    UPDATE report_runs
       SET status = 'claimed',
           claimed_at = now(),
           claimed_by = ${claimedBy},
           updated_at = now(),
           phase_deadline = now() + (${claimedBudget} || ' seconds')::interval
     WHERE id IN (
       SELECT id FROM report_runs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${CLAIM_LIMIT})
    RETURNING id, user_id, connected_subscription_id,
              period_start, period_end, timezone, scope, template_version_id
  `)

  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    connectedSubscriptionId: row.connected_subscription_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    timezone: row.timezone,
    scope: row.scope,
    templateVersionId: row.template_version_id,
  }))
}

// --- Re-reading a claimed row ----------------------------------------------

/**
 * Is this row still `claimed` (Requirement 41.9)?
 *
 * Read immediately before the invocation, and the reason is a specific double-invoke
 * this closes: between the claim and the invoke, the agent from a *previous* tick's
 * invocation of the same run could have posted `collecting`, or the sweep could have
 * failed it. Invoking a row that is no longer `claimed` would start a second
 * collection for one run — two containers, two sets of Azure calls, and a race to
 * write the terminal callback.
 *
 * Returns the row's current status, or `undefined` if the row vanished. The caller
 * skips the invoke for anything other than `claimed`.
 */
export async function readRunStatus(
  runId: string
): Promise<RunStatus | undefined> {
  const result = await getDb().execute<{ status: RunStatus }>(sql`
    SELECT status FROM report_runs WHERE id = ${runId} LIMIT 1
  `)

  return result.rows[0]?.status
}

// --- Failing a claimed row -------------------------------------------------

/**
 * Fail one claimed row, without a user scope (Requirements 39.10, 41.10).
 *
 * The reaper's gate uses this for the three cases that must not reach an invocation:
 * `scope_verified: false` → `SCOPE_UNVERIFIED`, an expired secret → `AUTH_EXPIRED`,
 * and a `client_secret_enc` that will not decrypt → `SECRET_UNREADABLE`.
 *
 * Not user-scoped, and named as an exception like `readRunForTokenHolder`: the tick
 * is authorized by a bearer secret and acts on rows it just claimed, so there is no
 * session to scope by. It is guarded on `status = 'claimed'` instead, which is the
 * scope that actually matters here — a row this tick did not claim is a row it must
 * not fail.
 *
 * `error_message` is passed by the caller and must exclude the ciphertext and the key
 * material (Requirement 41.10). This function does not construct it, so the exclusion
 * is asserted where the message is written rather than trusted here.
 */
export async function failClaimedRun(a: {
  runId: string
  errorCode: string
  errorMessage: string
}): Promise<boolean> {
  const result = await getDb().execute<{ id: string }>(sql`
    UPDATE report_runs
       SET status = 'failed',
           error_code = ${a.errorCode}::run_error_code,
           error_message = ${a.errorMessage},
           phase_deadline = NULL,
           progress_current = NULL,
           progress_total = NULL,
           progress_label = NULL,
           updated_at = now()
     WHERE id = ${a.runId} AND status = 'claimed'
    RETURNING id
  `)

  return result.rows.length === 1
}
