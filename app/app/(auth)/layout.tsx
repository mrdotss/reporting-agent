import { ShieldCheckIcon } from "@phosphor-icons/react/ssr"

/**
 * The shell both public auth pages render into (Requirement 7.8).
 *
 * A **server** component, and it stays one: nothing here is interactive, so the
 * only `"use client"` files in this route group are the two form leaves under
 * `components/auth/`. The Phosphor import is therefore from
 * `@phosphor-icons/react/ssr` — the package's default entry is the client build,
 * and naming it from a server component starts a `"use client"` cascade that
 * would drag this layout and both pages into the browser bundle for the sake of
 * one glyph.
 *
 * Luma preset, applied deliberately: `--background` under a centered column,
 * `--primary` as the single chromatic voice, `font-heading` (Geist) for the
 * wordmark, generous whitespace, no gradient and no shadow. The icon is
 * `dark:text-sidebar-primary` rather than plain `text-primary` because the
 * preset makes `--primary` *darker* in dark mode (`L 0.45` against an `L 0.148`
 * surface); `--sidebar-primary` is the lifted teal that reads as teal on a dark
 * background.
 *
 * `min-h-svh`, not `min-h-screen`: on mobile browsers `100vh` includes the
 * retracting toolbar, which pushes a vertically centered card off centre until
 * the user scrolls.
 */
export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-10 bg-background px-4 py-16">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        <ShieldCheckIcon
          aria-hidden="true"
          className="size-7 text-primary dark:text-sidebar-primary"
        />

        <h1 className="font-heading text-base font-medium tracking-tight">
          Infrastructure Utilization Reporting
        </h1>

        <p className="text-sm leading-relaxed text-muted-foreground">
          Every figure in a delivered report traces to an immutable snapshot.
        </p>
      </div>

      {children}
    </main>
  )
}
