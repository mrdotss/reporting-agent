import { createHash, randomUUID } from "node:crypto"

import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * Two claims of task 2.6 that are **not** already covered by
 * `templates-store.integration.test.ts` (task 2.3) or
 * `verifications-store.integration.test.ts` (task 2.4), against a real
 * Postgres 17 (Requirements 9.6, 9.8, 36.2, 36.7).
 *
 * Everything else task 2.6 lists — `version` = `max + 1`, the unchanged-digest
 * no-op, immutability, the concurrent-version race (Requirement 9.11), and
 * `report_verifications` insert-only append with `(run_id, attempt_id)`
 * idempotency — already has a passing, named test in one of those two files.
 * Duplicating it here would be a second, unverified copy of a claim that
 * already has one. See those two files' own docstrings for the reasoning.
 *
 * What is missing, and what this file adds:
 *
 *   1. **The partial CHECK on `report_runs.template_version_id`
 *      (Requirement 9.8)** is a fact about a raw constraint —
 *      `report_runs_template_version_id_ck` in `lib/db/schema.ts` — that
 *      neither store module's test exercises, because neither module writes
 *      a `report_runs` row at all. The constraint reads
 *      `created_at < '2026-12-01T00:00:00Z'::timestamptz OR
 *      template_version_id IS NOT NULL`, so testing it honestly means
 *      controlling `created_at` directly rather than trusting `now()` — the
 *      literal cutover is in the future relative to a real clock today, so a
 *      row inserted with `now()` and a null `template_version_id` would
 *      *pass* the CHECK right now, which would make a test that relies on
 *      `now()` alone pass for the wrong reason on every run until the
 *      calendar catches up to the constant. Every case below pins
 *      `created_at` explicitly.
 *   2. **Editing a template a completed run pinned leaves that run's
 *      digests and pin unchanged (Requirements 9.6, 36.2, 36.7)** is an
 *      end-to-end scenario across `lib/templates/store.ts` and
 *      `lib/verifications/store.ts` together with `report_runs` directly,
 *      which is why it belongs in a file that owns none of those modules
 *      individually. Inserting a new template version must not retroactively
 *      change what an already-pinned run resolves to, and nothing in either
 *      store's own suite pins a run and then edits the template out from
 *      under it.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

vi.mock("@/lib/db", () => ({
  getDb: () => currentDb(),
}))

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import * as schema from "@/lib/db/schema"
import {
  createTemplate,
  insertVersion,
  readLatestVersion,
  readVersion,
  type InsertVersionInput,
} from "@/lib/templates/store"
import { insertVerification, type InsertVerificationInput } from "@/lib/verifications/store"
import type { VerificationResult } from "@/lib/verifications/result"

// --- Wiring ------------------------------------------------------------

let drizzleDb: NodePgDatabase<typeof schema> | undefined
let ownerId: string
let subscriptionId: string

function currentDb(): NodePgDatabase<typeof schema> {
  if (drizzleDb === undefined) {
    throw new Error(
      "The scratch-schema Drizzle client is not open. Read it inside a test."
    )
  }
  return drizzleDb
}

const UNUSABLE_PASSWORD_HASH = "$argon2id$fixture-never-verified"

/** The literal cutover `lib/db/schema.ts`'s `report_runs_template_version_id_ck`
 * compares `created_at` against. Copied as a literal, not derived, because the
 * point of this test is to pin the exact instant the constraint itself names —
 * re-deriving it here would make the test agree with the schema by
 * construction rather than by checking it. */
const CHECK_CUTOVER = "2026-12-01T00:00:00Z"

beforeAll(async () => {
  if (!db.enabled) return

  drizzleDb = drizzle(db.pool(), { schema })
})

