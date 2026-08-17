import type { Metadata } from "next"
import Link from "next/link"
import {
  PlugsConnectedIcon,
  PlusIcon,
  SealWarningIcon,
} from "@phosphor-icons/react/ssr"

import { RunList } from "@/components/reports/run-list"
import { SecretExpiryBanner } from "@/components/subscriptions/secret-expiry-banner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { requireSession } from "@/lib/auth/guard"
import {
  toRunView,
  UNRESOLVED_RUN_VIEW_EXTRAS,
  type ConnectedSubscriptionView,
} from "@/lib/db/views"
import { RUN_STATUS_PRESENTATION } from "@/lib/runs/presentation"
import { listOwnedRuns } from "@/lib/runs/state"
import { resolveSubscriptionState } from "@/lib/subscriptions/state"
import { listConnectedSubscriptions } from "@/lib/subscriptions/store"

/**
 * `/dashboard` — recent runs, subscription health and expiry warnings
 * (Requirements 13.2, 13.6, 36.7, 36.10).
 *
 * A **server** component, and the landing surface after sign-in. It answers three
 * questions in the order a consultant asks them: is anything running, is anything broken,
 * and is anything about to break.
 *
 * ## The expiry banners come first, and they are non-dismissible
 *
 * An expired client secret is the failure mode most likely to produce a
 * **plausible-looking empty report** — it authenticates, returns zero resources, and
 * every downstream gate passes — so it gets its own visual weight at the top of the page
 * rather than a badge somewhere in a list. `--destructive` is spent on an expiry that has
 * already happened; an *approaching* one renders in mist neutrals through
 * `SecretExpiryBanner`, because it is information rather than a failure
 * (Requirement 13.6).
 *
 * ## Terminal state is read from the row
 *
 * Requirement 36.7. The in-flight and failed counts below come from `report_runs.status`
 * and `report_runs.error_code`, not from any event stream — which is what makes a
 * `TIMEOUT` run visible here at all, since the reaper writes that code with no event to
 * carry it.
 *
 * Every figure is mono tabular with no count-up animation. In a product whose thesis is
 * that the numbers are trustworthy, a numeral that animates is decoration pretending to
 * be data.
 */

export const metadata: Metadata = {
  title: "Dashboard",
  description:
    "Recent report runs, connected subscription health and client secret " +
    "expiry warnings.",
}

/** How many runs the dashboard shows before deferring to `/reports`. */
const RECENT_RUN_COUNT = 5

/** One counted figure, in mono tabular with its label. */
function Stat({
  label,
  value,
  tone,
}: Readonly<{
  label: string
  value: number
  tone?: "neutral" | "destructive"
}>) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs tracking-widest text-muted-foreground uppercase">
        {label}
      </dt>
      <dd
        data-slot="dashboard-stat"
        className={
          tone === "destructive"
            ? "font-mono text-2xl text-destructive tabular-nums"
            : "font-mono text-2xl tabular-nums"
        }
      >
        {value}
      </dd>
    </div>
  )
}

/** One subscription's health line. */
function SubscriptionHealth({
  subscription,
  now,
}: Readonly<{ subscription: ConnectedSubscriptionView; now: Date }>) {
  const state = resolveSubscriptionState(subscription, now)

  return (
    <li
      data-slot="subscription-health"
      data-state={state.kind}
      className="flex flex-wrap items-center justify-between gap-2 text-sm"
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <Link
          href="/subscriptions"
          className="rounded-lg outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          {subscription.displayName}
        </Link>

        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {subscription.maskedSubscriptionId}
        </span>
      </span>

      {/*
        `--destructive` for a credential that is already unusable and mist neutral
        `outline` for everything else, including an approaching expiry — see the module
        docstring on Requirement 13.6.
      */}
      <Badge
        variant={
          state.kind === "expired" || state.kind === "disabled"
            ? "destructive"
            : state.kind === "active"
              ? "secondary"
              : "outline"
        }
      >
        {state.kind === "disabled"
          ? "credential rejected"
          : state.kind === "expired"
            ? "secret expired"
            : state.kind === "expiring"
              ? `expires in ${state.wholeDaysRemaining}d`
              : state.kind === "pending"
                ? "scope unverified"
                : "active"}
      </Badge>
    </li>
  )
}

