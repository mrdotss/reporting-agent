import { createHash } from "node:crypto"

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

/**
 * `lib/auth/session.ts` — Requirements 2.6, 2.7, 2.8, 2.9 and 2.18.
 *
 * **A fake clock and an in-memory database, per the design's own testing
 * decision for Requirement 2** — session behaviour is time-and-state driven
 * rather than input driven, so what varies is the clock and the row, not the
 * argument.
 *
 * The choice matters most for Requirement 2.18, which says a request with no
 * cookie, or a token matching no row, performs **no database write**. That is a
 * claim about the statements issued, so it is asserted by **counting
 * invocations**: the fake below records every `select`, `insert`, `update` and
 * `delete` in order, and the assertion is that the write list is empty. Checking
 * the resulting rows instead would pass for an implementation that writes and
 * then writes back — which is exactly the regression the requirement exists to
 * forbid.
 *
 * The same reasoning picks the strongest form of Requirement 2.7's "leaves
 * `absolute_expires_at` unchanged": the assertion is that the `UPDATE`'s `SET`
 * clause **names only `idle_expires_at`**, so the absolute expiry is
 * byte-identical because no statement touched it. A before/after comparison of
 * the stored value would also pass for an implementation that re-wrote the same
 * instant back, and one that re-writes it is one clock-skew away from moving it.
 *
 * The alternative shape — the scratch-schema harness in `test/db` — was
 * rejected for this file, though task 3.8 uses it for the register/login/logout
 * paths where real SQL semantics are the subject. Three reasons: it cannot count
 * statements, so Requirement 2.18 would be asserted by inspecting state; it
 * skips entirely when `TEST_DATABASE_URL` is unset, which would leave the
 * product's central authentication invariant unasserted in a default `pnpm test`
 * run; and the expiry boundary is `>=`, so the "at the expiry instant" cases need
 * one clock shared by the row and the reader, which a database does not share
 * with the test process.
 *
 * `getDb` and `cookies` are the only two collaborators replaced. Everything
 * decided inside the module — the hashing, the constant-time compare, the
 * ordering of the checks, the expiry arithmetic — is the real implementation.
 */

// --- The two mocked collaborators -------------------------------------------

// Declared before the imports below because Vitest hoists these calls above
// them. Each factory closes over a hoisted *function*, not over a `let`, so
// nothing is dereferenced until a test has installed the current double.
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve(currentCookieStore()),
}))

vi.mock("@/lib/db", () => ({
  getDb: () => currentDb(),
}))

import {
  ABSOLUTE_TTL_S,
  IDLE_TTL_S,
  SESSION_COOKIE,
  createSession,
  readSession,
} from "@/lib/auth/session"

// --- Constants, hard-coded --------------------------------------------------

/** Requirement 2.15 — the cookie's name, spelled out rather than imported. */
const COOKIE_NAME = "rpt_session"

/** Requirement 2.6 — 30 days in seconds. */
const THIRTY_DAYS_S = 2_592_000

/** Requirements 2.7 and 2.17 — 7 days in seconds. */
const SEVEN_DAYS_S = 604_800

/** The instant every test measures from. Nothing here reads the wall clock. */
const NOW = new Date("2026-08-01T03:07:30.000Z")

const USER_ID = "user-0001"
const USER_EMAIL = "consultant@example.com"
const SESSION_ROW_ID = "session-0001"

/** A token of the shape `createSession` mints: 43 base64url characters. */
const TOKEN = "Zm9yLXRoZS10ZXN0LXN1aXRlLW9ubHktbm90LXJlYWwtdg"

/**
 * `sha256(token)` as lowercase hex — Requirement 2.2's statement, restated here
 * rather than imported. The module's own hashing helper is not exported, and a
 * test that called it would be comparing the implementation against itself.
 */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function secondsFromNow(seconds: number): Date {
  return new Date(NOW.getTime() + seconds * 1000)
}

