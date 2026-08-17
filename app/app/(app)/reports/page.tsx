import type { Metadata } from "next"

import { RunForm } from "@/components/reports/run-form"
import { RunList } from "@/components/reports/run-list"
import { requireSession } from "@/lib/auth/guard"
import { toRunView, UNRESOLVED_RUN_VIEW_EXTRAS } from "@/lib/db/views"
import { listOwnedRuns } from "@/lib/runs/state"
import { listConnectedSubscriptions } from "@/lib/subscriptions/store"

/**
 * `/reports` — request a run, and see the ones already requested
 * (Requirements 36.10, 37.1, 37.4).
 *
 * A **server** component. It resolves the signed-in user, reads that user's runs and
 * subscriptions scoped by `user_id`, projects both to their browser-safe shapes, and
 * hands them down. Nothing here parses an event and nothing here writes.
 *
 * `requireSession()` again, not because the `(app)` layout's check was insufficient but
 * because this page needs the **user id** to scope its reads and a layout cannot hand a
 * value to a page. That call also opts the route out of static rendering, which is what
 * keeps the run list current rather than frozen at build time.
 *
 * One `now` is fixed for the whole render and passed to the form, so every subscription
 * option is judged against the same instant and the date bounds cannot differ between
 * the server pass and hydration.
 */

export const metadata: Metadata = {
  title: "Reports",
  description:
    "Request an infrastructure utilization report and review the runs already " +
    "requested.",
}

export default async function ReportsPage() {
  const user = await requireSession()

  // Both reads scoped by `user_id` (Requirements 9.7, 36.10), and both projected: only
  // `RunView` and `ConnectedSubscriptionView` cross to the browser, so the unmasked
  // subscription id, the tenant id, the client id, the ciphertext, `progress_token_hash`,
  // `dedupe_key` and the requested scope are absent by construction.
  const [runs, subscriptions] = await Promise.all([
    listOwnedRuns(user.id),
    listConnectedSubscriptions(user.id),
  ])

  const now = new Date()

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-medium tracking-tight">
          Reports
        </h1>

        <p className="max-w-prose text-sm text-muted-foreground">
          A run collects CPU, memory, disk and network for every resource in
          scope over a period you choose, then writes one immutable snapshot.
          Every figure in the report traces back to a row in that snapshot.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-sm font-medium tracking-tight">
          Request a report
        </h2>

        <RunForm subscriptions={subscriptions} nowIso={now.toISOString()} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-sm font-medium tracking-tight">
          Runs
        </h2>

        <RunList
          runs={runs.map((run) => toRunView(run, UNRESOLVED_RUN_VIEW_EXTRAS))}
          subscriptions={subscriptions}
        />
      </section>
    </div>
  )
}
