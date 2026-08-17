import { randomUUID } from "node:crypto"

import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * `lib/actions/auth.ts` against a real Postgres 17 (Requirements 7.1, 7.2, 7.3,
 * 7.4, 7.10, 7.12, 2.12, 2.13, 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 1.7, 1.8).
 *
 * ## Why these particular claims need a database
 *
 * `lib/actions/auth.test.ts` covers the generic-outcome discipline against an
 * in-memory double, because that claim is about a returned value and must not
 * depend on docker. Everything in *this* file is a claim where the SQL semantics
 * **are** the behaviour, and a fake would be a second, unverified query planner
 * standing between the test and its subject:
 *
 *   * **Requirement 7.12** is a race on `users_email_normalized_unique`. Only the
 *     database can reject the losing insert, and only its SQLSTATE `23505` plus
 *     the constraint name can be mapped back to the email-unavailable rejection.
 *     A fake that threw a hand-built error would be asserting that the *test*
 *     knows the constraint's name.
 *   * **Requirement 7.10** is "the presented `sessions` row is deleted" — a row
 *     identity claim, asserted below by id rather than by counting rows.
 *   * **Requirement 3.4** excludes successful attempts from the lockout count,
 *     and that exclusion lives in a `WHERE success = false` inside
 *     `isLockedOut`'s query. The pure predicate cannot make that assertion: it
 *     is handed failures only, so it would agree with a query that forgot the
 *     filter. Five *successes* not locking an email is the case that catches it,
 *     and it is only reachable through real SQL.
 *   * **Requirement 7.3** stores two forms of one submitted address in two
 *     columns, one of them under a UNIQUE constraint.
 *
 * ## What is doubled, and what a counter is doing here
 *
 * Doubled: `getDb` (bound to this file's scratch schema), `cookies` and
 * `redirect`. `@/lib/auth/password` is **wrapped, not replaced** — every call
 * delegates to the real argon2id at the parameters Requirement 1.10 pins, and
 * the wrapper only counts and offers one seam.
 *
 * The counters are what make Requirement 3.3 assertable. "Reject without
 * invoking password verification" is a claim about a call that did *not* happen,
 * and the returned value is identical either way — so the locked-out test drives
 * the **correct** password and asserts that neither `verifyPassword` nor
 * `burnDecoyVerification` ran. Without the counters that test would pass against
 * an implementation that verified first and discarded the result.
 *
 * The seam is `hooks.beforeNextHash`; see {@link Requirement 7.12} in the
 * register describe below for why that particular point in the action is the
 * right place to force the race.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

// --- The wrapped password module -------------------------------------------

/**
 * Hoisted so the `vi.mock` factory below can close over them. Mutable state in a
 * plain module binding would be in its temporal dead zone when the factory runs.
 */
const { argon2Calls, hooks } = vi.hoisted(() => ({
  argon2Calls: { hash: 0, verify: 0, decoy: 0 },
  hooks: {} as { beforeNextHash?: () => Promise<void> },
}))

vi.mock("@/lib/auth/password", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/password")>()

  return {
    ...actual,

    /**
     * The seam for Requirement 7.12, and the reason it is *this* function.
     *
     * `registerAction` runs its duplicate-email `SELECT`, then hashes, then
     * inserts. So a hook here fires strictly **after** the pre-`SELECT` has
     * returned nothing and strictly **before** the `INSERT` — which is exactly
     * the window a second concurrent submission would land in. Nothing else in
     * the action offers that position without reaching into the database double.
     */
    hashPassword: async (plaintext: string) => {
      argon2Calls.hash += 1

      const hook = hooks.beforeNextHash
      hooks.beforeNextHash = undefined
      if (hook !== undefined) await hook()

      return await actual.hashPassword(plaintext)
    },

    verifyPassword: async (hash: string, plaintext: string) => {
      argon2Calls.verify += 1
      return await actual.verifyPassword(hash, plaintext)
    },

    /**
     * Counted separately from {@link verifyPassword} even though the real
     * implementation routes through it, because the module-internal call is not
     * intercepted here. That separation is what lets the tests below tell the
     * unmatched-email path apart from the failed-verification path — two
     * branches whose returned values are identical by design.
     */
    burnDecoyVerification: async (plaintext: string) => {
      argon2Calls.decoy += 1
      await actual.burnDecoyVerification(plaintext)
    },
  }
})

