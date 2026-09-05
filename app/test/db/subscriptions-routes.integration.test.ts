import { randomUUID } from "node:crypto"

import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * The onboarding route handlers against a real Postgres 17 — `POST` and `GET
 * /api/subscriptions`, and `POST /api/subscriptions/[id]/secret`
 * (Requirements 9.8, 9.10, 12.5, 10.2).
 *
 * ## Why these claims need a database, when the route suites do not
 *
 * `test/api/subscriptions.route.test.ts` and
 * `test/api/subscriptions.secret.route.test.ts` fake the store, because what they
 * assert is which arguments a handler passes and which status it answers with —
 * claims about the handler, decided before any SQL runs. Every claim in *this*
 * file is the other kind: a statement about what is, or is not, **in the table**
 * once the handler has returned.
 *
 *   * **Requirement 12.5** — "persists no row whose `status` is `active`" is a
 *     claim about the table, and the honest form of it is stronger than a status
 *     code: a rejected preflight must leave **no row at all**. Only a real
 *     `SELECT` can say that.
 *   * **Requirement 9.10** — the rejection is
 *     `connected_subscriptions_user_id_subscription_id_uq`. Only the database can
 *     refuse the second insert, and "no second row" is again a `SELECT`. A faked
 *     store throwing a hand-built error asserts that the *test* knows the
 *     constraint's name.
 *   * **Requirement 9.8** — "applies no write, and discloses no field" is a claim
 *     about the row that was *not* touched, so it is asserted by reading the other
 *     user's row back out afterwards.
 *
 * `test/db/subscription-store.integration.test.ts` already makes the duplicate and
 * cross-user claims at the **store's** boundary. This file makes them **through the
 * routes**, which is a different statement: it asserts that the handlers reach the
 * store with the session's user id and translate its refusals into the answers
 * Requirements 9.8 and 9.10 name, rather than that the store refuses when called
 * correctly.
 *
 * ## What is doubled
 *
 * Three things: `getDb` (bound to this file's scratch schema), the session guard,
 * and `runPreflight`. The store, the boundary schemas, the response builders and
 * `@/lib/crypto` are all real — the crypto especially, because the duplicate test
 * asserts that the losing submission's plaintext reached no column, and a stubbed
 * cipher would erase the property being asserted.
 *
 * The preflight is faked because it is the one collaborator that would otherwise
 * invoke AgentCore. Its fake carries a `beforeReturn` seam, which is what makes the
 * rotation's `WHERE` predicate assertable: see the third describe.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

// --- The three doubles ------------------------------------------------------

const { session, preflight } = vi.hoisted(() => ({
  session: { user: undefined as { id: string; email: string } | undefined },
  preflight: {
    outcome: undefined as unknown,
    calls: [] as unknown[],
    /** Runs inside the preflight, between the row read and the write. */
    beforeReturn: undefined as (() => Promise<void>) | undefined,
  },
}))

vi.mock("@/lib/db", () => ({
  getDb: () => currentDb(),
}))

vi.mock("@/lib/auth/guard", () => ({
  requireSessionForApi: async () => session.user ?? null,
}))

vi.mock("@/lib/subscriptions/preflight", () => ({
  runPreflight: async (submission: unknown) => {
    preflight.calls.push(submission)

    const hook = preflight.beforeReturn
    preflight.beforeReturn = undefined
    if (hook !== undefined) await hook()

    return preflight.outcome
  },
}))

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import type { ApiErrorBody } from "@/lib/api/response"
import * as schema from "@/lib/db/schema"
import type { ConnectedSubscriptionView } from "@/lib/db/views"

import { POST as ROTATE } from "@/app/api/subscriptions/[id]/secret/route"
import { GET, POST } from "@/app/api/subscriptions/route"

// --- Fixtures ---------------------------------------------------------------

/** 32 bytes, base64. A fixture key: it protects nothing. */
const FAKE_KEY_BASE64 = Buffer.alloc(32, 11).toString("base64")

/**
 * Distinctive enough that a substring scan over a whole row cannot match either
 * one by accident, and distinct from each other so the two submissions of the
 * duplicate test cannot be confused.
 */
const FIRST_SECRET = "azure-client-secret-FIRST-DO-NOT-DISCLOSE-9f13c7"
const SECOND_SECRET = "azure-client-secret-SECOND-DO-NOT-DISCLOSE-4b81ea"
const ROTATED_SECRET = "azure-client-secret-ROTATED-DO-NOT-DISCLOSE-71c0da"

const SUBSCRIPTION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
const OTHER_SUBSCRIPTION_ID = "9c8b7a65-4321-0fed-cba9-876543210fed"
const TENANT_ID = "11111111-2222-3333-4444-555555555555"
const CLIENT_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A year out, computed from the real clock: the boundary schema reads the clock at
 * parse time, and this file deliberately runs no fake timers — `pg` schedules its
 * own I/O on real timers, so faking them here would stall a query rather than
 * assert anything.
 */
function inAYear(): string {
  return new Date(Date.now() + 365 * DAY_MS).toISOString()
}

// `metricsHistorySince` is part of an accepted outcome — the route reads it to store the
// measured depth — so a fixture without it makes the route throw rather than insert.
const VERIFIED: unknown = {
  scopeVerified: true,
  fidelityTier: "baseline",
  metricsHistorySince: null,
}

const UNVERIFIED: unknown = {
  scopeVerified: false,
  code: "SCOPE_UNVERIFIED",
  message: "Read at subscription scope was not proved.",
}

// --- Wiring ----------------------------------------------------------------

let drizzleDb: NodePgDatabase<typeof schema> | undefined
let owner: { id: string; email: string }
let intruder: { id: string; email: string }

/** Read by the `@/lib/db` mock factory at call time. */
function currentDb(): NodePgDatabase<typeof schema> {
  if (drizzleDb === undefined) {
    throw new Error(
      "The scratch-schema Drizzle client is not open. Read it inside a test."
    )
  }
  return drizzleDb
}

const UNUSABLE_PASSWORD_HASH = "$argon2id$fixture-never-verified"

beforeAll(async () => {
  // With `TEST_DATABASE_URL` unset the harness registered no schema and every test
  // here is skipped, so nothing in this hook may touch the pool.
  if (!db.enabled) return

  drizzleDb = drizzle(db.pool(), { schema })

  owner = { id: randomUUID(), email: "owner@example.com" }
  intruder = { id: randomUUID(), email: "intruder@example.com" }

  for (const user of [owner, intruder]) {
    await db.query(
      `INSERT INTO users (id, email, email_normalized, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [user.id, user.email, user.email, UNUSABLE_PASSWORD_HASH]
    )
  }
})

beforeEach(async () => {
  vi.stubEnv("APP_ENCRYPTION_KEY", FAKE_KEY_BASE64)

  preflight.outcome = VERIFIED
  preflight.calls.length = 0
  preflight.beforeReturn = undefined

  // Guarded: Vitest runs `beforeEach` hooks in parallel, so the harness's skip hook
  // does not prevent this one from running with the variable unset.
  if (!db.enabled) return

  session.user = owner

  // `users` survives — the two accounts are seeded once. Everything else is
  // per-test, so no assertion below depends on file order.
  await db.query(`TRUNCATE connected_subscriptions CASCADE`)
})

// --- Request helpers -------------------------------------------------------

function createBody(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    displayName: "Northwind production",
    subscriptionId: SUBSCRIPTION_ID,
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    clientSecret: FIRST_SECRET,
    secretExpiresAt: inAYear(),
    logAnalyticsWorkspaceId: null,
    ...overrides,
  }
}

function jsonRequest(url: string, payload: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
}

async function create(
  overrides: Record<string, unknown> = {}
): Promise<Response> {
  return await POST(
    jsonRequest("https://app.example.com/api/subscriptions", {
      ...createBody(overrides),
    })
  )
}

async function list(): Promise<Response> {
  return await GET(new Request("https://app.example.com/api/subscriptions"))
}

async function rotate(
  id: string,
  clientSecret = ROTATED_SECRET
): Promise<Response> {
  return await ROTATE(
    jsonRequest(`https://app.example.com/api/subscriptions/${id}/secret`, {
      clientSecret,
      secretExpiresAt: inAYear(),
    }),
    { params: Promise.resolve({ id }) }
  )
}

// --- Row helpers -----------------------------------------------------------

interface StoredRow {
  readonly id: string
  readonly user_id: string
  readonly display_name: string
  readonly subscription_id: string
  readonly tenant_id: string
  readonly client_id: string
  readonly client_secret_enc: string
  readonly scope_verified: boolean
  readonly fidelity_tier: string
  readonly secret_expires_at: Date
  readonly status: string
  readonly log_analytics_workspace_id: string | null
}

async function allRows(): Promise<readonly StoredRow[]> {
  const result = await db.query<StoredRow>(
    `SELECT * FROM connected_subscriptions ORDER BY id`
  )
  return result.rows
}

async function rowById(id: string): Promise<StoredRow | undefined> {
  const result = await db.query<StoredRow>(
    `SELECT * FROM connected_subscriptions WHERE id = $1`,
    [id]
  )
  return result.rows[0]
}

/** The created row's id, from a `201` body. */
async function createdId(response: Response): Promise<string> {
  const payload = (await response.json()) as {
    subscription: ConnectedSubscriptionView
  }
  return payload.subscription.id
}

/** One subscription belonging to the other consultant, created as they would. */
async function seedIntruderSubscription(): Promise<string> {
  const previous = session.user
  session.user = intruder
  try {
    const response = await create({
      displayName: "Someone else's customer",
      subscriptionId: OTHER_SUBSCRIPTION_ID,
      clientSecret: SECOND_SECRET,
    })
    expect(response.status).toBe(201)
    return await createdId(response)
  } finally {
    session.user = previous
  }
}

// --- Requirement 12.5 ------------------------------------------------------

describe("Requirement 12.5 — a rejected preflight inserts no row", () => {
  test("a scope_verified false result leaves the table empty", async () => {
    preflight.outcome = UNVERIFIED

    const response = await create()
    const payload = (await response.json()) as ApiErrorBody

    expect(response.status).toBe(422)
    expect(payload.error.code).toBe("SCOPE_UNVERIFIED")

    // Requirement 12.5 says "persists no row whose `status` is `active`", and the
    // route holds something stronger: **no row at all**. A `pending` row for a
    // connection the consultant was told was refused would appear on their
    // subscriptions screen as something they had connected — and an over-narrow role
    // assignment is exactly the case this gate exists for, because its inventory
    // query succeeds and every figure derived from it verifies.
    expect(await allRows()).toEqual([])

    // The preflight did run: this is a rejection, not a skipped check.
    expect(preflight.calls).toHaveLength(1)
  })

  test("an AUTH_EXPIRED rejection also inserts nothing", async () => {
    // A different remedy — a secret the consultant rotates rather than a role the
    // customer fixes (Requirement 12.13) — and the same absence of a row.
    preflight.outcome = {
      scopeVerified: false,
      code: "AUTH_EXPIRED",
      message: "Azure rejected the client secret as expired.",
    }

    const response = await create()

    expect(response.status).toBe(422)
    expect(((await response.json()) as ApiErrorBody).error.code).toBe(
      "AUTH_EXPIRED"
    )
    expect(await allRows()).toEqual([])
  })

  test("an accepted preflight is the only thing that writes an active row", async () => {
    // The positive control, so the assertion above is not passing because nothing
    // ever writes. Both facts come off the stored row rather than off the response:
    // `status` is derived by the store from `scope_verified`, so `active` alongside
    // `scope_verified: false` is unrepresentable rather than merely unwritten.
    const response = await create()

    expect(response.status).toBe(201)

    const rows = await allRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe(owner.id)
    expect(rows[0].status).toBe("active")
    expect(rows[0].scope_verified).toBe(true)

    // And the submitted plaintext is nowhere in the row it produced.
    for (const [column, value] of Object.entries(rows[0])) {
      if (typeof value !== "string") continue
      expect(value, `${column} carries the submitted secret`).not.toContain(
        FIRST_SECRET
      )
    }
  })
})

// --- Requirement 9.10 ------------------------------------------------------

describe("Requirement 9.10 — a duplicate pair is rejected without a second row", () => {
  test("the second submission is a 409 and the first row is untouched", async () => {
    const first = await create()
    expect(first.status).toBe(201)

    const firstRow = await rowById(await createdId(first))
    expect(firstRow).toBeDefined()

    // Same `(user_id, subscription_id)`, everything else different — so a row that
    // *had* been overwritten would be visible as the second submission's values
    // rather than as a count.
    const second = await create({
      displayName: "A second attempt at the same subscription",
      clientSecret: SECOND_SECRET,
    })
    const payload = (await second.json()) as ApiErrorBody

    expect(second.status).toBe(409)
    expect(payload.error.code).toBe("ALREADY_CONNECTED")
    expect(payload.error.message).toContain("already connected")

    // The claim only the constraint can make. There is no pre-`SELECT` in the store,
    // so the rejection came from `connected_subscriptions_user_id_subscription_id_uq`
    // itself — and the insert is the only write in that path, so the losing
    // submission had nothing to unwind.
    const rows = await allRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toStrictEqual(firstRow)
    expect(rows[0].display_name).toBe("Northwind production")

    // Neither plaintext is anywhere in the table afterwards — not the stored one, and
    // not the rejected one.
    for (const [column, value] of Object.entries(rows[0])) {
      if (typeof value !== "string") continue
      expect(value, `${column} carries a submitted secret`).not.toContain(
        FIRST_SECRET
      )
      expect(value, `${column} carries the rejected secret`).not.toContain(
        SECOND_SECRET
      )
    }
  })

  test("the 409 body carries neither submitted secret", async () => {
    await create()

    const text = await (await create({ clientSecret: SECOND_SECRET })).text()

    for (const secret of [FIRST_SECRET, SECOND_SECRET, TENANT_ID, CLIENT_ID]) {
      expect(text).not.toContain(secret)
    }
  })

  test("the constraint is scoped to the user, so two consultants may connect one subscription", async () => {
    // Not a global UNIQUE, deliberately: two consultants may hold their own
    // connection to one customer subscription, with their own service principal. A
    // global constraint would make the first connection block the second and leak
    // the fact that it exists.
    expect((await create()).status).toBe(201)

    session.user = intruder
    expect((await create({ clientSecret: SECOND_SECRET })).status).toBe(201)

    const rows = await allRows()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.user_id))).toEqual(
      new Set([owner.id, intruder.id])
    )
  })
})

