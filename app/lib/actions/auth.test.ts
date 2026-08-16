import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"

/**
 * `lib/actions/auth.ts` — the **generic-outcome discipline** (Requirements 1.7,
 * 1.8, 3.6, 7.5) and the register rejection it must stay distinguishable from
 * (Requirement 7.2).
 *
 * ## Why this file exists alongside the Postgres suite
 *
 * `test/db/auth-actions.integration.test.ts` drives the same actions against a
 * real database, because register, login, logout and the UNIQUE-violation race
 * are claims about SQL. This file asserts something different and it must not
 * depend on docker: that **all four ways a sign-in can be refused produce one
 * byte-identical response**. That is the product's central authentication
 * invariant, and a suite that skips it when `TEST_DATABASE_URL` is unset would
 * leave it unasserted in a default `pnpm test` run.
 *
 * It is also the assertion with the widest blast radius if it regresses. A
 * response that differs between "no such account" and "wrong password" is a
 * registration oracle: an attacker enumerates addresses without ever guessing a
 * password. The three messages agreeing *today* is not the property — the
 * property is that there is only one of them.
 *
 * ## What is real and what is doubled
 *
 * Doubled: `getDb`, `cookies` and `redirect` — the three request-scoped
 * collaborators. Real: the zod schemas, the normalization, the branch ordering,
 * the lockout predicate, and argon2 itself at the parameters Requirement 1.10
 * pins. Nothing here lowers a cost parameter, so the count of genuine argon2
 * operations is kept small and the timeouts are generous instead.
 *
 * The database double **records** rather than simulates: the statements issued
 * are the evidence for two claims a state comparison could not make — that the
 * locked-out path never reads `users` (Requirement 3.3), and that no refusal
 * path writes a `sessions` row.
 */

// Declared before the imports below because Vitest hoists these calls above
// them. Each factory closes over a hoisted *function declaration*, so nothing is
// dereferenced until a test has installed the current double.
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

import {
  type AuthActionState,
  loginAction,
  registerAction,
} from "@/lib/actions/auth"
import { hashPassword } from "@/lib/auth/password"
import { FAILED_THRESHOLD, WINDOW_MINUTES } from "@/lib/auth/lockout"
import { loginAttempts, sessions, users } from "@/lib/db/schema"
import { FakeCookieStore, redirectTarget } from "@/test/next-doubles"

// --- Constants --------------------------------------------------------------

/**
 * Comfortably above the cost of the handful of argon2 operations any one test
 * here performs, so a loaded machine reports a real failure rather than a
 * timeout.
 */
const ARGON2_TIMEOUT_MS = 30_000

/** A registered account. The password is a fixture, never asserted on. */
const ACCOUNT_EMAIL = "consultant@example.com"
const ACCOUNT_PASSWORD = "a-fixture-passphrase-01"
const ACCOUNT_ID = "user-0001"

/** Not registered, in any test in this file. */
const UNKNOWN_EMAIL = "nobody@example.com"

/** Wrong for {@link ACCOUNT_EMAIL}, and long enough to reach verification. */
const WRONG_PASSWORD = "a-different-passphrase-01"

/**
 * The generic sign-in rejection, restated rather than imported.
 *
 * It **cannot** be imported: a `"use server"` module may only export async
 * functions, so the constant is module-private by construction. Restating it is
 * therefore not a stylistic choice — and it is the right one anyway, because a
 * test that read the constant out of the module could not notice the module
 * changing it.
 */
const INVALID_CREDENTIALS_MESSAGE =
  "Those sign-in details were not accepted. Check them and try again."

/** Requirement 7.2's rejection, which must stay *different* from the above. */
const EMAIL_UNAVAILABLE_MESSAGE = "That email address is not available."

// --- The recording database ------------------------------------------------

/**
 * A stand-in for a driver failure, carrying the one field
 * `lib/actions/auth.ts` reads off a thrown value: the SQLSTATE code.
 *
 * `42P01` is `undefined_table` — the shape of "`login_attempts` is unreadable"
 * that Requirement 3.8 is about.
 */
function unreadableTableError(): Error {
  return Object.assign(new Error("relation does not exist"), { code: "42P01" })
}

type OperationKind = "select" | "insert" | "update" | "delete"

interface Operation {
  readonly kind: OperationKind
  /** The Drizzle table object, compared by identity. */
  table?: unknown
  /** An `INSERT`'s values or an `UPDATE`'s `SET` clause. */
  payload?: Record<string, unknown>
}

type Row = Record<string, unknown>