// --- The two request-scoped collaborators ----------------------------------

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve(currentCookieStore()),
}))

vi.mock("next/navigation", async () => {
  const { redirect } = await import("@/test/next-doubles")
  return { redirect }
})

vi.mock("@/lib/db", () => ({
  getDb: () => currentDb(),
}))

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import { loginAction, logoutAction, registerAction } from "@/lib/actions/auth"
import { FAILED_THRESHOLD, WINDOW_MINUTES } from "@/lib/auth/lockout"
import { hashPassword } from "@/lib/auth/password"
import { SESSION_COOKIE, createSession } from "@/lib/auth/session"
import * as schema from "@/lib/db/schema"
import { STARTER_KEYS, STARTER_TEMPLATE_COUNT } from "@/lib/templates/starters"
import { FakeCookieStore, redirectTarget } from "@/test/next-doubles"

// --- Constants --------------------------------------------------------------

/** Generous: a handful of real argon2id operations, on a possibly loaded box. */
const ARGON2_TIMEOUT_MS = 30_000

const DASHBOARD = "/dashboard"
const LOGIN = "/login"

/** The shared registered account. Its password is a fixture, never asserted on. */
const ACCOUNT_EMAIL_AS_TYPED = "Consultant@Example.COM"
const ACCOUNT_EMAIL_NORMALIZED = "consultant@example.com"
const ACCOUNT_PASSWORD = "a-fixture-passphrase-01"

/** Wrong for the account above, and long enough to reach verification. */
const WRONG_PASSWORD = "a-different-passphrase-01"

/** Registered in no test in this file. */
const UNKNOWN_EMAIL = "nobody@example.com"

/** For accounts created by a test rather than seeded. */
const NEW_PASSWORD = "another-fixture-passphrase"

/**
 * The two messages, restated rather than imported: a `"use server"` module may
 * only export async functions, so both constants are module-private by
 * construction.
 */
const INVALID_CREDENTIALS = Object.freeze({
  status: "error",
  message: "Those sign-in details were not accepted. Check them and try again.",
})

const EMAIL_UNAVAILABLE = Object.freeze({
  status: "error",
  message: "That email address is not available.",
})

/**
 * A `password_hash` for a row no test ever authenticates against.
 *
 * Deliberately not a real argon2 digest: it satisfies `NOT NULL` and nothing
 * more, so a test that accidentally tried to sign in as one of these rows fails
 * rather than quietly succeeding.
 */
const UNUSABLE_PASSWORD_HASH = "$argon2id$fixture-never-verified"

// --- Wiring ----------------------------------------------------------------

let drizzleDb: NodePgDatabase<typeof schema> | undefined
let cookieStore: FakeCookieStore
let accountId: string

/** Hoisted function declarations, read by the mock factories at call time. */
function currentDb(): NodePgDatabase<typeof schema> {
  if (drizzleDb === undefined) {
    throw new Error(
      "The scratch-schema Drizzle client is not open. Read it inside a test."
    )
  }
  return drizzleDb
}

function currentCookieStore(): FakeCookieStore {
  return cookieStore
}

beforeAll(async () => {
  // The harness's own `beforeAll` has already created the schema and applied the
  // migrations by this point. With `TEST_DATABASE_URL` unset it registered none
  // of that, and every test in this file is skipped — so nothing here may touch
  // the pool.
  if (!db.enabled) return

  // The one Drizzle client for this file, over the harness's pool, whose every
  // connection has `search_path` bound to this file's scratch schema.
  drizzleDb = drizzle(db.pool(), { schema })

  accountId = randomUUID()

  // A real hash, once: the sign-in tests below run genuine verifications, and a
  // stubbed digest would erase the cost Requirement 1.11 exists to equalize.
  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [
      accountId,
      ACCOUNT_EMAIL_AS_TYPED,
      ACCOUNT_EMAIL_NORMALIZED,
      await hashPassword(ACCOUNT_PASSWORD),
    ]
  )
}, ARGON2_TIMEOUT_MS)

