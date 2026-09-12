import { PageBody } from "@/components/app-shell/page-body"
import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "@phosphor-icons/react/ssr"

import { ConnectFlow } from "@/components/subscriptions/connect-flow"
import { ReaderRoleExplainer } from "@/components/subscriptions/reader-role-explainer"
import { Card, CardContent } from "@/components/ui/card"

/**
 * `/subscriptions/new` — the onboarding wizard (Requirements 11.3–11.7, 11.9,
 * 11.10, 12.7).
 *
 * A **server** component with no `"use client"` anywhere in it. It composes two
 * things and does no work of its own:
 *
 *   * `<ReaderRoleExplainer />`, server-rendered here and handed to the wizard as
 *     a **prop**. The four statements Requirements 11.3–11.5 require are
 *     compliance copy a consultant forwards to a customer, so they belong in the
 *     initial HTML rather than after hydration. Passing the element rather than
 *     letting the wizard import it is the same arrangement the `(app)` layout uses
 *     for `<UserMenu />` inside the client sidebar.
 *   * the render instant, as ISO 8601. The wizard states the accepted expiry range
 *     and validates against it, and both have to be the same instant — a
 *     `new Date()` read inside a client component differs between the server pass
 *     and hydration, which is a mismatch on any date the copy prints.
 *
 * ## The long paragraph moved into the rail
 *
 * The header used to carry four sentences about how a connection is proved, above
 * a wizard that then says the same thing in its own first step. A consultant who
 * arrives here wants to know what they are about to do and roughly how long it
 * takes; the guarantee belongs next to the control that enforces it, which is
 * where `ReaderRoleExplainer` already sits.
 *
 * The route is already guarded: `app/(app)/layout.tsx` calls `requireSession()` on
 * every authenticated render, so this page needs no check of its own and
 * deliberately performs none. It reads no database and holds no secret — the
 * wizard talks to `POST /api/subscriptions/test` and `POST /api/subscriptions`,
 * and those are where the session, the preflight and the encryption live.
 *
 * Phosphor comes from `@phosphor-icons/react/ssr`: `rsc: true` makes the default
 * entry the client build, and importing it here would push the page across the
 * boundary for one glyph.
 */

export const metadata: Metadata = {
  title: "Connect a subscription",
  description:
    "Connect a customer's Azure subscription read-only, and prove read at " +
    "subscription scope before the connection is accepted.",
}

/** What connecting leads to. Three lines, because a consultant asked for four. */
const JOURNEY = [
  {
    title: "Connect the subscription",
    detail: "Read-only, proved against Azure's own permissions response.",
  },
  {
    title: "Choose resources and metrics",
    detail: "A scan discovers what the subscription holds.",
  },
  {
    title: "Style and deliver the report",
    detail: "A saved profile turns the snapshot into a document.",
  },
]

export default function NewSubscriptionPage() {
  return (
    <PageBody kind="reading">
      <header className="flex flex-col gap-3">
        <Link
          href="/subscriptions"
          className="flex w-fit items-center gap-1.5 rounded-lg text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
          Connections
        </Link>

        <div className="flex flex-col gap-1">
          <h1 className="text-title text-balance">Connect a subscription</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            A guided setup with a real access check before anything is saved.
          </p>
        </div>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(260px,1fr)]">
        <Card className="min-w-0">
          <CardContent>
            <ConnectFlow
              explainer={<ReaderRoleExplainer />}
              nowIso={new Date().toISOString()}
            />
          </CardContent>
        </Card>

        <aside
          aria-label="What happens next"
          className="flex flex-col gap-4 lg:sticky lg:top-6"
        >
          <h2 className="text-micro text-muted-foreground uppercase">
            What happens next
          </h2>

          <ol className="flex flex-col">
            {JOURNEY.map((stage, index) => (
              <li
                key={stage.title}
                className="flex gap-3 border-b border-border py-4 first:pt-0 last:border-b-0"
              >
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">{stage.title}</span>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    {stage.detail}
                  </span>
                </span>
              </li>
            ))}
          </ol>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Nothing is stored until Azure confirms read at subscription scope. If
            it refuses, the wizard says which permission is missing.
          </p>
        </aside>
      </div>
    </PageBody>
  )
}
