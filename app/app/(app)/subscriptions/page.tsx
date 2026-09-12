import { PageBody } from "@/components/app-shell/page-body"
import { selectedFilter } from "@/lib/workspaces/context"
import type { Metadata } from "next"
import Link from "next/link"
import { InfoIcon, PlusIcon } from "@phosphor-icons/react/ssr"

import { SubscriptionList } from "@/components/subscriptions/subscription-list"
import { buttonVariants } from "@/components/ui/button"
import { requireSession } from "@/lib/auth/guard"
import { listConnectedSubscriptions } from "@/lib/subscriptions/store"

/**
 * `/subscriptions` — the connected subscriptions screen (Requirements 10.2, 13.2,
 * 13.3, 13.6).
 *
 * A **server** component that does three things and delegates the rest:
 *
 *   * resolves the signed-in user. `requireSession()` again, not because the `(app)`
 *     layout's check was insufficient but because this page needs the **user id** to
 *     scope its read, and a layout cannot hand a value to a page. Every read of
 *     `connected_subscriptions` is scoped by that id (Requirement 9.7), so another
 *     user's row resolves as absent rather than as forbidden.
 *   * reads the rows as {@link listConnectedSubscriptions} projections — the only
 *     shape allowed to cross to the browser (Requirement 10.2). The unmasked
 *     subscription id, the tenant id, the client id and the ciphertext never enter
 *     this component's props.
 *   * fixes **one** `now` for the whole render, so every row's state is judged
 *     against the same instant.
 *
 * The page is dynamic without saying so: `requireSession()` reads the session cookie
 * and resolves it against Postgres, which opts the route out of static rendering. That
 * is what makes Requirement 13.2's "on every render of the subscriptions screen"
 * true — a cached page would freeze a day count that is supposed to be counting down.
 */

export const metadata: Metadata = {
  title: "Subscriptions",
  description:
    "Connected Azure subscriptions, their verification state and their client " +
    "secret expiry.",
}

export default async function SubscriptionsPage() {
  const user = await requireSession()
  const projectScope = await selectedFilter(user.id)

  const subscriptions = await listConnectedSubscriptions(user.id, projectScope)

  return (
    <PageBody kind="reading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-title">
            Connectors
          </h1>

          <p className="text-sm text-muted-foreground">
            Manage customer access, discover resources, and keep connections
            ready for reporting.
          </p>
        </div>

        {subscriptions.length === 0 ? null : (
          <Link
            data-slot="button"
            href="/subscriptions/new"
            className={buttonVariants({ variant: "outline" })}
          >
            <PlusIcon aria-hidden="true" />
            Connect a subscription
          </Link>
        )}
      </div>

      <SubscriptionList subscriptions={subscriptions} now={new Date()} />

      {/*
        A page that stops is a page that looks like it failed to load, and a list of one
        connection stops very early. This is not filler: an expired secret is the failure
        that produces a plausible-looking *empty* report — it authenticates, returns zero
        resources, and every downstream gate passes — which is the one thing worth
        saying at the foot of the page that manages secrets.
      */}
      {subscriptions.length === 0 ? null : (
        <p className="flex items-start gap-2 border-t border-border pt-5 text-xs leading-relaxed text-muted-foreground">
          <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          A connection is read-only and scoped to one subscription. When its secret
          expires the next run fails rather than delivering an empty report, so rotate
          it before the date above rather than after.
        </p>
      )}
    </PageBody>
  )
}
