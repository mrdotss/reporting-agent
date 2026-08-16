import Link from "next/link"
import { FileTextIcon } from "@phosphor-icons/react/ssr"

import { RunStatusBadge } from "@/components/reports/run-status-badge"
import { Card, CardContent } from "@/components/ui/card"
import type { ConnectedSubscriptionView, RunView } from "@/lib/db/views"
import { periodLine } from "@/lib/runs/presentation"

/**
 * The run list — one row per report run, newest first (Requirement 36.10).
 *
 * A **server** component. Every row is a {@link RunView}, the only run shape allowed to
 * cross to the browser, so `progress_token_hash`, `claimed_by`, `dedupe_key`, `scope`
 * and the three in-flight progress columns are absent by construction rather than
 * filtered here.
 *
 * Every numeral is mono tabular: the resource and gap counts line up down the column, and
 * a differing value does not reflow its row. That is the same rule the whole product
 * follows, and on this screen it is what makes two runs comparable at a glance.
 *
 * The subscription is named through its **masked** id and display name — this is a browser
 * payload, so the unmasked GUID is not available to it and would not be shown if it were.
 * The mapping is passed in rather than looked up per row, because a list of fifty runs
 * against three subscriptions should read three subscriptions rather than issue fifty
 * queries.
 */

/** How a run's subscription is named on this screen. */
function subscriptionLabel(
  run: RunView,
  subscriptions: ReadonlyMap<string, ConnectedSubscriptionView>
): string {
  const subscription = subscriptions.get(run.connectedSubscriptionId)

  // A run outlives its connection — `report_runs` rows are audit artifacts and are never
  // deleted with the subscription they targeted — so an absent entry is an ordinary
  // state, not a bug. Saying so is better than rendering an empty cell.
  return subscription?.displayName ?? "Subscription removed"
}

export function RunList({
  runs,
  subscriptions,
}: Readonly<{
  runs: readonly RunView[]
  /** The user's connections, for naming each run's subscription. */
  subscriptions: readonly ConnectedSubscriptionView[]
}>) {
  const byId = new Map(
    subscriptions.map((subscription) => [subscription.id, subscription])
  )

  if (runs.length === 0) {
    return (
      <div
        data-slot="run-list-empty"
        className="flex flex-col items-start gap-4 rounded-xl border border-border bg-muted/40 px-6 py-10"
      >
        <FileTextIcon
          aria-hidden="true"
          className="size-6 text-muted-foreground"
        />

        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-base font-medium tracking-tight">
            No reports yet
          </h2>

          <p className="max-w-prose text-sm text-muted-foreground">
            A run collects utilization for every resource in scope over a period
            you choose, then writes one immutable snapshot. It takes 8 to 12
            minutes at a few hundred resources, and closing the tab does not
            affect it.
          </p>
        </div>
      </div>
    )
  }

  return (
    <ul
      data-slot="run-list"
      aria-label="Report runs"
      className="flex flex-col gap-3"
    >
      {runs.map((run) => (
        <li key={run.id}>
          <Card
            data-slot="run-row"
            data-run-status={run.status}
            className="rounded-xl border border-border shadow-none ring-0"
          >
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  href={`/reports/${run.id}`}
                  className="rounded-lg font-heading text-sm font-medium tracking-tight outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
                >
                  {subscriptionLabel(run, byId)}
                </Link>

                <RunStatusBadge status={run.status} />
              </div>

              <dl className="flex flex-col gap-2 text-sm sm:flex-row sm:gap-8">
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs tracking-widest text-muted-foreground uppercase">
                    Period
                  </dt>
                  {/* The zone travels with the dates: "July" means July there. */}
                  <dd className="font-mono tabular-nums">{periodLine(run)}</dd>
                </div>

                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs tracking-widest text-muted-foreground uppercase">
                    Resources
                  </dt>
                  <dd className="font-mono tabular-nums">
                    {run.resourceCount ?? "—"}
                  </dd>
                </div>

                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs tracking-widest text-muted-foreground uppercase">
                    Gaps
                  </dt>
                  <dd className="font-mono tabular-nums">
                    {run.gapCount ?? "—"}
                  </dd>
                </div>

                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs tracking-widest text-muted-foreground uppercase">
                    Started
                  </dt>
                  {/*
                    The UTC calendar date and minute, with the zone named. Not
                    locale-formatted: a locale format differs between the server pass and
                    the browser, which on a list that re-renders would flicker.
                  */}
                  <dd className="font-mono tabular-nums">
                    {run.createdAt.slice(0, 16).replace("T", " ")}
                    <span className="ml-1 text-xs text-muted-foreground">
                      UTC
                    </span>
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  )
}
