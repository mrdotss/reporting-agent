import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * `/` — the signpost (Requirement 7.6).
 *
 * The product has no public landing page in this spec: a visitor either has a
 * session and belongs in the shell, or does not and belongs on `/login`. So this
 * route resolves the session once and forwards, and both destinations are
 * assertable from one seam — `readSession`.
 *
 * The route uses `readSession` rather than `requireSession` on purpose, and the
 * two tests below are what pin that decision. `requireSession()` would also send
 * an unauthenticated visitor to `/login`, but it builds that URL from a
 * `returnTo`, and the only target available here is `/` — which would send the
 * visitor straight back to this redirect after signing in. Asserting that the
 * unauthenticated case names a bare `/login`, with no query string, is what makes
 * that loop a test failure rather than a puzzle.
 */

const { redirectSpy } = vi.hoisted(() => ({
  redirectSpy: vi.fn<(target: string) => void>(),
}))

vi.mock("next/navigation", async () => {
  const { RedirectSignal } = await import("@/test/next-doubles")

  return {
    redirect: (target: string): never => {
      redirectSpy(target)
      throw new RedirectSignal(target)
    },
  }
})

vi.mock("@/lib/auth/session", () => ({
  readSession: () => Promise.resolve(currentSession()),
}))

import RootPage from "./page"
import { RedirectSignal, redirectTarget } from "@/test/next-doubles"

type Session = { id: string; email: string } | null

const SIGNED_IN: Session = {
  id: "user-0001",
  email: "consultant@example.com",
}

let session: Session

/** A hoisted function declaration, read by the mock factory at call time. */
function currentSession(): Session {
  return session
}

beforeEach(() => {
  session = null
  redirectSpy.mockClear()
})

describe("Requirement 7.6 — the root route forwards", () => {
  test("no session redirects to /login, with no return target", async () => {
    expect(await redirectTarget(RootPage())).toBe("/login")

    expect(redirectSpy).toHaveBeenCalledTimes(1)
    // A bare path. A `?returnTo=/` here would land the visitor back on this
    // redirect after signing in.
    expect(redirectSpy).toHaveBeenCalledWith("/login")
  })

  test("a session redirects to the dashboard", async () => {
    session = SIGNED_IN

    expect(await redirectTarget(RootPage())).toBe("/dashboard")

    expect(redirectSpy).toHaveBeenCalledTimes(1)
    expect(redirectSpy).toHaveBeenCalledWith("/dashboard")
  })

  test("the route never returns a page", async () => {
    // Its declared return type is `Promise<never>`: there is nothing to render on
    // either branch, so a return would be a blank page rather than a signpost.
    session = SIGNED_IN

    await expect(RootPage()).rejects.toBeInstanceOf(RedirectSignal)

    session = null

    await expect(RootPage()).rejects.toBeInstanceOf(RedirectSignal)
  })
})
