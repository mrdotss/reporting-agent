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
 * **Updated for task 4.4** (Requirement 12.2, 12.8, 12.9): the form retired
 * `customerName` entirely rather than merely hiding it, so `buildRunCreateBody`
 * no longer accepts it as a parameter at all. A schema_version 3 pin sources
 * the value from its own `identity.customer_name` instead — proven here
 * end-to-end against a real Postgres row, not just against `enqueueRun`'s
 * in-memory resolution. The consequence for a v2 pin (which has no
 * `identity.customer_name` to fall back to) is also asserted: it can no
 * longer be enqueued through this form at all, which is the intended shape
 * of retiring a run-time field, not a regression this file papers over.
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
import { V1_TEST_FIXTURE_DEFINITION } from "@/lib/templates/starters"
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

/** The v1 fixture, the same definition migrated to v2, and a dedicated v3
 * fixture carrying `identity.customer_name` (task 4.4's own sourcing path —
 * there is no "migrate v1/v2 to v3" function to reuse here, so this is built
 * directly, the same minimal-valid-v3 shape task 4.1's own tests use). */
const V1_DEFINITION = V1_TEST_FIXTURE_DEFINITION
const V2_DEFINITION = toSchemaVersion2(V1_DEFINITION)
const V3_DEFINITION = {
  schema_version: 3,
  identity: {
    name: "V3 fixture",
    language: "en",
    customer_name: "Contoso Ltd",
  },
  provider: "azure",
  sections: [
    {
      id: "sec_vm",
      type: "vm_utilization",
      selection: {
        resource_types: ["Microsoft.Compute/virtualMachines"],
        resource_groups: [],
        tag_filters: [],
        top_n: null,
        sort: null,
      },
      metrics: [{ metric: "Percentage CPU", statistic: "avg" }],
      presentation: "chart_and_table",
    },
  ],
  period: { kind: "last_full_month" },
  design: {
    preset: "editorial",
    accent_color: "oklch(0.52 0.105 223)",
    density: "normal",
    table_style: "hairline",
    page_size: "A4",
    number_format: { decimal_places: 1, group_thousands: true },
    cover_page: true,
    logo: null,
  },
  front_matter: {
    cover: { subtitle: "Test" },
    document_control: {
      approvers: [
        { role: "author", name: "A" },
        { role: "reviewer", name: "B" },
        { role: "approver", name: "C" },
        { role: "recipient", name: "D" },
      ],
    },
    toc: { enabled: true, max_level: 3 },
  },
}

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
 * anything — so this is the whole path from the consultant's inputs to the
 * action's argument, with nothing hand-written in between.
 */
function submissionFor(
  templateId: string,
  frontMatter: {
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
    // A v3 template that actually reaches an inserted row cannot be tested here
    // today: `enqueueRun`'s step 5 (`unionScope`) assumes the v1/v2 `blocks`
    // shape unconditionally and throws `TypeError: definition.blocks is not
    // iterable` on any v3 (`sections`-shaped) definition — a real, separate,
    // pre-existing gap this task's own testing surfaced, not something task 4.4
    // introduced or is scoped to fix. `resolveCustomerName`'s resolution logic
    // (the part task 4.4 actually built) runs at step 4b, strictly before that
    // crash, and is proven directly and unit-tested in
    // `test/customer-name-resolution.test.ts` instead — see that file and
    // `tasks.md`'s note on this task for the open gap.
    //
    // What CAN be proven here without `unionScope` succeeding: the v3
    // front-matter-values gate itself still fires correctly (it runs before
    // step 5 too), and the v1/v2 paths are unaffected by any of this.

    test("a v1 template enqueues with the two keys absent, as the form sends it", async () => {
      const templateId = await insertTemplate(V1_DEFINITION)

      // The other half of the same agreement: a v1 run must not be made to answer
      // for a page it does not have.
      const result = await enqueueRun(ownerId, submissionFor(templateId, null))

      expect(result.run.id).toBeTruthy()
    })

    test("a v3 template carrying its own customer name enqueues with no front matter", async () => {
      // This used to assert the opposite, and it was right when it was written: the form
      // submitted a customer name and a revision row per run, and a v3 pin sending
      // neither was the defect Requirement 13.14 refuses.
      //
      // Both of those moved onto the profile. `identity.customer_name` is authored once
      // in the wizard, and the revision row is derived at enqueue rather than submitted
      // (`DERIVED_REVISION_SCHEMA_VERSION`) — so at v3 there is nothing left for the form
      // to send, and refusing a run for not sending it would refuse every v3 run.
      //
      // The gate is unchanged; what reaches it is. The refusal it still makes is the
      // next test.
      const templateId = await insertTemplate(V3_DEFINITION)

      const result = await enqueueRun(ownerId, submissionFor(templateId, null))
      expect(result.run.id).toBeTruthy()
      expect(result.run.customerName).toBe("Contoso Ltd")
    })

    test("a v3 template with no customer name anywhere is still refused", async () => {
      // Requirement 13.14's live half. A blank customer is not a document anyone can
      // send: it would pass the gate and print an empty name on the document control
      // page, which is worse than the refusal.
      const { identity, ...rest } = V3_DEFINITION as Record<string, unknown> & {
        identity: Record<string, unknown>
      }
      const { customer_name: _dropped, ...identityWithout } = identity
      const templateId = await insertTemplate({
        ...rest,
        identity: identityWithout,
      })

      await expect(
        enqueueRun(ownerId, submissionFor(templateId, null))
      ).rejects.toThrow(EnqueueRejectedError)

      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM report_runs`
      )
      expect(Number(rows[0]!.n)).toBe(0)
    })

    test("a v2 template can no longer be enqueued through the form (Requirement 12.8)", async () => {
      // The form retired `customerName` entirely (task 4.4) — it is not merely
      // hidden for v3, `buildRunCreateBody` never accepts it as a parameter at
      // all. A v2 pin's front-matter gate still reads `input.customerName`
      // (identity.customer_name does not exist at v2), and the form now never
      // supplies it — so the one remaining path that used to work for v2 is
      // gone, which is the intended shape of retiring a run-time field rather
      // than an oversight this test papers over.
      const templateId = await insertTemplate(V2_DEFINITION)

      await expect(
        enqueueRun(ownerId, submissionFor(templateId, FRONT_MATTER))
      ).rejects.toThrow(EnqueueRejectedError)
    })
  }
)
