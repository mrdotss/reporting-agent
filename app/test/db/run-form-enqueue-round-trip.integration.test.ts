import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * The run form's body reaches the real `enqueueRun` (Requirements 13.7, 13.14, 37.1).
 *
 * ## The assertion this file exists for, and why it is not in `run-form.test.tsx`
 *
 * `POST /api/runs` rejected **every** `schema_version >= 2` run in production.
 * `lib/actions/runs.ts` requires a customer name and a revision-history row once it
 * has resolved which version the run pinned; `components/reports/run-form.tsx`
 * submitted three fields and had never collected those two. Each half was correct
 * about its own side, `lib/runs/input.ts` correctly accepted both as *optional*
 * (the schema runs before the version is resolved and cannot know yet whether it is
 * v2), and the browser showed `internalError()`'s fixed text — so the only evidence
 * was a server log nobody was reading.
 *
 * `run-form.test.tsx` asserts what the form **sends**. That is necessary and not
 * sufficient: it would keep passing if the enqueue's requirement changed underneath
 * it. This file closes the loop from the other end — it takes the body
 * `buildRunCreateBody` produces, parses it with the route's own schema, and hands the
 * result to the real `enqueueRun` against a real Postgres. **A v2 template must reach
 * an inserted row without an `EnqueueRejectedError`.**
 *
 * It is a separate file because it has to be. `vitest.config.ts` runs `.tsx` in the
 * jsdom project and `test/**` in the node project, and only the jsdom project carries
 * the react plugin — so a DB harness cannot live beside a rendering test, and a node
 * test cannot import the form module. The shared seam is `buildRunCreateBody`, which
 * both sides exercise; that function exists so this pair of tests can meet.
 *
 * Against a real database rather than a mock, for the reason the sibling
 * `enqueue-pinning.integration.test.ts` gives: the requirement turns on *which row is
 * read* — the highest existing version, and the `schema_version` inside its
 * definition — and a stubbed store would assert that against a fixture instead of
 * against the query.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

vi.mock("@/lib/db", () => ({
  getDb: () => currentDb(),
}))

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import { EnqueueRejectedError, enqueueRun } from "@/lib/actions/runs"
import * as schema from "@/lib/db/schema"
import { buildRunCreateBody, runCreateInputSchema } from "@/lib/runs/input"
import type { TemplateDefinition } from "@/lib/templates/definition"
import { toSchemaVersion2 } from "@/lib/templates/migrate"
import { STARTER_TEMPLATES } from "@/lib/templates/starters"
import { definitionSha256 } from "@/lib/templates/version"

let drizzleDb: NodePgDatabase<typeof schema> | null = null

function currentDb(): NodePgDatabase<typeof schema> {
  if (drizzleDb === null) throw new Error("the fixture database is not open")
  return drizzleDb
}

const UNUSABLE_PASSWORD_HASH = "$argon2id$fixture-never-verified"
const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64")
const JAKARTA = "Asia/Jakarta"

const savedEnv: Record<string, string | undefined> = {}

/** The v1 starter, and the same definition migrated to v2. */
const V1_DEFINITION = STARTER_TEMPLATES[0]!.definition
const V2_DEFINITION = toSchemaVersion2(V1_DEFINITION)

let ownerId = ""
let subscriptionId = ""

async function insertUser(id: string): Promise<void> {
  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [id, `${id}@example.com`, `${id}@example.com`, UNUSABLE_PASSWORD_HASH]
  )
}

/** One template owned by `ownerId`, carrying exactly one version. */
async function insertTemplate(definition: unknown): Promise<string> {
  const templateId = `tpl-${randomUUID()}`
  const versionId = `ver-${randomUUID()}`

  await db.query(
    `INSERT INTO report_templates (id, user_id, name, description)
     VALUES ($1, $2, 'Fixture', '')`,
    [templateId, ownerId]
  )

  await db.query(
    `INSERT INTO report_template_versions
       (id, template_id, version, definition, definition_sha256)
     VALUES ($1, $2, 1, $3, $4)`,
    [
      versionId,
      templateId,
      JSON.stringify(definition),
      definitionSha256(definition as TemplateDefinition),
    ]
  )

  await db.query(
    `UPDATE report_templates SET current_version_id = $2 WHERE id = $1`,
    [templateId, versionId]
  )

  return templateId
}

