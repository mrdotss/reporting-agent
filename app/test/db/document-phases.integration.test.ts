import { randomUUID } from "node:crypto"

import { beforeEach, describe, expect, test } from "vitest"

import { DRIVEN, PHASE_DEADLINE_SECONDS } from "@/lib/runs/state"
import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * The extended transition table, the `verifying → completed` precondition and the
 * verification callback's idempotency, against a real Postgres 17 (Requirements
 * 41.1, 41.2, 41.5, 41.7).
 *
 * Four of these cannot be asserted anywhere else:
 *
 *   * The **precondition** on `verifying → completed` is a `SELECT` and an `UPDATE`
 *     inside one transaction. Its whole content is what happens when another writer
 *     interleaves, and a fake has no other writer.
 *   * The **idempotency** of a retried verification callback is the
 *     `(run_id, attempt_id)` UNIQUE index deciding it, not a pre-`SELECT`. A test
 *     that checked first would assert its own check.
 *   * `PDF_CONVERSION_FAILED` **adding no status value** is a claim about the
 *     `run_status` enum, which only the engine holds.
 *   * A **terminal row rejecting every target** is enforced by the guarded write's
 *     `AND status = $expected` predicate, which is a statement, not a branch.
 *
 * The SQL is written out here rather than imported, for the reason
 * `runs-orchestration.integration.test.ts` explains at length: the modules call
 * `getDb()`, which opens its own pool against the default `search_path` and would
 * run against `public` rather than this file's scratch schema.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

const UNUSABLE_PASSWORD_HASH = "$argon2id$fixture-never-verified"

const DOCUMENT_PHASES = ["compiling", "rendering", "verifying"] as const

const SHA = {
  snapshot: "a".repeat(64),
  docx: "b".repeat(64),
  pdf: "c".repeat(64),
}

let userId: string
let subscriptionId: string
let templateVersionId: string

beforeEach(async () => {
  if (!db.enabled) return

  await db.query(`TRUNCATE users CASCADE`)
  await db.query(`TRUNCATE report_templates CASCADE`)

  userId = randomUUID()
  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [userId, "owner@example.com", "owner@example.com", UNUSABLE_PASSWORD_HASH]
  )

  subscriptionId = randomUUID()
  await db.query(
    `INSERT INTO connected_subscriptions
       (id, user_id, display_name, subscription_id, tenant_id, client_id,
        client_secret_enc, secret_expires_at, scope_verified, status)
     VALUES ($1, $2, 'Contoso production', $3, 'tenant', 'client', 'envelope',
             now() + interval '90 days', true, 'active')`,
    [subscriptionId, userId, `sub-${subscriptionId}`]
  )

  const templateId = randomUUID()
  await db.query(
    `INSERT INTO report_templates (id, user_id, name)
     VALUES ($1, $2, 'Monthly utilization')`,
    [templateId, userId]
  )

  templateVersionId = randomUUID()
  await db.query(
    `INSERT INTO report_template_versions
       (id, template_id, version, definition, definition_sha256)
     VALUES ($1, $2, 1, '{}'::jsonb, $3)`,
    [templateVersionId, templateId, "0".repeat(64)]
  )
})

/**
 * One run in `status`, satisfying `report_runs_error_code_ck` for that status.
 *
 * A terminal row carries no `phase_deadline` and a `failed` row carries a code, and
 * both are database CHECKs rather than conventions — so a fixture that ignored them
 * would fail on the insert rather than on the thing under test.
 */
async function insertRun(status: string): Promise<string> {
  const id = `run-${randomUUID()}`
  const terminal = status === "completed" || status === "failed"
  await db.query(
    `INSERT INTO report_runs
       (id, user_id, connected_subscription_id, period_start, period_end,
        timezone, scope, status, dedupe_key, progress_token_hash,
        phase_deadline, error_code, error_message)
     VALUES ($1, $2, $3, '2026-07-01', '2026-07-31', 'Asia/Jakarta',
             $4::jsonb, $5::run_status, $6, 'token-hash',
             CASE WHEN $7::bool THEN NULL
                  ELSE now() + interval '600 seconds' END,
             $8::run_error_code,
             CASE WHEN $8::run_error_code IS NULL THEN NULL ELSE 'seeded' END)`,
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
      `dedupe-${id}`,
      terminal,
      status === "failed" ? "COMPILE_FAILED" : null,
    ]
  )
  return id
}

