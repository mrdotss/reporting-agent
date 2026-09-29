import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * Review and send, and the public proof, against a real Postgres: contacts, the approved
 * send of a verified report (with Mailtrap replaced by a recorder), the customer's link and
 * its expiry, and what the proof page may read.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

vi.mock("@/lib/db", () => ({
  getDb: () => currentDb(),
  getPool: () => db.pool(),
}))

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import { enqueueRun } from "@/lib/actions/runs"
import * as schema from "@/lib/db/schema"
import {
  DeliveryInputError,
  addContact,
  approveAndSend,
  deliveryArtifact,
  latestDelivery,
  listContacts,
  openDelivery,
} from "@/lib/delivery/store"
import type { MailMessage, MailResult } from "@/lib/mail/mailtrap"
import { readProof } from "@/lib/proof/read"
import type { TemplateDefinition } from "@/lib/templates/definition"
import { V1_TEST_FIXTURE_DEFINITION } from "@/lib/templates/starters"
import { definitionSha256 } from "@/lib/templates/version"
import { WorkspaceAccessError } from "@/lib/workspaces/access"

let drizzleDb: NodePgDatabase<typeof schema> | undefined
let ownerId: string
let strangerId: string
let subscriptionId: string

function currentDb(): NodePgDatabase<typeof schema> {
  if (drizzleDb === undefined) throw new Error("The scratch-schema Drizzle client is not open.")
  return drizzleDb
}

const savedEnv: Record<string, string | undefined> = {}
const HEX = (c: string) => c.repeat(64)

