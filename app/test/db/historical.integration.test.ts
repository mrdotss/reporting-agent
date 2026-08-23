import { randomUUID } from "node:crypto"

import { beforeEach, describe, expect, test, vi } from "vitest"

import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * `lib/runs/historical.ts` against a real Postgres 17 (Requirements 18.4, 18.5, 18.6).
 *
 * The lateral join returning each run's latest verification across runs carrying
 * one, several, and none.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

vi.mock("@/lib/db", () => ({
  getDb: () => currentDb(),
}))

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import * as schema from "@/lib/db/schema"
import { fetchHistoricalCandidates } from "@/lib/runs/historical"

// --- Wiring ------------------------------------------------------------------

let drizzleDb: NodePgDatabase<typeof schema> | undefined
let userId: string
let subscriptionId: string
let templateId: string
let templateVersionId: string
let compilingRunId: string

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

  await db.query(`TRUNCATE users CASCADE`)
  await db.query(`TRUNCATE report_templates CASCADE`)

  userId = randomUUID()
  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [userId, "hist@example.com", "hist@example.com", UNUSABLE_PASSWORD_HASH]
  )

  subscriptionId = randomUUID()
  await db.query(
    `INSERT INTO connected_subscriptions
       (id, user_id, display_name, subscription_id, tenant_id, client_id,
        client_secret_enc, secret_expires_at, scope_verified, status)
     VALUES ($1, $2, 'Test sub', $3, 'tenant', 'client', 'envelope',
             now() + interval '90 days', true, 'active')`,
    [subscriptionId, userId, `sub-${subscriptionId}`]
  )

  templateId = randomUUID()
  await db.query(
    `INSERT INTO report_templates (id, user_id, name)
     VALUES ($1, $2, 'Historical test template')`,
    [templateId, userId]
  )

  templateVersionId = randomUUID()
  await db.query(
    `INSERT INTO report_template_versions
       (id, template_id, version, definition, definition_sha256)
     VALUES ($1, $2, 1, '{}'::jsonb, $3)`,
    [templateVersionId, templateId, "0".repeat(64)]
  )

  // The run being compiled — excluded from its own trend.
  compilingRunId = randomUUID()
  await db.query(
    `INSERT INTO report_runs
       (id, user_id, connected_subscription_id, template_version_id,
        period_start, period_end, timezone, scope, status, dedupe_key,
        progress_token_hash)
     VALUES ($1, $2, $3, $4, '2026-08-01', '2026-08-31', 'Asia/Jakarta',
             $5::jsonb, 'collecting', $6, 'tok')`,
    [
      compilingRunId,
      userId,
      subscriptionId,
      templateVersionId,
      JSON.stringify({
        resource_types: ["Microsoft.Compute/virtualMachines"],
        resource_groups: [],
        tag_filters: {},
      }),
      `dedupe-${compilingRunId}`,
    ]
  )
})

// --- Helpers ----------------------------------------------------------------

async function insertRun(opts: {
  id?: string
  periodStart: string
  periodEnd: string
  status?: string
  versionId?: string
}): Promise<string> {
  const id = opts.id ?? randomUUID()
  await db.query(
    `INSERT INTO report_runs
       (id, user_id, connected_subscription_id, template_version_id,
        period_start, period_end, timezone, scope, status, dedupe_key,
        progress_token_hash)
     VALUES ($1, $2, $3, $4, $5, $6, 'Asia/Jakarta',
             $7::jsonb, $8, $9, 'tok')`,
    [
      id,
      userId,
      subscriptionId,
      opts.versionId ?? templateVersionId,
      opts.periodStart,
      opts.periodEnd,
      JSON.stringify({
        resource_types: ["Microsoft.Compute/virtualMachines"],
        resource_groups: [],
        tag_filters: {},
      }),
      opts.status ?? "completed",
      `dedupe-${id}`,
    ]
  )
  return id
}

