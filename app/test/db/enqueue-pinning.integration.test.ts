import { randomUUID } from "node:crypto"

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"

import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * What the enqueue reads off a pinned template version, against a real Postgres
 * (Requirements 1.5, 3.3, 4.3, 4.5, 4.6, 4.7, 4.11, 9.6).
 *
 * Task 13.1 moved three facts out of the run submission and into the pinned
 * definition: the **version** a run resolves, the **period** it collects over,
 * and the **scope** it collects. Each was previously a field the form supplied,
 * so each is a place where the definition and the run row could now disagree —
 * and the failures are quiet ones. A run pinned to a stale version renders last
 * week's layout; a period resolved from the wrong instant collects the wrong
 * month; a scope narrower than the definition's leaves every block with a
 * `scope_override` rendering its "no resources matched" row on a run that every
 * gate calls correct.
 *
 * Against a real database rather than a mock, because two of the three are about
 * *which row is read*: "the highest existing version as of this read" and "no
 * version row at all" are statements about SQL, and a stubbed store would assert
 * them against a fixture rather than against the query.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

vi.mock("@/lib/db", () => ({
  getDb: () => currentDb(),
}))

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import { EnqueueRejectedError, enqueueRun } from "@/lib/actions/runs"
import { findReusableSnapshotRun } from "@/lib/runs/state"
import * as schema from "@/lib/db/schema"
import type { TemplateDefinition } from "@/lib/templates/definition"
import { V1_TEST_FIXTURE_DEFINITION } from "@/lib/templates/starters"
import { definitionSha256 } from "@/lib/templates/version"

let drizzleDb: NodePgDatabase<typeof schema> | undefined
let ownerId: string
let strangerId: string
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

/**
 * `deriveProgressToken` reads `APP_ENCRYPTION_KEY` at call time, so an enqueue
 * cannot reach its insert without one. A fixed 32-byte key rather than a random
 * one, because the derivation is a pure function of it and the run id — a
 * varying key would make the stored `progress_token_hash` vary between runs of
 * this suite for no reason a reader could see.
 */
const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64")

const savedEnv: Record<string, string | undefined> = {}

const VM = "Microsoft.Compute/virtualMachines"
const STORAGE = "Microsoft.Storage/storageAccounts"

const JAKARTA = "Asia/Jakarta"

/** A base definition the validator accepts — the dedicated v1 test fixture. */
const BASE = V1_TEST_FIXTURE_DEFINITION

function definitionWith(
  overrides: Partial<TemplateDefinition>
): TemplateDefinition {
  return { ...BASE, ...overrides } as TemplateDefinition
}

async function insertUser(id: string): Promise<void> {
  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [id, `${id}@example.com`, `${id}@example.com`, UNUSABLE_PASSWORD_HASH]
  )
}

