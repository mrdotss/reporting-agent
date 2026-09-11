import Link from "next/link"
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  FileTextIcon,
  PlugsConnectedIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react/ssr"

import { RunTable } from "@/components/reports/run-table"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { getPool } from "@/lib/db"
import { NO_RUN_VIEW_EXTRAS, toRunView } from "@/lib/db/views"
import { resolveRunExtrasBatch } from "@/lib/runs/detail"
import { listOwnedRuns } from "@/lib/runs/state"
import { resolveSubscriptionState } from "@/lib/subscriptions/state"
import { listConnectedSubscriptions } from "@/lib/subscriptions/store"
import { selectedContext } from "@/lib/workspaces/context"
import { can } from "@/lib/workspaces/policy"
import { cn } from "@/lib/utils"

/**
 * The workspace overview — the surface a consultant lands on after signing in.
 *
 * It answers three questions in the order they are asked: is anything running, is
 * anything broken, and is anything about to break.
 *
 * ## Four figures, and why these four
 *
 * The previous set counted `completed`, `running`, `failed` and `connections`, which is
 * the database's schema rather than a reader's question. `failed` in particular was a
 * 30-day total — 55 against 45 completed — presented with no way to act on it, which
 * reads as an alarm nobody can silence.
 *
 * These are the four a consultant acts on: what is **ready to send**, what is **still
 * running**, what **needs attention** (a connection expiring, expired or disabled — the
 * one failure that produces a plausible-looking empty report), and how many **sources**
 * are connected. Failures are still counted, under the runs they belong to, where the
 * run that failed is one click away.
 *
 * ## No count-up animation, anywhere
 *
 * In a product whose thesis is that the numbers are trustworthy, a numeral that animates
 * is decoration pretending to be data. Every figure here is mono tabular and static.
 */

/** How many runs the summary shows before deferring to `/reports`. */
const RECENT_RUN_COUNT = 5

/** How many connections the health card lists before deferring to `/subscriptions`. */
const HEALTH_ROW_COUNT = 4