async function insertVerification(
  runId: string,
  status: "pass" | "fail",
  attemptId = `att-${randomUUID()}`
): Promise<void> {
  await db.query(
    `INSERT INTO report_verifications
       (id, run_id, attempt_id, template_version_id, status, figure_count,
        snapshot_sha256, docx_sha256, pdf_sha256, replay, drift_sample,
        findings, counts, artifact_key)
     VALUES ($1, $2, $3, $4, $5::verification_status, 12,
             $6, $7, $8, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, $9)`,
    [
      randomUUID(),
      runId,
      attemptId,
      templateVersionId,
      status,
      SHA.snapshot,
      SHA.docx,
      SHA.pdf,
      `${userId}/reports/${runId}/verification-${attemptId}.json`,
    ]
  )
}

/**
 * The guarded write, as `lib/runs/state.ts#applyRunWriteIfStatus` issues it.
 *
 * The `AND status = $expected` predicate is what makes a terminal row unreachable:
 * a decision made against a status the row no longer carries matches nothing rather
 * than reopening a swept `failed` row.
 */
const GUARDED_WRITE = `
    UPDATE report_runs
       SET status = $3::run_status,
           error_code = CASE WHEN $3 = 'failed' THEN 'COMPILE_FAILED'::run_error_code
                             ELSE NULL END,
           error_message = CASE WHEN $3 = 'failed' THEN 'seeded' ELSE NULL END,
           phase_deadline = CASE WHEN $3 IN ('completed', 'failed') THEN NULL
                                 ELSE now() + interval '600 seconds' END,
           updated_at = now()
     WHERE id = $1 AND status = $2::run_status
    RETURNING id, status`

/**
 * `applyVerifiedCompletion`, as one transaction.
 *
 * The `SELECT` and the `UPDATE` are inside `BEGIN … COMMIT` deliberately. Without
 * that there is a real interleaving where the `SELECT` sees a `pass` row a concurrent
 * transaction then rolls back, and the `UPDATE` commits `completed` against a
 * verification that no longer exists.
 */
async function applyVerifiedCompletion(
  runId: string,
  expected: string
): Promise<string | undefined> {
  const client = await db.pool().connect()
  try {
    await client.query("BEGIN")
    const proof = await client.query(
      `SELECT id FROM report_verifications
        WHERE run_id = $1 AND status = 'pass' LIMIT 1`,
      [runId]
    )
    if (proof.rowCount === 0) {
      await client.query("ROLLBACK")
      return undefined
    }
    const written = await client.query<{ status: string }>(
      `UPDATE report_runs SET status = 'completed', updated_at = now()
        WHERE id = $1 AND status = $2::run_status
       RETURNING status`,
      [runId, expected]
    )
    await client.query("COMMIT")
    return written.rows[0]?.status
  } finally {
    client.release()
  }
}

// --- Requirement 41.1, 41.2 — the table, over every pair --------------------