export default async function DashboardPage() {
  const user = await requireSession()

  const [runs, subscriptions] = await Promise.all([
    listOwnedRuns(user.id),
    listConnectedSubscriptions(user.id),
  ])

  // One instant for the whole render, so every subscription's state is judged against the
  // same clock and two rows cannot disagree about whether the same day has passed.
  const now = new Date()

  const views = runs.map((run) => toRunView(run, UNRESOLVED_RUN_VIEW_EXTRAS))

  const inFlight = views.filter(
    (run) => RUN_STATUS_PRESENTATION[run.status].inFlight
  ).length
  const failed = views.filter((run) => run.status === "failed").length
  const completed = views.filter((run) => run.status === "completed").length

  const states = subscriptions.map((subscription) => ({
    subscription,
    state: resolveSubscriptionState(subscription, now),
  }))

  const unusable = states.filter(
    ({ state }) => state.kind === "expired" || state.kind === "disabled"
  )
  const expiring = states.filter(({ state }) => state.kind === "expiring")

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-medium tracking-tight">
          Dashboard
        </h1>

        <p className="text-sm text-muted-foreground">
          Signed in as{" "}
          <span className="font-mono tabular-nums">{user.email}</span>.
        </p>
      </div>

      {/*
        The unmissable state. An expired secret returns zero resources, and zero resources
        would otherwise pass every verification gate — so it is stated at the top, in the
        one token that means "this cannot be trusted", rather than left to a list.
      */}
      {unusable.length === 0 ? null : (
        <section
          data-slot="unusable-credentials"
          className="flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
        >
          <div className="flex items-start gap-2">
            <SealWarningIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-destructive"
            />

            <p className="max-w-prose text-sm text-destructive">
              {unusable.length === 1
                ? "One subscription's Azure client secret is no longer usable."
                : `${unusable.length} subscriptions have an Azure client secret that is no longer usable.`}{" "}
              Runs against them are blocked, because an unusable secret returns
              no resources at all — which would otherwise deliver a
              fully-verified, empty report.
            </p>
          </div>

          <div className="flex justify-start">
            <Button variant="outline" render={<Link href="/subscriptions" />}>
              Rotate a secret
            </Button>
          </div>
        </section>
      )}

      {/* Mist neutrals, one per approaching expiry (Requirements 13.2, 13.6). */}
      {expiring.map(({ subscription, state }) =>
        state.kind === "expiring" ? (
          <SecretExpiryBanner key={subscription.id} state={state} />
        ) : null
      )}

      <Card className="rounded-xl border border-border shadow-none ring-0">
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="In flight" value={inFlight} />
            <Stat label="Completed" value={completed} />
            <Stat
              label="Failed"
              value={failed}
              tone={failed > 0 ? "destructive" : "neutral"}
            />
            <Stat label="Subscriptions" value={subscriptions.length} />
          </dl>
        </CardContent>
      </Card>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-heading text-sm font-medium tracking-tight">
            Recent runs
          </h2>

          {views.length > RECENT_RUN_COUNT ? (
            <Link
              href="/reports"
              className="rounded-lg text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
            >
              All {views.length} runs
            </Link>
          ) : null}
        </div>

        <RunList
          runs={views.slice(0, RECENT_RUN_COUNT)}
          subscriptions={subscriptions}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-sm font-medium tracking-tight">
          Subscription health
        </h2>

        {subscriptions.length === 0 ? (
          <div className="flex flex-col items-start gap-4 rounded-xl border border-border bg-muted/40 px-6 py-8">
            <PlugsConnectedIcon
              aria-hidden="true"
              className="size-6 text-muted-foreground"
            />

            <p className="max-w-prose text-sm text-muted-foreground">
              No subscriptions are connected yet. Nothing can be collected until
              a service principal with Reader at subscription scope has been
              verified.
            </p>

            <Button render={<Link href="/subscriptions/new" />}>
              <PlusIcon aria-hidden="true" />
              Connect a subscription
            </Button>
          </div>
        ) : (
          <ul
            aria-label="Connected subscription health"
            className="flex flex-col gap-3 rounded-xl border border-border px-4 py-3"
          >
            {subscriptions.map((subscription) => (
              <SubscriptionHealth
                key={subscription.id}
                subscription={subscription}
                now={now}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
