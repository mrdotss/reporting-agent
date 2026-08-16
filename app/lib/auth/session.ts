import "server-only"

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"

import { eq } from "drizzle-orm"
import { cookies } from "next/headers"

import { type Database, getDb } from "@/lib/db"
import { sessions, users } from "@/lib/db/schema"

/**
 * Database-backed sessions (Requirement 2).
 *
 * A session is a **row**, not a signed blob, which is what makes sign-out and
 * expiry real rather than advisory: the cookie carries an opaque random token
 * and every authenticated request resolves it against `sessions`. Delete the
 * row and the cookie stops working on the next request, wherever it is held.
 * Nothing here is signed, so there is no `AUTH_SECRET` and no Auth.js.
 *
 * Two properties are worth stating up front because the code is arranged
 * around them rather than merely satisfying them:
 *
 * **The token is never stored.** Only `sha256(token)` hex reaches
 * `sessions.session_token_hash` (Req 2.2), so a database disclosure yields no
 * usable cookie value. The token exists in exactly two places: the browser's
 * cookie jar, and the local variable {@link createSession} minted it in.
 *
 * **A read that resolves nothing writes nothing.** No cookie, or a token
 * matching no row, returns `null` having issued no `INSERT`, `UPDATE` or
 * `DELETE` (Req 2.18). Every write in {@link readSession} lives in a helper
 * called *after* both of those early returns, so the invariant is visible in
 * the control flow instead of resting on a reviewer tracing branches.
 */

// --- The cookie -------------------------------------------------------------

/** Requirement 2.15. */
export const SESSION_COOKIE = "rpt_session"

/**
 * Absolute session lifetime, in seconds — 30 days (Req 2.6).
 *
 * Also the cookie's `maxAge` (Req 2.15), so the browser discards the cookie at
 * the same instant the row stops being accepted. The two are the same number
 * because a cookie outliving its row is a request that authenticates against
 * nothing, and a row outliving its cookie is a row nothing can present.
 */
export const ABSOLUTE_TTL_S = 30 * 24 * 3600

/** Idle window, in seconds — 7 days, rolled on every valid read (Req 2.7, 2.17). */
export const IDLE_TTL_S = 7 * 24 * 3600

/**
 * Set on the cookie explicitly even though `/` is `cookies().set`'s default,
 * because {@link destroySession} has to name the **same** path to clear it: a
 * `delete` whose path does not match the `set` leaves the cookie in place.
 * Naming it once is what keeps the pair in agreement.
 */
const COOKIE_PATH = "/"

// --- The token --------------------------------------------------------------

/** Requirement 2.1 — 32 bytes from `crypto.randomBytes`. */
const TOKEN_BYTES = 32

/**
 * SHA-256 is 32 bytes, i.e. 64 hex characters. The constant is the length
 * {@link digestsMatch} requires of both buffers before it compares them —
 * `timingSafeEqual` throws on a length mismatch rather than returning false.
 */
const DIGEST_BYTES = 32

/** The signed-in user, as every guarded surface needs them. */
export type AuthUser = { id: string; email: string }

/**
 * A handle a `DELETE` can be issued through.
 *
 * `Pick` rather than `Database`, because {@link revokeAllSessionsForUser} runs
 * **inside** the password-change transaction (Req 1.9, 1.13) and therefore has
 * to accept Drizzle's transaction handle as readily as the pooled client. Both
 * derive `delete` from the same `PgDatabase` instantiation, so one structural
 * type covers both without a union — and a union of two generic `delete`
 * signatures is precisely the shape TypeScript refuses to call.
 *
 * Narrow on purpose: a revoke needs one capability, and a parameter that could
 * also `insert` or `transaction` invites a caller to do more inside it.
 */
export type SessionWriter = Pick<Database, "delete">

// --- Token hashing ----------------------------------------------------------

/**
 * `sha256(token)` as lowercase hex — the only form of the token that is ever
 * persisted (Req 2.2).
 *
 * The hash is over the 43-character base64url **string** the cookie carries,
 * not over the 32 decoded bytes, so the value hashed here is exactly the value
 * a request presents. No re-decoding step means no way for the two sides to
 * disagree about encoding.
 */
function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