async function insertUser(id: string): Promise<void> {
  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash) VALUES ($1, $2, $3, $4)`,
    [id, `${id}@example.com`, `${id}@example.com`, "$argon2id$fixture-never-verified"]
  )
}

async function insertTemplate(userId: string): Promise<string> {
  const templateId = `tpl-${randomUUID()}`
  const versionId = `ver-${randomUUID()}`
  await db.query(`INSERT INTO report_templates (id, user_id, name, description) VALUES ($1, $2, 'Monthly', '')`, [templateId, userId])
  await db.query(
    `INSERT INTO report_template_versions (id, template_id, version, definition, definition_sha256) VALUES ($1, $2, 1, $3, $4)`,
    [versionId, templateId, JSON.stringify(V1_TEST_FIXTURE_DEFINITION), definitionSha256(V1_TEST_FIXTURE_DEFINITION as TemplateDefinition)]
  )
  await db.query(`UPDATE report_templates SET current_version_id = $2 WHERE id = $1`, [templateId, versionId])
  return templateId
}

const scopeOf = (userId: string) => ({ workspaceId: `imported-${userId}`, projectId: `imported-project-${userId}` })

/** A run of the owner's, completed and verified unless told otherwise. */
let enqueued = 0
async function verifiedRun({ completed = true, verified = true } = {}): Promise<string> {
  // Each in its own minute: the enqueue deduplicates submissions inside one.
  enqueued += 1
  const { run } = await enqueueRun(
    ownerId,
    { connectedSubscriptionId: subscriptionId, templateId: await insertTemplate(ownerId), timezone: "Asia/Jakarta" },
    new Date(Date.UTC(2026, 8, 2, 0, 0) + enqueued * 120_000)
  )
  if (completed) await db.query(`UPDATE report_runs SET status = 'completed' WHERE id = $1`, [run.id])
  await db.query(
    `INSERT INTO report_verifications
       (id, run_id, attempt_id, template_version_id, status, figure_count, snapshot_sha256, docx_sha256, pdf_sha256,
        replay, drift_sample, findings, counts, artifact_key)
     VALUES ($1, $2, 'attempt-1', $3, $4, 402, $5, $6, $7, '{}', '{}', '[]', '{}', $8)`,
    [
      randomUUID(), run.id, run.templateVersionId, verified ? "pass" : "fail", HEX("a"), HEX("b"), HEX("c"),
      `${ownerId}/reports/${run.id}/verification-attempt-1.json`,
    ]
  )
  return run.id
}

function recorder(fail: (to: string) => string | null = () => null) {
  const sent: MailMessage[] = []
  const send = async (message: MailMessage): Promise<MailResult> => {
    sent.push(message)
    const error = fail(message.to.email)
    return error === null ? { ok: true, messageId: `msg-${sent.length}` } : { ok: false, error }
  }
  return { sent, send }
}

beforeAll(() => {
  if (!db.enabled) return
  savedEnv["APP_ENCRYPTION_KEY"] = process.env["APP_ENCRYPTION_KEY"]
  process.env["APP_ENCRYPTION_KEY"] = Buffer.alloc(32, 9).toString("base64")
  drizzleDb = drizzle(db.pool(), { schema })
})

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

beforeEach(async () => {
  if (!db.enabled) return
  await db.query(`TRUNCATE users CASCADE`)
  ownerId = randomUUID()
  strangerId = randomUUID()
  subscriptionId = `sub-${randomUUID()}`
  await insertUser(ownerId)
  await insertUser(strangerId)
  await db.query(
    `INSERT INTO connected_subscriptions
       (id, user_id, display_name, subscription_id, tenant_id, client_id, client_secret_enc,
        scope_verified, fidelity_tier, secret_expires_at, status)
     VALUES ($1, $2, 'Fixture subscription', '3f2b0000-0000-0000-0000-000000000000', 'tenant-fixture',
             'client-fixture', 'ciphertext-fixture', true, 'baseline', now() + interval '400 days', 'active')`,
    [subscriptionId, ownerId]
  )
})

describe.skipIf(!db.enabled)("Review and send", () => {
  test("contacts: validated, unique per customer, and only for members who can edit", async () => {
    const scope = scopeOf(ownerId)
    await addContact(ownerId, scope, { name: "Budi", email: " Budi@Customer.co.id " })
    await expect(addContact(ownerId, scope, { name: "Budi again", email: "budi@customer.co.id" })).rejects.toBeInstanceOf(DeliveryInputError)
    await expect(addContact(ownerId, scope, { name: "No address", email: "not-an-email" })).rejects.toBeInstanceOf(DeliveryInputError)
    await expect(addContact(strangerId, scope, { name: "X", email: "x@example.com" })).rejects.toBeInstanceOf(WorkspaceAccessError)
    expect(await listContacts(ownerId, scope)).toEqual([expect.objectContaining({ name: "Budi", email: "budi@customer.co.id" })])
  })

  test("only a completed, verified report is sent, and only to a customer with contacts", async () => {
    const { send } = recorder()
    const unverified = await verifiedRun({ verified: false })
    await expect(approveAndSend(ownerId, unverified, { send, baseUrl: "https://app.test" })).rejects.toBeInstanceOf(DeliveryInputError)
    const runId = await verifiedRun()
    await expect(approveAndSend(ownerId, runId, { send, baseUrl: "https://app.test" })).rejects.toThrow(/at least one contact/)
    await expect(approveAndSend(strangerId, runId, { send, baseUrl: "https://app.test" })).rejects.toBeInstanceOf(WorkspaceAccessError)
  })

  test("a send emails each contact separately, records each result, and the link opens and expires", async () => {
    const scope = scopeOf(ownerId)
    await addContact(ownerId, scope, { name: "Budi", email: "budi@customer.co.id" })
    await addContact(ownerId, scope, { name: "Sari", email: "sari@customer.co.id" })
    const runId = await verifiedRun()
    const { sent, send } = recorder((to) => (to.startsWith("sari") ? "Mailtrap's sending limit was reached." : null))
    const now = new Date("2026-09-03T02:00:00Z")

    const delivery = await approveAndSend(ownerId, runId, { send, now, baseUrl: "https://app.test/" })
    expect(delivery.status).toBe("partial")
    expect(delivery.recipients).toEqual([
      { name: "Budi", email: "budi@customer.co.id", ok: true },
      { name: "Sari", email: "sari@customer.co.id", ok: false, error: "Mailtrap's sending limit was reached." },
    ])
    expect(sent).toHaveLength(2)
    expect(sent[0]!.to).toEqual({ email: "budi@customer.co.id", name: "Budi" })
    expect(sent[0]!.text).toContain("402 figures")
    expect(sent[0]!.text).toContain(`https://app.test/v/${runId}`)
    const token = /https:\/\/app\.test\/r\/([A-Za-z0-9_-]+)/.exec(sent[0]!.text)![1]!

    const opened = await openDelivery(token, new Date("2026-09-04T00:00:00Z"))
    expect(opened).toMatchObject({ runId, figureCount: 402 })
    expect(await latestDelivery(ownerId, runId)).toMatchObject({ openCount: 1, firstOpenedAt: "2026-09-04T00:00:00.000Z" })
    expect(await deliveryArtifact(token, "pdf")).toEqual({ runId, actorId: ownerId, key: `${ownerId}/reports/${runId}/report.pdf` })

    // Thirty days by default; after that the link is gone.
    expect(await openDelivery(token, new Date("2026-10-04T00:00:00Z"))).toBeNull()
    expect(await openDelivery("not-a-real-token-at-all-000000", now)).toBeNull()
  })
})

describe.skipIf(!db.enabled)("the public proof", () => {
  test("states only what proves the file, and only for a completed, verified report", async () => {
    const runId = await verifiedRun()
    const proof = await readProof(runId)
    expect(proof).toMatchObject({ runId, figureCount: 402, snapshotSha256: HEX("a"), docxSha256: HEX("b"), pdfSha256: HEX("c") })
    expect(Object.keys(proof!).sort()).toEqual(
      ["docxSha256", "figureCount", "pdfSha256", "periodEnd", "periodStart", "runId", "snapshotSha256", "timezone", "verifiedAt"].sort()
    )
    expect(await readProof(await verifiedRun({ completed: false }))).toBeNull()
    expect(await readProof(await verifiedRun({ verified: false }))).toBeNull()
    expect(await readProof("not-a-uuid")).toBeNull()
  })
})