describe("Requirement 41.1 — the extended transition table", () => {
  const STATUSES = Object.keys(DRIVEN) as (keyof typeof DRIVEN)[]

  test("every driven pair the table declares is accepted by the guarded write", async () => {
    for (const from of STATUSES) {
      for (const to of DRIVEN[from]) {
        // `verifying → completed` has a precondition beyond the table and is
        // asserted separately below; here it would pass for the wrong reason.
        if (from === "verifying" && to === "completed") continue

        const runId = await insertRun(from)
        const written = await db.query<{ status: string }>(GUARDED_WRITE, [
          runId,
          from,
          to,
        ])

        expect(written.rows[0]?.status, `${from} → ${to}`).toBe(to)
      }
    }
  })

  test("every terminal row rejects every target", async () => {
    for (const from of ["completed", "failed"] as const) {
      for (const to of STATUSES) {
        const runId = await insertRun(from)
        // The row is terminal, so the *decision* never reaches a write — but the
        // write is guarded on the status anyway, and this asserts the second line
        // of defence rather than the first. A caller that skipped the decision
        // still cannot move a finished run.
        const written = await db.query<{ status: string }>(GUARDED_WRITE, [
          runId,
          "collecting",
          to,
        ])

        expect(written.rowCount, `${from} → ${to}`).toBe(0)
      }
    }
  })

  test("a pair the table does not declare moves nothing", async () => {
    // `collecting → verifying` is the interesting one: skipping two phases would
    // leave a run reporting a verification of a document nothing rendered.
    const runId = await insertRun("collecting")

    const written = await db.query(GUARDED_WRITE, [runId, "compiling", "verifying"])

    expect(written.rowCount).toBe(0)
    expect(DRIVEN.collecting).not.toContain("verifying")
  })

  test("every non-terminal status carries a phase budget", () => {
    // A status with no budget is a row the reaper has no deadline for, which is a
    // row that sits in that phase forever when its container dies.
    for (const status of STATUSES) {
      const terminal = status === "completed" || status === "failed"
      expect(
        PHASE_DEADLINE_SECONDS[status] === undefined,
        `${status} budget`
      ).toBe(terminal)
    }
  })
})

// --- Requirement 41.1 — the precondition ------------------------------------

describe("Requirement 41.1 — verifying → completed needs its proof", () => {
  test("it is refused when no verification row exists", async () => {
    const runId = await insertRun("verifying")

    expect(await applyVerifiedCompletion(runId, "verifying")).toBeUndefined()

    const row = await db.query<{ status: string }>(
      `SELECT status FROM report_runs WHERE id = $1`,
      [runId]
    )
    expect(row.rows[0].status).toBe("verifying")
  })

  test("it is refused when the only verification failed", async () => {
    // The near miss, and the one that matters: a run whose verification ran and
    // said no must not reach the status the download control keys off.
    const runId = await insertRun("verifying")
    await insertVerification(runId, "fail")

    expect(await applyVerifiedCompletion(runId, "verifying")).toBeUndefined()
  })

  test("it is accepted when a passing verification exists", async () => {
    const runId = await insertRun("verifying")
    await insertVerification(runId, "pass")

    expect(await applyVerifiedCompletion(runId, "verifying")).toBe("completed")
  })

  test("a passing verification for a different run does not unlock this one", async () => {
    const runId = await insertRun("verifying")
    const other = await insertRun("verifying")
    await insertVerification(other, "pass")

    expect(await applyVerifiedCompletion(runId, "verifying")).toBeUndefined()
  })

  test("a pass among failures unlocks it", async () => {
    // A re-verification that succeeded after an earlier attempt failed. Nothing
    // updates or deletes an earlier row, so the predicate has to be "any pass"
    // rather than "the latest".
    const runId = await insertRun("verifying")
    await insertVerification(runId, "fail")
    await insertVerification(runId, "pass")
    await insertVerification(runId, "fail")

    expect(await applyVerifiedCompletion(runId, "verifying")).toBe("completed")
  })
})

// --- Requirement 41.5 — the callback is idempotent --------------------------