// --- The in-memory database ------------------------------------------------

/** Exactly the columns `readSession`'s join projects. */
interface SessionJoinRow {
  readonly sessionId: string
  readonly sessionTokenHash: string
  readonly absoluteExpiresAt: Date
  readonly idleExpiresAt: Date
  readonly userId: string
  readonly email: string
}

type OperationKind = "select" | "insert" | "update" | "delete"

interface Operation {
  readonly kind: OperationKind
  /** An `INSERT`'s values or an `UPDATE`'s `SET` clause, as handed to Drizzle. */
  payload?: Record<string, unknown>
}

interface SelectChain extends PromiseLike<readonly SessionJoinRow[]> {
  from(...args: readonly unknown[]): SelectChain
  innerJoin(...args: readonly unknown[]): SelectChain
  where(...args: readonly unknown[]): SelectChain
  limit(...args: readonly unknown[]): SelectChain
}

interface WriteChain extends PromiseLike<void> {
  values(payload: Record<string, unknown>): WriteChain
  set(payload: Record<string, unknown>): WriteChain
  where(...args: readonly unknown[]): WriteChain
}

/**
 * A recording stand-in for the Drizzle client.
 *
 * It records rather than simulates: no statement is interpreted, and the rows a
 * `select` resolves to are configured per test. That is deliberate — the
 * assertions in this file are about **which statements were issued**, and a fake
 * that tried to execute them would be a second, unverified query planner
 * standing between the test and its claim.
 */
class RecordingDb {
  readonly operations: Operation[] = []

  /** What the next `select` resolves to. `[]` is "the token matched no row". */
  rows: readonly SessionJoinRow[] = []

  /** Every `INSERT`, `UPDATE` and `DELETE`, in the order they were issued. */
  get writes(): readonly Operation[] {
    return this.operations.filter((operation) => operation.kind !== "select")
  }

  get selects(): readonly Operation[] {
    return this.operations.filter((operation) => operation.kind === "select")
  }

  select(): SelectChain {
    this.operations.push({ kind: "select" })
    return this.selectChain()
  }

  insert(): WriteChain {
    return this.writeChain({ kind: "insert" })
  }

  update(): WriteChain {
    return this.writeChain({ kind: "update" })
  }

  delete(): WriteChain {
    return this.writeChain({ kind: "delete" })
  }

  private selectChain(): SelectChain {
    const rows = () => this.rows
    const chain: SelectChain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: () => chain,
      then: (onfulfilled, onrejected) =>
        Promise.resolve(rows()).then(onfulfilled, onrejected),
    }
    return chain
  }

  private writeChain(operation: Operation): WriteChain {
    this.operations.push(operation)

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
        Promise.resolve(undefined).then(onfulfilled, onrejected),
    }
    return chain
  }
}

// --- The cookie store ------------------------------------------------------

interface CookieWrite {
  readonly name: string
  readonly value: string
  readonly httpOnly?: boolean
  readonly sameSite?: string
  readonly path?: string
  readonly maxAge?: number
  readonly secure?: boolean
}

interface CookieDelete {
  readonly name: string
  readonly path?: string
}

/**
 * A stand-in for the request's cookie store, recording every write.
 *
 * The recording is not incidental: Requirements 2.7 and 2.14 say a read writes
 * **no** cookie — a `readSession` called from a Server Component render would
 * throw in Next 16 if it tried — so "no cookie was written" has to be an
 * assertion, and a store that silently accepted a write could not make it.
 */
class FakeCookieStore {
  readonly writes: CookieWrite[] = []
  readonly deletes: CookieDelete[] = []

  constructor(private value: string | undefined = undefined) {}

  get(name: string): { name: string; value: string } | undefined {
    return this.value === undefined ? undefined : { name, value: this.value }
  }

  set(options: CookieWrite): void {
    this.writes.push(options)
    this.value = options.value
  }

