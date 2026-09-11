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
  Card,
  CardContent,
  CardAction,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
        `divide-*` rather than `border-r` on each cell. The old set put a right border on
        every figure including the last of each row, so the 2-column phone layout showed
        a rule down the middle and a second one hanging off the right edge.
      */}
      <Card>
        <CardContent className="grid grid-cols-2 gap-px bg-border p-px sm:grid-cols-4">
          {figures.map(({ label, value, alarming }) => (
            <div
              key={label}
              data-slot="dashboard-figure"
              className="flex flex-col gap-1.5 bg-card px-5 py-5"
            >
              <p className="text-[11px] tracking-wider text-muted-foreground uppercase">
                {label}
              </p>
              <p
                data-slot="dashboard-stat"
                className={cn(
                  "font-mono text-3xl leading-none font-medium tracking-tight tabular-nums",
                  alarming && "text-destructive"
                )}
              >
                {value}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.85fr)_minmax(280px,1fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Recent reports</CardTitle>
            <CardAction className="self-center">
              <Link
                href="/reports"
                className="rounded-lg text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                View all
              </Link>
            </CardAction>
          </CardHeader>

          <CardContent className="min-w-0 px-0">
            {runs.length === 0 ? (
              <Empty className="py-8">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileTextIcon />
                  </EmptyMedia>
                  <EmptyTitle>No reports yet</EmptyTitle>
                  <EmptyDescription>
                    A report profile plus a connected subscription is everything
                    a run needs.
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Connection health</CardTitle>
            {subscriptions.length === 0 ? null : (
              <CardAction className="self-center">
                <Badge variant="secondary" className="tabular-nums">
                  {subscriptions.length}
                </Badge>
              </CardAction>
            )}
          </CardHeader>

          <CardContent>
            {subscriptions.length === 0 ? (
              <Empty className="py-4">
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
              <ul className="flex flex-col">
                {states.slice(0, HEALTH_ROW_COUNT).map(({ subscription, state }) => (
                  <li
                    key={subscription.id}
                    data-slot="subscription-health"
                    data-state={state.kind}
                    className="flex items-start justify-between gap-3 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0"
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
            )}
          </CardContent>

          {subscriptions.length === 0 ? null : (
            <CardFooter>
              <Link
                href="/subscriptions"
                className="flex items-center gap-1 rounded-lg text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                Manage connections
                <ArrowUpRightIcon className="size-3.5" />
              </Link>
            </CardFooter>
          )}
        </Card>
      </div>

      <Card className="border-primary/25 bg-primary/4">
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-base font-semibold">
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
        </CardContent>
      </Card>
    </div>
  )
}