/**
 * Constant-time comparison of two hex digests (Req 2.5).
 *
 * The SQL index does the *finding*; this does the *deciding*. Comparing the
 * stored hash to the recomputed one with `timingSafeEqual` over the decoded
 * digests keeps the accept/reject decision free of the early-exit timing that
 * `===` on strings has.
 *
 * The length guard is required, not defensive: `timingSafeEqual` throws when
 * the buffers differ in length, and `Buffer.from(value, "hex")` silently stops
 * at the first non-hex character — so a truncated or malformed stored hash
 * arrives here as a short buffer and must resolve to `false` rather than an
 * exception.
 */
function digestsMatch(storedHex: string, presentedHex: string): boolean {
  const stored = Buffer.from(storedHex, "hex")
  const presented = Buffer.from(presentedHex, "hex")

  if (stored.length !== DIGEST_BYTES) return false
  if (presented.length !== DIGEST_BYTES) return false

  return timingSafeEqual(stored, presented)
}

// --- Cookie access ----------------------------------------------------------

/**
 * The presented token, or `undefined` when the request carries none.
 *
 * `await cookies()` because Next 16 removed synchronous access entirely — the
 * synchronous form is not deprecated here, it is gone.
 *
 * An empty value is treated as absent: a cleared cookie can still arrive as
 * `rpt_session=`, and it must take the no-write path (Req 2.18) rather than
 * hash the empty string and probe the table for it.
 */
async function readSessionCookie(): Promise<string | undefined> {
  const store = await cookies()
  const value = store.get(SESSION_COOKIE)?.value

  return value === undefined || value.length === 0 ? undefined : value
}

/**
 * Requirements 2.3, 2.4, 2.15.
 *
 * `secure` is read from `process.env.NODE_ENV` **at call time** so local HTTP
 * development works while every deployed environment gets the flag — the same
 * call-time resolution rule `lib/env.ts` follows, and the reason a test can
 * exercise both sides of it.
 */
function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: COOKIE_PATH,
    maxAge: ABSOLUTE_TTL_S,
    secure: process.env.NODE_ENV === "production",
  }
}

// --- Writes -----------------------------------------------------------------

/**
 * Roll the idle window to `now + 7d`, leaving `absolute_expires_at` untouched
 * (Req 2.7).
 *
 * **A database write with no cookie write**, which is both what Req 2.7 and
 * 2.14 demand and the only thing Next 16 permits: cookies cannot be set during
 * a Server Component render, and `readSession` is called from exactly there by
 * the `(app)` layout's guard. The requirement and the framework agree.
 *
 * One `UPDATE ... WHERE id = $1` per authenticated request is the price of idle
 * expiry being real rather than decorative.
 *
 * A failure here is **not** swallowed. Req 2.11 licenses swallowing exactly one
 * failure — the expired-row delete, where the request is already resolving
 * unauthenticated — and this is not it. The `SELECT` immediately before this
 * write propagates its own failures too, so masking this one would make a
 * degraded database look like a working one that has stopped expiring sessions.
 */
async function rollIdleExpiry(sessionId: string, now: Date): Promise<void> {
  await getDb()
    .update(sessions)
    .set({ idleExpiresAt: new Date(now.getTime() + IDLE_TTL_S * 1000) })
    .where(eq(sessions.id, sessionId))
}

/**
 * Delete an expired row, best effort (Req 2.10, 2.11).
 *
 * The caller has already decided the request is unauthenticated, so a failed
 * delete changes nothing it can act on: the row stays, and the next request
 * carrying that token reaches the same expiry check and the same outcome. Logged
 * rather than raised, and the log carries the driver error only — never the
 * token, which is why this takes a row id.
 */
async function deleteExpiredSession(sessionId: string): Promise<void> {
  try {
    await getDb().delete(sessions).where(eq(sessions.id, sessionId))
  } catch (error) {
    console.error("[auth] an expired session row was not deleted", error)
  }
}

// --- Public API -------------------------------------------------------------

/**
 * Mint a session for `userId`: one row, one cookie.
 *
 * The token is 32 random bytes as base64url — 43 characters over the base64url
 * alphabet, unpadded (Req 2.1, 2.16). `absolute_expires_at` is the creation
 * instant plus 30 days and `idle_expires_at` the creation instant plus 7 days
 * (Req 2.6, 2.17), both from one `now` so they cannot be minted against two
 * different clock readings.
 *
 * The row is written **before** the cookie. A cookie whose row failed to insert
 * is a token that can never authenticate — a signed-in user who is not; a row
 * whose cookie was never sent is inert and expires on its own. Only one of those
 * two failures is invisible to the user, so the write order removes it.
 *
 * Sets a cookie, so this may only be called from a Server Action or a Route
 * Handler. Next 16 rejects a cookie write during a Server Component render, and
 * so does Req 2.14.
 */