/**
 * The form's body for one submission, parsed by the route's own schema.
 *
 * Both steps on purpose. `buildRunCreateBody` is what the form calls, and
 * `runCreateInputSchema` is what the route applies before `enqueueRun` sees
 * anything — so this is the whole path from the consultant's four inputs to the
 * action's argument, with nothing hand-written in between.
 */
function submissionFor(
  templateId: string,
  frontMatter: {
    readonly customerName: string
    readonly revision: string
    readonly note: string
    readonly author: string
  } | null
) {
  const body = buildRunCreateBody({
    connectedSubscriptionId: subscriptionId,
    templateId,
    timezone: JAKARTA,
    frontMatter,
  })

  return runCreateInputSchema.parse(body)
}

const FRONT_MATTER = {
  customerName: "Contoso Ltd",
  revision: "1.0",
  note: "First issue",
  author: "A. Consultant",
} as const

beforeAll(async () => {
  if (!db.enabled) return

  savedEnv["APP_ENCRYPTION_KEY"] = process.env["APP_ENCRYPTION_KEY"]
  process.env["APP_ENCRYPTION_KEY"] = ENCRYPTION_KEY

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
  subscriptionId = `sub-${randomUUID()}`

  await insertUser(ownerId)

  // Deliberately never the reason a case here rejects.
  await db.query(
    `INSERT INTO connected_subscriptions
       (id, user_id, display_name, subscription_id, tenant_id, client_id,
        client_secret_enc, scope_verified, fidelity_tier, secret_expires_at,
        status)
     VALUES ($1, $2, 'Fixture subscription',
             '3f2b0000-0000-0000-0000-000000000000', 'tenant-fixture',
             'client-fixture', 'ciphertext-fixture', true, 'baseline',
             now() + interval '90 days', 'active')`,
    [subscriptionId, ownerId]
  )
})

// ---------------------------------------------------------------------------

describe.skipIf(!db.enabled)(
  "Requirement 13.14 — the form's body satisfies the enqueue",
  () => {
    test("a v2 template with the four values filled enqueues without rejection", async () => {
      const templateId = await insertTemplate(V2_DEFINITION)

      // The assertion the missing test would have made. Not "the enqueue accepts a
      // hand-written body carrying the right keys" — it always did — but that the
      // body *the form builds* is one of those.
      const result = await enqueueRun(
        ownerId,
        submissionFor(templateId, FRONT_MATTER)
      )

      expect(result.run.id).toBeTruthy()

      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM report_runs`
      )
      expect(Number(rows[0]!.n)).toBe(1)
    })

    test("the customer name and revision row reach the row, not just the call", async () => {
      const templateId = await insertTemplate(V2_DEFINITION)

      await enqueueRun(ownerId, submissionFor(templateId, FRONT_MATTER))

      const { rows } = await db.query<{
        customer_name: string | null
        revision_history_row: unknown
      }>(
        `SELECT customer_name, revision_history_row FROM report_runs LIMIT 1`
      )

      // Persisted, because a value the enqueue accepted and dropped would render a
      // cover page with nothing on it — which is the failure the requirement exists
      // to prevent, one layer past the one this defect was at.
      expect(rows[0]!.customer_name).toBe("Contoso Ltd")
      expect(rows[0]!.revision_history_row).toEqual({
        revision: "1.0",
        note: "First issue",
        author: "A. Consultant",
      })
    })

    test("a v1 template enqueues with the two keys absent, as the form sends it", async () => {
      const templateId = await insertTemplate(V1_DEFINITION)

      // The other half of the same agreement: a v1 run must not be made to answer
      // for a page it does not have.
      const result = await enqueueRun(ownerId, submissionFor(templateId, null))

      expect(result.run.id).toBeTruthy()
    })

    test("the defect's own shape still rejects — a v2 template with no front matter", async () => {
      const templateId = await insertTemplate(V2_DEFINITION)

      // This is what the form used to send for a v2 template, and it must keep
      // failing. The requirement is not relaxed by anything above: a cover and a
      // revision row with nothing in them is not a document anyone can send a
      // customer, so the enqueue's refusal is correct and stays.
      await expect(
        enqueueRun(ownerId, submissionFor(templateId, null))
      ).rejects.toThrow(EnqueueRejectedError)

      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM report_runs`
      )
      expect(Number(rows[0]!.n)).toBe(0)
    })
  }
)