async function insertVerification(
  runId: string,
  opts?: { status?: string; createdAt?: string; snapshotSha256?: string }
): Promise<string> {
  const id = randomUUID()
  const status = opts?.status ?? "pass"
  const sha = opts?.snapshotSha256 ?? "a".repeat(64)
  const createdAt = opts?.createdAt ?? new Date().toISOString()

  await db.query(
    `INSERT INTO report_verifications
       (id, run_id, attempt_id, template_version_id, status, figure_count,
        snapshot_sha256, docx_sha256, pdf_sha256, replay, drift_sample,
        findings, counts, artifact_key, created_at)
     VALUES ($1, $2, $3, $4, $5, 42, $6, $7, $8, $9::jsonb, $10::jsonb,
             '[]'::jsonb, '{}'::jsonb, $11, $12::timestamptz)`,
    [
      id,
      runId,
      `attempt-${id}`,
      templateVersionId,
      status,
      sha,
      "d".repeat(64),
      "p".repeat(64),
      JSON.stringify({
        possible: true,
        digest_matches: true,
        recomputed_sha256: sha,
        stored_sha256: sha,
        fold_count: 10,
      }),
      JSON.stringify({ n: 5, method: "named_plus_random", seed: 12345 }),
      `artifacts/${userId}/${runId}/verification-${id}.json`,
      createdAt,
    ]
  )
  return id
}

// --- Tests ------------------------------------------------------------------

