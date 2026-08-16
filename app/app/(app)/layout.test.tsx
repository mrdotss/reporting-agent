import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

/**
 * The authenticated shell's route guard (Requirement 7.6).
 *
 * ## The guard is asserted at the layout, because the layout *is* the guard
 *
 * There is no `proxy.ts` and no `middleware.ts` in this app, on purpose: Next 16
 * renamed `middleware` to `proxy`, and a proxy check sees a **cookie** rather than
 * a session. Sessions here are database rows — expiry is a column and sign-out is
 * a `DELETE` — so a revoked session still presents a cookie and a cookie-peeking
 * guard would let it through. The authoritative check therefore lives in
 * `app/(app)/layout.tsx`, which every authenticated render passes through, and
 * that is the unit this file exercises.
 *
 * `readSession` is the seam. It is the one thing between the layout and Postgres,
 * so doubling it resolves the request as unauthenticated without needing a
 * database — everything else on the path is real: the guard, its `safeReturnTo`
 * sanitizing, the URL it builds, and the shell it renders on the other side.
 *
 * ## `redirect` throws, and both halves of that matter
 *
 * The double re-creates that: it records the target *and* throws a
 * `NEXT_REDIRECT`-shaped error. So the unauthenticated test asserts two separate
 * things — that `/login` was named, and that the layout **did not return**. A
 * double whose `redirect` merely returned would let a guard that continued past
 * it render the shell to a visitor with no session, and the "was called with
 * /login" assertion would still pass.
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
    // The sidebar rail reads it to decide `aria-current="page"`. Fixed here, so
    // the shell renders one deterministic active item.
    usePathname: () => "/dashboard",
  }
})

vi.mock("@/lib/auth/session", () => ({
  readSession: () => Promise.resolve(currentSession()),
}))

vi.mock("@/lib/actions/auth", () => ({
  // The rail's footer renders `<form action={logoutAction}>`. Doubled so this
  // suite does not drag argon2 and the Postgres pool in for a form it never
  // submits.
  logoutAction: () => Promise.resolve(),
}))

import AppLayout from "./layout"
import { RedirectSignal } from "@/test/next-doubles"

/** Exactly the shape `readSession` resolves to. */
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

const GUARDED_CONTENT = "the guarded surface"

function guardedChildren(): React.ReactNode {
  return <p>{GUARDED_CONTENT}</p>
}

beforeEach(() => {
  session = null
  redirectSpy.mockClear()
})

afterEach(cleanup)

describe("Requirement 7.6 — an unauthenticated request is redirected to /login", () => {
  test("redirect is called exactly once, with /login and nothing else", async () => {
    const thrown = await AppLayout({ children: guardedChildren() }).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(redirectSpy).toHaveBeenCalledTimes(1)
    expect(redirectSpy).toHaveBeenCalledWith("/login")

    // No `returnTo`, and that is deliberate rather than incidental: a layout
    // cannot know the pathname — the App Router exposes it to the browser only —
    // so a target passed from here would be a guess. A bare `/login` is also
    // what an off-origin or malformed target resolves to, so the URL never
    // advertises that something was rejected.
    expect(redirectSpy.mock.calls[0][0]).not.toMatch(/\?/)

    // The layout did not return. `redirect` signals by throwing, so a guard that
    // swallowed the signal would render the shell to a visitor with no session.
    expect(thrown).toBeInstanceOf(RedirectSignal)
    expect((thrown as RedirectSignal).digest).toMatch(/^NEXT_REDIRECT;/)
  })

  test("nothing is rendered for an unauthenticated request", async () => {
    await AppLayout({ children: guardedChildren() }).catch(() => undefined)

    // The guarded children never reach the document. Asserted separately from the
    // redirect call because they are different failures: one is "the wrong URL",
    // the other is "the content leaked anyway".
    expect(screen.queryByText(GUARDED_CONTENT)).toBeNull()
    expect(document.body.textContent).not.toContain(SIGNED_IN.email)
  })
})

describe("Requirement 7.6 — an authenticated request renders the shell", () => {
  beforeEach(() => {
    session = SIGNED_IN
  })

  test("the layout returns, and no redirect is issued", async () => {
    // Non-vacuity for both assertions above: a layout that redirected
    // unconditionally would satisfy every one of them.
    render(await AppLayout({ children: guardedChildren() }))

    expect(redirectSpy).not.toHaveBeenCalled()
    expect(screen.getByText(GUARDED_CONTENT)).toBeInTheDocument()
  })

  test("the signed-in email is rendered in the rail", async () => {
    render(await AppLayout({ children: guardedChildren() }))

    // Resolved once by the layout's own `requireSession()` and passed down as a
    // prop, so the rail does not perform a second read that could disagree with
    // the guard's.
    const email = screen.getByText(SIGNED_IN.email)

    expect(email).toBeInTheDocument()
    // Never abbreviated in the DOM, so a screen reader reads the whole address
    // even though the rail truncates it visually.
    expect(email.textContent).toBe(SIGNED_IN.email)
  })

  test("the shell's landmarks and the way out are present", async () => {
    render(await AppLayout({ children: guardedChildren() }))

    // The visible section label *is* the navigation's accessible name, via
    // `aria-labelledby` — a separate `aria-label` would be a second name to keep
    // in agreement with the one on screen.
    expect(
      screen.getByRole("navigation", { name: "Workspace" })
    ).toBeInTheDocument()

    // Sign-out is a form posting to a Server Function, so it works before — and
    // without — hydration, and it cannot be a GET.
    expect(
      screen.getByRole("button", { name: /sign out/i })
    ).toBeInTheDocument()

    // The rail is a long, repeated stop on every page, so keyboard users get a
    // way past it.
    expect(
      screen.getByRole("link", { name: "Skip to content" })
    ).toHaveAttribute("href", "#app-content")
  })
})