/** One template owned by `userId`, with a version per definition supplied. */
async function insertTemplate(
  userId: string,
  definitions: readonly unknown[]
): Promise<string> {
  const templateId = `tpl-${randomUUID()}`

  await db.query(
    `INSERT INTO report_templates (id, user_id, name, description)
     VALUES ($1, $2, 'Fixture', '')`,
    [templateId, userId]
  )

  let lastVersionId: string | null = null

  for (const [index, definition] of definitions.entries()) {
    lastVersionId = `ver-${randomUUID()}`

    await db.query(
      `INSERT INTO report_template_versions
         (id, template_id, version, definition, definition_sha256)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        lastVersionId,
        templateId,
        index + 1,
        JSON.stringify(definition),
        definitionSha256(definition as TemplateDefinition),
      ]
    )
  }

  if (lastVersionId !== null) {
    await db.query(
      `UPDATE report_templates SET current_version_id = $2 WHERE id = $1`,
      [templateId, lastVersionId]
    )
  }

  return templateId
}

async function rejectionFrom(
  promise: Promise<unknown>
): Promise<EnqueueRejectedError["rejection"]> {
  try {
    await promise
  } catch (thrown) {
    if (thrown instanceof EnqueueRejectedError) return thrown.rejection
    throw thrown
  }

  throw new Error("the enqueue was expected to reject and did not")
}

async function runCount(): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM report_runs`
  )
  return Number(rows[0]?.n ?? "0")
}

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
  strangerId = randomUUID()
  subscriptionId = `sub-${randomUUID()}`

  await insertUser(ownerId)
  await insertUser(strangerId)

  // `scope_verified` true, `active`, secret good for 90 days: the subscription
  // is deliberately never the reason a case below rejects.
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

describe.skipIf(!db.enabled)("Requirement 9.6 — the run pins a version", () => {
  test("it pins the highest existing version, not current_version_id", async () => {
    const templateId = await insertTemplate(ownerId, [BASE, BASE, BASE])

    // A concurrent save can leave `current_version_id` a version behind, so the
    // enqueue resolves the highest existing row instead. Staling the pointer
    // here is what makes the difference observable: a run that read the pointer
    // would pin version 1.
    const stale = await db.query<{ id: string }>(
      `SELECT id FROM report_template_versions
        WHERE template_id = $1 AND version = 1`,
      [templateId]
    )
    await db.query(
      `UPDATE report_templates SET current_version_id = $2 WHERE id = $1`,
      [templateId, stale.rows[0]!.id]
    )

    const { run } = await enqueueRun(ownerId, {
      connectedSubscriptionId: subscriptionId,
      templateId,
      timezone: JAKARTA,
    })

    const pinned = await db.query<{ version: number }>(
      `SELECT version FROM report_template_versions WHERE id = $1`,
      [run.templateVersionId]
    )

    expect(pinned.rows[0]?.version).toBe(3)
  })

  test("a template with no version rejects and inserts nothing", async () => {
    const templateId = await insertTemplate(ownerId, [])

    const rejection = await rejectionFrom(
      enqueueRun(ownerId, {
        connectedSubscriptionId: subscriptionId,
        templateId,
        timezone: JAKARTA,
      })
    )

    expect(rejection.kind).toBe("template_unversioned")
    expect(await runCount()).toBe(0)
  })

  test("another user's template is not found, and so is an id that exists for nobody", async () => {
    // Requirement 1.5 — the two must be indistinguishable. A `403` for the
    // first would confirm the row exists, and its existence is a fact about
    // somebody else's account.
    const strangers = await insertTemplate(strangerId, [BASE])

    expect(
      (
        await rejectionFrom(
          enqueueRun(ownerId, {
            connectedSubscriptionId: subscriptionId,
            templateId: strangers,
            timezone: JAKARTA,
          })
        )
      ).kind
    ).toBe("template_not_found")

    expect(
      (
        await rejectionFrom(
          enqueueRun(ownerId, {
            connectedSubscriptionId: subscriptionId,
            templateId: `tpl-${randomUUID()}`,
            timezone: JAKARTA,
          })
        )
      ).kind
    ).toBe("template_not_found")

    expect(await runCount()).toBe(0)
  })
})

describe.skipIf(!db.enabled)(
  "Requirements 4.3, 4.5 — the period comes from the pinned specification",
  () => {
    test("last_full_month resolves against the enqueue instant in the run's zone", async () => {
      const templateId = await insertTemplate(ownerId, [
        definitionWith({ period: { kind: "last_full_month" } }),
      ])

      // 2026-08-18T20:00Z is already 2026-08-19 in Jakarta, so the resolution
      // has to use the *local* date. Both give July here, which is the point:
      // the assertion is that the row carries July's first and last local day
      // rather than a window derived from a UTC date.
      const { run } = await enqueueRun(
        ownerId,
        {
          connectedSubscriptionId: subscriptionId,
          templateId,
          timezone: JAKARTA,
        },
        new Date("2026-08-18T20:00:00Z")
      )

      expect(run.periodStart).toBe("2026-07-01")
      expect(run.periodEnd).toBe("2026-07-31")
    })

    test("a custom specification is recorded as its own two dates", async () => {
      const templateId = await insertTemplate(ownerId, [
        definitionWith({
          period: { kind: "custom", start: "2026-07-05", end: "2026-07-11" },
        }),
      ])

      const { run } = await enqueueRun(
        ownerId,
        {
          connectedSubscriptionId: subscriptionId,
          templateId,
          timezone: JAKARTA,
        },
        new Date("2026-08-18T00:00:00Z")
      )

      expect(run.periodStart).toBe("2026-07-05")
      expect(run.periodEnd).toBe("2026-07-11")
    })

    test("two enqueues in the same local day resolve one identical window", async () => {
      // Requirement 4.8. Not the same *run* — the dedupe bucket would collapse
      // those — but the same resolved window from two instants seven hours apart
      // that fall in one Jakarta day.
      const templateId = await insertTemplate(ownerId, [
        definitionWith({ period: { kind: "last_7d" } }),
      ])

      const morning = await enqueueRun(
        ownerId,
        {
          connectedSubscriptionId: subscriptionId,
          templateId,
          timezone: JAKARTA,
        },
        new Date("2026-08-18T01:00:00Z")
      )

      await db.query(`DELETE FROM report_runs`)

      const evening = await enqueueRun(
        ownerId,
        {
          connectedSubscriptionId: subscriptionId,
          templateId,
          timezone: JAKARTA,
        },
        new Date("2026-08-18T08:00:00Z")
      )

      expect(evening.run.periodStart).toBe(morning.run.periodStart)
      expect(evening.run.periodEnd).toBe(morning.run.periodEnd)
    })
  }
)

describe.skipIf(!db.enabled)(
  "Requirements 4.6, 4.7, 4.11 — a period that cannot be collected inserts no row",
  () => {
    test("mtd on the first local day of the month has no complete day", async () => {
      const templateId = await insertTemplate(ownerId, [
        definitionWith({ period: { kind: "mtd" } }),
      ])

      // 2026-08-01 in Jakarta. `mtd` is "the first local day of the current
      // month through the local day preceding today", which on the first is an
      // empty window — and a report over zero days would be a document of
      // nothing that passed every gate.
      const rejection = await rejectionFrom(
        enqueueRun(
          ownerId,
          {
            connectedSubscriptionId: subscriptionId,
            templateId,
            timezone: JAKARTA,
          },
          new Date("2026-08-01T03:00:00Z")
        )
      )

      expect(rejection).toMatchObject({
        kind: "resolved_period",
        code: "no_complete_local_day",
      })
      expect(await runCount()).toBe(0)
    })

    test("a pinned specification outside the six is unrecognized", async () => {
      // Requirement 4.11 is explicitly about a *pinned* version — data read back
      // out of `jsonb`, where the TypeScript type is a promise the database
      // cannot keep. The row is written past the validator on purpose.
      const templateId = await insertTemplate(ownerId, [
        { ...BASE, period: { kind: "last_fortnight" } },
      ])

      const rejection = await rejectionFrom(
        enqueueRun(ownerId, {
          connectedSubscriptionId: subscriptionId,
          templateId,
          timezone: JAKARTA,
        })
      )

      expect(rejection).toMatchObject({
        kind: "resolved_period",
        code: "unrecognized_period",
      })
      expect(await runCount()).toBe(0)
    })

    test("a custom span longer than the maximum is refused", async () => {
      const templateId = await insertTemplate(ownerId, [
        {
          ...BASE,
          period: { kind: "custom", start: "2026-05-01", end: "2026-07-31" },
        },
      ])

      const rejection = await rejectionFrom(
        enqueueRun(ownerId, {
          connectedSubscriptionId: subscriptionId,
          templateId,
          timezone: JAKARTA,
        })
      )

      expect(rejection).toMatchObject({
        kind: "resolved_period",
        code: "exceeds_maximum_days",
      })
      expect(await runCount()).toBe(0)
    })
  }
)

describe.skipIf(!db.enabled)(
  "Requirement 3.3 — the scope is the definition's union",
  () => {
    test("a block's scope_override widens what the run collects", async () => {
      // The failure this catches: before task 13.1 the form supplied the scope,
      // so a block scoped to storage accounts collected none — and rendered its
      // "no resources matched" row on a run that passed every gate.
      const templateId = await insertTemplate(ownerId, [
        definitionWith({
          scope: {
            resource_types: [VM],
            tag_filters: [],
            resource_groups: [],
            top_n: null,
            sort: null,
          },
          blocks: [
            {
              id: "storage-table",
              type: "resource_table",
              config: {
                columns: [{ metric: "Percentage CPU", statistic: "avg" }],
              },
              scope_override: {
                resource_types: [STORAGE],
                tag_filters: [],
                resource_groups: [],
                top_n: null,
                sort: null,
              },
            },
          ],
        }),
      ])

      const { run } = await enqueueRun(ownerId, {
        connectedSubscriptionId: subscriptionId,
        templateId,
        timezone: JAKARTA,
      })

      expect(run.scope.resource_types).toEqual([VM, STORAGE].sort())
    })

    test("the recorded scope carries no top_n and no sort", async () => {
      // Requirement 3.3 — one snapshot has to carry every resource any block
      // needs, *including* the candidates a top-N ordering discards.
      const templateId = await insertTemplate(ownerId, [
        definitionWith({
          scope: {
            resource_types: [VM],
            tag_filters: [],
            resource_groups: [],
            top_n: { count: 10, metric: "Percentage CPU", statistic: "avg" },
            sort: "descending",
          },
        }),
      ])

      const { run } = await enqueueRun(ownerId, {
        connectedSubscriptionId: subscriptionId,
        templateId,
        timezone: JAKARTA,
      })

      expect(Object.keys(run.scope).sort()).toEqual([
        "resource_groups",
        "resource_types",
        "tag_filters",
      ])
    })
  }
)

// ---------------------------------------------------------------------------
// Reusing a snapshot a previous run collected
//
// A re-run of one period asks Azure the same question again, and Azure may answer
// differently — late samples, a resized machine, a resource deleted since. Reuse is the
// consultant's choice; these hold the shape of the offer they are choosing from.
// ---------------------------------------------------------------------------

describe.skipIf(!db.enabled)("findReusableSnapshotRun", () => {
  const JULY = { periodStart: "2026-07-01", periodEnd: "2026-07-31" }
  const SCOPE = {
    resource_types: ["Microsoft.Compute/virtualMachines"],
    resource_groups: [],
    tag_filters: {},
  }

  async function seedRun(
    overrides: Partial<{
      status: string
      periodStart: string
      periodEnd: string
      timezone: string
      scope: unknown
      userId: string
      subscriptionId: string
      createdAt: string
    }> = {}
  ): Promise<string> {
    const id = randomUUID()
    await db.query(
      `INSERT INTO report_runs
         (id, user_id, connected_subscription_id, period_start, period_end,
          timezone, scope, status, dedupe_key, progress_token_hash,
          phase_deadline, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'hash',
               now() + interval '900 seconds', $10, now())`,
      [
        id,
        overrides.userId ?? ownerId,
        overrides.subscriptionId ?? subscriptionId,
        overrides.periodStart ?? JULY.periodStart,
        overrides.periodEnd ?? JULY.periodEnd,
        overrides.timezone ?? JAKARTA,
        JSON.stringify(overrides.scope ?? SCOPE),
        overrides.status ?? "completed",
        randomUUID(),
        overrides.createdAt ?? "2026-08-01T00:00:00Z",
      ]
    )
    return id
  }

  const criteria = {
    connectedSubscriptionId: "",
    periodStart: JULY.periodStart,
    periodEnd: JULY.periodEnd,
    timezone: JAKARTA,
    scope: SCOPE,
  }

  function forThisSubscription() {
    return { ...criteria, connectedSubscriptionId: subscriptionId }
  }

  test("a completed run over the same period and scope is offered", async () => {
    const id = await seedRun()
    const found = await findReusableSnapshotRun(ownerId, forThisSubscription())
    expect(found?.id).toBe(id)
  })

  test("the newest is offered where a period was collected several times", async () => {
    // The most recent is the one whose numbers the consultant most likely has in front
    // of them.
    await seedRun({ createdAt: "2026-08-01T00:00:00Z" })
    const newer = await seedRun({ createdAt: "2026-08-20T00:00:00Z" })
    const found = await findReusableSnapshotRun(ownerId, forThisSubscription())
    expect(found?.id).toBe(newer)
  })

  test("a run that did not complete has no snapshot to offer", async () => {
    // `failed` is seeded separately: `report_runs_error_code_ck` requires a failed row to
    // carry a code, which is the database holding the same line this function does —
    // a run that did not complete wrote no snapshot to offer.
    for (const status of ["queued", "claimed", "collecting"]) {
      await seedRun({ status })
    }
    await db.query(
      `INSERT INTO report_runs
         (id, user_id, connected_subscription_id, period_start, period_end,
          timezone, scope, status, error_code, dedupe_key, progress_token_hash,
          phase_deadline, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'failed', 'TIMEOUT', $8, 'hash',
               now() + interval '900 seconds', now(), now())`,
      [
        randomUUID(),
        ownerId,
        subscriptionId,
        JULY.periodStart,
        JULY.periodEnd,
        JAKARTA,
        JSON.stringify(SCOPE),
        randomUUID(),
      ]
    )
    expect(
      await findReusableSnapshotRun(ownerId, forThisSubscription())
    ).toBeUndefined()
  })

  test("another period is not offered", async () => {
    await seedRun({ periodStart: "2026-06-01", periodEnd: "2026-06-30" })
    expect(
      await findReusableSnapshotRun(ownerId, forThisSubscription())
    ).toBeUndefined()
  })

  test("another timezone is not offered", async () => {
    // One UTC window is a different set of local days in another zone, and every day
    // bucket in the snapshot is keyed by a local day. The runtime refuses this too; the
    // offer declines it first so nobody learns it from a failed run.
    await seedRun({ timezone: "America/New_York" })
    expect(
      await findReusableSnapshotRun(ownerId, forThisSubscription())
    ).toBeUndefined()
  })

  test("a narrower scope is not offered", async () => {
    // The runtime cannot catch this: the resources the snapshot lacks would read as an
    // estate that simply has none of that type. So the offer is where it must be caught.
    await seedRun({ scope: { ...SCOPE, resource_types: [] } })
    expect(
      await findReusableSnapshotRun(ownerId, forThisSubscription())
    ).toBeUndefined()
  })

  test("another user's run is never offered", async () => {
    await seedRun({ userId: strangerId })
    expect(
      await findReusableSnapshotRun(ownerId, forThisSubscription())
    ).toBeUndefined()
  })

  test("another subscription's run is not offered", async () => {
    const other = `sub-${randomUUID()}`
    await db.query(
      `INSERT INTO connected_subscriptions
         (id, user_id, display_name, subscription_id, tenant_id, client_id,
          client_secret_enc, scope_verified, fidelity_tier, secret_expires_at, status)
       VALUES ($1, $2, 'Other', '4f2b0000-0000-0000-0000-000000000000', 't', 'c',
               'x', true, 'baseline', now() + interval '90 days', 'active')`,
      [other, ownerId]
    )
    await seedRun({ subscriptionId: other })
    expect(
      await findReusableSnapshotRun(ownerId, forThisSubscription())
    ).toBeUndefined()
  })

  test("the enqueue records the choice on the row", async () => {
    const source = await seedRun()
    const templateId = await insertTemplate(ownerId, [BASE])

    const { run } = await enqueueRun(ownerId, {
      connectedSubscriptionId: subscriptionId,
      templateId,
      timezone: JAKARTA,
      reuseSnapshotRunId: source,
    })

    expect(run.reuseSnapshotRunId).toBe(source)
  })

  test("a run that did not ask to reuse records null", async () => {
    const templateId = await insertTemplate(ownerId, [BASE])
    const { run } = await enqueueRun(ownerId, {
      connectedSubscriptionId: subscriptionId,
      templateId,
      timezone: JAKARTA,
    })
    expect(run.reuseSnapshotRunId).toBeNull()
  })
})
