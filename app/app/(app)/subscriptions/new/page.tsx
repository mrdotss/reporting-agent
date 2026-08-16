import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "@phosphor-icons/react/ssr"

import { ConnectWizard } from "@/components/subscriptions/connect-wizard"
import { ReaderRoleExplainer } from "@/components/subscriptions/reader-role-explainer"

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

export default function NewSubscriptionPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Link
          href="/subscriptions"
          className="flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
          Subscriptions
        </Link>

        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-medium tracking-tight">
            Connect a subscription
          </h1>

          <p className="text-sm text-muted-foreground">
            Read-only, at subscription scope, and proved before it is saved. A
            connection is only accepted once Azure&apos;s own permissions
            response confirms read at the subscription&apos;s scope — never
            because an inventory query happened to succeed.
          </p>
        </div>
      </div>

      <ConnectWizard
        explainer={<ReaderRoleExplainer />}
        nowIso={new Date().toISOString()}
      />
    </div>
  )
}
