import { PageBody } from "@/components/app-shell/page-body"
import { selectedFilter } from "@/lib/workspaces/context"
import type { Metadata } from "next"

import { LiveRefresh } from "@/components/reports/live-refresh"
import { RequestReportDialog } from "@/components/reports/request-report-dialog"
import { RunFilters, RunPagination } from "@/components/reports/run-filters"
import { RunTable } from "@/components/reports/run-table"
import { requireSession } from "@/lib/auth/guard"
import type { RunStatus } from "@/lib/db/schema"
import { NO_RUN_VIEW_EXTRAS, toRunView, toTemplateView } from "@/lib/db/views"
import { resolveFigureCounts, resolveRunExtrasBatch } from "@/lib/runs/detail"
import { RUN_STATUS_PRESENTATION } from "@/lib/runs/presentation"
import {
  RUN_PAGE_SIZE,
  countOwnedRuns,
  listOwnedRuns,
  type RunListQuery,
} from "@/lib/runs/state"
import { listConnectedSubscriptions } from "@/lib/subscriptions/store"
import { listTemplates, readLatestVersionForView } from "@/lib/templates/store"

/**
 * `/reports` — request a run, and see the ones already requested
 * (Requirements 36.10, 37.1, 37.4).
 *
 * A **server** component. It resolves the signed-in user, reads that user's runs and
 * subscriptions scoped by `user_id`, projects both to their browser-safe shapes, and
 * hands them down. Nothing here parses an event and nothing here writes.
 *
 * While any run on the page is still in flight, `LiveRefresh` re-reads the page on an
 * interval, so "In flight" turns into "Verified" without a reload.
 */

export const metadata: Metadata = {
  title: "Reports",
  description:
    "Request an infrastructure utilization report and review the runs already " +
    "requested.",
}

/**
 * The status groups a chip selects, and the only ones the URL admits.
 *
 * `running` is a group rather than a status: a consultant asking "what is in flight"
 * does not distinguish `collecting` from `verifying`.
 */
const STATUS_GROUPS = {
  all: [],
  completed: ["completed"],
  failed: ["failed"],
  running: ["queued", "claimed", "collecting", "compiling", "rendering", "verifying"],
} as const satisfies Record<string, readonly RunStatus[]>

type GroupKey = keyof typeof STATUS_GROUPS

function readGroup(raw: string | undefined): GroupKey {
  return raw !== undefined && raw in STATUS_GROUPS ? (raw as GroupKey) : "all"
}

/** A 1-based page from the URL, clamped to something a query can use. */
function readPage(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "1", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

export default async function ReportsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>
}>) {
  const user = await requireSession()
  const projectScope = await selectedFilter(user.id)

  // The filters live in the URL so the server can read them — this page's list pages
  // and filters in SQL.
  const params = await searchParams
  const group = readGroup(
    typeof params.status === "string" ? params.status : undefined
  )
  const search = typeof params.q === "string" ? params.q : ""
  const page = readPage(typeof params.page === "string" ? params.page : undefined)

  const query: RunListQuery = {
    ...projectScope,
    statuses: STATUS_GROUPS[group],
    search,
    limit: RUN_PAGE_SIZE,
    offset: (page - 1) * RUN_PAGE_SIZE,
  }

  // Both reads scoped by `user_id` (Requirements 9.7, 36.10), and both projected. The
  // chip counts share the search term but not the status, so each says how much *that*
  // chip would show.
  const [runs, total, counts, subscriptions, templateRows] = await Promise.all([
    listOwnedRuns(user.id, query),
    countOwnedRuns(user.id, { ...projectScope, statuses: STATUS_GROUPS[group], search }),
    (async () => {
      const entries = await Promise.all(
        (Object.keys(STATUS_GROUPS) as GroupKey[]).map(
          async (key) =>
            [
              key,
              await countOwnedRuns(user.id, {
                ...projectScope,
                statuses: STATUS_GROUPS[key],
                search,
              }),
            ] as const
        )
      )
      return Object.fromEntries(entries) as Record<GroupKey, number>
    })(),
    listConnectedSubscriptions(user.id, projectScope),
    listTemplates(user.id, projectScope),
  ])

  // The **highest existing** version per template, which is what the enqueue pins
  // (Requirement 9.6).
  const templates = await Promise.all(
    templateRows.map(async (row) =>
      toTemplateView(row, (await readLatestVersionForView(user.id, row.id)) ?? null)
    )
  )

  // Requirement 37.1 — the template name, the pinned version and the verification
  // status per run, plus the figures each passing verification proved; one query each
  // for the whole page.
  const [runExtras, figures] = await Promise.all([
    resolveRunExtrasBatch(runs),
    resolveFigureCounts(runs),
  ])

  const now = new Date()
  const anyInFlight = runs.some((run) => RUN_STATUS_PRESENTATION[run.status].inFlight)

  return (
    <PageBody kind="wide">
      <LiveRefresh active={anyInFlight} />

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-title">Reports</h1>
          <p className="max-w-[62ch] text-meta text-muted-foreground">
            Every run, grouped by the period it reports on. A report is only
            offered for download once every figure in it is proven.
          </p>
        </div>

        <RequestReportDialog
          subscriptions={subscriptions}
          templates={templates}
          nowIso={now.toISOString()}
        />
      </header>

      <section aria-label="Runs" className="flex flex-col gap-4">
        <RunFilters
          total={total}
          shown={runs.length}
          offset={query.offset ?? 0}
          counts={counts}
        />

        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <RunTable
            runs={runs.map((run) =>
              toRunView(run, runExtras.get(run.id) ?? NO_RUN_VIEW_EXTRAS)
            )}
            subscriptions={subscriptions}
            figures={figures}
          />
        </div>

        {/* After the rows, not before them. */}
        <RunPagination
          total={total}
          offset={query.offset ?? 0}
          pageSize={RUN_PAGE_SIZE}
        />
      </section>
    </PageBody>
  )
}