beforeEach(async () => {
  cookieStore = new FakeCookieStore()

  argon2Calls.hash = 0
  argon2Calls.verify = 0
  argon2Calls.decoy = 0
  hooks.beforeNextHash = undefined

  // Guarded, and the guard is load-bearing: Vitest runs `beforeEach` hooks in
  // parallel by default, so the harness's skip hook does not prevent this one
  // from running when `TEST_DATABASE_URL` is unset.
  if (!db.enabled) return

  // `users` deliberately survives, because the shared account is seeded once in
  // `beforeAll`. Tests that create a user use their own address, and every
  // assertion below is scoped by email, user id or row id.
  await db.query(`TRUNCATE sessions, login_attempts`)
})

// --- Fixtures and queries --------------------------------------------------

function credentials(email: string, password: string): FormData {
  const formData = new FormData()
  formData.set("email", email)
  formData.set("password", password)
  return formData
}

async function insertUser(
  id: string,
  email: string,
  emailNormalized: string
): Promise<void> {
  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [id, email, emailNormalized, UNUSABLE_PASSWORD_HASH]
  )
}

interface UserRow {
  readonly id: string
  readonly email: string
  readonly email_normalized: string
}

async function usersWithNormalized(
  emailNormalized: string
): Promise<readonly UserRow[]> {
  // `password_hash` is deliberately not projected: no test in this file needs to
  // see a stored hash, so none of them reads one.
  const result = await db.query<UserRow>(
    `SELECT id, email, email_normalized FROM users
      WHERE email_normalized = $1 ORDER BY id`,
    [emailNormalized]
  )
  return result.rows
}

/** Session row ids for one user. Never the token hash. */
async function sessionIdsFor(userId: string): Promise<readonly string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM sessions WHERE user_id = $1 ORDER BY id`,
    [userId]
  )
  return result.rows.map(({ id }) => id)
}

async function sessionExists(sessionId: string): Promise<boolean> {
  const result = await db.query(`SELECT 1 FROM sessions WHERE id = $1`, [
    sessionId,
  ])
  return result.rowCount === 1
}

async function totalSessions(): Promise<number> {
  const result = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sessions`
  )
  return Number(result.rows[0].n)
}

async function attemptsFor(
  emailNormalized: string
): Promise<readonly boolean[]> {
  const result = await db.query<{ success: boolean }>(
    `SELECT success FROM login_attempts
      WHERE email_normalized = $1 ORDER BY created_at`,
    [emailNormalized]
  )
  return result.rows.map(({ success }) => success)
}

/**
 * `count` attempts for one email, dated `secondsAgo` and older.
 *
 * The timestamps come from the **app's** clock rather than from `now()`, because
 * `isLockedOut` compares them against a `new Date()` taken in the action. Mixing
 * the database's clock into the stored side and the process's into the
 * comparison makes the window slightly wrong in whichever direction the two have
 * drifted.
 */
async function seedAttempts(
  emailNormalized: string,
  count: number,
  success: boolean,
  secondsAgo = 1
): Promise<void> {
  const base = Date.now()

  for (let index = 0; index < count; index += 1) {
    await db.query(
      `INSERT INTO login_attempts (id, email_normalized, success, created_at)
       VALUES ($1, $2, $3, $4)`,
      [
        randomUUID(),
        emailNormalized,
        success,
        new Date(base - (secondsAgo + index) * 1000),
      ]
    )
  }
}

/** The `seeded_starter_key` values one user holds (Requirement 10.2). */
async function starterKeysFor(userId: string): Promise<readonly string[]> {
  const result = await db.query<{ seeded_starter_key: string }>(
    `SELECT seeded_starter_key FROM report_templates
      WHERE user_id = $1 AND seeded_starter_key IS NOT NULL
      ORDER BY seeded_starter_key`,
    [userId]
  )
  return result.rows.map(({ seeded_starter_key: key }) => key)
}

/** One row per seeded starter version, joined to the template that pins it. */
async function starterVersionsFor(userId: string): Promise<
  readonly {
    readonly version_id: string
    readonly version: number
    readonly current_version_id: string | null
  }[]