interface SelectChain extends PromiseLike<readonly Row[]> {
  from(table: unknown): SelectChain
  innerJoin(...args: readonly unknown[]): SelectChain
  where(...args: readonly unknown[]): SelectChain
  orderBy(...args: readonly unknown[]): SelectChain
  limit(...args: readonly unknown[]): SelectChain
}

interface WriteChain extends PromiseLike<void> {
  values(payload: Row): WriteChain
  set(payload: Row): WriteChain
  where(...args: readonly unknown[]): WriteChain
}

/**
 * A recording stand-in for the Drizzle client.
 *
 * It interprets no statement. A `select` resolves to whatever was seeded for the
 * table named by its `.from(...)`, matched by **object identity** against the
 * table definitions in `lib/db/schema.ts` — so the double cannot be fooled by a
 * query that reads the wrong table, which a call-order-based fake would be.
 */
class RecordingDb {
  readonly operations: Operation[] = []

  private readonly seeded = new Map<unknown, readonly Row[]>()

  /** Tables whose statements reject, so a degraded database is assertable. */
  private readonly unreadable = new Set<unknown>()

  seed(table: unknown, rows: readonly Row[]): void {
    this.seeded.set(table, rows)
  }

  breakTable(table: unknown): void {
    this.unreadable.add(table)
  }

  operationsOn(table: unknown): readonly Operation[] {
    return this.operations.filter((operation) => operation.table === table)
  }

  get writes(): readonly Operation[] {
    return this.operations.filter((operation) => operation.kind !== "select")
  }

  select(): SelectChain {
    const operation: Operation = { kind: "select" }
    this.operations.push(operation)

    const resolve = (): Promise<readonly Row[]> =>
      this.unreadable.has(operation.table)
        ? Promise.reject(unreadableTableError())
        : Promise.resolve(this.seeded.get(operation.table) ?? [])

    const chain: SelectChain = {
      from: (table) => {
        operation.table = table
        return chain
      },
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (onfulfilled, onrejected) =>
        resolve().then(onfulfilled, onrejected),
    }

    return chain
  }

  insert(table: unknown): WriteChain {
    return this.writeChain("insert", table)
  }

  update(table: unknown): WriteChain {
    return this.writeChain("update", table)
  }

  delete(table: unknown): WriteChain {
    return this.writeChain("delete", table)
  }

  private writeChain(kind: OperationKind, table: unknown): WriteChain {
    const operation: Operation = { kind, table }
    this.operations.push(operation)

    const resolve = (): Promise<void> =>
      this.unreadable.has(table)
        ? Promise.reject(unreadableTableError())
        : Promise.resolve(undefined)

    const chain: WriteChain = {
      values: (payload) => {
        operation.payload = payload
        return chain
      },
      set: (payload) => {
        operation.payload = payload
        return chain
      },
      where: () => chain,
      then: (onfulfilled, onrejected) =>
        resolve().then(onfulfilled, onrejected),
    }

    return chain
  }
}

// --- Wiring ----------------------------------------------------------------

let db: RecordingDb
let cookieStore: FakeCookieStore

/** Hoisted function declarations, read by the mock factories at call time. */
function currentDb(): RecordingDb {
  return db
}

function currentCookieStore(): FakeCookieStore {
  return cookieStore
}

/**
 * A real argon2id hash of {@link ACCOUNT_PASSWORD}, computed once.
 *
 * One genuine hash for the whole file. It is seeded into the `users` row the
 * wrong-password path reads, so that path runs a real verification at the real
 * cost — the point of Requirement 1.11 is that the unmatched-email path costs
 * the same, and a stubbed verifier would erase the thing being compared.
 */
let accountPasswordHash: string

beforeAll(async () => {
  accountPasswordHash = await hashPassword(ACCOUNT_PASSWORD)
}, ARGON2_TIMEOUT_MS)