describe("Requirement 41.5 — a retried verification callback", () => {
  test("(run_id, attempt_id) is unique, so a retry inserts nothing new", async () => {
    const runId = await insertRun("verifying")
    const attemptId = "att-retried"

    await insertVerification(runId, "pass", attemptId)
    await expect(
      insertVerification(runId, "pass", attemptId)
    ).rejects.toThrow(/duplicate key|unique/i)

    const count = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM report_verifications WHERE run_id = $1`,
      [runId]
    )
    expect(count.rows[0].n).toBe("1")
  })

  test("a genuine re-verification mints a new attempt and both rows survive", async () => {
    const runId = await insertRun("verifying")

    await insertVerification(runId, "fail", "att-1")
    await insertVerification(runId, "pass", "att-2")

    const rows = await db.query<{ attempt_id: string; status: string }>(
      `SELECT attempt_id, status FROM report_verifications
        WHERE run_id = $1 ORDER BY attempt_id`,
      [runId]
    )
    expect(rows.rows.map((r) => r.attempt_id)).toEqual(["att-1", "att-2"])
    expect(rows.rows.map((r) => r.status)).toEqual(["fail", "pass"])
  })

  test("two different runs may each mint the same attempt id", async () => {
    // Which is why the UNIQUE is on the pair rather than on `attempt_id` alone.
    const first = await insertRun("verifying")
    const second = await insertRun("verifying")

    await insertVerification(first, "pass", "att-1")
    await insertVerification(second, "pass", "att-1")

    const count = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM report_verifications`
    )
    expect(count.rows[0].n).toBe("2")
  })
})

// --- Requirement 41.7 — PDF conversion adds no status -----------------------

describe("Requirement 41.7 — PDF_CONVERSION_FAILED arrives from rendering", () => {
  test("the transition lands and the run_status enum gained no value for it", async () => {
    const runId = await insertRun("rendering")

    await db.query(
      `UPDATE report_runs
          SET status = 'failed', error_code = 'PDF_CONVERSION_FAILED',
              error_message = 'the conversion produced no readable page',
              phase_deadline = NULL, updated_at = now()
        WHERE id = $1 AND status = 'rendering'`,
      [runId]
    )

    const row = await db.query<{ status: string; error_code: string }>(
      `SELECT status, error_code FROM report_runs WHERE id = $1`,
      [runId]
    )
    expect(row.rows[0]).toEqual({
      status: "failed",
      error_code: "PDF_CONVERSION_FAILED",
    })

    // Conversion is the second half of rendering. Giving it a status would migrate
    // the enum for a phase whose failure the error code already names.
    const statuses = await db.query<{ label: string }>(
      `SELECT unnest(enum_range(NULL::run_status))::text AS label`
    )
    expect(statuses.rows.map((r) => r.label).sort()).toEqual([
      "claimed",
      "collecting",
      "compiling",
      "completed",
      "failed",
      "queued",
      "rendering",
      "verifying",
    ])
  })

  test("every document-phase error code is a value the enum holds", async () => {
    const codes = await db.query<{ label: string }>(
      `SELECT unnest(enum_range(NULL::run_error_code))::text AS label`
    )
    const held = new Set(codes.rows.map((r) => r.label))

    for (const code of [
      "TEMPLATE_INVALID",
      "COMPILE_FAILED",
      "RENDER_FAILED",
      "PDF_CONVERSION_FAILED",
      "VERIFICATION_FAILED",
      "REPLAY_MISMATCH",
    ]) {
      expect(held.has(code), code).toBe(true)
    }
  })

  test.each(DOCUMENT_PHASES)(
    "a %s row can be failed with its own phase's code",
    async (phase) => {
      const code = {
        compiling: "COMPILE_FAILED",
        rendering: "RENDER_FAILED",
        verifying: "VERIFICATION_FAILED",
      }[phase]

      const runId = await insertRun(phase)
      await db.query(
        `UPDATE report_runs SET status = 'failed', error_code = $2::run_error_code,
                error_message = 'seeded', phase_deadline = NULL, updated_at = now()
          WHERE id = $1 AND status = $3::run_status`,
        [runId, code, phase]
      )

      const row = await db.query<{ error_code: string }>(
        `SELECT error_code FROM report_runs WHERE id = $1`,
        [runId]
      )
      expect(row.rows[0].error_code).toBe(code)
    }
  )
})