> {
  const result = await db.query<{
    version_id: string
    version: number
    current_version_id: string | null
  }>(
    `SELECT v.id AS version_id, v.version, t.current_version_id
       FROM report_template_versions v
       JOIN report_templates t ON t.id = v.template_id
      WHERE t.user_id = $1 AND t.seeded_starter_key IS NOT NULL
      ORDER BY t.seeded_starter_key`,
    [userId]
  )
  return result.rows
}

/** Mint a session through the production path, as a browser would then hold it. */
async function presentSessionFor(userId: string): Promise<string> {
  await createSession(userId)

  const ids = await sessionIdsFor(userId)
  expect(ids).toHaveLength(1)
  return ids[0]
}

// --- Registration ----------------------------------------------------------

describe("registerAction", () => {
  test(
    "Requirements 7.1, 7.3 — creates the user in both forms, a session, and redirects",
    async () => {
      // Surrounding whitespace on purpose: it is a paste artifact, so neither
      // stored column may carry it, and the ≤254 check measures the trimmed form.
      const asTyped = "Ada.Lovelace@Example.COM"
      const normalized = "ada.lovelace@example.com"

      const target = await redirectTarget(
        registerAction(undefined, credentials(`  ${asTyped}  `, NEW_PASSWORD))
      )

      // Requirement 7.1 — the dashboard, not a `returnTo`: registration is not
      // the resumption of an interrupted request.
      expect(target).toBe(DASHBOARD)

      const rows = await usersWithNormalized(normalized)
      expect(rows).toHaveLength(1)

      // Requirement 7.3, both halves from one submitted value: the normalized
      // form under the UNIQUE constraint, and the visitor's own casing kept.
      expect(rows[0].email_normalized).toBe(normalized)
      expect(rows[0].email).toBe(asTyped)

      expect(await sessionIdsFor(rows[0].id)).toHaveLength(1)

      // One hash, for the one account created.
      expect(argon2Calls.hash).toBe(1)

      // The cookie the session row is reachable through. Its *value* is a
      // session token and is neither read nor asserted on here.
      expect(cookieStore.writes).toHaveLength(1)
      expect(cookieStore.writes[0].name).toBe(SESSION_COOKIE)
      expect(cookieStore.writes[0].httpOnly).toBe(true)
      expect(cookieStore.writes[0].sameSite).toBe("lax")
    },
    ARGON2_TIMEOUT_MS
  )

  test(
    "Requirement 7.2 — a pre-existing normalized email creates neither user nor session",
    async () => {
      const existingId = randomUUID()
      await insertUser(
        existingId,
        "First.Owner@Example.com",
        "first@example.com"
      )

      // A different spelling of the same address: the UNIQUE constraint is over
      // the normalized form, so this collides.
      const rejection = await registerAction(
        undefined,
        credentials("  FIRST@Example.COM ", NEW_PASSWORD)
      )

      expect(rejection).toStrictEqual(EMAIL_UNAVAILABLE)

      const rows = await usersWithNormalized("first@example.com")
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe(existingId)

      expect(await totalSessions()).toBe(0)
      expect(cookieStore.writes).toEqual([])

      // Rejected before any work: no hash was computed for a submission that
      // was never going to be stored.
      expect(argon2Calls.hash).toBe(0)
    },
    ARGON2_TIMEOUT_MS
  )

  test(
    "Requirement 7.12 — a UNIQUE violation is the same rejection, with no user and no session",
    async () => {
      const normalized = "race@example.com"
      const interloperId = randomUUID()

      // **Forcing the race.** The conflicting row is inserted from
      // `hashPassword`, which `registerAction` calls after its duplicate-email
      // `SELECT` has returned nothing and before its `INSERT` runs — the same
      // window a second concurrent submission would land in.
      //
      // Two genuinely concurrent `registerAction` calls would reach this window
      // only when the scheduler happened to interleave them, so the test would
      // pass most of the time whether or not the catch existed. Placing the
      // insert deterministically inside the window exercises the *catch*, and
      // `hookRan` below is the proof that it did: the hook cannot fire unless
      // the pre-`SELECT` already came back empty.
      let hookRan = false
      hooks.beforeNextHash = async () => {
        hookRan = true
        await insertUser(interloperId, "Race@Example.com", normalized)
      }

      const lostTheRace = await registerAction(
        undefined,
        credentials("RACE@Example.com", NEW_PASSWORD)
      )

      // The pre-`SELECT` found nothing, so this rejection came from the
      // constraint — SQLSTATE 23505 on `users_email_normalized_unique`, mapped
      // by the action's own catch — and not from the gate before it.
      expect(hookRan).toBe(true)
      expect(argon2Calls.hash).toBe(1)
      expect(lostTheRace).toStrictEqual(EMAIL_UNAVAILABLE)

      // The losing submission wrote nothing. The insert is the first write in
      // the action, so there was nothing to unwind — and this is the assertion
      // that would fail if it were not.
      const rows = await usersWithNormalized(normalized)
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe(interloperId)
      expect(await totalSessions()).toBe(0)
      expect(cookieStore.writes).toEqual([])

      // Requirement 7.2 and Requirement 7.12 are **one** answer. Two
      // constructions of the same sentence is how a whitespace edit to one of
      // them turns the register form into a registration oracle, so the two
      // paths are compared as serialized values and as one object.
      const preSelectRejection = await registerAction(
        undefined,
        credentials("race@EXAMPLE.com", NEW_PASSWORD)
      )

      expect(JSON.stringify(preSelectRejection)).toBe(
        JSON.stringify(lostTheRace)
      )
      expect(preSelectRejection).toBe(lostTheRace)

      // The second submission took the pre-`SELECT` path, so it cost no hash.
      expect(argon2Calls.hash).toBe(1)
    },
    ARGON2_TIMEOUT_MS
  )

  test(
    "Requirement 10.2 — registration seeds the three starter templates",
    async () => {
      // Account creation is the **only** place starters are seeded, so this is
      // the wiring assertion: three templates, three version-1 rows, each
      // template pointing at its own version.
      const normalized = "seeded.on.register@example.com"

      const target = await redirectTarget(
        registerAction(undefined, credentials(normalized, NEW_PASSWORD))
      )

      expect(target).toBe(DASHBOARD)

      const [account] = await usersWithNormalized(normalized)
      expect(account).toBeDefined()

      const templates = await starterKeysFor(account.id)
      expect([...templates].sort()).toEqual([...STARTER_KEYS].sort())

      const versions = await starterVersionsFor(account.id)
      expect(versions).toHaveLength(STARTER_TEMPLATE_COUNT)
      expect(versions.map(({ version }) => version)).toEqual(
        Array.from({ length: STARTER_TEMPLATE_COUNT }, () => 1)
      )
      for (const row of versions) {
        expect(row.current_version_id).toBe(row.version_id)
      }
    },
    ARGON2_TIMEOUT_MS
  )

  test(
    "Requirement 10.6 — a seeding failure does not fail the registration",
    async () => {
      // The binding constraint of the wiring: the user row and the session must
      // survive, the visitor must still land on the dashboard, and no partially
      // inserted starter may remain — so the account is usable and the wizard is
      // reachable, which is what "leaves that user able to author a template"
      // means in practice.
      const logged = vi.spyOn(console, "error").mockImplementation(() => {})
      const normalized = "starters.failed@example.com"

      try {
        // Forced from inside the database, on the **third** starter, so two are
        // already inserted when it raises. Anything other than zero rows below
        // would mean the three do not share one transaction.
        await db.query(
          `CREATE OR REPLACE FUNCTION fail_on_starter() RETURNS trigger AS $$
           BEGIN RAISE EXCEPTION 'forced mid-seed failure'; END $$ LANGUAGE plpgsql`
        )
        await db.query(
          `CREATE TRIGGER fail_on_starter_trg BEFORE INSERT ON report_templates
             FOR EACH ROW EXECUTE FUNCTION fail_on_starter()`
        )

        const target = await redirectTarget(
          registerAction(undefined, credentials(normalized, NEW_PASSWORD))
        )

        // The registration completed. A seeding failure that propagated would
        // have replaced this redirect with an error page — and would have left
        // the account created but unreachable, since the `users` insert had
        // already committed.
        expect(target).toBe(DASHBOARD)

        const [account] = await usersWithNormalized(normalized)
        expect(account).toBeDefined()
        expect(await sessionIdsFor(account.id)).toHaveLength(1)

        // Requirement 10.6 — nothing partially inserted.
        expect(await starterKeysFor(account.id)).toEqual([])
        expect(await starterVersionsFor(account.id)).toEqual([])

        // The failure is stated server-side, which is the signal the
        // `/templates` surface reads the row against — see `lib/templates/seed.ts`.
        expect(
          logged.mock.calls.some((call) =>
            String(call[0]).includes("[starters]")
          )
        ).toBe(true)
      } finally {
        await db.query(
          `DROP TRIGGER IF EXISTS fail_on_starter_trg ON report_templates`
        )
        await db.query(`DROP FUNCTION IF EXISTS fail_on_starter()`)
        logged.mockRestore()
      }
    },
    ARGON2_TIMEOUT_MS
  )
})

