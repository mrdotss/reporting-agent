import { randomUUID } from "node:crypto"

import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * `lib/subscriptions/store.ts` against a real Postgres 17 (Requirements 9.2, 9.3,
 * 9.7, 9.8, 9.9, 9.10, 13.7, 13.9).
 *
 * ## Why these claims need a database
 *
 * Every one of them is a claim where the SQL *is* the behaviour, so a double would
 * be a second, unverified query planner standing between the test and its subject:
 *
 *   * **Requirement 9.10** is a violation of
 *     `connected_subscriptions_user_id_subscription_id_uq`. Only the database can
 *     reject the second insert, and only its SQLSTATE `23505` plus the constraint
 *     name can be mapped back to the already-connected rejection. A fake throwing
 *     a hand-built error would be asserting that the *test* knows the
 *     constraint's name.
 *   * **Requirements 9.7 and 9.8** are `AND user_id = $n` inside four statements.
 *     "Applies no write" is a claim about the row that was *not* touched, so it is
 *     asserted by reading the other user's row back out of the table afterwards.
 *   * **Requirement 9.2** is a claim about a stored column: the plaintext must
 *     appear in `client_secret_enc` in no form, and in no other column at all.
 *     That is asserted here by scanning every text column of the row.
 *   * **Requirement 13.7** is "retains no earlier ciphertext", which is a
 *     statement about what is *absent* from the table after an `UPDATE`.
 *
 * ## What is doubled
 *
 * Only `getDb`, bound to this file's scratch schema. `@/lib/crypto` is the real
 * AES-256-GCM implementation under a fixture key, because a stubbed cipher would
 * erase the very property Requirement 9.2 is about — that what lands in the column
 * is not the submitted secret.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

vi.mock("@/lib/db", () => ({
  getDb: () => currentDb(),
}))

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import * as schema from "@/lib/db/schema"
import { maskSubscriptionId } from "@/lib/db/views"
import {
  createConnectedSubscription,
  disableConnectedSubscription,
  getConnectedSubscription,
  listConnectedSubscriptions,
  readSubscriptionRowState,
  resolveSubscriptionCredentials,
  resolveSubscriptionIdentity,
  rotateClientSecret,
  SubscriptionAlreadyConnectedError,
  SubscriptionNotFoundError,
  SubscriptionSecretUnreadableError,
  type CreateConnectedSubscriptionInput,
} from "@/lib/subscriptions/store"

// --- Fixtures ---------------------------------------------------------------

/** 32 bytes, base64. A fixture key: it protects nothing. */
const FAKE_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64")

/**
 * The plaintext secret every assertion about disclosure is made against.
 *
 * Distinctive enough that a substring scan over a whole row, or over a
 * serialized view, cannot match it by accident.
 */
const PLAINTEXT_SECRET = "azure-client-secret-DO-NOT-DISCLOSE-9f13c7"

/** The rotated one, equally distinctive, so the two cannot be confused. */
const ROTATED_SECRET = "azure-client-secret-ROTATED-4b81ea"

const OWNER_TENANT_ID = "11111111-2222-3333-4444-555555555555"
const OWNER_CLIENT_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa"

/** The owner's subscription, and a second one for the list ordering. */
const SUBSCRIPTION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
const OTHER_SUBSCRIPTION_ID = "9c8b7a65-4321-0fed-cba9-876543210fed"

/** The enhanced tier's workspace, so the nullable column is exercised non-null. */
const WORKSPACE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

const YEAR_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Truncated to the second, so a `timestamptz` round trip is exact. Postgres keeps
 * microseconds and JavaScript keeps milliseconds, which is enough to make an
 * equality assertion on a re-read date flake at sub-millisecond precision.
 */
const SECRET_EXPIRES_AT = new Date(
  Math.floor((Date.now() + YEAR_MS) / 1000) * 1000
)

const ROTATED_EXPIRES_AT = new Date(SECRET_EXPIRES_AT.getTime() + YEAR_MS)

// --- Wiring ----------------------------------------------------------------

