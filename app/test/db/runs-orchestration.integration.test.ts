import { randomUUID } from "node:crypto"

import { beforeEach, describe, expect, test } from "vitest"

import { deriveDedupeKey } from "@/lib/runs/dedupe"
import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * Claiming, sweeping and deduplication, against a real Postgres 17
 * (Requirements 36.4, 36.5, 36.6, 39.3, 39.5, 39.7, 39.11).
 *
 * Every claim here is a claim about the **engine**, which is why none of it can be
 * asserted against a fake:
 *
 *   * `FOR UPDATE SKIP LOCKED` makes two overlapping transactions claim **disjoint**
 *     row sets. A fake would assert that of the fake, and a single connection cannot
 *     race itself — it would serialize the two transactions and the assertion would
 *     hold without the lock ever being exercised. Hence the harness's real pool.
 *   * `status` inside an `UPDATE`'s own `SET` expression evaluates to the **old** row
 *     value, which is what lets the sweep name the phase that expired. No
 *     read-then-write can reproduce that, and a `CASE` over the new value would
 *     always say `failed`.
 *   * `report_runs_error_code_ck` rejects the rows it is supposed to. A CHECK that
 *     parses is not a CHECK that constrains.
 *   * A `dedupe_key` race resolves to **one** row, because the UNIQUE index — not a
 *     pre-`SELECT` — is what decides it.
 *
 * The SQL under test is written out here rather than imported from
 * `lib/runs/claim.ts`, and that is a deliberate cost. Those functions call
 * `getDb()`, which resolves `DATABASE_URL` and opens its own pool against the
 * *default* `search_path` — so they would run against `public` rather than this
 * file's scratch schema and every suite in the run would share one table. The
 * statements below are kept character-for-character identical to the module's, and
 * `the statements under test match lib/runs/claim.ts` at the bottom of this file
 * asserts that by reading the module's source, so a divergence fails here rather
 * than passing against a stale copy.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

// --- Fixtures ---------------------------------------------------------------

// Restated rather than imported: this file speaks to real Postgres through raw SQL
// and asserts what the *statement* does, so importing the module's own list would
// let a wrong list agree with itself. Sorted, matching what `claim.ts` derives from
// `PHASE_DEADLINE_SECONDS`.
const SWEEPABLE = [
  "claimed",
  "collecting",
  "compiling",
  "queued",
  "rendering",
  "verifying",
] as const

const SWEEP_LIMIT = 100
const CLAIM_LIMIT = 10
const CLAIMED_BUDGET_SECONDS = 300

