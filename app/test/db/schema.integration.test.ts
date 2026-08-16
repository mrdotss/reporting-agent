import { describe, expect, test } from "vitest"

import {
  fidelityTier,
  runErrorCode,
  runStatus,
  subscriptionStatus,
} from "@/lib/db/schema"
import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * The generated migration, applied into a real Postgres 17 and then interrogated
 * (Requirements 9.1, 9.4, 9.6, 36.1, 36.3, 36.4, 36.6, 36.12).
 *
 * This is deliberately **not** the static migration guard of task 2.2. That one
 * parses the SQL text and enforces that the schema only grows; this one asks the
 * engine what it actually built, which is the only way to establish the two
 * claims the schema rests on and text cannot settle:
 *
 *   * a `pgEnum` is a real type whose value list the database enforces, not a
 *     TypeScript union that vanishes at build time (Requirements 9.6, 36.1);
 *   * `report_runs_error_code_ck` rejects the rows it is supposed to reject
 *     (Requirement 36.6). A CHECK that parses is not a CHECK that constrains.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

/** The declared value lists, imported rather than restated: a test holding its
 * own copy of an enum passes while the schema and the requirement disagree. */
const DECLARED_ENUMS: readonly (readonly [string, readonly string[]])[] = [
  ["subscription_status", subscriptionStatus.enumValues],
  ["fidelity_tier", fidelityTier.enumValues],
  ["run_status", runStatus.enumValues],
  ["run_error_code", runErrorCode.enumValues],
]

/**
 * Scoped to **this file's** scratch schema, and the join is load-bearing rather
 * than tidy.
 *
 * `pg_type.typname` is unique per namespace, not per cluster. Every scratch
 * schema in a run applies the same migration, so every one of them holds its own
 * `run_status` — and a `WHERE typname = $1` on its own returns the labels of all
 * of them concatenated, as soon as two database suites overlap. That reads as
 * "the enum has 16 values", which is a confusing failure about a correct schema,
 * and it passes or fails depending on which files happen to be in flight.
 */
async function enumValues(typeName: string): Promise<string[]> {
  const result = await db.query<{ label: string }>(
    `SELECT e.enumlabel AS label
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typname = $2
      ORDER BY e.enumsortorder`,
    [db.schemaName, typeName]
  )
  return result.rows.map(({ label }) => label)
}

/** A committed user, so the FK-bearing inserts below have a parent row. */
async function seedUser(id: string): Promise<string> {
  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [id, `${id}@Example.com`, `${id}@example.com`, `$argon2id$fixture`]
  )
  return id
}

async function seedSubscription(userId: string, id: string): Promise<string> {
  await db.query(
    `INSERT INTO connected_subscriptions
       (id, user_id, display_name, subscription_id, tenant_id, client_id,
        client_secret_enc, secret_expires_at)
     VALUES ($1, $2, 'Contoso production', $3, 'tenant', 'client', 'envelope',
             now() + interval '90 days')`,
    [id, userId, `sub-${id}`]
  )
  return id
}

/**
 * One `report_runs` insert, with only the status/error pair varying. Everything
 * else is fixed so a rejection can only be about the CHECK under test.
 */
async function insertRun(
  subscriptionId: string,
  userId: string,
  runId: string,
  status: string,
  errorCode: string | null
): Promise<void> {
  await db.query(
    `INSERT INTO report_runs
       (id, user_id, connected_subscription_id, period_start, period_end,
        scope, status, dedupe_key, progress_token_hash, error_code)
     VALUES ($1, $2, $3, '2026-07-01', '2026-07-31',
             $4::jsonb, $5::run_status, $6, 'token-hash', $7::run_error_code)`,
    [
      runId,
      userId,
      subscriptionId,
      JSON.stringify({
        resource_types: ["Microsoft.Compute/virtualMachines"],
        resource_groups: [],
        tag_filters: {},
      }),
      status,
      `dedupe-${runId}`,
      errorCode,
    ]
  )
}

describe("the migration applies", () => {
  test("at least one migration file was applied", () => {
    // Guards the case this whole file would otherwise pass through silently: an
    // empty migrations directory yields an empty scratch schema, and every
    // assertion below would then fail for a confusing reason instead of this one.
    expect(db.appliedMigrations().length).toBeGreaterThan(0)
  })

  test("the eight tables exist in the scratch schema", async () => {
    const result = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
      [db.schemaName]
    )

    expect(result.rows.map(({ tablename }) => tablename)).toEqual([
      "connected_subscriptions",
      "login_attempts",
      "report_runs",
      "report_template_versions",
      "report_templates",
      "report_verifications",
      "sessions",
      "users",
    ])
  })
})