beforeEach(async () => {
  if (!db.enabled) return

  // `users CASCADE` takes every table below it — `connected_subscriptions`,
  // `report_templates` (and its versions), `report_runs` and
  // `report_verifications` — so there is one statement to keep correct
  // rather than an ordered list a new table would fall off.
  await db.query(`TRUNCATE users CASCADE`)

  ownerId = randomUUID()
  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [ownerId, "owner@example.com", "owner@example.com", UNUSABLE_PASSWORD_HASH]
  )

  subscriptionId = randomUUID()
  await db.query(
    `INSERT INTO connected_subscriptions
       (id, user_id, display_name, subscription_id, tenant_id, client_id,
        client_secret_enc, secret_expires_at, scope_verified, status)
     VALUES ($1, $2, 'Contoso production', $3, 'tenant', 'client', 'envelope',
             now() + interval '90 days', true, 'active')`,
    [subscriptionId, ownerId, `sub-${subscriptionId}`]
  )
})

// --- Helpers -------------------------------------------------------------

/** A stand-in for `lib/templates/version.ts`'s canonical digest — any stable
 * hash of the definition serves this test, which never canonicalizes on its
 * own. Mirrors `templates-store.integration.test.ts`'s own copy. */
function digestOf(definition: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(definition), "utf8")
    .digest("hex")
}

function versionInput(definition: unknown): InsertVersionInput {
  return { definition, definitionSha256: digestOf(definition) }
}

const RUN_SCOPE = JSON.stringify({
  resource_types: ["Microsoft.Compute/virtualMachines"],
  resource_groups: [],
  tag_filters: {},
})

interface InsertRunOptions {
  readonly templateVersionId?: string | null
  /** ISO instant, cast to `timestamptz`. Omitted lets Postgres default to `now()`. */
  readonly createdAt?: string
  readonly status?: string
}

/**
 * A raw `report_runs` insert. Raw rather than through a store module, because
 * this file's whole point is to exercise a table constraint and a
 * cross-store scenario that no store's own exported function is responsible
 * for — `lib/runs/state.ts`'s enqueue path is a different task's concern
 * (task 13.1) and is not what either half of this file is testing.
 */
async function insertReportRun(options: InsertRunOptions = {}): Promise<string> {
  const id = randomUUID()
  const templateVersionId = options.templateVersionId ?? null
  const status = options.status ?? "collecting"

  if (options.createdAt === undefined) {
    await db.query(
      `INSERT INTO report_runs
         (id, user_id, connected_subscription_id, period_start, period_end,
          timezone, scope, status, dedupe_key, progress_token_hash,
          template_version_id)
       VALUES ($1, $2, $3, '2026-07-01', '2026-07-31', 'Asia/Jakarta',
               $4::jsonb, $5, $6, 'token-hash', $7)`,
      [id, ownerId, subscriptionId, RUN_SCOPE, status, `dedupe-${id}`, templateVersionId]
    )
  } else {
    await db.query(
      `INSERT INTO report_runs
         (id, user_id, connected_subscription_id, period_start, period_end,
          timezone, scope, status, dedupe_key, progress_token_hash,
          template_version_id, created_at)
       VALUES ($1, $2, $3, '2026-07-01', '2026-07-31', 'Asia/Jakarta',
               $4::jsonb, $5, $6, 'token-hash', $7, $8::timestamptz)`,
      [
        id,
        ownerId,
        subscriptionId,
        RUN_SCOPE,
        status,
        `dedupe-${id}`,
        templateVersionId,
        options.createdAt,
      ]
    )
  }

  return id
}

async function readRunRow(
  runId: string
): Promise<{ readonly template_version_id: string | null } | undefined> {
  const result = await db.query<{ template_version_id: string | null }>(
    `SELECT template_version_id FROM report_runs WHERE id = $1`,
    [runId]
  )
  return result.rows[0]
}

const SHA_SNAPSHOT = "a".repeat(64)
const SHA_DOCX = "b".repeat(64)
const SHA_PDF = "c".repeat(64)
const SHA_LEDGER = "d".repeat(64)

