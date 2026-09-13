import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"

/**
 * The authenticated shell's route guard (Requirement 7.6), and the shell it renders.
 *
 * ## The guard is asserted at the layout, because the layout *is* the guard
 *
 * There is no `proxy.ts` and no `middleware.ts` in this app, on purpose: a proxy check
 * sees a **cookie** rather than a session. Sessions here are database rows — expiry is a
 * column and sign-out is a `DELETE` — so a revoked session still presents a cookie and a
 * cookie-peeking guard would let it through. The authoritative check therefore lives in
 * `app/(app)/layout.tsx`, which every authenticated render passes through.
 *
 * `readSession` is the seam between the layout and Postgres. The workspace context and
 * the close loaders are doubled too, with a real board built from the real pure
 * functions, so the sidebar renders what production would for that data.
 *
 * ## `redirect` throws, and both halves of that matter
 *
 * The double records the target *and* throws a `NEXT_REDIRECT`-shaped error, so the
 * unauthenticated test asserts both that `/login` was named and that the layout **did
 * not return**.
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
    usePathname: () => "/dashboard",
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  }
})

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined }),
}))

vi.mock("@/lib/auth/session", () => ({
  readSession: () => Promise.resolve(currentSession()),
}))

vi.mock("@/lib/actions/auth", () => ({
  // The rail's footer renders `<form action={logoutAction}>`. Doubled so this suite
  // does not drag argon2 and the Postgres pool in for a form it never submits.
  logoutAction: () => Promise.resolve(),
}))

vi.mock("@/lib/workspaces/context", () => ({
  selectedContext: () =>
    Promise.resolve({
      workspace: { id: "w1", name: "My workspace", role: "owner", closeDay: 15 },
      workspaces: [
        { id: "w1", name: "My workspace", role: "owner", closeDay: 15 },
      ],
      projects: [PROJECT],
      project: PROJECT,
    }),
}))

vi.mock("@/lib/close/load", async () => {
  const { closePeriod } = await import("@/lib/close/period")
  const { buildBoard } = await import("@/lib/close/board")
  return {
    loadClose: () => {
      const period = closePeriod(
        new Date("2026-09-13T03:00:00Z"),
        15,
        "Asia/Jakarta"
      )
      const board = buildBoard(
        [
          {
            id: "p1",
            name: "Satu Data Labs",
            archived: false,
            createdMonth: "2026-01",
            connector: null,
            preset: null,
          },
        ],
        [],
        [period.month],
        period.month
      )
      return Promise.resolve({ period, board })
    },
  }
})

vi.mock("@/lib/close/attention", () => ({
  loadAttention: () => Promise.resolve([]),
}))

import AppLayout from "./layout"
import { RedirectSignal } from "@/test/next-doubles"

const PROJECT = {
  id: "p1",
  workspaceId: "w1",
  name: "Satu Data Labs",
  description: "",
  archivedAt: null,
}

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

beforeAll(() => {
  // The sidebar primitive asks `matchMedia` whether it is on a phone.
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    })
  }
})

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

    // No `returnTo`: a layout cannot know the pathname, so a target passed from here
    // would be a guess.
    expect(redirectSpy.mock.calls[0][0]).not.toMatch(/\?/)

    // The layout did not return. `redirect` signals by throwing, so a guard that
    // swallowed the signal would render the shell to a visitor with no session.
    expect(thrown).toBeInstanceOf(RedirectSignal)
    expect((thrown as RedirectSignal).digest).toMatch(/^NEXT_REDIRECT;/)
  })

  test("nothing is rendered for an unauthenticated request", async () => {
    await AppLayout({ children: guardedChildren() }).catch(() => undefined)

    expect(screen.queryByText(GUARDED_CONTENT)).toBeNull()
    expect(document.body.textContent).not.toContain(SIGNED_IN.email)
  })
})

describe("Requirement 7.6 — an authenticated request renders the shell", () => {
  beforeEach(() => {
    session = SIGNED_IN
  })

  test("the layout returns, and no redirect is issued", async () => {
    render(await AppLayout({ children: guardedChildren() }))

    expect(redirectSpy).not.toHaveBeenCalled()
    expect(screen.getByText(GUARDED_CONTENT)).toBeInTheDocument()
  })

  test("the signed-in email is rendered in the rail, never abbreviated in the DOM", async () => {
    render(await AppLayout({ children: guardedChildren() }))

    const email = screen.getByText(SIGNED_IN.email)
    expect(email.textContent).toBe(SIGNED_IN.email)
  })

  test("the way out and the way past the rail are present", async () => {
    render(await AppLayout({ children: guardedChildren() }))

    expect(
      screen.getByRole("button", { name: /sign out/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Skip to content" })
    ).toHaveAttribute("href", "#app-content")
  })

  test("the rail marks the current page and lists the open period's customers", async () => {
    render(await AppLayout({ children: guardedChildren() }))

    // Scoped to the rail: the header breadcrumb's current page is also exposed as a
    // `link` with `aria-current="page"`, by shadcn's BreadcrumbPage.
    const rail = within(
      document.querySelector<HTMLElement>('[data-slot="sidebar"]')!
    )

    expect(rail.getByRole("link", { name: "Close board" })).toHaveAttribute(
      "aria-current",
      "page"
    )
    expect(rail.getByRole("link", { name: "Reports" })).not.toHaveAttribute(
      "aria-current"
    )
    expect(
      rail.getByRole("group", { name: /Reporting period August 2026/ })
    ).toBeInTheDocument()
    expect(
      rail.getByRole("button", { name: /Satu Data Labs, August 2026: Not requested/ })
    ).toBeInTheDocument()
  })
})