// --- Sign-in ---------------------------------------------------------------

describe("loginAction", () => {
  test(
    "Requirements 7.4, 3.1 — valid credentials create a session, record a success, and redirect",
    async () => {
      const target = await redirectTarget(
        loginAction(
          undefined,
          credentials(ACCOUNT_EMAIL_AS_TYPED, ACCOUNT_PASSWORD)
        )
      )

      expect(target).toBe(DASHBOARD)
      expect(await sessionIdsFor(accountId)).toHaveLength(1)

      // Requirement 3.1 — the attempt is recorded, keyed on the normalized form
      // so case and whitespace cannot split the window.
      expect(await attemptsFor(ACCOUNT_EMAIL_NORMALIZED)).toEqual([true])

      // One real verification, and no decoy: this submission matched a user.
      expect(argon2Calls.verify).toBe(1)
      expect(argon2Calls.decoy).toBe(0)
    },
    ARGON2_TIMEOUT_MS
  )

  test(
    "Requirement 7.10 — authenticating with a cookie present deletes the presented row",
    async () => {
      const presentedId = await presentSessionFor(accountId)

      const target = await redirectTarget(
        loginAction(
          undefined,
          credentials(ACCOUNT_EMAIL_AS_TYPED, ACCOUNT_PASSWORD)
        )
      )

      expect(target).toBe(DASHBOARD)

      // Asserted **by id**, which is the whole claim. "One row exists" would
      // also hold for an implementation that left the presented row alive and
      // failed to write a new one, and for one that reused the same row.
      expect(await sessionExists(presentedId)).toBe(false)

      const remaining = await sessionIdsFor(accountId)
      expect(remaining).toHaveLength(1)
      expect(remaining[0]).not.toBe(presentedId)

      // The rotation is visible in the cookie too: the presented cookie was
      // cleared and a new one set, in that order.
      expect(cookieStore.deletes).toHaveLength(1)
      expect(cookieStore.writes).toHaveLength(2)
    },
    ARGON2_TIMEOUT_MS
  )
})

