import type { Metadata } from "next"
import Link from "next/link"
import { PlusIcon } from "@phosphor-icons/react/ssr"

import { SubscriptionList } from "@/components/subscriptions/subscription-list"
import { Button } from "@/components/ui/button"
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

  const subscriptions = await listConnectedSubscriptions(user.id)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-medium tracking-tight">
            Subscriptions
          </h1>

          <p className="text-sm text-muted-foreground">
            Read-only connections to your customers&apos; Azure subscriptions. A
            client secret has a maximum lifetime of 24 months, so each one is
            watched and warned about before it lapses.
          </p>
        </div>

        {subscriptions.length === 0 ? null : (
          <Button variant="outline" render={<Link href="/subscriptions/new" />}>
            <PlusIcon aria-hidden="true" />
            Connect a subscription
          </Button>
        )}
      </div>

      <SubscriptionList subscriptions={subscriptions} now={new Date()} />
    </div>
  )
}