export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url")
  const createdAt = Date.now()

  await getDb()
    .insert(sessions)
    .values({
      // Random and unrelated to the token: an id derived from the token would
      // put a token-equivalent value in a column that is not treated as one.
      id: randomUUID(),
      userId,
      sessionTokenHash: hashSessionToken(token),
      absoluteExpiresAt: new Date(createdAt + ABSOLUTE_TTL_S * 1000),
      idleExpiresAt: new Date(createdAt + IDLE_TTL_S * 1000),
    })

  const store = await cookies()
  store.set({ name: SESSION_COOKIE, value: token, ...sessionCookieOptions() })
}

/**
 * Resolve the request's session, or `null` for an unauthenticated one.
 *
 * The order of the steps is the requirement set, read top to bottom:
 *
 *  1. no cookie → `null`, **no query and no write** (Req 2.18);
 *  2. no row for the presented hash → `null`, **no write** (Req 2.18);
 *  3. the stored hash fails the constant-time compare → `null` (Req 2.5);
 *  4. at or after either expiry → best-effort delete, `null` (Req 2.8–2.11);
 *  5. otherwise roll the idle window and return the user (Req 2.7).
 *
 * Expiry is **at or after**, not after: a row whose `idle_expires_at` equals the
 * current instant is expired. The comparison uses one `now` for both bounds and
 * for the rolled value, so a slow request cannot pass the idle check against one
 * reading and be renewed against a later one.
 *
 * Writes no cookie on any path (Req 2.7, 2.14) — see {@link rollIdleExpiry}.
 */
export async function readSession(): Promise<AuthUser | null> {
  const token = await readSessionCookie()
  if (token === undefined) return null

  const presentedHash = hashSessionToken(token)

  const [row] = await getDb()
    .select({
      sessionId: sessions.id,
      sessionTokenHash: sessions.sessionTokenHash,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
      idleExpiresAt: sessions.idleExpiresAt,
      userId: users.id,
      email: users.email,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.sessionTokenHash, presentedHash))
    .limit(1)

  if (row === undefined) return null
  if (!digestsMatch(row.sessionTokenHash, presentedHash)) return null

  const now = new Date()
  const expired =
    now.getTime() >= row.absoluteExpiresAt.getTime() ||
    now.getTime() >= row.idleExpiresAt.getTime()

  if (expired) {
    await deleteExpiredSession(row.sessionId)
    return null
  }

  await rollIdleExpiry(row.sessionId, now)

  return { id: row.userId, email: row.email }
}

/**
 * Sign out: delete the presented row, then clear the cookie (Req 2.12).
 *
 * With no cookie present this returns without raising and without touching the
 * database (Req 2.13) — signing out of a session that is not there is a no-op,
 * not an error, and it is a perfectly ordinary request from a stale tab.
 *
 * The row goes first and a failure propagates. Clearing the cookie on a failed
 * delete would show the user a completed sign-out while the token still
 * authenticates from anywhere else it is held, which is the one outcome this
 * whole module exists to prevent.
 *
 * Both the read and the clear go through one cookie store — the same object
 * `await cookies()` returns for the rest of the request.
 */
export async function destroySession(): Promise<void> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (token === undefined || token.length === 0) return

  await getDb()
    .delete(sessions)
    .where(eq(sessions.sessionTokenHash, hashSessionToken(token)))

  // The same name **and path** the cookie was set with; a mismatched path
  // clears nothing.
  store.delete({ name: SESSION_COOKIE, path: COOKIE_PATH })
}

/**
 * Delete every session row for one user (Req 1.9).
 *
 * `writer` is required rather than defaulted, because the caller that needs
 * this is `changePasswordAction`: the new hash and this delete land in **one
 * transaction** (Req 1.13), so a failed change retains both the previous hash
 * and every previous row. A default would let that call site accidentally
 * revoke outside the transaction and still typecheck.
 *
 * Clears no cookie: the writer may be a transaction on a request that has no
 * cookie to clear, and the sessions being revoked are mostly other browsers'.
 * The row is the authority — the next request from any of them resolves
 * unauthenticated because {@link readSession} finds nothing.
 */
export async function revokeAllSessionsForUser(
  userId: string,
  writer: SessionWriter
): Promise<void> {
  await writer.delete(sessions).where(eq(sessions.userId, userId))
}