// --- Sign-out --------------------------------------------------------------

describe("logoutAction", () => {
  test("Requirement 2.12 — deletes the presented row and clears the cookie", async () => {
    const presentedId = await presentSessionFor(accountId)

    const target = await redirectTarget(logoutAction())

    expect(target).toBe(LOGIN)
    expect(await sessionExists(presentedId)).toBe(false)
    expect(await sessionIdsFor(accountId)).toEqual([])

    // The same name *and* path the cookie was set with; a mismatched path
    // clears nothing.
    expect(cookieStore.deletes).toEqual([{ name: SESSION_COOKIE, path: "/" }])
  })

  test("Requirement 2.13 — a sign-out with no cookie is a no-op", async () => {
    const survivorId = await presentSessionFor(accountId)

    // A stale tab: the row is still there, the request carries no cookie.
    cookieStore = new FakeCookieStore()

    const target = await redirectTarget(logoutAction())

    expect(target).toBe(LOGIN)

    // Nothing raised, and nothing deleted — signing out of a session that is not
    // presented must not delete somebody else's row.
    expect(await sessionExists(survivorId)).toBe(true)
    expect(cookieStore.deletes).toEqual([])
  })
})

// --- Lockout, end to end ---------------------------------------------------

describe("lockout wired through loginAction", () => {
  test("the threshold and window are the declared ones", () => {
    // Hard-coded, so the seeding below is expressed in the exported constants
    // without this suite moving silently if one of them changes.
    expect(FAILED_THRESHOLD).toBe(5)
    expect(WINDOW_MINUTES).toBe(15)
  })

  test(
    "Requirements 3.2, 3.3, 3.6, 3.7 — five failures lock the email, without verifying, and the rejection is recorded",
    async () => {
      await seedAttempts(ACCOUNT_EMAIL_NORMALIZED, FAILED_THRESHOLD, false)

      // The **correct** password. A refusal here can only have come from the
      // lockout gate, which is what makes the counter assertions below mean
      // something.
      const rejection = await loginAction(
        undefined,
        credentials(ACCOUNT_EMAIL_AS_TYPED, ACCOUNT_PASSWORD)
      )

      // Requirement 3.6 — the same answer an unmatched email gets.
      expect(rejection).toStrictEqual(INVALID_CREDENTIALS)

      // Requirement 3.3 — no verification was invoked, on either path.
      expect(argon2Calls.verify).toBe(0)
      expect(argon2Calls.decoy).toBe(0)

      // Requirement 3.7 — the rejected attempt is itself recorded as a failure,
      // so the window measures from the most recent attempt and hammering a
      // locked email keeps it locked rather than aging it out.
      expect(await attemptsFor(ACCOUNT_EMAIL_NORMALIZED)).toEqual(
        Array.from({ length: FAILED_THRESHOLD + 1 }, () => false)
      )

      expect(await totalSessions()).toBe(0)
      expect(cookieStore.writes).toEqual([])
    },
    ARGON2_TIMEOUT_MS
  )

  test(
    "Requirement 3.4 — five successes do not lock the email",
    async () => {
      // **The assertion the pure predicate structurally cannot make.**
      // `isLockedOutFromFailures` is handed failures only, so it agrees with a
      // query that dropped its `success = false` filter. This is the case that
      // catches that query: five rows in the window, none of them a failure.
      await seedAttempts(ACCOUNT_EMAIL_NORMALIZED, FAILED_THRESHOLD, true)

      const target = await redirectTarget(
        loginAction(
          undefined,
          credentials(ACCOUNT_EMAIL_AS_TYPED, ACCOUNT_PASSWORD)
        )
      )

      expect(target).toBe(DASHBOARD)
      expect(argon2Calls.verify).toBe(1)
      expect(await sessionIdsFor(accountId)).toHaveLength(1)

      expect(await attemptsFor(ACCOUNT_EMAIL_NORMALIZED)).toEqual(
        Array.from({ length: FAILED_THRESHOLD + 1 }, () => true)
      )
    },
    ARGON2_TIMEOUT_MS
  )

  test(
    "Requirement 3.8 — an unreadable login_attempts rejects without verifying",
    async () => {
      // Fails **closed**, against the real relation. The table is renamed out
      // from under the query, so `isLockedOut`'s `SELECT` gets a genuine
      // SQLSTATE `42P01` rather than a hand-built error — which is the point,
      // because a fake would be asserting that this test knows how the driver
      // reports a missing table.
      //
      // Treating an unreadable counter as "not locked" would turn a database
      // problem into an unthrottled password oracle, so the safe answer and the
      // true answer are allowed to differ here.
      const logged = vi.spyOn(console, "error").mockImplementation(() => {})

      try {
        await db.query(
          `ALTER TABLE login_attempts RENAME TO login_attempts_gone`
        )

        // Again the correct password, so the refusal can only be the closed gate.
        const rejection = await loginAction(
          undefined,
          credentials(ACCOUNT_EMAIL_AS_TYPED, ACCOUNT_PASSWORD)
        )

        // Requirement 3.6 — and it has to be *this* response: a degraded
        // database that answered differently would itself be the oracle the
        // shared constant exists to prevent.
        expect(rejection).toStrictEqual(INVALID_CREDENTIALS)
        expect(argon2Calls.verify).toBe(0)
        expect(argon2Calls.decoy).toBe(0)
        expect(await totalSessions()).toBe(0)

        // The rejected attempt could not be recorded either, and that failure is
        // logged rather than raised: an escaping error there would replace the
        // outcome Requirement 3.8 names with an error page.
        expect(logged).toHaveBeenCalled()
      } finally {
        await db.query(
          `ALTER TABLE login_attempts_gone RENAME TO login_attempts`
        )
        logged.mockRestore()
      }
    },
    ARGON2_TIMEOUT_MS
  )

  test(
    "Requirements 3.2, 3.4 — a failure older than the window does not count",
    async () => {
      // The other half of the SQL window: `created_at >= now - 15min` is applied
      // in the query as well as in the predicate, so a threshold's worth of
      // failures that includes one stale row must not lock.
      await seedAttempts(ACCOUNT_EMAIL_NORMALIZED, FAILED_THRESHOLD - 1, false)
      await seedAttempts(
        ACCOUNT_EMAIL_NORMALIZED,
        1,
        false,
        (WINDOW_MINUTES + 1) * 60
      )

      expect(await attemptsFor(ACCOUNT_EMAIL_NORMALIZED)).toHaveLength(
        FAILED_THRESHOLD
      )

      const target = await redirectTarget(
        loginAction(
          undefined,
          credentials(ACCOUNT_EMAIL_AS_TYPED, ACCOUNT_PASSWORD)
        )
      )

      expect(target).toBe(DASHBOARD)
      expect(argon2Calls.verify).toBe(1)
    },
    ARGON2_TIMEOUT_MS
  )
})

