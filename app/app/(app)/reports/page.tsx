import type { Metadata } from "next"

import { RequestReportDialog } from "@/components/reports/request-report-dialog"
import { RunFilters } from "@/components/reports/run-filters"
import { RunTable } from "@/components/reports/run-table"
import { requireSession } from "@/lib/auth/guard"
import type { RunStatus } from "@/lib/db/schema"
import { NO_RUN_VIEW_EXTRAS, toRunView, toTemplateView } from "@/lib/db/views"
import { resolveRunExtrasBatch } from "@/lib/runs/detail"
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

/**
 * The status groups a chip selects, and the only ones the URL admits.
 *
 * `running` is a group rather than a status: a consultant asking "what is in
 * flight" does not distinguish `collecting` from `verifying`, and offering five
 * chips for one question would be five chips.
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

  // The filters live in the URL so the server can read them — this page's list
  // pages and filters in SQL, and a filter held in client state could only ever
  // narrow the rows already fetched.
  const params = await searchParams
  const group = readGroup(
    typeof params.status === "string" ? params.status : undefined
  )
  const search = typeof params.q === "string" ? params.q : ""
  const page = readPage(typeof params.page === "string" ? params.page : undefined)

  const query: RunListQuery = {
    statuses: STATUS_GROUPS[group],
    search,
    limit: RUN_PAGE_SIZE,
    offset: (page - 1) * RUN_PAGE_SIZE,
  }

  // Both reads scoped by `user_id` (Requirements 9.7, 36.10), and both projected: only
  // `RunView` and `ConnectedSubscriptionView` cross to the browser, so the unmasked
  // subscription id, the tenant id, the client id, the ciphertext, `progress_token_hash`,
  // `dedupe_key` and the requested scope are absent by construction.
  // The chip counts share the search term but not the status, so each says how
  // much *that* chip would show rather than how much the current view holds.
  const [runs, total, counts, subscriptions, templateRows] = await Promise.all([
    listOwnedRuns(user.id, query),
    countOwnedRuns(user.id, { statuses: STATUS_GROUPS[group], search }),
    (async () => {
      const entries = await Promise.all(
        (Object.keys(STATUS_GROUPS) as GroupKey[]).map(
          async (key) =>
            [
              key,
              await countOwnedRuns(user.id, {
                statuses: STATUS_GROUPS[key],
                search,
              }),
            ] as const
        )
      )
      return Object.fromEntries(entries) as Record<GroupKey, number>
    })(),
    listConnectedSubscriptions(user.id),
    listTemplates(user.id),
  ])

  // The **highest existing** version per template, which is what the enqueue
  // pins (Requirement 9.6) — not the cached `current_version_id`, so the version
  // number the form shows is the one a run would actually use.
  //
  // `readLatestVersionForView` rather than `readLatestVersion`: the form needs the
  // definition's `schema_version` to know whether to ask for the per-run
  // front-matter values a v2 template requires (Requirement 13.14), and that read
  // projects the one scalar in SQL instead of pulling N whole block trees over to
  // decide N option labels.
  const templates = await Promise.all(
    templateRows.map(async (row) =>
      toTemplateView(row, (await readLatestVersionForView(user.id, row.id)) ?? null)
    )
  )

  // Requirement 37.1 — the template name, the pinned version and the
  // verification status, per run, in two queries rather than two per row.
  const runExtras = await resolveRunExtrasBatch(runs)

  const now = new Date()

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-medium tracking-tight">
          Reports
        </h1>

        <p className="max-w-prose text-sm text-muted-foreground">
          A run collects CPU, memory, disk and network for every resource a
          template scopes, over the period that template&rsquo;s own rule
          resolves to, then writes one immutable snapshot. Every figure in the
          report traces back to a row in that snapshot.
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-heading text-sm font-medium tracking-tight">
            Run history
          </h2>

          <RequestReportDialog
            subscriptions={subscriptions}
            templates={templates}
            nowIso={now.toISOString()}
          />
        </div>

        <RunFilters
          total={total}
          shown={runs.length}
          offset={query.offset ?? 0}
          pageSize={RUN_PAGE_SIZE}
          counts={counts}
        />

        <RunTable
          runs={runs.map((run) =>
            toRunView(run, runExtras.get(run.id) ?? NO_RUN_VIEW_EXTRAS)
          )}
          subscriptions={subscriptions}
        />
      </section>
    </div>
  )
}