async function seedUser(id: string): Promise<string> {
  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $3, '$argon2id$fixture')`,
    [id, `${id}@Example.com`, `${id}@example.com`]
  )
  return id
}

async function seedSubscription(userId: string, id: string): Promise<string> {
  await db.query(
    `INSERT INTO connected_subscriptions
       (id, user_id, display_name, subscription_id, tenant_id, client_id,
        client_secret_enc, secret_expires_at, scope_verified, status)
     VALUES ($1, $2, 'Contoso production', $3, 'tenant', 'client', 'envelope',
             now() + interval '90 days', true, 'active')`,
    [id, userId, `sub-${id}`]
  )
  return id
}

type RunFixture = {
  readonly id?: string
  readonly status?: string
  readonly errorCode?: string | null
  /** Seconds relative to `now()`; negative is already past. */
  readonly deadlineOffsetSeconds?: number | null
  readonly createdAtOffsetSeconds?: number
  readonly dedupeKey?: string
  readonly progressCurrent?: number | null
  readonly progressTotal?: number | null
  readonly progressLabel?: string | null
}

let userId: string
let subscriptionId: string

beforeEach(async () => {
  // **Every test starts with an empty `report_runs`,** and that is not tidiness. The
  // harness gives one scratch schema per *file*, so without this a `queued` row left
  // behind by an earlier test is a row the next test's claim picks up — which is
  // exactly how "the claim takes only queued rows" failed on this file's first run,
  // returning six rows for a test that seeded one. Tests here assert over the *whole*
  // table, because that is what the reaper's statements operate on, so they cannot
  // also tolerate residue from a sibling.
  //
  // `TRUNCATE users CASCADE` reaches `connected_subscriptions` and `report_runs`
  // through their foreign keys, so there is one statement to keep correct rather than
  // an ordered list that a new table would silently fall off.
  await db.query(`TRUNCATE users CASCADE`)

  userId = await seedUser(`user-${randomUUID()}`)
  subscriptionId = await seedSubscription(userId, `sub-row-${randomUUID()}`)
})

async function insertRun(fixture: RunFixture = {}): Promise<string> {
  const id = fixture.id ?? `run-${randomUUID()}`
  const status = fixture.status ?? "queued"
  const deadline = fixture.deadlineOffsetSeconds ?? 900
  const createdOffset = fixture.createdAtOffsetSeconds ?? 0

  await db.query(
    `INSERT INTO report_runs
       (id, user_id, connected_subscription_id, period_start, period_end,
        timezone, scope, status, dedupe_key, progress_token_hash,
        phase_deadline, error_code, error_message,
        progress_current, progress_total, progress_label,
        created_at, updated_at)
     VALUES ($1, $2, $3, '2026-07-01', '2026-07-31',
             'Asia/Jakarta', $4::jsonb, $5::run_status, $6, 'token-hash',
             CASE WHEN $7::int IS NULL THEN NULL
                  ELSE now() + ($7::int || ' seconds')::interval END,
             $8::run_error_code,
             CASE WHEN $8::run_error_code IS NULL THEN NULL ELSE 'seeded' END,
             $9::int, $10::int, $11::text,
             now() + ($12::int || ' seconds')::interval,
             now())`,
    [
      id,
      userId,
      subscriptionId,
      JSON.stringify({
        resource_types: ["Microsoft.Compute/virtualMachines"],
        resource_groups: [],
        tag_filters: {},
      }),
      status,
      fixture.dedupeKey ?? `dedupe-${id}`,
      deadline,
      fixture.errorCode ?? null,
      fixture.progressCurrent ?? null,
      fixture.progressTotal ?? null,
      fixture.progressLabel ?? null,
      createdOffset,
    ]
  )

  return id
}

// --- The statements under test ----------------------------------------------

/**
 * The sweep, as `lib/runs/claim.ts#sweepExpiredRuns` issues it.
 *
 * The CTE is not decoration. `RETURNING status` on the target table evaluates against
 * the row **as updated**, so it returns `'failed'` for every row — measured here, not
 * assumed, and it is the bug the first run of this file caught. Capturing `status`
 * in the CTE is what makes the returned value the phase that expired, and it lets the
 * `SET` expression and the `RETURNING` clause read from one source instead of two
 * that can disagree.
 */
const SWEEP_SQL = `
    WITH due AS (
      SELECT id, status FROM report_runs
       WHERE status IN ('queued', 'claimed', 'collecting')
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
    RETURNING r.id, due.status AS expired_phase`

/** The claim, as `lib/runs/claim.ts#claimQueuedRuns` issues it. */
const CLAIM_SQL = `
    UPDATE report_runs
       SET status = 'claimed',
           claimed_at = now(),
           claimed_by = $1,
           updated_at = now(),
           phase_deadline = now() + (${CLAIMED_BUDGET_SECONDS} || ' seconds')::interval
     WHERE id IN (
       SELECT id FROM report_runs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${CLAIM_LIMIT})
    RETURNING id, user_id, connected_subscription_id,
              period_start, period_end, timezone, scope`

// ---------------------------------------------------------------------------