// --- Requirement 9.8 ------------------------------------------------------

describe("Requirement 9.8 — another user's subscription id is not found on read, rotate and list", () => {
  test("read — the rotate route's row read refuses before any preflight", async () => {
    const theirs = await seedIntruderSubscription()
    const before = await rowById(theirs)

    // The seeding create ran a preflight of its own; only this request's calls are
    // the subject.
    preflight.calls.length = 0

    const response = await rotate(theirs)
    const payload = (await response.json()) as ApiErrorBody

    // Not found, **not** forbidden: a "forbidden" answer confirms the row exists, and
    // its existence is itself a fact about somebody else's customer. The body names
    // nothing at all.
    expect(response.status).toBe(404)
    expect(payload.error.code).toBe("NOT_FOUND")
    expect(payload.error.message).toBe("Not found.")

    // The read is scoped by `user_id`, so it refused before the 30-second preflight —
    // which is why this route reads the identity first rather than preflighting and
    // then discovering the row is not the caller's.
    expect(preflight.calls).toEqual([])

    // And no write landed anywhere.
    expect(await rowById(theirs)).toStrictEqual(before)
  })

  test("rotate — the write's own predicate refuses a row that changed hands mid-request", async () => {
    // The claim the read above cannot make. `rotateClientSecret` carries
    // `AND user_id = $n` inside the `UPDATE` itself, so there is no ordering in which
    // the ownership check passes and the write lands anyway. Forcing that ordering
    // needs the row to move *between* the identity read and the update, which is
    // what the preflight seam is for — and it is also the real case of a row deleted
    // or reassigned during a request.
    const mine = await createdId(await create())
    const before = await rowById(mine)

    // The create above ran a preflight of its own; only this request's calls are the
    // subject.
    preflight.calls.length = 0

    preflight.beforeReturn = async () => {
      await db.query(
        `UPDATE connected_subscriptions SET user_id = $1 WHERE id = $2`,
        [intruder.id, mine]
      )
    }

    const response = await rotate(mine)

    expect(response.status).toBe(404)
    expect(preflight.calls).toHaveLength(1)

    // The row is byte-identical apart from the ownership the seam changed: the
    // rotated ciphertext and the rotated expiry are both absent, so the `UPDATE`
    // matched nothing rather than writing and then being reported as a 404.
    const after = await rowById(mine)
    expect(after).toStrictEqual({ ...before, user_id: intruder.id })
    expect(after?.client_secret_enc).toBe(before?.client_secret_enc)
  })

  test("list — each consultant's list holds only their own rows", async () => {
    const theirs = await seedIntruderSubscription()
    const mine = await createdId(await create())

    const response = await list()
    const text = await response.text()
    const payload = JSON.parse(text) as {
      subscriptions: readonly ConnectedSubscriptionView[]
    }

    expect(response.status).toBe(200)
    expect(payload.subscriptions.map((view) => view.id)).toEqual([mine])

    // Nothing of the other consultant's row survives into this response — not its
    // id, not its label, not its subscription's masked tail.
    for (const disclosure of [
      theirs,
      intruder.id,
      "Someone else's customer",
      OTHER_SUBSCRIPTION_ID.slice(-4),
    ]) {
      expect(text).not.toContain(disclosure)
    }

    // The same predicate read from the other side, which is what shows the filter is
    // on `user_id` rather than on something that happened to correlate with it.
    session.user = intruder
    const mirror = (await (await list()).json()) as {
      subscriptions: readonly ConnectedSubscriptionView[]
    }
    expect(mirror.subscriptions.map((view) => view.id)).toEqual([theirs])
  })

  test("an absent id and another user's id are the same answer", async () => {
    const theirs = await seedIntruderSubscription()

    const forAbsent = await rotate(randomUUID())
    const forSomeoneElse = await rotate(theirs)

    // Byte-identical, so a probe cannot tell an id that does not exist from one that
    // belongs to another consultant.
    expect(forAbsent.status).toBe(forSomeoneElse.status)
    expect(await forAbsent.text()).toBe(await forSomeoneElse.text())
  })

  test("a rotation of the caller's own subscription still works", async () => {
    // The positive control for all four refusals above: the scoping is a predicate on
    // `user_id`, not a route that refuses everything.
    const mine = await createdId(await create())
    const before = await rowById(mine)

    const response = await rotate(mine)

    expect(response.status).toBe(200)

    const after = await rowById(mine)
    expect(after?.client_secret_enc).not.toBe(before?.client_secret_enc)
    expect(after?.status).toBe("active")

    for (const [column, value] of Object.entries(after ?? {})) {
      if (typeof value !== "string") continue
      expect(value, `${column} retained a previous value`).not.toContain(
        before?.client_secret_enc ?? "unreachable"
      )
      expect(value).not.toContain(ROTATED_SECRET)
    }
  })
})