describe("fetchHistoricalCandidates", () => {
  test("returns empty when no prior runs exist", async () => {
    const result = await fetchHistoricalCandidates(
      userId,
      templateId,
      subscriptionId,
      compilingRunId,
      "2026-08-01"
    )

    expect(result).toEqual([])
  })

  test("excludes the compiling run itself", async () => {
    // The compiling run has period_end = 2026-08-31 which is not < 2026-08-01,
    // and it's also excluded by id. Verify no results even if we loosen the date.
    const result = await fetchHistoricalCandidates(
      userId,
      templateId,
      subscriptionId,
      compilingRunId,
      "2026-09-01"
    )

    expect(result).toEqual([])
  })

  test("returns a run with no verification (LEFT JOIN yields nulls)", async () => {
    const runA = await insertRun({
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
    })

    const result = await fetchHistoricalCandidates(
      userId,
      templateId,
      subscriptionId,
      compilingRunId,
      "2026-08-01"
    )

    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe(runA)
    expect(result[0]!.verificationId).toBeNull()
    expect(result[0]!.verificationStatus).toBeNull()
    expect(result[0]!.verificationCreatedAt).toBeNull()
    expect(result[0]!.verificationSnapshotSha256).toBeNull()
  })

  test("returns the latest verification when a run has several", async () => {
    const runA = await insertRun({
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
    })

    // Insert older verification first (status: fail)
    await insertVerification(runA, {
      status: "fail",
      createdAt: "2026-06-01T10:00:00Z",
      snapshotSha256: "f".repeat(64),
    })

    // Insert newer verification (status: pass) — this is the latest
    const latestVerId = await insertVerification(runA, {
      status: "pass",
      createdAt: "2026-06-02T10:00:00Z",
      snapshotSha256: "b".repeat(64),
    })

    const result = await fetchHistoricalCandidates(
      userId,
      templateId,
      subscriptionId,
      compilingRunId,
      "2026-08-01"
    )

    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe(runA)
    expect(result[0]!.verificationId).toBe(latestVerId)
    expect(result[0]!.verificationStatus).toBe("pass")
    expect(result[0]!.verificationSnapshotSha256).toBe("b".repeat(64))
  })

  test("mixes runs with one, several, and no verifications", async () => {
    // Run with no verification
    const runNoVer = await insertRun({
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
    })

    // Run with one verification
    const runOneVer = await insertRun({
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
    })
    const oneVerId = await insertVerification(runOneVer, {
      status: "pass",
      createdAt: "2026-06-01T00:00:00Z",
      snapshotSha256: "1".repeat(64),
    })

    // Run with multiple verifications
    const runMultiVer = await insertRun({
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
    })
    await insertVerification(runMultiVer, {
      status: "fail",
      createdAt: "2026-07-01T00:00:00Z",
      snapshotSha256: "2".repeat(64),
    })
    await insertVerification(runMultiVer, {
      status: "fail",
      createdAt: "2026-07-02T00:00:00Z",
      snapshotSha256: "3".repeat(64),
    })
    const latestMultiVerId = await insertVerification(runMultiVer, {
      status: "pass",
      createdAt: "2026-07-03T00:00:00Z",
      snapshotSha256: "4".repeat(64),
    })

    const result = await fetchHistoricalCandidates(
      userId,
      templateId,
      subscriptionId,
      compilingRunId,
      "2026-08-01"
    )

    expect(result).toHaveLength(3)

    // Ordered by period_end DESC
    expect(result[0]!.id).toBe(runMultiVer)
    expect(result[0]!.verificationId).toBe(latestMultiVerId)
    expect(result[0]!.verificationStatus).toBe("pass")

    expect(result[1]!.id).toBe(runOneVer)
    expect(result[1]!.verificationId).toBe(oneVerId)
    expect(result[1]!.verificationStatus).toBe("pass")

    expect(result[2]!.id).toBe(runNoVer)
    expect(result[2]!.verificationId).toBeNull()
    expect(result[2]!.verificationStatus).toBeNull()
  })

  test("filters on template_id (any version of the template)", async () => {
    // Create a second version of the SAME template
    const version2Id = randomUUID()
    await db.query(
      `INSERT INTO report_template_versions
         (id, template_id, version, definition, definition_sha256)
       VALUES ($1, $2, 2, '{"v":2}'::jsonb, $3)`,
      [version2Id, templateId, "2".repeat(64)]
    )

    // Run pinned to version 1
    const run1 = await insertRun({
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      versionId: templateVersionId,
    })

    // Run pinned to version 2 — same template row, should be included
    const run2 = await insertRun({
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      versionId: version2Id,
    })

    // Run of a DIFFERENT template — should be excluded
    const otherTemplateId = randomUUID()
    await db.query(
      `INSERT INTO report_templates (id, user_id, name)
       VALUES ($1, $2, 'Other template')`,
      [otherTemplateId, userId]
    )
    const otherVersionId = randomUUID()
    await db.query(
      `INSERT INTO report_template_versions
         (id, template_id, version, definition, definition_sha256)
       VALUES ($1, $2, 1, '{}'::jsonb, $3)`,
      [otherVersionId, otherTemplateId, "9".repeat(64)]
    )
    await insertRun({
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      versionId: otherVersionId,
    })

    const result = await fetchHistoricalCandidates(
      userId,
      templateId,
      subscriptionId,
      compilingRunId,
      "2026-08-01"
    )

    // Only the two runs from the same template row
    expect(result).toHaveLength(2)
    const ids = result.map((r) => r.id)
    expect(ids).toContain(run1)
    expect(ids).toContain(run2)
  })

  test("filters by user_id — other users' runs are excluded", async () => {
    const otherUserId = randomUUID()
    await db.query(
      `INSERT INTO users (id, email, email_normalized, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [
        otherUserId,
        "other@example.com",
        "other@example.com",
        UNUSABLE_PASSWORD_HASH,
      ]
    )

    // Insert a run owned by the other user, same subscription and template version
    const otherRunId = randomUUID()
    await db.query(
      `INSERT INTO report_runs
         (id, user_id, connected_subscription_id, template_version_id,
          period_start, period_end, timezone, scope, status, dedupe_key,
          progress_token_hash)
       VALUES ($1, $2, $3, $4, '2026-06-01', '2026-06-30', 'Asia/Jakarta',
               $5::jsonb, 'completed', $6, 'tok')`,
      [
        otherRunId,
        otherUserId,
        subscriptionId,
        templateVersionId,
        JSON.stringify({
          resource_types: ["Microsoft.Compute/virtualMachines"],
          resource_groups: [],
          tag_filters: {},
        }),
        `dedupe-${otherRunId}`,
      ]
    )

    const result = await fetchHistoricalCandidates(
      userId,
      templateId,
      subscriptionId,
      compilingRunId,
      "2026-08-01"
    )

    expect(result).toHaveLength(0)
  })

  test("period_end < periodEndBefore is strict", async () => {
    // period_end = 2026-08-01, which is NOT < 2026-08-01
    await insertRun({
      periodStart: "2026-07-01",
      periodEnd: "2026-08-01",
    })

    // period_end = 2026-07-31, which IS < 2026-08-01
    const eligible = await insertRun({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    })

    const result = await fetchHistoricalCandidates(
      userId,
      templateId,
      subscriptionId,
      compilingRunId,
      "2026-08-01"
    )

    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe(eligible)
  })

  test("ORDER BY period_end DESC, verification created_at DESC, id DESC", async () => {
    // Two runs with different period_end
    const runJune = await insertRun({
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
    })
    const runMay = await insertRun({
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
    })

    await insertVerification(runJune, {
      createdAt: "2026-07-01T00:00:00Z",
    })
    await insertVerification(runMay, {
      createdAt: "2026-07-10T00:00:00Z",
    })

    const result = await fetchHistoricalCandidates(
      userId,
      templateId,
      subscriptionId,
      compilingRunId,
      "2026-08-01"
    )

    // June has later period_end → comes first
    expect(result[0]!.id).toBe(runJune)
    expect(result[1]!.id).toBe(runMay)
  })

  test("LIMIT 200 is enforced", async () => {
    // Insert 205 runs
    for (let i = 0; i < 205; i++) {
      // Spread across many months to avoid hitting the same period_end
      const monthOffset = Math.floor(i / 28)
      const dayOfMonth = (i % 28) + 1
      const year = 2020 + Math.floor(monthOffset / 12)
      const month = (monthOffset % 12) + 1
      const startStr = `${year}-${String(month).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`
      // period_end one day after start
      const endDate = new Date(Date.UTC(year, month - 1, dayOfMonth + 1))
      const endStr = endDate.toISOString().slice(0, 10)

      await insertRun({ periodStart: startStr, periodEnd: endStr })
    }

    const result = await fetchHistoricalCandidates(
      userId,
      templateId,
      subscriptionId,
      compilingRunId,
      "2026-08-01"
    )

    expect(result).toHaveLength(200)
  })

  test("lateral join tie-break: same created_at picks greater id", async () => {
    const runA = await insertRun({
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
    })

    // Two verifications at the exact same created_at — id tie-break
    const idSmall = "0" + randomUUID().slice(1)
    const idLarge = "z" + randomUUID().slice(1)

    await db.query(
      `INSERT INTO report_verifications
         (id, run_id, attempt_id, template_version_id, status, figure_count,
          snapshot_sha256, docx_sha256, pdf_sha256, replay, drift_sample,
          findings, counts, artifact_key, created_at)
       VALUES ($1, $2, $3, $4, 'fail', 0, $5, $6, $7, $8::jsonb, $9::jsonb,
               '[]'::jsonb, '{}'::jsonb, $10, '2026-07-01T12:00:00Z'::timestamptz)`,
      [
        idSmall,
        runA,
        `attempt-${idSmall}`,
        templateVersionId,
        "e".repeat(64),
        "d".repeat(64),
        "p".repeat(64),
        JSON.stringify({
          possible: true,
          digest_matches: true,
          recomputed_sha256: "e".repeat(64),
          stored_sha256: "e".repeat(64),
          fold_count: 1,
        }),
        JSON.stringify({ n: 1, method: "named_plus_random", seed: 1 }),
        `artifacts/${userId}/${runA}/v-${idSmall}.json`,
      ]
    )

    await db.query(
      `INSERT INTO report_verifications
         (id, run_id, attempt_id, template_version_id, status, figure_count,
          snapshot_sha256, docx_sha256, pdf_sha256, replay, drift_sample,
          findings, counts, artifact_key, created_at)
       VALUES ($1, $2, $3, $4, 'pass', 10, $5, $6, $7, $8::jsonb, $9::jsonb,
               '[]'::jsonb, '{}'::jsonb, $10, '2026-07-01T12:00:00Z'::timestamptz)`,
      [
        idLarge,
        runA,
        `attempt-${idLarge}`,
        templateVersionId,
        "b".repeat(64),
        "d".repeat(64),
        "p".repeat(64),
        JSON.stringify({
          possible: true,
          digest_matches: true,
          recomputed_sha256: "b".repeat(64),
          stored_sha256: "b".repeat(64),
          fold_count: 1,
        }),
        JSON.stringify({ n: 1, method: "named_plus_random", seed: 1 }),
        `artifacts/${userId}/${runA}/v-${idLarge}.json`,
      ]
    )

    const result = await fetchHistoricalCandidates(
      userId,
      templateId,
      subscriptionId,
      compilingRunId,
      "2026-08-01"
    )

    expect(result).toHaveLength(1)
    // ORDER BY rv.id DESC picks the larger id
    expect(result[0]!.verificationId).toBe(idLarge)
    expect(result[0]!.verificationStatus).toBe("pass")
  })
})