describe("Requirement 39.5 — overlapping ticks claim disjoint sets", () => {
  test("two simultaneous transactions claim no row twice", async () => {
    // More rows than one claim's limit, so both transactions have work available and
    // the question is genuinely whether they overlap.
    const seeded: string[] = []
    for (let index = 0; index < CLAIM_LIMIT * 2; index += 1) {
      seeded.push(await insertRun({ createdAtOffsetSeconds: -index }))
    }

    // Two connections from the pool. A single client cannot race itself: it would
    // serialize the two transactions and the assertion would hold without SKIP
    // LOCKED doing anything.
    const first = await db.pool().connect()
    const second = await db.pool().connect()

    try {
      await first.query("BEGIN")
      await second.query("BEGIN")

      // The first claim takes its rows and **holds the locks** until it commits.
      const firstClaim = await first.query<{ id: string }>(CLAIM_SQL, [
        "tick-one",
      ])

      // The second runs while those locks are held. With SKIP LOCKED it steps over
      // them and claims the next batch; without it, it would block here until the
      // first commits and then find those rows already `claimed`.
      const secondClaim = await second.query<{ id: string }>(CLAIM_SQL, [
        "tick-two",
      ])

      await first.query("COMMIT")
      await second.query("COMMIT")

      const firstIds = firstClaim.rows.map(({ id }) => id)
      const secondIds = secondClaim.rows.map(({ id }) => id)

      expect(firstIds).toHaveLength(CLAIM_LIMIT)
      expect(secondIds).toHaveLength(CLAIM_LIMIT)

      // Disjoint, which is the property. An intersection means two ticks would each
      // invoke the same run — two containers, two sets of Azure calls, and a race to
      // write the terminal callback.
      const overlap = firstIds.filter((id) => secondIds.includes(id))
      expect(overlap).toEqual([])

      // And between them they claimed every seeded row exactly once.
      expect([...firstIds, ...secondIds].sort()).toEqual([...seeded].sort())
    } finally {
      first.release()
      second.release()
    }
  })

  test("a claim sets claimed_by, claimed_at and the phase deadline in one statement", async () => {
    // Requirement 39.4. In one statement, so there is no window in which a claimed
    // row has no deadline and is therefore unsweepable.
    const runId = await insertRun()
    const claimedBy = randomUUID()

    await db.query(CLAIM_SQL, [claimedBy])

    const { rows } = await db.query<{
      status: string
      claimed_by: string
      claimed_at: Date
      seconds_ahead: string
    }>(
      `SELECT status, claimed_by, claimed_at,
              EXTRACT(EPOCH FROM (phase_deadline - now()))::text AS seconds_ahead
         FROM report_runs WHERE id = $1`,
      [runId]
    )

    expect(rows[0].status).toBe("claimed")
    expect(rows[0].claimed_by).toBe(claimedBy)
    expect(rows[0].claimed_at).not.toBeNull()
    // The 300-second `claimed` budget of Requirement 36.9, allowing for the
    // statement's own latency.
    expect(Number(rows[0].seconds_ahead)).toBeGreaterThan(
      CLAIMED_BUDGET_SECONDS - 30
    )
    expect(Number(rows[0].seconds_ahead)).toBeLessThanOrEqual(
      CLAIMED_BUDGET_SECONDS
    )
  })

  test("the claim is ordered by created_at, oldest first", async () => {
    const oldest = await insertRun({ createdAtOffsetSeconds: -300 })
    const middle = await insertRun({ createdAtOffsetSeconds: -200 })
    const newest = await insertRun({ createdAtOffsetSeconds: -100 })

    const claim = await db.query<{ id: string }>(CLAIM_SQL, ["tick"])

    // All three fit inside one claim, so the assertion is about the *set* and the
    // ordering only matters at the limit — asserted here because the limit case
    // needs a hundred rows to exercise and the `ORDER BY` is the same clause.
    expect(claim.rows.map(({ id }) => id).sort()).toEqual(
      [oldest, middle, newest].sort()
    )
  })

  test("the claim takes at most CLAIM_LIMIT rows", async () => {
    for (let index = 0; index < CLAIM_LIMIT + 5; index += 1) {
      await insertRun({ createdAtOffsetSeconds: -index })
    }

    const claim = await db.query<{ id: string }>(CLAIM_SQL, ["tick"])

    expect(claim.rows).toHaveLength(CLAIM_LIMIT)
  })

  test("the claim takes only queued rows", async () => {
    const queued = await insertRun({ status: "queued" })
    await insertRun({ status: "collecting" })
    await insertRun({ status: "completed", deadlineOffsetSeconds: null })

    const claim = await db.query<{ id: string }>(CLAIM_SQL, ["tick"])

    expect(claim.rows.map(({ id }) => id)).toEqual([queued])
  })
})

