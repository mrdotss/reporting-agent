import Link from "next/link"
import {
  ArrowRightIcon,
  WarningCircleIcon,
  PlugsConnectedIcon,
} from "@phosphor-icons/react/ssr"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { RunTable } from "@/components/reports/run-table"
import { selectedContext } from "@/lib/workspaces/context"
import { getPool } from "@/lib/db"
import { listOwnedRuns } from "@/lib/runs/state"
import { listConnectedSubscriptions } from "@/lib/subscriptions/store"
import { resolveRunExtrasBatch } from "@/lib/runs/detail"
import { NO_RUN_VIEW_EXTRAS, toRunView } from "@/lib/db/views"
import { resolveSubscriptionState } from "@/lib/subscriptions/state"
import { can } from "@/lib/workspaces/policy"
export async function WorkspaceOverview({ userId }: { userId: string }) {
  const { workspace, project } = await selectedContext(userId),
    now = new Date()
  const scope = { workspaceId: workspace.id, projectId: project?.id }
  const [runs, subscriptions, stats] = await Promise.all([
    listOwnedRuns(userId, { ...scope, limit: 5 }),
    listConnectedSubscriptions(userId, scope),
    getPool().query(
      `select count(*) filter(where r.status='completed')::int completed,count(*) filter(where r.status='failed')::int failed,count(*) filter(where r.status not in ('completed','failed'))::int running from report_runs r join workspace_members m on m.workspace_id=r.workspace_id where m.user_id=$1 and r.workspace_id=$2 and ($3::text is null or r.project_id=$3) and r.created_at>=now()-interval '30 days'`,
      [userId, workspace.id, project?.id ?? null]
    ),
  ])
  const extras = await resolveRunExtrasBatch(runs),
    counts = stats.rows[0],
    issues = subscriptions.filter(
      (s) => resolveSubscriptionState(s, now).kind !== "active"
    )
  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
            {project?.name ?? "All customer projects"}
          </p>
          <h1>A clear view of your reporting.</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Monitor delivery, keep connections healthy, and prepare your next
            report.
          </p>
        </div>
        {project && !project.archivedAt && can(workspace.role, "edit") && (
          <Link
            data-slot="button"
            href="/reports/new"
            className={buttonVariants()}
          >
            Request report
            <ArrowRightIcon />
          </Link>
        )}
      </div>
      {issues.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300/50 bg-amber-50 p-4 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="flex items-center gap-3">
            <WarningCircleIcon className="size-5" />
            <div>
              <p className="text-sm font-semibold">
                {issues.length} connection
                {issues.length === 1 ? " needs" : "s need"} your attention
              </p>
              <p className="text-xs">
                Review credentials and verification before requesting a report.
              </p>
            </div>
          </div>
          <Link
            data-slot="button"
            href="/subscriptions"
            className={buttonVariants({ variant: "ghost" })}
          >
            Review connections →
          </Link>
        </div>
      )}
      <div>
        <p className="mb-3 text-xs text-muted-foreground">
          Report activity · last 30 days
        </p>
        <Card>
          <CardContent className="grid grid-cols-2 gap-0 p-0 md:grid-cols-4">
            {[
              ["Completed reports", counts.completed],
              ["In progress", counts.running],
              ["Failed reports", counts.failed],
              ["Connected sources", subscriptions.length],
            ].map(([label, value]) => (
              <div key={label} className="border-r p-6 last:border-r-0">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-2 font-mono text-3xl font-medium tracking-tight tabular-nums">
                  {value}
                </p>
                {label === "Connected sources" && (
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Current total
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.8fr)_minmax(280px,1fr)]">
        <Card className="min-w-0">
          <CardContent className="px-0 pt-6">
            <div className="mb-5 flex items-center justify-between px-6">
              <div>
                <h2 className="text-base font-semibold">Recent reports</h2>
                <p className="text-xs text-muted-foreground">
                  Latest requests · all periods
                </p>
              </div>
              <Link
                href="/reports"
                className="text-xs font-medium text-primary"
              >
                View all →
              </Link>
            </div>
            <div className="overflow-x-auto">
              <RunTable
                runs={runs.map((r) =>
                  toRunView(r, extras.get(r.id) ?? NO_RUN_VIEW_EXTRAS)
                )}
                subscriptions={subscriptions}
              />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <h2 className="mb-4 text-base font-semibold">Connection health</h2>
            {subscriptions.length === 0 ? (
              <div className="space-y-3 py-4">
                <PlugsConnectedIcon className="size-7 text-primary" />
                <p className="text-sm text-muted-foreground">
                  Connect your first subscription to discover resources.
                </p>
                <Link
                  href="/subscriptions/new"
                  className="text-sm text-primary"
                >
                  Connect source →
                </Link>
              </div>
            ) : (
              subscriptions.slice(0, 5).map((s) => {
                const state = resolveSubscriptionState(s, now)
                return (
                  <div
                    key={s.id}
                    className="flex justify-between gap-3 border-t py-4"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {s.displayName}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        Microsoft Azure
                      </p>
                    </div>
                    <span className="h-fit rounded-md bg-muted px-2 py-1 text-xs">
                      {state.kind === "active"
                        ? "Connected"
                        : state.kind === "expiring"
                          ? `Expires in ${state.wholeDaysRemaining}d`
                          : state.kind}
                    </span>
                  </div>
                )
              })
            )}
            <Link
              href="/subscriptions"
              className="mt-4 inline-block text-xs font-medium text-primary"
            >
              Manage connections →
            </Link>
          </CardContent>
        </Card>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-primary/5 p-6">
        <div>
          <h2 className="text-base font-semibold">
            A good report starts with a good profile.
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Reuse your customer’s scope, metrics, and document style.
          </p>
        </div>
        <Link
          data-slot="button"
          href="/report-profiles"
          className={buttonVariants({ variant: "outline" })}
        >
          Browse profiles →
        </Link>
      </div>
    </div>
  )
}
