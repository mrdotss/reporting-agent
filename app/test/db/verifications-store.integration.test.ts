import { randomUUID } from "node:crypto"

import { beforeEach, describe, expect, test, vi } from "vitest"

import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * `lib/verifications/store.ts` against a real Postgres 17 (Requirements 36.1,
 * 36.2, 36.3, 36.5, 36.6, 36.7, 36.8).
 *
 * ## Why these claims need a database
 *
 *   * **Requirement 36.1/36.7** is "a re-verification appends" — settled by the
 *     absence of a UNIQUE on `run_id` and the presence of one on
 *     `(run_id, attempt_id)`. Both are facts about the schema's own
 *     constraints, not about this module's code.
 *   * **Requirement 41.5's idempotent callback** is a UNIQUE-violation retry
 *     path: a genuine Postgres `23505` on
 *     `report_verifications_run_id_attempt_id_uq`, forced by inserting the
 *     same `(run_id, attempt_id)` pair twice, is what exercises
 *     {@link insertVerification}'s catch branch. A double would have to
 *     simulate that violation itself, which would be asserting the mock
 *     agrees with itself.
 *   * **Requirement 36.2** ("no operation modifies or deletes a row") is
 *     asserted here by reading the table back unchanged after every
 *     operation this store exposes has been exercised against it.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

vi.mock("@/lib/db", () => ({
  getDb: () => currentDb(),
}))

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import * as schema from "@/lib/db/schema"
import type { VerificationResult } from "@/lib/verifications/result"
import {
  insertVerification,
  latestForRun,
  readLatestVerificationStatus,
  type InsertVerificationInput,
} from "@/lib/verifications/store"

// --- Wiring ------------------------------------------------------------

let drizzleDb: NodePgDatabase<typeof schema> | undefined
let userId: string
let subscriptionId: string
let runId: string
let templateId: string
let templateVersionId: string

function currentDb(): NodePgDatabase<typeof schema> {
  if (drizzleDb === undefined) {
    throw new Error(
      "The scratch-schema Drizzle client is not open. Read it inside a test."
    )
  }
  return drizzleDb
}

const UNUSABLE_PASSWORD_HASH = "$argon2id$fixture-never-verified"

beforeEach(async () => {
  if (!db.enabled) return

  drizzleDb = drizzle(db.pool(), { schema })

  // Every table this fixture touches is truncated together — `users` cascades
  // through every FK below it, so there is one statement to keep correct
  // rather than an ordered list a new table would fall off.
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

  templateId = randomUUID()
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

  runId = randomUUID()
  await db.query(
    `INSERT INTO report_runs
       (id, user_id, connected_subscription_id, period_start, period_end,
        timezone, scope, status, dedupe_key, progress_token_hash)
     VALUES ($1, $2, $3, '2026-07-01', '2026-07-31', 'Asia/Jakarta',
             $4::jsonb, 'collecting', $5, 'token-hash')`,
    [
      runId,
      userId,
      subscriptionId,
      JSON.stringify({
        resource_types: ["Microsoft.Compute/virtualMachines"],
        resource_groups: [],
        tag_filters: {},
      }),
      `dedupe-${runId}`,
    ]
  )
})

// --- Fixtures ---------------------------------------------------------------

const SHA_A = "a".repeat(64)
const SHA_B = "b".repeat(64)
const SHA_C = "c".repeat(64)
const SHA_D = "d".repeat(64)

function resultFixture(
  overrides: Partial<VerificationResult> = {}
): VerificationResult {
  return {
    schema_version: 1,
    attempt_id: `ver_${randomUUID()}`,
    run_id: runId,
    template_version_id: templateVersionId,
    status: "pass",
    figure_count: 1480,
    snapshot_sha256: SHA_A,
    docx_sha256: SHA_B,
    pdf_sha256: SHA_C,
    ledger_sha256: SHA_D,
    counts: { ledger_entries_checked: 1480, ledger_entries_unrendered: 0 },
    replay: {
      possible: true,
      recomputed_sha256: SHA_A,
      stored_sha256: SHA_A,
      objects_folded: 87,
      objects_named: 87,
    },
    drift_sample: {
      n: 25,
      method: "document_named+top10_max+10pct",
      seed: "a3f9",
      not_requeried: [],
    },
    findings: [],
    ...overrides,
  }
}

function insertInput(
  overrides: Partial<VerificationResult> = {}
): InsertVerificationInput {
  const result = resultFixture(overrides)
  return {
    result,
    artifactKey: `${userId}/reports/${result.run_id}/verification-${result.attempt_id}.json`,
  }
}

async function allRows(): Promise<readonly { attempt_id: string }[]> {
  const result = await db.query<{ attempt_id: string }>(
    `SELECT attempt_id FROM report_verifications ORDER BY created_at, attempt_id`
  )
  return result.rows
}

// --- insertVerification -------------------------------------------------