// --- The generic outcome, against real SQL ---------------------------------

describe("Requirements 1.7, 1.8, 3.6 — one response for three real refusals", () => {
  test(
    "unmatched email, wrong password and locked out are byte-identical",
    async () => {
      // The same claim `lib/actions/auth.test.ts` makes against an in-memory
      // double, re-made here against the real queries — so a divergence
      // introduced by the database layer rather than by the branch is caught
      // too. The counters confirm each call took the branch it was meant to,
      // which a returned value cannot show: all three are the same value.

      // Requirement 1.7 — no user matches. One decoy verification is burned so
      // this path costs what the next one costs (Requirement 1.11).
      const unmatchedEmail = await loginAction(
        undefined,
        credentials(UNKNOWN_EMAIL, ACCOUNT_PASSWORD)
      )
      expect(argon2Calls.decoy).toBe(1)
      expect(argon2Calls.verify).toBe(0)

      // Requirement 1.8 — the stored hash does not accept this password. This
      // also becomes the first recorded failure for the account below.
      const wrongPassword = await loginAction(
        undefined,
        credentials(ACCOUNT_EMAIL_AS_TYPED, WRONG_PASSWORD)
      )
      expect(argon2Calls.verify).toBe(1)

      // Requirement 3.3, 3.6 — four more failures reach the threshold, so the
      // next submission is refused by the gate with the correct password in
      // hand and no verification performed.
      await seedAttempts(ACCOUNT_EMAIL_NORMALIZED, FAILED_THRESHOLD - 1, false)

      const lockedOut = await loginAction(
        undefined,
        credentials(ACCOUNT_EMAIL_AS_TYPED, ACCOUNT_PASSWORD)
      )
      expect(argon2Calls.verify).toBe(1)
      expect(argon2Calls.decoy).toBe(1)

      const serialized = [unmatchedEmail, wrongPassword, lockedOut].map(
        (state) => JSON.stringify(state)
      )

      expect(new Set(serialized).size, serialized.join("\n")).toBe(1)
      expect(JSON.parse(serialized[0])).toStrictEqual(INVALID_CREDENTIALS)

      // No refusal granted a session, and every one of them was counted.
      expect(await totalSessions()).toBe(0)
      expect(await attemptsFor(UNKNOWN_EMAIL)).toEqual([false])
      expect(await attemptsFor(ACCOUNT_EMAIL_NORMALIZED)).toHaveLength(
        FAILED_THRESHOLD + 1
      )
    },
    ARGON2_TIMEOUT_MS
  )
})
