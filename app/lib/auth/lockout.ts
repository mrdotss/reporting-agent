import "server-only"

import { randomUUID } from "node:crypto"
import { and, desc, eq, gte, lte } from "drizzle-orm"

import { getDb } from "@/lib/db"
import { loginAttempts } from "@/lib/db/schema"

/**
 * Login lockout (Requirement 3).
 *
 * Lockout is **derived, never stored**: there is no lock row and no lock column
 * (Requirement 3.4). The whole state is one predicate over the timestamps of
 * recent failures, which has two consequences worth being explicit about:
 *
 *   * an email unlocks itself 15 minutes after its most recent qualifying
 *     failure, with nothing to clear and nothing to expire — a stored lock
 *     would need something to run at the moment it lapses, and nothing runs at
 *     that moment;
 *   * the behaviour is testable without a database, because the decision lives
 *     in {@link isLockedOutFromFailures} rather than in a query.
 *
 * The two halves of this module are deliberately unequal: the predicate is pure
 * and total, and the two async functions are thin — one insert, one indexed
 * read — so there is only one place where "locked out" is defined.
 */

/** Failures inside the window at which an email is locked out (Req 3.2). */
export const FAILED_THRESHOLD = 5

/** The length of the trailing window, in minutes (Req 3.2, 3.4). */
export const WINDOW_MINUTES = 15

const MS_PER_MINUTE = 60_000

/**
 * The inclusive lower bound of the trailing window.
 *
 * One function, used by both the predicate and the query below, so the window
 * cannot be 15 minutes in the decision and something else in the SQL that
 * feeds it. Pure.
 */
function windowStart(now: Date): Date {
  return new Date(now.getTime() - WINDOW_MINUTES * MS_PER_MINUTE)
}

/**
 * Whether these failure timestamps lock the email out at `now` — the single
 * definition of lockout state (Requirements 3.2, 3.4, 3.5).
 *
 * **Pure.** No clock read, no database access, no I/O of any kind: the caller
 * supplies both the failures and the instant, which is what makes the
 * "locked for 15 minutes" behaviour directly assertable at its edges.
 *
 * The window is inclusive at **both** bounds — `now - 15min <= t <= now` — so a
 * failure exactly 15 minutes old still counts, and one dated after `now` (clock
 * skew between two app instances) does not. Order is irrelevant: this is a
 * count over a filter, not a scan of a sorted list.
 *
 * `failures` carries **failed** attempts only. Successes are excluded upstream,
 * in the caller's query, because lockout counts failures and nothing else
 * (Requirement 3.4).
 *
 * An invalid `Date` compares false against both bounds and is therefore
 * ignored rather than counted.
 */
export function isLockedOutFromFailures(
  failures: readonly Date[],
  now: Date
): boolean {
  const lower = windowStart(now).getTime()
  const upper = now.getTime()

  let inWindow = 0
  for (const failure of failures) {
    const at = failure.getTime()

    /**
     * Stated positively, and that matters: an invalid `Date` is `NaN`, and
     * `NaN` is neither below `lower` nor above `upper`, so the negated form
     * `at < lower || at > upper` would *count* it.
     */
    const withinWindow = at >= lower && at <= upper
    if (!withinWindow) continue

    inWindow += 1
    if (inWindow >= FAILED_THRESHOLD) return true
  }

  return false
}

/**
 * Record one completed login attempt (Requirements 3.1, 3.7).
 *
 * Every completed attempt is written, **including one this module itself
 * rejected** as locked out (Requirement 3.7). That is what makes the window
 * measure from the most recent attempt rather than from the most recent
 * attempt that reached password verification: hammering a locked email keeps it
 * locked, instead of quietly aging out while the attacker keeps trying.
 *
 * `created_at` is written from the app clock rather than left to the column's
 * `now()` default. The stored timestamps and the `now` they are compared
 * against in {@link isLockedOut} then come from **one** clock; mixing the
 * database's clock into the stored side and the caller's into the comparison
 * makes the window slightly wrong in whichever direction the two have drifted,
 * and the direction that matters is the one that hands back attempts.
 *
 * A write failure **propagates**. It is not swallowed: an attempt that cannot
 * be counted is an attempt that does not count, and the caller
 * (`lib/actions/auth.ts`) is where the decision about a failing database on the
 * sign-in path belongs.
 */
export async function recordLoginAttempt(
  emailNormalized: string,
  success: boolean
): Promise<void> {
  await getDb().insert(loginAttempts).values({
    id: randomUUID(),
    emailNormalized,
    success,
    createdAt: new Date(),
  })
}

/**
 * Whether this normalized email is locked out at `now` (Requirements 3.2, 3.8).
 *
 * The query narrows; {@link isLockedOutFromFailures} decides. Both bounds are
 * applied in SQL from the same {@link windowStart} the predicate uses, which is
 * what makes `limit(FAILED_THRESHOLD)` safe: when at least `FAILED_THRESHOLD`
 * in-window failures exist, the newest `FAILED_THRESHOLD` of them are all
 * in-window, so a bounded read can never under-count into a false negative. It
 * walks `login_attempts (email_normalized, created_at DESC)` newest-first and
 * stops, rather than reading an email's whole history to count five rows.
 *
 * **Fails closed** (Requirement 3.8): an unreadable `login_attempts` resolves
 * as locked out, so the caller rejects the sign-in without invoking password
 * verification. A read failure is the one case where the safe answer and the
 * true answer may differ, and treating an unreadable counter as "not locked"
 * would turn a database problem into an unthrottled password oracle.
 *
 * The failure is logged with no password and no secret in it — neither is a
 * parameter of this query, and the only value bound to it is the normalized
 * email, which is not written to the log line.
 */
export async function isLockedOut(
  emailNormalized: string,
  now: Date
): Promise<boolean> {
  let failures: readonly Date[]

  try {
    const rows = await getDb()
      .select({ createdAt: loginAttempts.createdAt })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.emailNormalized, emailNormalized),
          eq(loginAttempts.success, false),
          gte(loginAttempts.createdAt, windowStart(now)),
          lte(loginAttempts.createdAt, now)
        )
      )
      .orderBy(desc(loginAttempts.createdAt))
      .limit(FAILED_THRESHOLD)

    failures = rows.map((row) => row.createdAt)
  } catch (error) {
    console.error(
      "[auth] login_attempts is unreadable; failing closed as locked out",
      error
    )
    return true
  }

  return isLockedOutFromFailures(failures, now)
}