describe("insertVerification", () => {
  test("inserts a row carrying every NOT NULL column from the artifact", async () => {
    const input = insertInput()

    const row = await insertVerification(input)

    expect(row.runId).toBe(runId)
    expect(row.attemptId).toBe(input.result.attempt_id)
    expect(row.templateVersionId).toBe(templateVersionId)
    expect(row.status).toBe("pass")
    expect(row.figureCount).toBe(1480)
    expect(row.snapshotSha256).toBe(SHA_A)
    expect(row.docxSha256).toBe(SHA_B)
    expect(row.pdfSha256).toBe(SHA_C)
    expect(row.artifactKey).toBe(input.artifactKey)
    expect(row.replay).toEqual(input.result.replay)
    expect(row.driftSample).toEqual(input.result.drift_sample)
    expect(row.findings).toEqual([])
    expect(row.counts).toEqual(input.result.counts)
  })

  test("the artifact's fourth digest (ledger_sha256) is not persisted to a column", async () => {
    const input = insertInput()

    const row = await insertVerification(input)

    // The table has no ledger_sha256 column at all — asserted at the raw SQL
    // level, so a column added later without updating this test's intent
    // still shows the mapping is deliberate rather than accidental.
    const raw = await db.query<Record<string, unknown>>(
      `SELECT * FROM report_verifications WHERE id = $1`,
      [row.id]
    )
    expect(raw.rows[0]).not.toHaveProperty("ledger_sha256")
  })

  test("Requirement 36.1 — run_id carries no UNIQUE: a second attempt for one run appends", async () => {
    await insertVerification(insertInput({ status: "fail" }))
    await insertVerification(insertInput({ status: "pass" }))

    const rows = await allRows()
    expect(rows).toHaveLength(2)
  })

  test("Requirement 41.5 — a retried callback for the same (run_id, attempt_id) is idempotent", async () => {
    const input = insertInput()

    const first = await insertVerification(input)
    const second = await insertVerification(input)

    expect(second.id).toBe(first.id)
    expect(await allRows()).toHaveLength(1)
  })

  test("a duplicate attempt_id is idempotent even with a differing artifact key on retry", async () => {
    const result = resultFixture()
    const first = await insertVerification({
      result,
      artifactKey: `${userId}/reports/${runId}/verification-${result.attempt_id}.json`,
    })

    // A retried delivery of the *same* callback would carry the same key in
    // practice; this asserts the idempotency path resolves to the
    // already-stored row regardless, rather than silently overwriting it —
    // which it structurally cannot do, since there is no update path.
    const second = await insertVerification({
      result,
      artifactKey: `${userId}/reports/${runId}/verification-${result.attempt_id}-retry.json`,
    })

    expect(second.id).toBe(first.id)
    expect(second.artifactKey).toBe(first.artifactKey)
    expect(await allRows()).toHaveLength(1)
  })

  test("Requirement 36.2 — no operation modifies a row: the stored row is unchanged after further inserts", async () => {
    const first = await insertVerification(insertInput({ status: "fail" }))

    await insertVerification(insertInput({ status: "pass" }))
    await insertVerification(insertInput({ status: "pass" }))

    const stillThere = await db.query<{
      status: string
      figure_count: number
    }>(`SELECT status, figure_count FROM report_verifications WHERE id = $1`, [
      first.id,
    ])
    expect(stillThere.rows[0]?.status).toBe("fail")
  })
})

// --- latestForRun --------------------------------------------------------

describe("latestForRun", () => {
  test("undefined and a count of 0 when the run carries no verification", async () => {
    const { latest, count } = await latestForRun(runId)

    expect(latest).toBeUndefined()
    expect(count).toBe(0)
  })

  test("Requirement 36.7 — returns the row with the greatest created_at, plus the row count", async () => {
    await insertVerification(insertInput({ status: "fail" }))
    // A distinct instant, so ordering is unambiguous rather than resting on
    // insertion order coinciding with clock order by luck.
    await db.query(`SELECT pg_sleep(0.01)`)
    const second = await insertVerification(insertInput({ status: "pass" }))
    await db.query(`SELECT pg_sleep(0.01)`)
    const third = await insertVerification(
      insertInput({ status: "fail", figure_count: 5 })
    )

    const { latest, count } = await latestForRun(runId)

    expect(latest?.id).toBe(third.id)
    expect(latest?.figureCount).toBe(5)
    expect(count).toBe(3)
    // Sanity: the middle row is not what was returned.
    expect(latest?.id).not.toBe(second.id)
  })

  test("counts only rows for the requested run", async () => {
    await insertVerification(insertInput())

    const otherRunId = randomUUID()
    await db.query(
      `INSERT INTO report_runs
         (id, user_id, connected_subscription_id, period_start, period_end,
          timezone, scope, status, dedupe_key, progress_token_hash)
       VALUES ($1, $2, $3, '2026-08-01', '2026-08-31', 'Asia/Jakarta',
               $4::jsonb, 'collecting', $5, 'token-hash')`,
      [
        otherRunId,
        userId,
        subscriptionId,
        JSON.stringify({
          resource_types: ["Microsoft.Compute/virtualMachines"],
          resource_groups: [],
          tag_filters: {},
        }),
        `dedupe-${otherRunId}`,
      ]
    )
    await insertVerification({
      result: resultFixture({ run_id: otherRunId }),
      artifactKey: `${userId}/reports/${otherRunId}/verification-x.json`,
    })

    const { count } = await latestForRun(runId)
    expect(count).toBe(1)
  })
})

// --- readLatestVerificationStatus -----------------------------------------

describe("readLatestVerificationStatus", () => {
  test("undefined when the run carries no verification", async () => {
    await expect(
      readLatestVerificationStatus(runId)
    ).resolves.toBeUndefined()
  })

  test("returns the latest attempt's status, distinguishing fail from absent", async () => {
    await insertVerification(insertInput({ status: "fail" }))

    await expect(readLatestVerificationStatus(runId)).resolves.toBe("fail")
  })

  test("reflects the most recent re-verification's status, not an earlier one", async () => {
    await insertVerification(insertInput({ status: "fail" }))
    await db.query(`SELECT pg_sleep(0.01)`)
    await insertVerification(insertInput({ status: "pass" }))

    await expect(readLatestVerificationStatus(runId)).resolves.toBe("pass")
  })
})