describe("Requirements 9.6, 36.1 — the enums are real Postgres types", () => {
  test.each(DECLARED_ENUMS)(
    "%s carries its declared values in order",
    async (typeName, declared) => {
      expect(await enumValues(typeName)).toEqual([...declared])
    }
  )

  test("run_error_code excludes PARTIAL_COVERAGE", async () => {
    // It is an event code on a run that *completes* with recorded gaps, never a
    // failed row's code. Admitting it here would let a report with gaps be filed
    // as a failure instead of surfaced with its gap list.
    const values = await enumValues("run_error_code")

    expect(values).not.toContain("PARTIAL_COVERAGE")
    // Requirement 36.6's ten, plus Requirement 41.2's six document-phase codes.
    expect(values).toHaveLength(16)
  })

  test("run_error_code grew by addition, keeping the ten it already had", async () => {
    // Requirement 41.2 read as a property of the *type*, not of `schema.ts`: the
    // six new values were appended with `ALTER TYPE ... ADD VALUE`, so the
    // foundation's ten are still present and still in their original positions.
    // A drop-and-recreate would satisfy the length check above and fail this one.
    expect((await enumValues("run_error_code")).slice(0, 10)).toEqual([
      "AUTH_EXPIRED",
      "AUTH_FAILED",
      "SCOPE_UNVERIFIED",
      "SECRET_UNREADABLE",
      "EMPTY_SCOPE",
      "CATALOG_UNUSABLE",
      "NO_STATISTICS",
      "REGION_UNREACHABLE",
      "THROTTLED",
      "TIMEOUT",
    ])
  })

  test("an undeclared status is rejected by the database", async () => {
    // The point of a pgEnum over `text`: this rejection happens for every
    // writer, including one that is not this app.
    await expect(db.query(`SELECT 'colecting'::run_status`)).rejects.toThrow(
      /invalid input value for enum/i
    )
  })
})

describe("Requirement 36.6 — report_runs_error_code_ck constrains the pair", () => {
  test("a failed row must carry a code and a completed row must not", async () => {
    const userId = await seedUser("usr_ck")
    const subscriptionId = await seedSubscription(userId, "sub_ck")

    // Accepted: the two halves the state machine actually writes.
    await insertRun(
      subscriptionId,
      userId,
      "run_ok_failed",
      "failed",
      "TIMEOUT"
    )
    await insertRun(subscriptionId, userId, "run_ok_done", "completed", null)
    await insertRun(subscriptionId, userId, "run_ok_queued", "queued", null)

    // Rejected: a failure the UI cannot explain …
    await expect(
      insertRun(subscriptionId, userId, "run_bad_failed", "failed", null)
    ).rejects.toThrow(/report_runs_error_code_ck/)

    // … and a success carrying a code, which reads as a delivered failure.
    await expect(
      insertRun(
        subscriptionId,
        userId,
        "run_bad_done",
        "completed",
        "EMPTY_SCOPE"
      )
    ).rejects.toThrow(/report_runs_error_code_ck/)
  })

  test("Requirement 41.2 — each document-phase code is a value the column holds", async () => {
    // The agent writes one of these on the terminal transition out of the compile,
    // render or verify phase, so a `failed` row has to be able to carry each of
    // them. Asserted against the column rather than against `schema.ts`, because
    // the enum is only added to the type by the migration — a value present in the
    // TypeScript array and absent from the type fails here and nowhere else.
    const userId = await seedUser("usr_phase_codes")
    const subscriptionId = await seedSubscription(userId, "sub_phase_codes")

    for (const code of [
      "TEMPLATE_INVALID",
      "COMPILE_FAILED",
      "RENDER_FAILED",
      "PDF_CONVERSION_FAILED",
      "VERIFICATION_FAILED",
      "REPLAY_MISMATCH",
    ]) {
      await expect(
        insertRun(subscriptionId, userId, `run_${code}`, "failed", code)
      ).resolves.toBeUndefined()
    }
  })

  test("Requirement 36.4 — dedupe_key is unique and non-empty", async () => {
    const userId = await seedUser("usr_dk")
    const subscriptionId = await seedSubscription(userId, "sub_dk")

    await insertRun(subscriptionId, userId, "run_dk_1", "queued", null)

    // UNIQUE settles distinctness …
    await expect(
      db.query(
        `INSERT INTO report_runs
           (id, user_id, connected_subscription_id, period_start, period_end,
            scope, dedupe_key, progress_token_hash)
         VALUES ('run_dk_2', $1, $2, '2026-07-01', '2026-07-31',
                 '{}'::jsonb, 'dedupe-run_dk_1', 'token-hash')`,
        [userId, subscriptionId]
      )
    ).rejects.toThrow(/dedupe_key/)

    // … and the CHECK settles presence: an empty string is perfectly unique.
    await expect(
      db.query(
        `INSERT INTO report_runs
           (id, user_id, connected_subscription_id, period_start, period_end,
            scope, dedupe_key, progress_token_hash)
         VALUES ('run_dk_3', $1, $2, '2026-07-01', '2026-07-31',
                 '{}'::jsonb, '', 'token-hash')`,
        [userId, subscriptionId]
      )
    ).rejects.toThrow(/report_runs_dedupe_key_ck/)
  })
})