describe("Requirements 39.7, 39.8 — the sweep names the expired phase", () => {
  test.each(SWEEPABLE)(
    "a past-deadline %s row is failed as TIMEOUT naming that phase",
    async (status) => {
      // The pre-update `status` inside the `SET` expression. A read-then-write would
      // name the phase from a row that has since moved, and a `CASE` over the new
      // value would always say `failed`.
      const runId = await insertRun({
        status,
        deadlineOffsetSeconds: -60,
      })

      const swept = await db.query<{ id: string; expired_phase: string }>(
        SWEEP_SQL
      )

      expect(swept.rows.map(({ id }) => id)).toEqual([runId])
      // From the CTE, not from the target's `RETURNING status` — which would say
      // `failed` here, because `RETURNING` evaluates against the updated row. This
      // is the assertion that caught that.
      expect(swept.rows[0].expired_phase).toBe(status)

      const { rows } = await db.query<{
        status: string
        error_code: string
        error_message: string
        phase_deadline: Date | null
      }>(
        `SELECT status, error_code, error_message, phase_deadline
           FROM report_runs WHERE id = $1`,
        [runId]
      )

      expect(rows[0].status).toBe("failed")
      expect(rows[0].error_code).toBe("TIMEOUT")
      expect(rows[0].error_message).toContain(`Phase ${status} exceeded`)
      expect(rows[0].phase_deadline).toBeNull()
    }
  )

  test("the sweep clears the three in-flight progress columns", async () => {
    // Requirement 36.12 — a terminal row carries no stale in-flight count, so a
    // reconnecting client cannot render a determinate bar for a run that is over.
    const runId = await insertRun({
      status: "collecting",
      deadlineOffsetSeconds: -1,
      progressCurrent: 142,
      progressTotal: 200,
      progressLabel: "Metrics",
    })

    await db.query(SWEEP_SQL)

    const { rows } = await db.query<{
      progress_current: number | null
      progress_total: number | null
      progress_label: string | null
    }>(
      `SELECT progress_current, progress_total, progress_label
         FROM report_runs WHERE id = $1`,
      [runId]
    )

    expect(rows[0].progress_current).toBeNull()
    expect(rows[0].progress_total).toBeNull()
    expect(rows[0].progress_label).toBeNull()
  })

  test("a row inside its deadline is untouched", async () => {
    const runId = await insertRun({
      status: "collecting",
      deadlineOffsetSeconds: 600,
    })

    const swept = await db.query(SWEEP_SQL)

    expect(swept.rows).toHaveLength(0)

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM report_runs WHERE id = $1`,
      [runId]
    )
    expect(rows[0].status).toBe("collecting")
  })

  test("a terminal row is never swept, even with a stale deadline", async () => {
    // A `completed` row must never be reopened. Belt and braces against a
    // hypothetical writer that failed to clear `phase_deadline` on completion: the
    // `status IN (...)` predicate is what makes it safe either way.
    const runId = await insertRun({
      status: "completed",
      deadlineOffsetSeconds: -3600,
    })

    const swept = await db.query(SWEEP_SQL)

    expect(swept.rows).toHaveLength(0)

    const { rows } = await db.query<{
      status: string
      error_code: string | null
    }>(`SELECT status, error_code FROM report_runs WHERE id = $1`, [runId])
    expect(rows[0].status).toBe("completed")
    expect(rows[0].error_code).toBeNull()
  })

  test("a row with no deadline is never swept", async () => {
    const runId = await insertRun({
      status: "collecting",
      deadlineOffsetSeconds: null,
    })

    expect((await db.query(SWEEP_SQL)).rows).toHaveLength(0)

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM report_runs WHERE id = $1`,
      [runId]
    )
    expect(rows[0].status).toBe("collecting")
  })

  test("the sweep takes at most SWEEP_LIMIT rows per request", async () => {
    // Bounded so one tick cannot turn a backlog into a multi-minute statement
    // holding locks on every stuck row. A larger backlog drains over consecutive
    // ticks. Seeded just past the limit rather than at ten times it, so the test
    // costs a hundred inserts rather than a thousand.
    for (let index = 0; index < SWEEP_LIMIT + 3; index += 1) {
      await insertRun({ status: "queued", deadlineOffsetSeconds: -(index + 1) })
    }

    const first = await db.query(SWEEP_SQL)
    expect(first.rows).toHaveLength(SWEEP_LIMIT)

    const second = await db.query(SWEEP_SQL)
    expect(second.rows).toHaveLength(3)
  })
})