function verificationResultFixture(
  runId: string,
  templateVersionId: string
): VerificationResult {
  return {
    schema_version: 1,
    attempt_id: `ver_${randomUUID()}`,
    run_id: runId,
    template_version_id: templateVersionId,
    status: "pass",
    figure_count: 1480,
    snapshot_sha256: SHA_SNAPSHOT,
    docx_sha256: SHA_DOCX,
    pdf_sha256: SHA_PDF,
    ledger_sha256: SHA_LEDGER,
    counts: { ledger_entries_checked: 1480, ledger_entries_unrendered: 0 },
    replay: {
      possible: true,
      recomputed_sha256: SHA_SNAPSHOT,
      stored_sha256: SHA_SNAPSHOT,
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
  }
}

function insertVerificationInput(
  runId: string,
  templateVersionId: string
): InsertVerificationInput {
  const result = verificationResultFixture(runId, templateVersionId)
  return {
    result,
    artifactKey: `${ownerId}/reports/${runId}/verification-${result.attempt_id}.json`,
  }
}

interface DriverError {
  readonly code?: string
  readonly constraint?: string
}

/** The two fields a raw `pg` error carries on this path — no `DrizzleQueryError`
 * wrapper here, because `db.query` goes straight through node-postgres. */
function asDriverError(thrown: unknown): DriverError {
  if (typeof thrown !== "object" || thrown === null) return {}
  const { code, constraint } = thrown as Record<string, unknown>
  return {
    code: typeof code === "string" ? code : undefined,
    constraint: typeof constraint === "string" ? constraint : undefined,
  }
}

const CHECK_VIOLATION = "23514"
const TEMPLATE_VERSION_ID_CHECK = "report_runs_template_version_id_ck"

// --- The partial CHECK on report_runs.template_version_id ------------------

describe("Requirement 9.8 — the partial CHECK on report_runs.template_version_id", () => {
  test("a foundation-era row (created_at before the cutover) with a null template_version_id is accepted", async () => {
    const runId = await insertReportRun({
      templateVersionId: null,
      createdAt: "2026-11-30T23:59:59Z",
    })

    expect((await readRunRow(runId))?.template_version_id).toBeNull()
  })

  test("a row created exactly at the cutover instant with a null template_version_id is rejected", async () => {
    const attempt = insertReportRun({
      templateVersionId: null,
      createdAt: CHECK_CUTOVER,
    })

    await expect(attempt).rejects.toBeTruthy()

    const failure = await attempt.catch((error: unknown) => error)
    const driverError = asDriverError(failure)
    expect(driverError.code).toBe(CHECK_VIOLATION)
    expect(driverError.constraint).toBe(TEMPLATE_VERSION_ID_CHECK)
  })

  test("a row created well after the cutover with a null template_version_id is rejected", async () => {
    const attempt = insertReportRun({
      templateVersionId: null,
      createdAt: "2027-01-01T00:00:00Z",
    })

    await expect(attempt).rejects.toBeTruthy()
    const driverError = asDriverError(await attempt.catch((error: unknown) => error))
    expect(driverError.code).toBe(CHECK_VIOLATION)
    expect(driverError.constraint).toBe(TEMPLATE_VERSION_ID_CHECK)
  })

  test("a row created at or after the cutover with a non-null template_version_id is accepted", async () => {
    const template = await createTemplate(ownerId, { name: "Pinned era" })
    const version = await insertVersion(
      ownerId,
      template.id,
      versionInput({ schema_version: 1, blocks: ["a"] })
    )

    const runId = await insertReportRun({
      templateVersionId: version.id,
      createdAt: "2027-01-01T00:00:00Z",
    })

    expect((await readRunRow(runId))?.template_version_id).toBe(version.id)
  })

  test("an insert with no explicit created_at and a null template_version_id applies no write when it violates the CHECK", async () => {
    // Documents the trap this suite exists to avoid: `now()` on a real clock
    // today is *before* the literal 2026-12-01 cutover, so this insert is
    // expected to **succeed** right now — it is not a rejection case. The
    // assertion is on the row's own `created_at`, not on an assumption about
    // which side of the cutover "no explicit value" lands on.
    const runId = await insertReportRun({ templateVersionId: null })

    const result = await db.query<{
      created_at: Date
      template_version_id: string | null
    }>(
      `SELECT created_at, template_version_id FROM report_runs WHERE id = $1`,
      [runId]
    )
    const row = result.rows[0]
    expect(row).toBeDefined()
    expect(row?.template_version_id).toBeNull()
    expect(row?.created_at.getTime()).toBeLessThan(Date.parse(CHECK_CUTOVER))
  })
})

// --- Editing a pinned template leaves a completed run's pin unchanged ------

describe("Requirements 9.6, 36.2, 36.7 — editing a template a completed run pinned", () => {
  test("leaves that run's pin and its verification's digests unchanged, and the run keeps resolving against its pinned version rather than the newest one", async () => {
    const template = await createTemplate(ownerId, { name: "Pinned template" })

    const v1 = await insertVersion(
      ownerId,
      template.id,
      versionInput({ schema_version: 1, blocks: ["v1-only"] })
    )

    const runId = await insertReportRun({
      templateVersionId: v1.id,
      status: "completed",
    })

    const verification = await insertVerification(
      insertVerificationInput(runId, v1.id)
    )

    // The template is "edited": a new version is saved after the run above
    // was already pinned to version 1.
    const v2 = await insertVersion(
      ownerId,
      template.id,
      versionInput({ schema_version: 1, blocks: ["v1-only", "v2-addition"] })
    )
    expect(v2.version).toBe(2)
    expect(v2.id).not.toBe(v1.id)
    expect(v2.definitionSha256).not.toBe(v1.definitionSha256)

    // The run's own pin, re-read directly, still names version 1 — inserting
    // a new version touched no existing report_runs row.
    const runRow = await readRunRow(runId)
    expect(runRow?.template_version_id).toBe(v1.id)

    // The verification's three digests and its own recorded pin are
    // unchanged — no operation this store exposes updates a
    // report_verifications row (Requirement 36.2), and nothing about saving
    // a later template version touches an earlier run's proof.
    const verificationRow = await db.query<{
      snapshot_sha256: string
      docx_sha256: string
      pdf_sha256: string
      template_version_id: string
    }>(
      `SELECT snapshot_sha256, docx_sha256, pdf_sha256, template_version_id
       FROM report_verifications WHERE id = $1`,
      [verification.id]
    )
    expect(verificationRow.rows[0]?.snapshot_sha256).toBe(SHA_SNAPSHOT)
    expect(verificationRow.rows[0]?.docx_sha256).toBe(SHA_DOCX)
    expect(verificationRow.rows[0]?.pdf_sha256).toBe(SHA_PDF)
    expect(verificationRow.rows[0]?.template_version_id).toBe(v1.id)

    // Resolving the run's pin explicitly (readVersion(1)) still returns
    // version 1's definition and digest, distinct from what
    // readLatestVersion now returns.
    const pinned = await readVersion(ownerId, template.id, 1)
    expect(pinned.id).toBe(v1.id)
    expect(pinned.definitionSha256).toBe(v1.definitionSha256)
    expect(pinned.definition).toEqual({ schema_version: 1, blocks: ["v1-only"] })

    const latest = await readLatestVersion(ownerId, template.id)
    expect(latest?.id).toBe(v2.id)
    expect(latest?.id).not.toBe(pinned.id)
    expect(latest?.definitionSha256).not.toBe(pinned.definitionSha256)

    // And resolving strictly through the run's own FK — the shape a
    // re-verification or a report-detail read actually uses — lands on
    // version 1's row, not version 2's.
    const resolvedByRunPin = await db.query<{
      definition: unknown
      definition_sha256: string
    }>(
      `SELECT definition, definition_sha256 FROM report_template_versions WHERE id = $1`,
      [runRow?.template_version_id]
    )
    expect(resolvedByRunPin.rows[0]?.definition_sha256).toBe(v1.definitionSha256)
    expect(resolvedByRunPin.rows[0]?.definition_sha256).not.toBe(
      v2.definitionSha256
    )
  })
})
