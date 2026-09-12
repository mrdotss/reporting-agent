"use client"

import { useEffect } from "react"
import Link from "next/link"
import { ArrowClockwiseIcon, WarningOctagonIcon } from "@phosphor-icons/react"

import { PageBody } from "@/components/app-shell/page-body"
import { Button, buttonVariants } from "@/components/ui/button"

/**
 * What an authenticated page shows when its render throws.
 *
 * ## Why this file exists
 *
 * Every page in this group reads Postgres, and several read S3. Without an error
 * boundary a failed query left Next's own error page — an unstyled stack trace in
 * development, a bare "Application error" in production — which is both outside
 * the design and, worse, indistinguishable from the product having no data. A
 * consultant cannot tell "this query failed" from "this customer has no runs",
 * and those demand opposite responses.
 *
 * ## What it does and does not claim
 *
 * It does not guess. The boundary knows a render threw and nothing else, so it
 * says that, offers the two things that are actually useful — try again, or go
 * somewhere that works — and prints the digest, which is the only thing that ties
 * what the reader saw to what the server logged.
 *
 * `--destructive` is correct here and this is one of the few places it is: the
 * design system reserves the token for verification failure **and hard errors**,
 * and a page that could not render is a hard error. It is spent on the icon and
 * the digest, not on a full red panel — the page failed, the product did not.
 *
 * ## The layout's own throw does not land here
 *
 * `layout.tsx` calls `requireSession()` and `selectedContext()`, and an error
 * thrown by a layout is caught by its **parent** segment's boundary, never its
 * own. `WorkspaceAccessError` from `selectedContext` therefore lands in
 * `app/error.tsx`, which exists for that reason.
 */
export default function AppError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string }
  reset: () => void
}>) {
  useEffect(() => {
    // The browser console is where a developer looks first, and the boundary is
    // the only place holding the original error — Next hands the digest to the
    // client and keeps the message on the server.
    console.error("[app] page render failed", error)
  }, [error])

  return (
    <PageBody kind="reading">
      <div className="flex flex-col items-start gap-5 py-10">
        <WarningOctagonIcon
          aria-hidden="true"
          className="size-7 text-destructive"
        />

        <div className="flex flex-col gap-2">
          <h1 className="text-title">This page could not be loaded.</h1>

          <p className="text-meta max-w-prose text-muted-foreground">
            Something failed while reading this page&apos;s data. Nothing was
            changed, and no report run was affected — this is the page, not the
            pipeline.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={reset}>
            <ArrowClockwiseIcon aria-hidden="true" />
            Try again
          </Button>

          <Link
            href="/dashboard"
            className={buttonVariants({ variant: "outline" })}
          >
            Back to overview
          </Link>
        </div>

        {/*
          The one fact worth carrying into a support conversation. Mono tabular
          because it is an identifier, and selectable because it will be pasted.
        */}
        {error.digest === undefined ? null : (
          <p className="text-meta text-muted-foreground">
            Reference{" "}
            <span className="font-mono tabular-nums select-all">
              {error.digest}
            </span>
          </p>
        )}
      </div>
    </PageBody>
  )
}