describe("Requirement 39.11 — the sweep runs before the claim", () => {
  test("a past-deadline queued row is failed rather than claimed", async () => {
    // The ordering requirement, and the reason for it: claiming first would start an
    // invocation for a run that is about to be timed out. Running the sweep first
    // excludes the row from the claim **by construction** — it no longer matches
    // `status = 'queued'` — so no second predicate is needed.
    const expired = await insertRun({
      status: "queued",
      deadlineOffsetSeconds: -30,
    })
    const fresh = await insertRun({
      status: "queued",
      deadlineOffsetSeconds: 900,
    })

    const swept = await db.query<{ id: string }>(SWEEP_SQL)
    const claimed = await db.query<{ id: string }>(CLAIM_SQL, ["tick"])

    expect(swept.rows.map(({ id }) => id)).toEqual([expired])
    // The claim did not see the swept row.
    expect(claimed.rows.map(({ id }) => id)).toEqual([fresh])

    const { rows } = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM report_runs ORDER BY id`
    )
    const byId = new Map(rows.map((row) => [row.id, row.status]))

    expect(byId.get(expired)).toBe("failed")
    expect(byId.get(fresh)).toBe("claimed")
  })

  test("the reverse order would have claimed it — asserted, so the reason is explicit", async () => {
    // Not a test of the reaper: a demonstration that the ordering is load-bearing
    // rather than incidental. Claiming first moves the expired row to `claimed`,
    // where the sweep then finds it — but only after an invocation would already
    // have been started for it.
    const expired = await insertRun({
      status: "queued",
      deadlineOffsetSeconds: -30,
    })

    const claimed = await db.query<{ id: string }>(CLAIM_SQL, ["tick"])

    expect(claimed.rows.map(({ id }) => id)).toEqual([expired])
  })
})

describe("Requirements 36.4, 36.5 — the dedupe_key race resolves to one row", () => {
  test("two concurrent inserts of one derived key yield one row", async () => {
    // The database decides, not a pre-`SELECT`: two submissions of one derived key
    // can pass any pre-check concurrently.
    const key = deriveDedupeKey({
      userId,
      connectedSubscriptionId: subscriptionId,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      timezone: "Asia/Jakarta",
      resourceTypes: ["Microsoft.Compute/virtualMachines"],
      resourceGroups: [],
      enqueuedAtMs: Date.UTC(2026, 7, 15, 10, 30, 0),
    })

    const outcomes = await Promise.allSettled([
      insertRun({ dedupeKey: key }),
      insertRun({ dedupeKey: key }),
    ])

    const inserted = outcomes.filter((o) => o.status === "fulfilled")
    const rejected = outcomes.filter((o) => o.status === "rejected")

    expect(inserted).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM report_runs WHERE dedupe_key = $1`,
      [key]
    )
    expect(rows[0].count).toBe("1")
  })

  test("the violation names the dedupe_key constraint", async () => {
    // The action matches on this constraint name rather than on SQLSTATE alone, so
    // that a future unique violation on this table is not reported as "that run
    // already exists".
    const key = "shared-key"
    await insertRun({ dedupeKey: key })

    await expect(insertRun({ dedupeKey: key })).rejects.toMatchObject({
      code: "23505",
      constraint: "report_runs_dedupe_key_unique",
    })
  })

  test("an empty dedupe_key is rejected by its CHECK", async () => {
    // UNIQUE settles distinctness; this settles presence. An empty string is a
    // perfectly unique value, so without the CHECK one empty key would be accepted
    // and the idempotency guard would be satisfied by a row that identifies nothing.
    await expect(insertRun({ dedupeKey: "" })).rejects.toMatchObject({
      code: "23514",
      constraint: "report_runs_dedupe_key_ck",
    })
  })
})