describe("Requirement 9.1 — nullability on connected_subscriptions", () => {
  test("log_analytics_workspace_id is the only nullable column", async () => {
    const result = await db.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'connected_subscriptions'
          AND is_nullable = 'YES'
        ORDER BY column_name`,
      [db.schemaName]
    )

    expect(result.rows.map(({ column_name }) => column_name)).toEqual([
      "log_analytics_workspace_id",
    ])
  })

  test("scope_verified defaults to false", async () => {
    // Preflight is its only writer of `true`; it is never inferred from a
    // successful inventory query, which is itself RBAC-filtered.
    const userId = await seedUser("usr_sv")
    const subscriptionId = await seedSubscription(userId, "sub_sv")

    const result = await db.query<{
      scope_verified: boolean
      status: string
      fidelity_tier: string
    }>(
      `SELECT scope_verified, status, fidelity_tier
         FROM connected_subscriptions WHERE id = $1`,
      [subscriptionId]
    )

    expect(result.rows[0]).toEqual({
      scope_verified: false,
      status: "pending",
      fidelity_tier: "baseline",
    })
  })
})

describe("Requirement 36.12 — the in-flight progress columns are nullable", () => {
  test("a run inserts with all three absent", async () => {
    const userId = await seedUser("usr_pg")
    const subscriptionId = await seedSubscription(userId, "sub_pg")

    await insertRun(subscriptionId, userId, "run_pg_1", "queued", null)

    const result = await db.query<{
      progress_current: number | null
      progress_total: number | null
      progress_label: string | null
    }>(
      `SELECT progress_current, progress_total, progress_label
         FROM report_runs WHERE id = 'run_pg_1'`
    )

    expect(result.rows[0]).toEqual({
      progress_current: null,
      progress_total: null,
      progress_label: null,
    })
  })
})

describe("the declared constraints and indexes exist", () => {
  test("every UNIQUE constraint from the design is present", async () => {
    const result = await db.query<{ conname: string }>(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = $1 AND c.contype = 'u'
        ORDER BY c.conname`,
      [db.schemaName]
    )
    const names = result.rows.map(({ conname }) => conname)

    expect(names).toEqual([
      "connected_subscriptions_user_id_subscription_id_uq",
      "report_runs_dedupe_key_unique",
      "report_template_versions_template_id_version_uq",
      "report_templates_user_id_seeded_starter_key_uq",
      "report_verifications_run_id_attempt_id_uq",
      "sessions_session_token_hash_unique",
      "users_email_normalized_unique",
    ])
  })

  test("login_attempts is indexed by email with created_at descending", async () => {
    // The direction is part of the index because it is part of the query: the
    // lockout read wants the newest failures for one email and nothing older.
    const result = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1
          AND indexname = 'login_attempts_email_normalized_created_at_idx'`,
      [db.schemaName]
    )

    // Postgres spells out the null ordering a descending key implies, so match
    // the key list rather than the whole rendered definition.
    expect(result.rows[0]?.indexdef).toMatch(
      /\(email_normalized, created_at DESC\b/
    )
  })

  test("report_runs carries the reaper's two indexes", async () => {
    const result = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'report_runs'
        ORDER BY indexname`,
      [db.schemaName]
    )
    const names = result.rows.map(({ indexname }) => indexname)

    expect(names).toContain("report_runs_status_created_at_idx")
    expect(names).toContain("report_runs_phase_deadline_idx")
  })
})
