import "server-only"

import { redirect } from "next/navigation"

import { type AuthUser, readSession } from "@/lib/auth/session"
import { DEFAULT_RETURN_TO, safeReturnTo } from "@/lib/validation/return-to"

/**
 * The route guard (Requirement 7.6).
 *
 * **There is no `proxy.ts` and no `middleware.ts` in this app, on purpose.**
 * Next 16 deprecated `middleware` and renamed it `proxy`, and the authentication
 * guide's own advice is that a proxy check is an *optimistic* one: it sees a
 * cookie, not a session. This app's sessions are database rows — expiry is a
 * column and sign-out is a `DELETE` — so a cookie's presence proves nothing a
 * guard can act on. A revoked session would still look signed in to a
 * cookie-peeking proxy, which is the exact failure the row-backed design exists
 * to prevent.
 *
 * So the guard is an **authoritative check where the data is used**: the `(app)`
 * layout calls {@link requireSession} on every authenticated render, and each
 * route handler calls {@link requireSessionForApi}. Both resolve the session
 * against Postgres. `proxy` additionally runs on every request including
 * prefetches, so putting a database read there would multiply the cost of the
 * one check that has to be right.
 *
 * Neither function writes a cookie. `readSession` rolls the idle window with a
 * database write and nothing else, which is both what Requirements 2.7 and 2.14
 * demand and the only thing Next 16 permits during a Server Component render.
 */

/** Where an unauthenticated request to the authenticated shell lands (Req 7.6). */
export const LOGIN_PATH = "/login"

/**
 * The query parameter carrying the post-login return target.
 *
 * Exported so the login page reads the same key this module writes. Two string
 * literals in two files is how a deep link silently stops surviving sign-in:
 * nothing breaks, the visitor just always lands on the dashboard.
 */
export const RETURN_TO_PARAM = "returnTo"

/**
 * `/login`, carrying a sanitized return target when there is one worth carrying.
 *
 * The parameter is omitted when the sanitized target is already
 * {@link DEFAULT_RETURN_TO} — an absent, off-origin or malformed target and no
 * target at all produce the same clean `/login`, so the URL never advertises
 * that something was rejected, and the login page's own fallback covers the
 * absent case anyway (Requirement 7.9).
 *
 * `URLSearchParams` does the encoding. A hand-built query string is where a
 * target containing `&` or `#` turns into two parameters.
 */
function loginPathFor(returnTo: string | undefined): string {
  const target = safeReturnTo(returnTo)
  if (target === DEFAULT_RETURN_TO) return LOGIN_PATH

  const query = new URLSearchParams({ [RETURN_TO_PARAM]: target })

  return `${LOGIN_PATH}?${query.toString()}`
}

/**
 * Resolve the signed-in user, or redirect to the login page (Requirement 7.6).
 *
 * For a rendered surface: the `(app)` layout and any server component or server
 * action that must not proceed without a user. The return type is `AuthUser`
 * rather than `AuthUser | null` because `redirect` throws — every caller gets a
 * user or never resumes, so there is no unauthenticated branch to forget.
 *
 * `returnTo` passes through {@link safeReturnTo}, so a target this app did not
 * mint cannot turn its own login page into an open redirect (Requirement 7.9).
 * It is sanitized **here**, at the point the URL is built, rather than trusted
 * to have been sanitized by whoever supplied it.
 *
 * Called outside any `try`/`catch` block: `redirect` signals through a thrown
 * `NEXT_REDIRECT` error, and a `catch` around it swallows the redirect and
 * renders the guarded surface to an unauthenticated visitor.
 */
export async function requireSession(returnTo?: string): Promise<AuthUser> {
  const user = await readSession()
  if (user !== null) return user

  redirect(loginPathFor(returnTo))
}

/**
 * Resolve the signed-in user, or `null` (Requirement 7.6).
 *
 * For a route handler, which must answer with a **status code**, not a
 * redirect: a `fetch` following a 307 to `/login` receives that page's HTML with
 * a 200, so a caller expecting JSON sees a parse error instead of "not signed
 * in". The handler decides between `401` and — where even confirming that a
 * resource exists would disclose something — `404`.
 *
 * Thin by design. It exists so every handler names one guard rather than
 * reaching for `readSession` directly, which keeps the authoritative check and
 * its 401 in one place instead of thirteen route files.
 */
export async function requireSessionForApi(): Promise<AuthUser | null> {
  return await readSession()
}