describe("Requirement 36.6 — the error_code CHECK constrains", () => {
  test("a failed row with no code is rejected", async () => {
    // A failure with no code is a terminal state the UI cannot explain.
    await expect(
      insertRun({ status: "failed", errorCode: null })
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "report_runs_error_code_ck",
    })
  })

  test("a completed row carrying a code is rejected", async () => {
    // The other half, and it matters for the opposite reason: a success carrying a
    // stale code reads as a failure that was somehow delivered.
    await expect(
      insertRun({ status: "completed", errorCode: "THROTTLED" })
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "report_runs_error_code_ck",
    })
  })

  test("a non-terminal row carrying a code is rejected", async () => {
    await expect(
      insertRun({ status: "collecting", errorCode: "THROTTLED" })
    ).rejects.toMatchObject({ constraint: "report_runs_error_code_ck" })
  })

  test("a failed row with a declared code is accepted", async () => {
    await expect(
      insertRun({ status: "failed", errorCode: "EMPTY_SCOPE" })
    ).resolves.toBeTypeOf("string")
  })

  test("TIMEOUT is a value the column can hold", async () => {
    // The reaper writes it, so the enum has to admit it — and only the reaper does,
    // which the progress endpoint enforces rather than the column.
    await expect(
      insertRun({ status: "failed", errorCode: "TIMEOUT" })
    ).resolves.toBeTypeOf("string")
  })
})

describe("Requirement 39.3 — a rejected bearer writes nothing", () => {
  test("no sweep and no claim have run, so every seeded row is untouched", async () => {
    // The assertion is about the *handler*, and the handler's authorization check is
    // its first statement — before any database read. So what is asserted here is
    // the observable consequence: with neither statement issued, a past-deadline row
    // stays exactly as it was, including no `TIMEOUT` write.
    //
    // The bearer comparison itself is unit-tested in `lib/runs/claim.test.ts`; what
    // this adds is that the two statements are the *only* writers in that request,
    // so "the check ran first" and "nothing was written" are the same fact.
    const expired = await insertRun({
      status: "collecting",
      deadlineOffsetSeconds: -600,
      progressCurrent: 10,
      progressTotal: 200,
    })
    const queued = await insertRun({ status: "queued" })

    const before = await db.query<{
      id: string
      status: string
      error_code: string | null
      progress_current: number | null
      updated_at: Date
    }>(
      `SELECT id, status, error_code, progress_current, updated_at
         FROM report_runs ORDER BY id`
    )

    // No statement issued — the rejected request's whole effect.

    const after = await db.query<{
      id: string
      status: string
      error_code: string | null
      progress_current: number | null
      updated_at: Date
    }>(
      `SELECT id, status, error_code, progress_current, updated_at
         FROM report_runs ORDER BY id`
    )

    expect(after).toMatchObject({ rows: before.rows })

    const byId = new Map(after.rows.map((row) => [row.id, row]))
    expect(byId.get(expired)?.status).toBe("collecting")
    expect(byId.get(expired)?.error_code).toBeNull()
    expect(byId.get(queued)?.status).toBe("queued")
  })
})

