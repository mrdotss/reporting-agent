import { AppSidebar } from "@/components/app-shell/sidebar"
import { UserMenu } from "@/components/app-shell/user-menu"
import { requireSession } from "@/lib/auth/guard"

/**
 * The authenticated shell (Requirements 7.6, 7.8).
 *
 * ## This layout is the route guard
 *
 * `requireSession()` runs on **every** authenticated render and resolves the
 * session against Postgres — expiry is a column and sign-out is a `DELETE`, so
 * only the row can answer whether a request is still signed in. There is no
 * `proxy.ts` and no `middleware.ts` in this app on purpose: Next 16 renamed
 * `middleware` to `proxy`, a proxy check sees a cookie rather than a session, and
 * a revoked session still presents a cookie. `proxy` also runs on every request
 * including prefetches, which would multiply the cost of the one check that has
 * to be right.
 *
 * Called with **no argument**, so an unauthenticated request lands on a clean
 * `/login` with no `returnTo`. A layout cannot know the pathname — the App
 * Router exposes it to the browser only — so a target passed from here would be
 * a guess. Pages that want their deep link to survive sign-in pass their own.
 *
 * It is also awaited outside any `try`/`catch`: `redirect` signals by throwing
 * `NEXT_REDIRECT`, and a `catch` in its path would swallow the redirect and
 * render this shell to a visitor who has no session.
 *
 * ## The composition
 *
 * A server component that renders one client leaf. `<UserMenu />` is
 * server-rendered here and handed to {@link AppSidebar} as `children` rather
 * than imported by it, so the rail's `usePathname` does not drag the signed-in
 * email, the sign-out form or `logoutAction` across the client boundary. The
 * only thing in the browser bundle is the rail itself and the theme toggle.
 *
 * `min-h-svh`, not `min-h-screen`: on mobile browsers `100vh` includes the
 * retracting toolbar, so a full-height rail overshoots the viewport by the
 * height of the chrome.
 */
export default async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const user = await requireSession()

  return (
    <div className="flex min-h-svh flex-col bg-background md:flex-row">
      {/*
        The rail is a long, repeated stop on every page, so keyboard users get a
        way past it. Hidden until focused, then a real, visible control — the
        pattern only works if it can be seen once it has focus.
      */}
      <a
        href="#app-content"
        className="sr-only rounded-4xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground outline-none focus-visible:not-sr-only focus-visible:absolute focus-visible:start-4 focus-visible:top-4 focus-visible:z-50"
      >
        Skip to content
      </a>

      <AppSidebar>
        <UserMenu email={user.email} />
      </AppSidebar>

      <main
        id="app-content"
        className="min-w-0 flex-1 px-4 py-8 md:px-8 md:py-10"
      >
        {children}
      </main>
    </div>
  )
}