export async function WorkspaceOverview({ userId }: { userId: string }) {
  const { workspace, project } = await selectedContext(userId)
  const now = new Date()
  const scope = { workspaceId: workspace.id, projectId: project?.id }

  const [runs, subscriptions, stats] = await Promise.all([
    listOwnedRuns(userId, { ...scope, limit: RECENT_RUN_COUNT }),
    listConnectedSubscriptions(userId, scope),
    getPool().query(
      `select count(*) filter(where r.status='completed')::int completed,count(*) filter(where r.status='failed')::int failed,count(*) filter(where r.status not in ('completed','failed'))::int running from report_runs r join workspace_members m on m.workspace_id=r.workspace_id where m.user_id=$1 and r.workspace_id=$2 and ($3::text is null or r.project_id=$3) and r.created_at>=now()-interval '30 days'`,
      [userId, workspace.id, project?.id ?? null]
    ),
  ])

  const extras = await resolveRunExtrasBatch(runs)
  const counts = stats.rows[0]

  const states = subscriptions.map((subscription) => ({
    subscription,
    state: resolveSubscriptionState(subscription, now),
  }))
  const issues = states.filter((entry) => entry.state.kind !== "active")

  const canRequest =
    project !== undefined &&
    project !== null &&
    !project.archivedAt &&
    can(workspace.role, "edit")

  const figures = [
    { label: "Ready to send", value: counts.completed },
    { label: "In progress", value: counts.running },
    {
      label: "Needs attention",
      value: issues.length,
      // The only figure allowed to shout, and only when it is not zero. A permanently
      // red numeral is a numeral people stop reading.
      alarming: issues.length > 0,
    },
    { label: "Connected sources", value: subscriptions.length },
  ]

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            {project?.name ?? "All customer projects"}
          </p>

          <h1 className="text-balance">A clear view of your reporting.</h1>

          <p className="max-w-prose text-sm text-muted-foreground">
            Monitor delivery, keep connections healthy, and prepare your next
            report.
          </p>
        </div>

        {canRequest ? (
          <Link
            data-slot="button"
            href="/reports/new"
            className={buttonVariants()}
          >
            Request report
            <ArrowRightIcon />
          </Link>
        ) : null}
      </header>

      {issues.length > 0 ? (
        <Alert>
          <WarningCircleIcon />
          <AlertTitle>
            {issues.length === 1
              ? "One connection needs your attention"
              : `${issues.length} connections need your attention`}
          </AlertTitle>
          <AlertDescription>
            A connection that cannot authenticate still returns zero resources,
            and a report built on that looks complete.
          </AlertDescription>
          <Link
            href="/subscriptions"
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "col-start-2 mt-1 w-fit"
            )}
          >
            Review connections
          </Link>
        </Alert>
      ) : null}

      {/*
        No card. Four figures on the page ground, separated by hairlines — a box around a
        box around a number is two containers more than the number needs, and the ring
        plus the internal rules read as a table with a frame.

        `divide-x` rather than a right border on each cell: a border on every figure put
        a rule down the middle of the 2-column phone layout and a second one hanging off
        the right edge.
      */}
      <dl
        data-slot="dashboard-figures"
        className="grid grid-cols-2 divide-x divide-y divide-border border-y border-border sm:grid-cols-4 sm:divide-y-0"
      >
        {figures.map(({ label, value, alarming }) => (
          <div
            key={label}
            data-slot="dashboard-figure"
            className="flex flex-col gap-2 px-5 py-6 first:pl-0 sm:last:pr-0"
          >
            <dt className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
              {label}
            </dt>
            <dd
              data-slot="dashboard-stat"
              className={cn(
                "font-mono text-[2rem] leading-none font-medium tracking-tight tabular-nums",
                alarming && "text-destructive"
              )}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="grid items-start gap-10 xl:grid-cols-[minmax(0,1.9fr)_minmax(260px,1fr)] xl:gap-12">
        {/*
          A section, not a card. The rows already carry their own hairlines, so a border
          around them is a second frame drawn over the first — and it is what made this
          block read as heavier than the page it summarises.
        */}
        <section className="flex min-w-0 flex-col gap-4">
          <div className="flex items-baseline justify-between gap-4 border-b border-border pb-3">
            <h2 className="text-sm font-medium">Recent reports</h2>
            <Link
              href="/reports"
              className="rounded-lg text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
            >
              View all
            </Link>
          </div>

          {runs.length === 0 ? (
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileTextIcon />
                </EmptyMedia>
                <EmptyTitle>No reports yet</EmptyTitle>
                <EmptyDescription>
                  A report profile plus a connected subscription is everything a
                  run needs.
                </EmptyDescription>
              </EmptyHeader>
              {canRequest ? (
                <EmptyContent>
                  <Link
                    href="/reports/new"
                    className={buttonVariants({ variant: "outline" })}
                  >
                    Request your first report
                  </Link>
                </EmptyContent>
              ) : null}
            </Empty>
          ) : (
            <RunTable
              variant="compact"
              runs={runs.map((run) =>
                toRunView(run, extras.get(run.id) ?? NO_RUN_VIEW_EXTRAS)
              )}
              subscriptions={subscriptions}
            />
          )}
        </section>

        <section className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-4 border-b border-border pb-3">
            <h2 className="text-sm font-medium">Connection health</h2>
            {subscriptions.length === 0 ? null : (
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {subscriptions.length}
              </span>
            )}
          </div>

          {subscriptions.length === 0 ? (
            <Empty className="py-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PlugsConnectedIcon />
                </EmptyMedia>
                <EmptyTitle>Nothing connected</EmptyTitle>
                <EmptyDescription>
                  Connect a subscription to discover what it holds.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Link
                  href="/subscriptions/new"
                  className={buttonVariants({ variant: "outline" })}
                >
                  Connect a source
                </Link>
              </EmptyContent>
            </Empty>
          ) : (
            <>
              <ul className="flex flex-col">
                {states
                  .slice(0, HEALTH_ROW_COUNT)
                  .map(({ subscription, state }) => (
                    <li
                      key={subscription.id}
                      data-slot="subscription-health"
                      data-state={state.kind}
                      className="flex items-start justify-between gap-3 border-b border-border py-3 last:border-b-0"
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <p className="truncate text-sm font-medium">
                          {subscription.displayName}
                        </p>
                        <p className="truncate font-mono text-xs text-muted-foreground tabular-nums">
                          {subscription.maskedSubscriptionId}
                        </p>
                      </div>

                      <Badge
                        variant={
                          state.kind === "active"
                            ? "secondary"
                            : state.kind === "expiring"
                              ? "outline"
                              : "destructive"
                        }
                        className="shrink-0"
                      >
                        {state.kind === "active"
                          ? "Connected"
                          : state.kind === "expiring"
                            ? `${state.wholeDaysRemaining}d left`
                            : state.kind}
                      </Badge>
                    </li>
                  ))}
              </ul>

              <Link
                href="/subscriptions"
                className="flex w-fit items-center gap-1 rounded-lg text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                Manage connections
                <ArrowUpRightIcon className="size-3.5" />
              </Link>
            </>
          )}
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-sm font-medium">
            A good report starts with a good profile.
          </h2>
          <p className="text-sm text-muted-foreground">
            Reuse your customer&rsquo;s scope, metrics, and document style.
          </p>
        </div>

        <Link
          data-slot="button"
          href="/report-profiles"
          className={buttonVariants({ variant: "outline" })}
        >
          Browse profiles
          <ArrowRightIcon />
        </Link>
      </div>
    </div>
  )
}