  delete(options: CookieDelete): void {
    this.deletes.push(options)
    this.value = undefined
  }
}

// --- Wiring ---------------------------------------------------------------

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
 * A stored session row for {@link TOKEN}, valid at {@link NOW} unless an expiry
 * is overridden.
 */
function sessionRow(overrides: Partial<SessionJoinRow> = {}): SessionJoinRow {
  return {
    sessionId: SESSION_ROW_ID,
    sessionTokenHash: sha256Hex(TOKEN),
    absoluteExpiresAt: secondsFromNow(THIRTY_DAYS_S),
    idleExpiresAt: secondsFromNow(SEVEN_DAYS_S),
    userId: USER_ID,
    email: USER_EMAIL,
    ...overrides,
  }
}

beforeEach(() => {
  db = new RecordingDb()
  cookieStore = new FakeCookieStore()
  // The row's expiries and the instant they are compared against come from one
  // clock, which is what makes an "at the expiry instant" case assertable.
  vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

// --- createSession --------------------------------------------------------

describe("createSession — Requirements 2.6, 2.17", () => {
  test("the two lifetimes are 30 days and 7 days", () => {
    // Hard-coded, so the arithmetic below can be expressed in the exported
    // constants without the whole suite moving silently if one of them changes.
    expect(ABSOLUTE_TTL_S).toBe(THIRTY_DAYS_S)
    expect(IDLE_TTL_S).toBe(SEVEN_DAYS_S)
    expect(SESSION_COOKIE).toBe(COOKIE_NAME)
  })

  test("sets absolute_expires_at to the creation instant plus 30 days", async () => {
    await createSession(USER_ID)

    expect(db.writes).toHaveLength(1)
    const [insert] = db.writes
    expect(insert.kind).toBe("insert")
    expect(insert.payload?.absoluteExpiresAt).toEqual(
      new Date("2026-08-31T03:07:30.000Z")
    )
    expect(insert.payload?.absoluteExpiresAt).toEqual(
      secondsFromNow(THIRTY_DAYS_S)
    )
  })

  test("sets idle_expires_at to the creation instant plus 7 days", async () => {
    await createSession(USER_ID)

    const [insert] = db.writes
    expect(insert.payload?.idleExpiresAt).toEqual(
      new Date("2026-08-08T03:07:30.000Z")
    )
    expect(insert.payload?.idleExpiresAt).toEqual(secondsFromNow(SEVEN_DAYS_S))
  })

  test("both expiries are minted from one clock reading", async () => {
    // A second `Date.now()` for the idle expiry would put the two instants a
    // few milliseconds apart — invisible in production and invisible to a
    // tolerance-based assertion, so the difference between the two is asserted
    // exactly.
    await createSession(USER_ID)

    const [insert] = db.writes
    const absolute = insert.payload?.absoluteExpiresAt as Date
    const idle = insert.payload?.idleExpiresAt as Date

    expect(absolute.getTime() - idle.getTime()).toBe(
      (THIRTY_DAYS_S - SEVEN_DAYS_S) * 1000
    )
  })

  test("the inserted row is the one the cookie resolves to, and holds no token", async () => {
    // Without this, the two assertions above would hold over an `INSERT` that
    // was not a session at all. It is also Requirement 2.2 in passing: what is
    // stored is `sha256(token)`, and the token itself appears in no column.
    await createSession(USER_ID)

    const [insert] = db.writes
    const [cookie] = cookieStore.writes

    expect(cookie.name).toBe(SESSION_COOKIE)
    expect(insert.payload?.sessionTokenHash).toBe(sha256Hex(cookie.value))
    expect(Object.values(insert.payload ?? {})).not.toContain(cookie.value)
    // The cookie expires when the row does (Requirement 2.15).
    expect(cookie.maxAge).toBe(ABSOLUTE_TTL_S)
  })
})

// --- readSession, expiry --------------------------------------------------

describe("readSession expiry — Requirements 2.8, 2.9", () => {
  beforeEach(() => {
    cookieStore = new FakeCookieStore(TOKEN)
  })

  /** Each pair is one expiry column, exercised at the same three instants. */
  const COLUMNS = [
    { column: "absolute_expires_at", key: "absoluteExpiresAt" },
    { column: "idle_expires_at", key: "idleExpiresAt" },
  ] as const

  describe.each(COLUMNS)("$column", ({ key }) => {
    test("a row expiring exactly at the current instant is unauthenticated", async () => {
      // Requirements 2.8 and 2.9 are "at or after", not "after". The boundary
      // instant is the case that separates `>=` from `>`, and it is unreachable
      // without a clock the test controls.
      db.rows = [sessionRow({ [key]: new Date(NOW) })]

      expect(await readSession()).toBeNull()
    })

    test("a row expiring one millisecond ago is unauthenticated", async () => {
      db.rows = [sessionRow({ [key]: new Date(NOW.getTime() - 1) })]

      expect(await readSession()).toBeNull()
    })

    test("a row expiring one millisecond from now still authenticates", async () => {
      // The other side of the same boundary, so the pair pins the comparison
      // rather than merely agreeing with it. A `readSession` that rejected
      // everything would pass every assertion above and fail this one.
      db.rows = [sessionRow({ [key]: new Date(NOW.getTime() + 1) })]

      expect(await readSession()).toEqual({ id: USER_ID, email: USER_EMAIL })
    })

    test("an expired row is deleted and never rolled", async () => {
      // Requirement 2.10. The delete matters here mostly as evidence of which
      // branch ran: an `UPDATE` in this list would mean the idle window was
      // rolled on a session that had already expired.
      db.rows = [sessionRow({ [key]: new Date(NOW) })]

      await readSession()

      expect(db.writes.map((write) => write.kind)).toEqual(["delete"])
      expect(cookieStore.writes).toHaveLength(0)
    })
  })

  test("a row expired on both counts is unauthenticated", async () => {
    db.rows = [
      sessionRow({
        absoluteExpiresAt: new Date(NOW.getTime() - 1),
        idleExpiresAt: new Date(NOW.getTime() - 1),
      }),
    ]

    expect(await readSession()).toBeNull()
    expect(db.writes.map((write) => write.kind)).toEqual(["delete"])
  })
})

// --- readSession, the idle roll ------------------------------------------

describe("readSession's idle roll — Requirement 2.7", () => {
  beforeEach(() => {
    cookieStore = new FakeCookieStore(TOKEN)
  })

  test("rolls idle_expires_at to the read instant plus 7 days", async () => {
    db.rows = [sessionRow({ idleExpiresAt: secondsFromNow(60) })]

    expect(await readSession()).toEqual({ id: USER_ID, email: USER_EMAIL })

    expect(db.writes).toHaveLength(1)
    const [update] = db.writes
    expect(update.kind).toBe("update")
    expect(update.payload?.idleExpiresAt).toEqual(secondsFromNow(SEVEN_DAYS_S))
    expect(update.payload?.idleExpiresAt).toEqual(
      new Date("2026-08-08T03:07:30.000Z")
    )
  })

  test("leaves absolute_expires_at out of the SET clause entirely", async () => {
    // The strongest available form of "unchanged": the statement does not name
    // the column, so the stored value is byte-identical because nothing wrote
    // it. Comparing the value before and after would also pass for an
    // implementation that re-wrote the same instant back — and one that re-writes
    // it is one clock reading away from extending a 30-day session forever,
    // which is the whole point of having an absolute expiry.
    const absoluteExpiresAt = secondsFromNow(THIRTY_DAYS_S)
    db.rows = [sessionRow({ absoluteExpiresAt })]

    await readSession()

    const [update] = db.writes
    expect(Object.keys(update.payload ?? {})).toEqual(["idleExpiresAt"])
    expect(update.payload).not.toHaveProperty("absoluteExpiresAt")
    expect(update.payload).not.toHaveProperty("absolute_expires_at")
  })

  test("writes no cookie", async () => {
    // Requirements 2.7 and 2.14. `readSession` is called from the `(app)`
    // layout's guard, and Next 16 rejects a cookie write during a Server
    // Component render — so a cookie write here is not merely unnecessary, it
    // is a crash on the authenticated shell's happy path.
    db.rows = [sessionRow()]

    await readSession()

    expect(cookieStore.writes).toHaveLength(0)
    expect(cookieStore.deletes).toHaveLength(0)
  })

  test("issues exactly one read and one write per authenticated request", async () => {
    // The cost of idle expiry being real rather than decorative, stated so a
    // second query added to this path is a decision rather than a drift.
    db.rows = [sessionRow()]

    await readSession()

    expect(db.operations.map((operation) => operation.kind)).toEqual([
      "select",
      "update",
    ])
  })
})

// --- readSession, the no-write invariant ---------------------------------

describe("readSession writes nothing when it resolves nothing — Requirement 2.18", () => {
  test("a request with no cookie performs no database write", async () => {
    cookieStore = new FakeCookieStore(undefined)

    expect(await readSession()).toBeNull()

    expect(db.writes).toEqual([])
    // Stronger than the requirement, and worth pinning: with no token there is
    // nothing to look up either, so the request costs no query at all.
    expect(db.operations).toEqual([])
    expect(cookieStore.writes).toHaveLength(0)
    expect(cookieStore.deletes).toHaveLength(0)
  })

  test("a cleared cookie arriving as an empty value performs no database write", async () => {
    // `rpt_session=` is what a cleared cookie looks like on the wire. Treated as
    // present it would hash the empty string and probe the table for it.
    cookieStore = new FakeCookieStore("")

    expect(await readSession()).toBeNull()

    expect(db.operations).toEqual([])
  })

  test("a token matching no row performs no database write", async () => {
    cookieStore = new FakeCookieStore(TOKEN)
    db.rows = []

    expect(await readSession()).toBeNull()

    // One `SELECT` — the lookup that found nothing — and nothing else.
    expect(db.selects).toHaveLength(1)
    expect(db.writes).toEqual([])
    expect(cookieStore.writes).toHaveLength(0)
    expect(cookieStore.deletes).toHaveLength(0)
  })

  test("a row failing the constant-time compare performs no database write", async () => {
    // A row found by hash equality whose stored digest does not match the
    // presented one is an unmatched row for Requirement 2.18's purposes: it
    // resolves the request unauthenticated, so it must not write either. A
    // valid-length digest, so the rejection comes from the comparison rather
    // than from the length guard.
    cookieStore = new FakeCookieStore(TOKEN)
    db.rows = [sessionRow({ sessionTokenHash: sha256Hex("a different token") })]

    expect(await readSession()).toBeNull()

    expect(db.selects).toHaveLength(1)
    expect(db.writes).toEqual([])
  })

  test("a malformed stored digest performs no database write", async () => {
    // A truncated `session_token_hash` reaches the comparison as a short buffer,
    // where `timingSafeEqual` throws rather than returning false. It has to
    // resolve unauthenticated — and, still, write nothing.
    cookieStore = new FakeCookieStore(TOKEN)
    db.rows = [sessionRow({ sessionTokenHash: sha256Hex(TOKEN).slice(0, 32) })]

    expect(await readSession()).toBeNull()

    expect(db.writes).toEqual([])
  })

  test("the no-write paths are not vacuous — a valid row does write", async () => {
    // Non-vacuity for all five cases above: a `readSession` that never wrote
    // anything would satisfy every one of them.
    cookieStore = new FakeCookieStore(TOKEN)
    db.rows = [sessionRow()]

    expect(await readSession()).not.toBeNull()
    expect(db.writes).toHaveLength(1)
  })
})
