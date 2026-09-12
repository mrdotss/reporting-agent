"use client"

import { useEffect } from "react"
import Link from "next/link"
import { ArrowClockwiseIcon, WarningOctagonIcon } from "@phosphor-icons/react"

import { Button, buttonVariants } from "@/components/ui/button"

/**
 * The boundary above the authenticated shell.
 *
 * ## Why a second one
 *
 * `app/(app)/error.tsx` catches a **page** that throws. It cannot catch its own
 * layout: an error thrown while rendering a layout is caught by the parent
 * segment's boundary, never by a boundary inside the segment that threw. And
 * `(app)/layout.tsx` is where two of this product's most likely failures happen —
 * `requireSession()` resolving the session against Postgres, and
 * `selectedContext()` throwing `WorkspaceAccessError` when a user has no
 * workspace at all. Without this file both of those rendered Next's own error
 * page with the rail, the header and the whole design absent.
 *
 * So this one assumes nothing: no shell, no `PageBody`, no workspace context. It
 * centres itself in the viewport and uses only the root layout's tokens, because
 * the root layout is the one thing still known to have rendered.
 *
 * A signed-out visitor whose session lookup failed is offered sign-in as well as
 * a retry — for the no-workspace and expired-session cases, retrying the same
 * render will fail the same way, and the link is the only way out.
 */
export default function RootError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string }
  reset: () => void
}>) {
  useEffect(() => {
    console.error("[app] shell render failed", error)
  }, [error])

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6 py-16">
      <div className="flex w-full max-w-md flex-col items-start gap-5">
        <WarningOctagonIcon
          aria-hidden="true"
          className="size-7 text-destructive"
        />

        <div className="flex flex-col gap-2">
          <h1 className="text-title">The workspace could not be opened.</h1>

          <p className="text-meta text-muted-foreground">
            Your session or your workspace could not be read. Signing in again
            resolves this in most cases; nothing you have saved is affected.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={reset}>
            <ArrowClockwiseIcon aria-hidden="true" />
            Try again
          </Button>

          <Link href="/login" className={buttonVariants({ variant: "outline" })}>
            Sign in
          </Link>
        </div>

        {error.digest === undefined ? null : (
          <p className="text-meta text-muted-foreground">
            Reference{" "}
            <span className="font-mono tabular-nums select-all">
              {error.digest}
            </span>
          </p>
        )}
      </div>
    </main>
  )
}