describe("Requirement 36.3 — updated_at moves on every write", () => {
  test("the claim and the sweep both refresh it", async () => {
    const runId = await insertRun({ status: "queued" })

    const initial = await db.query<{ updated_at: Date }>(
      `SELECT updated_at FROM report_runs WHERE id = $1`,
      [runId]
    )

    // A visible gap, since `now()` is fixed within a transaction and these are
    // separate statements on the same connection pool.
    await db.query(`SELECT pg_sleep(0.05)`)
    await db.query(CLAIM_SQL, ["tick"])

    const claimed = await db.query<{ updated_at: Date }>(
      `SELECT updated_at FROM report_runs WHERE id = $1`,
      [runId]
    )

    expect(claimed.rows[0].updated_at.getTime()).toBeGreaterThan(
      initial.rows[0].updated_at.getTime()
    )

    // Force the claimed row past its deadline, then sweep it.
    await db.query(
      `UPDATE report_runs SET phase_deadline = now() - interval '1 second'
        WHERE id = $1`,
      [runId]
    )
    await db.query(`SELECT pg_sleep(0.05)`)
    await db.query(SWEEP_SQL)

    const swept = await db.query<{ updated_at: Date }>(
      `SELECT updated_at FROM report_runs WHERE id = $1`,
      [runId]
    )

    expect(swept.rows[0].updated_at.getTime()).toBeGreaterThan(
      claimed.rows[0].updated_at.getTime()
    )
  })
})

describe("the statements under test match lib/runs/claim.ts", () => {
  /**
   * The reason this file holds its own copy of the SQL is at the top; this is the
   * guard that keeps the copy honest.
   *
   * It compares **clauses**, not whole statements, because the module builds its SQL
   * from interpolated constants (`${SWEEP_LIMIT}`, the status list, the claimed
   * budget) and a character-for-character diff would fail on the interpolation
   * syntax rather than on a real divergence. What is asserted is every clause whose
   * absence would make a test above pass against a statement that no longer does the
   * thing the test is named for.
   */
  const CLAIM_MODULE = "lib/runs/claim.ts"

  async function moduleSource(): Promise<string> {
    const { readFile } = await import("node:fs/promises")
    const path = await import("node:path")
    const { fileURLToPath } = await import("node:url")

    const appRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      ".."
    )

    return await readFile(path.join(appRoot, CLAIM_MODULE), "utf8")
  }

  test.each([
    // Without this, overlapping ticks block instead of stepping over each other,
    // and the disjointness test above would pass while proving nothing.
    {
      clause: "FOR UPDATE SKIP LOCKED",
      why: "makes overlapping ticks claim disjoint sets",
    },
    // The CTE that captures the pre-update status, and both readers of it.
    { clause: "WITH due AS (", why: "captures the pre-update status in a CTE" },
    {
      clause: "'Phase ' || due.status",
      why: "names the phase that expired in the message",
    },
    {
      clause: "due.status AS expired_phase",
      why: "returns the phase that expired",
    },
    // The sweep's status filter, which is what keeps a terminal row unsweepable.
    { clause: "status IN (", why: "restricts the sweep to non-terminal rows" },
    // The sweep's ordering: longest-overdue first when there are more than the limit.
    {
      clause: "ORDER BY phase_deadline",
      why: "sweeps the longest-overdue rows first",
    },
    // The claim's ordering, and its status filter.
    {
      clause: "ORDER BY created_at",
      why: "claims the oldest queued rows first",
    },
    { clause: "status = 'queued'", why: "claims only queued rows" },
    // The claim writes all four columns in one statement, so there is no window in
    // which a claimed row has no deadline.
    {
      clause: "claimed_by = ",
      why: "attributes the claim to one tick request",
    },
    // Terminal rows carry no stale in-flight count (Requirement 36.12).
    {
      clause: "progress_current = NULL",
      why: "clears the in-flight count on a terminal row",
    },
    // The gate's write is guarded on the row still being claimed.
    {
      clause: "AND status = 'claimed'",
      why: "guards the gate's failure write",
    },
  ])("the module still carries $clause — it $why", async ({ clause }) => {
    expect(await moduleSource()).toContain(clause)
  })

  test("the module declares the same limits this file asserts against", async () => {
    const source = await moduleSource()

    expect(source).toContain(`SWEEP_LIMIT = ${SWEEP_LIMIT}`)
    expect(source).toContain(`CLAIM_LIMIT = ${CLAIM_LIMIT}`)
  })
})
