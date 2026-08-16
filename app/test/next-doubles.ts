/**
 * Test doubles for the two request-scoped Next.js APIs the authentication path
 * reaches: `redirect` from `next/navigation` and the cookie store from
 * `next/headers`.
 *
 * Both live here rather than in each suite because the *same* two doubles are
 * needed by three different kinds of test — the server-action unit suite, the
 * Postgres integration suite, and the jsdom page suites — and the properties
 * being asserted are properties of what the action *did* with them. A double
 * that silently accepted a cookie write, or that let `redirect` return, could
 * not make those assertions at all.
 *
 * This module is not a test file (`vitest.config.ts` collects `test/**\/*.test.ts`),
 * so it is imported rather than collected.
 */

// --- redirect ---------------------------------------------------------------

/**
 * A stand-in for the error `next/navigation`'s `redirect` throws.
 *
 * **`redirect` signals by throwing**, and that is not an implementation detail a
 * test may paper over: `registerAction` and `loginAction` are written so the
 * `redirect` call sits outside every `try` block precisely because a `catch` in
 * its path would swallow the navigation and return a rejection for a submission
 * that actually succeeded. A double whose `redirect` merely returned would let
 * that regression pass.
 *
 * The real error carries a `digest` of the form
 * `NEXT_REDIRECT;<mode>;<url>;<status>;`, and Next identifies a redirect by that
 * string rather than by the error's class. It is reproduced here so a suite can
 * assert against the digest as well as against {@link target}.
 */
export class RedirectSignal extends Error {
  /** The exact argument the action passed to `redirect`. */
  readonly target: string

  /** The shape Next's own redirect detection matches on. */
  readonly digest: string

  constructor(target: string) {
    super(`NEXT_REDIRECT to ${target}`)
    this.name = "RedirectSignal"
    this.target = target
    this.digest = `NEXT_REDIRECT;replace;${target};307;`
  }
}

/** The double itself: `vi.mock("next/navigation", () => ({ redirect }))`. */
export function redirect(target: string): never {
  throw new RedirectSignal(target)
}

/**
 * Await a call that is expected to redirect, and return the target it named.
 *
 * Throws a *descriptive* failure when the call returned instead — an action that
 * returned a rejection where a redirect was expected is the interesting failure,
 * and `rejects.toBeInstanceOf(...)` would report it as "promise resolved"
 * without saying what it resolved to.
 *
 * A thrown value that is not a {@link RedirectSignal} is re-thrown untouched, so
 * a genuine bug does not arrive disguised as a missing redirect.
 */
export async function redirectTarget(call: Promise<unknown>): Promise<string> {
  let returned: unknown

  try {
    returned = await call
  } catch (thrown) {
    if (thrown instanceof RedirectSignal) return thrown.target
    throw thrown
  }

  throw new Error(
    `Expected a redirect. The call returned ${JSON.stringify(returned)} instead.`
  )
}

// --- the cookie store -------------------------------------------------------

/** The options `cookies().set(...)` is called with, as recorded. */
export interface CookieWrite {
  readonly name: string
  readonly value: string
  readonly httpOnly?: boolean
  readonly sameSite?: string
  readonly path?: string
  readonly maxAge?: number
  readonly secure?: boolean
}

/** The options `cookies().delete(...)` is called with, as recorded. */
export interface CookieDelete {
  readonly name: string
  readonly path?: string
}

/**
 * A stand-in for the request's cookie store that **records** every write and
 * every delete.
 *
 * The recording is the point. "Sign-out clears the cookie" (Req 2.12) and "a
 * read writes no cookie" (Req 2.7, 2.14) are both claims about what was *done*
 * to the store, not about what it ended up holding — and Next 16 throws on a
 * cookie write during a Server Component render, so a spurious write is a crash
 * on the authenticated shell's happy path rather than a harmless extra.
 *
 * It also behaves like a real store: a `set` becomes readable by `get`, and a
 * `delete` makes `get` return nothing. That is what lets one suite mint a
 * session through the production path and then present it back, the way a
 * browser would.
 */
export class FakeCookieStore {
  readonly writes: CookieWrite[] = []
  readonly deletes: CookieDelete[] = []

  private value: string | undefined

  constructor(initialValue?: string) {
    this.value = initialValue
  }

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