let drizzleDb: NodePgDatabase<typeof schema> | undefined
let ownerId: string
let intruderId: string

/** Hoisted declaration, read by the mock factory at call time. */
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
  // With `TEST_DATABASE_URL` unset the harness registered no schema and every
  // test here is skipped, so nothing in this hook may touch the pool.
  if (!db.enabled) return

  drizzleDb = drizzle(db.pool(), { schema })

  ownerId = randomUUID()
  intruderId = randomUUID()

  for (const [id, email] of [
    [ownerId, "owner@example.com"],
    [intruderId, "intruder@example.com"],
  ] as const) {
    await db.query(
      `INSERT INTO users (id, email, email_normalized, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [id, email, email, UNUSABLE_PASSWORD_HASH]
    )
  }
})

beforeEach(async () => {
  vi.stubEnv("APP_ENCRYPTION_KEY", FAKE_KEY_BASE64)

  // Guarded: Vitest runs `beforeEach` hooks in parallel, so the harness's skip
  // hook does not prevent this one from running with the variable unset.
  if (!db.enabled) return

  // `users` survives — the two accounts are seeded once. Everything else is
  // per-test, so no assertion below depends on file order.
  await db.query(`TRUNCATE connected_subscriptions CASCADE`)
})

// --- Helpers ---------------------------------------------------------------

function createInput(
  overrides: Partial<CreateConnectedSubscriptionInput> = {}
): CreateConnectedSubscriptionInput {
  return {
    userId: ownerId,
    displayName: "Northwind production",
    subscriptionId: SUBSCRIPTION_ID,
    tenantId: OWNER_TENANT_ID,
    clientId: OWNER_CLIENT_ID,
    clientSecret: PLAINTEXT_SECRET,
    secretExpiresAt: SECRET_EXPIRES_AT,
    scopeVerified: true,
    fidelityTier: "baseline",
    ...overrides,
  }
}

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
  readonly created_at: Date
  /** Requirement 9.2 — the inventory cache's invalidation signal. */
  readonly updated_at: Date
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

/** A row belonging to `intruderId`, inserted through the store as they would. */
async function seedIntruderSubscription(): Promise<string> {
  const view = await createConnectedSubscription(
    createInput({
      userId: intruderId,
      displayName: "Someone else's customer",
      subscriptionId: OTHER_SUBSCRIPTION_ID,
      tenantId: "deadbeef-0000-0000-0000-000000000001",
      clientId: "deadbeef-0000-0000-0000-000000000002",
    })
  )
  return view.id
}

// --- Create ----------------------------------------------------------------

describe("createConnectedSubscription", () => {
  test("Requirements 9.2, 9.9 — the plaintext reaches client_secret_enc as ciphertext and no other column", async () => {
    const view = await createConnectedSubscription(createInput())

    const row = await rowById(view.id)
    expect(row).toBeDefined()

    // The column holds an envelope, not the submission.
    expect(row?.client_secret_enc).not.toBe(PLAINTEXT_SECRET)
    expect(row?.client_secret_enc.length).toBeGreaterThan(0)

    // Requirement 9.9's "no column other than `client_secret_enc`", asserted over
    // **every** column rather than the three a reader would think to check — a
    // future column that quietly received the plaintext is exactly the failure
    // this sweep exists for.
    for (const [column, value] of Object.entries(row ?? {})) {
      if (typeof value !== "string") continue
      expect(value, `${column} carries the submitted secret`).not.toContain(
        PLAINTEXT_SECRET
      )
    }

    // And the decryption round-trips, so the envelope is the secret rather than
    // merely not being it.
    const credentials = await resolveSubscriptionCredentials(ownerId, view.id)
    expect(credentials.clientSecret).toBe(PLAINTEXT_SECRET)
  })

  test("Requirement 10.2 — the return value is the browser-safe projection only", async () => {
    const view = await createConnectedSubscription(createInput())

    // The exact key set, sorted: a column added to the table cannot reach a
    // caller of this store without this assertion changing.
    expect(Object.keys(view).sort()).toEqual([
      "displayName",
      "fidelityTier",
      "id",
      "maskedSubscriptionId",
      // Reviewed and admitted: how far back this subscription's exported metrics reach.
      // A measurement of the customer's own telemetry depth — no secret, and it names no
      // resource — read by the profile wizard to say what a trend can cover.
      "metricsHistorySince",
      "scopeVerified",
      "secretExpiresAt",
      "status",
    ])

    expect(view.maskedSubscriptionId).toBe(maskSubscriptionId(SUBSCRIPTION_ID))

    // Nothing secret survives the serialization, including the unmasked id.
    const serialized = JSON.stringify(view)
    for (const secret of [
      PLAINTEXT_SECRET,
      OWNER_TENANT_ID,
      OWNER_CLIENT_ID,
      SUBSCRIPTION_ID,
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  test("Requirements 9.6, 12.5 — status is derived from the preflight result", async () => {
    const verified = await createConnectedSubscription(createInput())
    expect(verified.status).toBe("active")
    expect(verified.scopeVerified).toBe(true)

    // The combination Requirement 12.5 forbids — `active` alongside
    // `scope_verified: false` — is unrepresentable: `status` is derived, so there
    // is no argument through which a caller can ask for it.
    const unverified = await createConnectedSubscription(
      createInput({
        subscriptionId: OTHER_SUBSCRIPTION_ID,
        scopeVerified: false,
      })
    )
    expect(unverified.status).toBe("pending")

    const rows = await allRows()
    expect(
      rows.filter((row) => row.status === "active" && !row.scope_verified)
    ).toEqual([])
  })

  test("Requirement 9.10 — a duplicate (user_id, subscription_id) is rejected with no second row", async () => {
    const first = await createConnectedSubscription(createInput())

    await expect(
      createConnectedSubscription(
        createInput({
          displayName: "A second attempt at the same subscription",
        })
      )
    ).rejects.toBeInstanceOf(SubscriptionAlreadyConnectedError)

    // The rejection came from the constraint — there is no pre-`SELECT` in the
    // store — and it wrote nothing: the insert is the only write in that path.
    const rows = await allRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(first.id)
    expect(rows[0].display_name).toBe("Northwind production")
  })

  test("Requirement 9.10 — the constraint is scoped to the user, so two consultants may connect the same subscription", async () => {
    // Not a global UNIQUE, deliberately: two consultants may hold their own
    // connection to one customer subscription, with their own service principal.
    // A global constraint would make the first connection block the second and
    // leak the fact that it exists.
    await createConnectedSubscription(createInput())
    await createConnectedSubscription(createInput({ userId: intruderId }))

    const rows = await allRows()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.user_id)).size).toBe(2)
  })

  test("a driver failure is re-thrown carrying neither ciphertext nor tenant id", async () => {
    // Requirement 9.9 reaches further than it looks: drizzle wraps a driver
    // failure in a `DrizzleQueryError` whose message carries the statement **and
    // its bound parameters** — which for this insert include the envelope, the
    // tenant id and the client id. Re-throwing that verbatim writes them into a
    // server log, so the store replaces it.
    //
    // The table is renamed out from under the statement, so the error is a real
    // SQLSTATE `42P01` rather than a hand-built one.
    await db.query(
      `ALTER TABLE connected_subscriptions RENAME TO connected_subscriptions_gone`
    )

    try {
      const thrown = await createConnectedSubscription(createInput()).then(
        () => undefined,
        (error: unknown) => error
      )

      expect(thrown).toBeInstanceOf(Error)
      const message = String(thrown)

      expect(message).toContain("42P01")
      for (const secret of [
        PLAINTEXT_SECRET,
        OWNER_TENANT_ID,
        OWNER_CLIENT_ID,
      ]) {
        expect(message).not.toContain(secret)
      }

      // No `cause` chain either — that is where the wrapped message would ride
      // along to whatever logs the error.
      expect((thrown as Error).cause).toBeUndefined()
    } finally {
      await db.query(
        `ALTER TABLE connected_subscriptions_gone RENAME TO connected_subscriptions`
      )
    }
  })
})

// --- Reads -----------------------------------------------------------------

describe("Requirements 9.7, 9.8 — every read is scoped to the owner", () => {
  test("another user's id resolves as not found on get, disclosing no field", async () => {
    const intruderSubscriptionId = await seedIntruderSubscription()

    const thrown = await getConnectedSubscription(
      ownerId,
      intruderSubscriptionId
    ).then(
      () => undefined,
      (error: unknown) => error
    )

    // Not found, **not** forbidden: a "forbidden" answer confirms the row exists,
    // and its existence is itself a fact about somebody else's customer.
    expect(thrown).toBeInstanceOf(SubscriptionNotFoundError)

    // And the refusal names nothing — not the id, not the owner, not a field.
    const message = String(thrown)
    for (const disclosure of [
      intruderSubscriptionId,
      intruderId,
      OTHER_SUBSCRIPTION_ID,
      "Someone else's customer",
    ]) {
      expect(message).not.toContain(disclosure)
    }
  })

  test("an absent id and another user's id are the same refusal", async () => {
    const intruderSubscriptionId = await seedIntruderSubscription()

    const forAbsent = await getConnectedSubscription(
      ownerId,
      randomUUID()
    ).catch((error: unknown) => error)
    const forSomeoneElse = await getConnectedSubscription(
      ownerId,
      intruderSubscriptionId
    ).catch((error: unknown) => error)

    // Byte-identical, so a probe cannot tell an id that does not exist from one
    // that belongs to another consultant.
    expect(String(forAbsent)).toBe(String(forSomeoneElse))
  })

  test("the list holds only this user's rows", async () => {
    await seedIntruderSubscription()
    const mine = await createConnectedSubscription(createInput())

    const listed = await listConnectedSubscriptions(ownerId)

    expect(listed.map((view) => view.id)).toEqual([mine.id])

    // The other consultant sees theirs and not mine — the same predicate read
    // from the other side, which is what shows the filter is on `user_id` rather
    // than on something that happened to correlate with it.
    const theirs = await listConnectedSubscriptions(intruderId)
    expect(theirs).toHaveLength(1)
    expect(theirs[0].id).not.toBe(mine.id)

    // A user with no connections gets an empty list rather than an error.
    await db.query(`DELETE FROM connected_subscriptions WHERE user_id = $1`, [
      ownerId,
    ])
    expect(await listConnectedSubscriptions(ownerId)).toEqual([])
  })

  test("Requirement 9.3 — credentials resolve server-side, and only for the owner", async () => {
    const mine = await createConnectedSubscription(createInput())
    const intruderSubscriptionId = await seedIntruderSubscription()

    const resolved = await resolveSubscriptionCredentials(ownerId, mine.id)

    // The unmasked id and the decrypted secret, which is what the invoke
    // payload's `context` needs and the only place either one exists.
    expect(resolved).toStrictEqual({
      subscriptionId: SUBSCRIPTION_ID,
      tenantId: OWNER_TENANT_ID,
      clientId: OWNER_CLIENT_ID,
      clientSecret: PLAINTEXT_SECRET,
      fidelityTier: "baseline",
      logAnalyticsWorkspaceId: null,
    })

    await expect(
      resolveSubscriptionCredentials(ownerId, intruderSubscriptionId)
    ).rejects.toBeInstanceOf(SubscriptionNotFoundError)
  })

  test("an unreadable envelope is distinct from not found", async () => {
    const mine = await createConnectedSubscription(createInput())

    // A well-formed envelope encrypted under a different key: the row is this
    // user's, so the refusal must say "rotate the secret" rather than "no such
    // subscription". The two have different remedies.
    await db.query(
      `UPDATE connected_subscriptions SET client_secret_enc = $1 WHERE id = $2`,
      [Buffer.alloc(64, 3).toString("base64"), mine.id]
    )

    const thrown = await resolveSubscriptionCredentials(ownerId, mine.id).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(thrown).toBeInstanceOf(SubscriptionSecretUnreadableError)
    expect(thrown).not.toBeInstanceOf(SubscriptionNotFoundError)
    expect((thrown as Error).cause).toBeUndefined()
  })
})

// --- Identity resolution ---------------------------------------------------

describe("resolveSubscriptionIdentity", () => {
  test("Requirement 9.7 — the stored identity, with no credential in it", async () => {
    const mine = await createConnectedSubscription(
      createInput({ logAnalyticsWorkspaceId: WORKSPACE_ID })
    )

    const identity = await resolveSubscriptionIdentity(ownerId, mine.id)

    // `toStrictEqual` against the whole shape, so a field added to the return
    // value has to be added here too — which is the assertion that no secret joins
    // it by convenience.
    expect(identity).toStrictEqual({
      displayName: "Northwind production",
      subscriptionId: SUBSCRIPTION_ID,
      tenantId: OWNER_TENANT_ID,
      clientId: OWNER_CLIENT_ID,
      logAnalyticsWorkspaceId: WORKSPACE_ID,
    })

    expect(Object.keys(identity)).not.toContain("clientSecret")
  })

  test("Requirement 9.8 — another user's id resolves as not found", async () => {
    const intruderSubscriptionId = await seedIntruderSubscription()

    await expect(
      resolveSubscriptionIdentity(ownerId, intruderSubscriptionId)
    ).rejects.toBeInstanceOf(SubscriptionNotFoundError)
  })

  test("an unreadable envelope still resolves, because nothing is decrypted", async () => {
    const mine = await createConnectedSubscription(createInput())

    // The reason this function exists as a separate read. A row whose stored
    // envelope no longer decrypts is precisely a row that needs rotating, so the
    // rotation path must not be the path `SubscriptionSecretUnreadableError`
    // blocks.
    await db.query(
      `UPDATE connected_subscriptions SET client_secret_enc = $1 WHERE id = $2`,
      [Buffer.alloc(64, 3).toString("base64"), mine.id]
    )

    await expect(
      resolveSubscriptionCredentials(ownerId, mine.id)
    ).rejects.toBeInstanceOf(SubscriptionSecretUnreadableError)

    const identity = await resolveSubscriptionIdentity(ownerId, mine.id)
    expect(identity.tenantId).toBe(OWNER_TENANT_ID)
    expect(identity.clientId).toBe(OWNER_CLIENT_ID)
  })
})

// --- The inventory endpoint's ordering read ---------------------------------

describe("readSubscriptionRowState", () => {
  test("Requirement 9.2 — the two facts the endpoint orders by, and no credential", async () => {
    const mine = await createConnectedSubscription(createInput())
    const row = await rowById(mine.id)
    expect(row).toBeDefined()

    const state = await readSubscriptionRowState(ownerId, mine.id)

    // `toStrictEqual` against the whole shape for the reason
    // `resolveSubscriptionIdentity`'s test uses it: a field added to the return value
    // has to be added here too, which is the assertion that no secret joins it by
    // convenience.
    expect(state).toStrictEqual({
      status: "active",
      updatedAt: row?.updated_at.toISOString(),
      displayName: "Northwind production",
    })
    expect(Object.keys(state)).not.toContain("clientSecret")
    expect(Object.keys(state)).not.toContain("tenantId")
  })

  test("`updatedAt` is the row's updated_at and not its created_at", async () => {
    // The two are equal on an inserted row, so a read of the wrong column passes
    // every assertion until something writes. This forces them apart first.
    const mine = await createConnectedSubscription(createInput())
    await db.query(
      `UPDATE connected_subscriptions SET updated_at = created_at + interval '1 hour' WHERE id = $1`,
      [mine.id]
    )

    const row = await rowById(mine.id)
    const state = await readSubscriptionRowState(ownerId, mine.id)

    expect(state.updatedAt).toBe(row?.updated_at.toISOString())
    expect(state.updatedAt).not.toBe(row?.created_at.toISOString())
  })

  test("Requirements 9.4, 9.8 — another user's id resolves as not found", async () => {
    const intruderSubscriptionId = await seedIntruderSubscription()

    await expect(
      readSubscriptionRowState(ownerId, intruderSubscriptionId)
    ).rejects.toBeInstanceOf(SubscriptionNotFoundError)
  })

  test("an unreadable envelope still resolves, because nothing is decrypted", async () => {
    // The whole reason this is its own read. A `disabled` row is exactly the row
    // whose envelope may no longer decrypt, and Requirement 9.9 says the endpoint
    // names that status — which means not touching the secret to find it.
    const mine = await createConnectedSubscription(createInput())
    await db.query(
      `UPDATE connected_subscriptions SET client_secret_enc = $1, status = 'disabled' WHERE id = $2`,
      [Buffer.alloc(64, 3).toString("base64"), mine.id]
    )

    const state = await readSubscriptionRowState(ownerId, mine.id)

    expect(state.status).toBe("disabled")
  })
})

describe("Requirement 9.2 — updated_at moves on every write to the row", () => {
  test("an inserted row carries an updated_at", async () => {
    const mine = await createConnectedSubscription(createInput())

    const row = await rowById(mine.id)

    // NOT NULL with a default, so the additive migration gives an existing row a
    // value: a NULL compared against a cache entry would read as "not written
    // since", which is the answer that serves a stale list.
    expect(row?.updated_at).toBeInstanceOf(Date)
  })

  test("a rotation moves it, so a rotated credential lists the subscription again", async () => {
    const mine = await createConnectedSubscription(createInput())
    // Backdated, so "moved" cannot be satisfied by the value it already had.
    await db.query(
      `UPDATE connected_subscriptions SET updated_at = now() - interval '1 day' WHERE id = $1`,
      [mine.id]
    )
    const before = await rowById(mine.id)

    await rotateClientSecret(ownerId, mine.id, {
      clientSecret: ROTATED_SECRET,
      secretExpiresAt: ROTATED_EXPIRES_AT,
      scopeVerified: true,
    })

    const after = await rowById(mine.id)
    expect(after?.updated_at.getTime()).toBeGreaterThan(
      before?.updated_at.getTime() ?? 0
    )
  })

  test("a disable moves it too, even though it is otherwise idempotent", async () => {
    const mine = await createConnectedSubscription(createInput())
    await db.query(
      `UPDATE connected_subscriptions SET updated_at = now() - interval '1 day' WHERE id = $1`,
      [mine.id]
    )
    const before = await rowById(mine.id)

    await disableConnectedSubscription(ownerId, mine.id)

    const after = await rowById(mine.id)
    // A changed status has to invalidate the cached listing, and this write changes
    // nothing else — so without the explicit `updatedAt` it would move nothing.
    expect(after?.updated_at.getTime()).toBeGreaterThan(
      before?.updated_at.getTime() ?? 0
    )
  })

  test("a write that touches another user's row moves nothing", async () => {
    const intruderSubscriptionId = await seedIntruderSubscription()
    const before = await rowById(intruderSubscriptionId)

    await expect(
      disableConnectedSubscription(ownerId, intruderSubscriptionId)
    ).rejects.toBeInstanceOf(SubscriptionNotFoundError)

    const after = await rowById(intruderSubscriptionId)
    expect(after?.updated_at.getTime()).toBe(before?.updated_at.getTime())
  })
})

// --- Rotation --------------------------------------------------------------

describe("rotateClientSecret", () => {
  test("Requirement 13.7 — fresh ciphertext, the submitted expiry, and no earlier ciphertext retained", async () => {
    const mine = await createConnectedSubscription(createInput())
    const before = await rowById(mine.id)
    expect(before).toBeDefined()

    const rotated = await rotateClientSecret(ownerId, mine.id, {
      clientSecret: ROTATED_SECRET,
      secretExpiresAt: ROTATED_EXPIRES_AT,
      scopeVerified: true,
    })

    expect(rotated.secretExpiresAt).toBe(ROTATED_EXPIRES_AT.toISOString())

    const after = await rowById(mine.id)
    expect(after?.client_secret_enc).not.toBe(before?.client_secret_enc)

    // "Retains no earlier ciphertext" is a claim about what is **absent** from the
    // table: one row, and nowhere in it the previous envelope or either
    // plaintext.
    const rows = await allRows()
    expect(rows).toHaveLength(1)

    for (const [column, value] of Object.entries(after ?? {})) {
      if (typeof value !== "string") continue
      expect(value, `${column} retained a previous value`).not.toContain(
        before?.client_secret_enc ?? "unreachable"
      )
      expect(value).not.toContain(PLAINTEXT_SECRET)
      expect(value).not.toContain(ROTATED_SECRET)
    }

    // The new secret is the one that resolves now.
    const credentials = await resolveSubscriptionCredentials(ownerId, mine.id)
    expect(credentials.clientSecret).toBe(ROTATED_SECRET)
  })

  test("Requirement 13.8 — scope_verified is set from the re-run preflight, and status follows it", async () => {
    const mine = await createConnectedSubscription(createInput())

    const unverified = await rotateClientSecret(ownerId, mine.id, {
      clientSecret: ROTATED_SECRET,
      secretExpiresAt: ROTATED_EXPIRES_AT,
      scopeVerified: false,
    })

    // A rotation whose assertion failed cannot leave the row `active`.
    expect(unverified.scopeVerified).toBe(false)
    expect(unverified.status).toBe("pending")

    const reverified = await rotateClientSecret(ownerId, mine.id, {
      clientSecret: PLAINTEXT_SECRET,
      secretExpiresAt: ROTATED_EXPIRES_AT,
      scopeVerified: true,
      fidelityTier: "enhanced",
    })

    expect(reverified.scopeVerified).toBe(true)
    expect(reverified.status).toBe("active")
    expect(reverified.fidelityTier).toBe("enhanced")
  })

  test("Requirement 9.8 — rotating another user's subscription applies no write", async () => {
    const intruderSubscriptionId = await seedIntruderSubscription()
    const before = await rowById(intruderSubscriptionId)

    await expect(
      rotateClientSecret(ownerId, intruderSubscriptionId, {
        clientSecret: ROTATED_SECRET,
        secretExpiresAt: ROTATED_EXPIRES_AT,
        scopeVerified: true,
      })
    ).rejects.toBeInstanceOf(SubscriptionNotFoundError)

    // The whole row, unchanged. The `AND user_id = $n` is in the statement's
    // `WHERE`, so there is no ordering in which a check passes and the write
    // lands anyway — which is the reason to assert the row rather than the error.
    const after = await rowById(intruderSubscriptionId)
    expect(after).toStrictEqual(before)
  })
})

// --- Azure rejected the credential ----------------------------------------

describe("disableConnectedSubscription", () => {
  test("Requirement 13.9 — status becomes disabled while the recorded expiry stays in the future", async () => {
    const mine = await createConnectedSubscription(createInput())

    const disabled = await disableConnectedSubscription(ownerId, mine.id)

    expect(disabled.status).toBe("disabled")

    // The recorded date is untouched — it is consultant-entered, and the point of
    // this write is that Azure's rejection outranks it rather than rewrites it.
    expect(disabled.secretExpiresAt).toBe(SECRET_EXPIRES_AT.toISOString())

    // `scope_verified` is left alone too: the scope assertion was true when it
    // was made, the credential is what failed, and Requirement 12.14 reserves
    // writing that flag to the preflight.
    expect(disabled.scopeVerified).toBe(true)

    // Idempotent — the reaper and a terminal callback can both reach this.
    expect((await disableConnectedSubscription(ownerId, mine.id)).status).toBe(
      "disabled"
    )
  })

  test("Requirement 9.8 — disabling another user's subscription applies no write", async () => {
    const intruderSubscriptionId = await seedIntruderSubscription()
    const before = await rowById(intruderSubscriptionId)

    await expect(
      disableConnectedSubscription(ownerId, intruderSubscriptionId)
    ).rejects.toBeInstanceOf(SubscriptionNotFoundError)

    const after = await rowById(intruderSubscriptionId)
    expect(after).toStrictEqual(before)
    expect(after?.status).toBe("active")
  })
})