beforeEach(() => {
  db = new RecordingDb()
  cookieStore = new FakeCookieStore()

  // The unreadable-`login_attempts` scenario logs twice by design (the read that
  // failed closed, and the rejected attempt that could not be recorded). Silenced
  // so a passing run is quiet; the assertions are about the returned value.
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// --- Helpers ---------------------------------------------------------------

function credentials(email: unknown, password: unknown): FormData {
  const formData = new FormData()
  if (typeof email === "string") formData.set("email", email)
  if (typeof password === "string") formData.set("password", password)
  return formData
}

/** A registered account, as `loginAction`'s `users` lookup projects it. */
function seedAccount(): void {
  db.seed(users, [{ id: ACCOUNT_ID, passwordHash: accountPasswordHash }])
}

/**
 * `count` failures for one email, spread inside the trailing window.
 *
 * Spaced by seconds rather than stacked on one instant, so the rows look like
 * real attempts and the newest-first bounded read in `isLockedOut` sees the same
 * set the predicate then counts.
 */
function seedFailures(count: number): void {
  const now = Date.now()
  db.seed(
    loginAttempts,
    Array.from({ length: count }, (_unused, index) => ({
      createdAt: new Date(now - (index + 1) * 1000),
    }))
  )
}

// --- The four refusal paths -------------------------------------------------

/**
 * Every way `loginAction` can refuse a submission, each named by the criterion
 * that describes it.
 *
 * The list is exhaustive against the implementation's branches, and that is what
 * makes the assertion below a statement about the action rather than about three
 * examples of it.
 */
const REFUSALS = [
  {
    label: "the submission fails the boundary schema (Req 7.5)",
    async run(): Promise<AuthActionState> {
      // No rows seeded and none needed: a submission that is not an address is
      // rejected before anything is read.
      return await loginAction(
        undefined,
        credentials("not-an-address", ACCOUNT_PASSWORD)
      )
    },
  },
  {
    label: "the email matches no user (Req 1.7)",
    async run(): Promise<AuthActionState> {
      return await loginAction(
        undefined,
        credentials(UNKNOWN_EMAIL, ACCOUNT_PASSWORD)
      )
    },
  },
  {
    label: "the password does not verify (Req 1.8)",
    async run(): Promise<AuthActionState> {
      seedAccount()
      return await loginAction(
        undefined,
        credentials(ACCOUNT_EMAIL, WRONG_PASSWORD)
      )
    },
  },
  {
    label: "the email is locked out (Req 3.3, 3.6)",
    async run(): Promise<AuthActionState> {
      // Registered, and the password is the *correct* one — so a refusal here
      // can only have come from the lockout gate.
      seedAccount()
      seedFailures(FAILED_THRESHOLD)
      return await loginAction(
        undefined,
        credentials(ACCOUNT_EMAIL, ACCOUNT_PASSWORD)
      )
    },
  },
  {
    label: "login_attempts is unreadable, so lockout fails closed (Req 3.8)",
    async run(): Promise<AuthActionState> {
      seedAccount()
      db.breakTable(loginAttempts)
      return await loginAction(
        undefined,
        credentials(ACCOUNT_EMAIL, ACCOUNT_PASSWORD)
      )
    },
  },
] as const

describe("Requirements 1.7, 1.8, 3.6 — one response for every refusal", () => {
  test(
    "all five refusal paths return byte-identical responses",
    async () => {
      // **The assertion this task exists for.**
      //
      // Serialized rather than compared field by field, so a future divergence
      // in *any* field fails here — a `field: "password"` added to one branch, a
      // `code`, a `retryAfter`. Comparing `message` alone would let exactly the
      // kind of helpful extra through that turns one of these branches into an
      // oracle.
      const serialized: string[] = []

      for (const refusal of REFUSALS) {
        db = new RecordingDb()
        cookieStore = new FakeCookieStore()

        serialized.push(JSON.stringify(await refusal.run()))
      }

      expect(serialized).toHaveLength(REFUSALS.length)
      expect(new Set(serialized).size, serialized.join("\n")).toBe(1)

      // Non-vacuity: the responses are identical *and* they are a real
      // rejection. Five `undefined`s would also be a set of size one.
      expect(JSON.parse(serialized[0])).toStrictEqual({
        status: "error",
        message: INVALID_CREDENTIALS_MESSAGE,
      })
    },
    ARGON2_TIMEOUT_MS
  )

  test(
    "the five paths return the same object, not five equal ones",
    async () => {
      // Stronger than serialization equality, and the form the implementation
      // actually guarantees: one frozen module constant returned by reference.
      // Serialization equality would still pass for five branches that each
      // construct the same sentence — which is the arrangement in which a
      // whitespace edit to one of them becomes an oracle.
      const results: AuthActionState[] = []

      for (const refusal of REFUSALS) {
        db = new RecordingDb()
        cookieStore = new FakeCookieStore()

        results.push(await refusal.run())
      }

      const [first] = results
      for (const result of results) expect(result).toBe(first)

      expect(Object.isFrozen(first)).toBe(true)
    },
    ARGON2_TIMEOUT_MS
  )

  test("the response names neither field and carries no other key", async () => {
    // Requirement 7.5. Not "email or password" either: a message naming the pair
    // still tells an enumerator that the pair was the gate.
    const state = await loginAction(
      undefined,
      credentials("not-an-address", ACCOUNT_PASSWORD)
    )

    expect(state?.message).toBe(INVALID_CREDENTIALS_MESSAGE)
    expect(state?.message).not.toMatch(/email/i)
    expect(state?.message).not.toMatch(/password/i)
    expect(state?.message).not.toMatch(/account/i)

    // A closed shape, so there is no per-field slot for somebody to fill in.
    expect(Object.keys(state ?? {}).sort()).toEqual(["message", "status"])
  })

  test("the assertion can tell two rejections apart", async () => {
    // Non-vacuity for the byte-identity test above: if every rejection in this
    // module serialized identically, that test would pass without meaning
    // anything. Requirement 7.2's rejection is a *different* response, and this
    // is what proves the comparison has resolution.
    db.seed(users, [{ id: ACCOUNT_ID }])

    const registerRejection = await registerAction(
      undefined,
      credentials(ACCOUNT_EMAIL, ACCOUNT_PASSWORD)
    )
    const loginRejection = await loginAction(
      undefined,
      credentials("not-an-address", ACCOUNT_PASSWORD)
    )

    expect(registerRejection?.message).toBe(EMAIL_UNAVAILABLE_MESSAGE)
    expect(JSON.stringify(registerRejection)).not.toBe(
      JSON.stringify(loginRejection)
    )
  })
})

describe("Requirement 3.3 — the locked-out path invokes no verification", () => {
  test(
    "it never reads users at all",
    async () => {
      // The structural form of "without invoking password verification": the
      // action returns before `users` is queried, so there is no stored hash in
      // hand to verify against. Asserting on the statements issued is the only
      // way to see that — a returned value looks the same either way.
      seedAccount()
      seedFailures(FAILED_THRESHOLD)

      await loginAction(undefined, credentials(ACCOUNT_EMAIL, ACCOUNT_PASSWORD))

      expect(db.operationsOn(users)).toEqual([])
      expect(db.operationsOn(loginAttempts).map(({ kind }) => kind)).toEqual([
        // The bounded newest-first read that decided the lockout …
        "select",
        // … and the rejected attempt, recorded so the window measures from the
        // most recent attempt (Requirement 3.7).
        "insert",
      ])
    },
    ARGON2_TIMEOUT_MS
  )

  test(
    "one failure short of the threshold, the same submission reads users",
    async () => {
      // Non-vacuity for the assertion above, in its strongest form: the *same*
      // submission that was refused at `FAILED_THRESHOLD` failures is accepted
      // at one fewer. So the refusal came from the gate, and the gate's boundary
      // is where Requirement 3.2 puts it.
      seedAccount()
      seedFailures(FAILED_THRESHOLD - 1)

      const target = await redirectTarget(
        loginAction(undefined, credentials(ACCOUNT_EMAIL, ACCOUNT_PASSWORD))
      )

      expect(target).toBe("/dashboard")
      expect(db.operationsOn(users).map(({ kind }) => kind)).toEqual(["select"])
    },
    ARGON2_TIMEOUT_MS
  )

  test("the threshold and window are the declared ones", () => {
    // Hard-coded, so the seeding above is expressed in the exported constants
    // without the whole suite moving silently if one of them changes.
    expect(FAILED_THRESHOLD).toBe(5)
    expect(WINDOW_MINUTES).toBe(15)
  })
})

describe("no refusal path grants a session", () => {
  test(
    "no sessions row is written and no cookie is set on any refusal",
    async () => {
      // The consequence that matters if a branch is ever reordered: a refusal
      // that reached `createSession` would return the generic message *and* hand
      // out a session, and every assertion above would still pass.
      for (const refusal of REFUSALS) {
        db = new RecordingDb()
        cookieStore = new FakeCookieStore()

        await refusal.run()

        expect(db.operationsOn(sessions), refusal.label).toEqual([])
        expect(cookieStore.writes, refusal.label).toEqual([])
      }
    },
    ARGON2_TIMEOUT_MS
  )

  test(
    "the refusal paths are not vacuous — an accepted sign-in does write one",
    async () => {
      // Non-vacuity for every assertion in this file that counts a write: a
      // `loginAction` that wrote nothing under any circumstances would satisfy
      // all of them.
      seedAccount()

      const target = await redirectTarget(
        loginAction(undefined, credentials(ACCOUNT_EMAIL, ACCOUNT_PASSWORD))
      )

      expect(target).toBe("/dashboard")
      expect(db.operationsOn(sessions).map(({ kind }) => kind)).toEqual([
        "insert",
      ])
      expect(cookieStore.writes).toHaveLength(1)
    },
    ARGON2_TIMEOUT_MS
  )
})
