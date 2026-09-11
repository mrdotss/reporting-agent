import Link from "next/link"

import { RunStatusBadge } from "@/components/reports/run-status-badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { ConnectedSubscriptionView, RunView } from "@/lib/db/views"
import { messageText } from "@/lib/messages/catalog"
import { periodLine } from "@/lib/runs/presentation"

/**
 * The run history, as a table (task 2.2).
 *
 * ## Why this replaced the card list
 *
 * A run carries six things worth scanning — profile, connection, period,
 * resources, gaps, when — and as a card each one is a labelled `<dl>` entry, so a
 * single run occupied a block and eleven runs occupied a screen. Nothing about a
 * run is prose; it is six aligned values, which is a row.
 *
 * The page it lives on is the one a consultant opens to *read history*, so the
 * shape that scales is the one that matters: this pages at
 * `RUN_PAGE_SIZE`, and its filters run in SQL rather than over the page already
 * fetched. A filter applied after the read would answer "no runs" for a profile
 * whose runs are on page three.
 *
 * A **server** component. The toolbar beside it owns the interaction and pushes
 * search params; this only renders what the page read back.
 *
 * ## Columns drop out rather than scrolling out
 *
 * Seven columns do not fit a phone, and they did not fit the dashboard's left column
 * either — that surface wrapped the table in `overflow-x-auto`, so the status of every
 * run, the rightmost column, was off-screen on the page whose job is to show you the
 * status of every run.
 *
 * A horizontal scrollbar inside a card is the wrong answer twice: it hides the column
 * that matters most, and nothing on the page tells you it is there. So each column
 * declares the width it earns its place at, and the two that always render are the two
 * you came for — which report, and how it went.
 *
 * `variant="compact"` is the dashboard's: four columns at most, because that surface is
 * a summary with a "View all" link under it, not the history.
 */

function subscriptionName(
  run: RunView,
  byId: ReadonlyMap<string, ConnectedSubscriptionView>
): string {
  return (
    byId.get(run.connectedSubscriptionId)?.displayName ??
    (messageText("ui.run_list.subscription_removed", "en") ?? "")
  )
}

export function RunTable({
  runs,
  subscriptions,
  variant = "full",
}: Readonly<{
  runs: readonly RunView[]
  subscriptions: readonly ConnectedSubscriptionView[]
  /** `compact` drops the columns a summary does not need. Defaults to the history's. */
  variant?: "full" | "compact"
}>) {
  const byId = new Map(
    subscriptions.map((subscription) => [subscription.id, subscription])
  )

  const compact = variant === "compact"

  // Declared once and spread onto the header and the cell together: a column that
  // disappears at a width its header does not is a header over the wrong values.
  const connectionAt = compact ? "hidden" : "hidden lg:table-cell"
  const resourcesAt = compact ? "hidden" : "hidden sm:table-cell"
  const gapsAt = "hidden sm:table-cell"
  const startedAt = compact ? "hidden" : "hidden xl:table-cell"

  return (
    <Table aria-label={messageText("ui.run_list.aria_label", "en") ?? undefined}>
      <TableHeader>
        <TableRow>
          <TableHead>{messageText("ui.run_table.profile", "en")}</TableHead>
          <TableHead className={connectionAt}>
            {messageText("ui.run_table.connection", "en")}
          </TableHead>
          <TableHead>{messageText("ui.run_list.period", "en")}</TableHead>
          <TableHead className={`w-24 text-right ${resourcesAt}`}>
            {messageText("ui.run_list.resources", "en")}
          </TableHead>
          <TableHead className={`w-20 text-right ${gapsAt}`}>
            {messageText("ui.run_list.gaps", "en")}
          </TableHead>
          <TableHead className={`w-40 ${startedAt}`}>
            {messageText("ui.run_list.started", "en")}
          </TableHead>
          <TableHead className="w-28 text-right">
            {messageText("ui.run_table.status", "en")}
          </TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id} data-slot="run-row" data-run-status={run.status}>
            <TableCell>
              <Link
                href={`/reports/${run.id}`}
                className="rounded-lg font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                {run.templateName ?? "—"}
              </Link>
              {/*
                In compact the connection has no column of its own, and a run without
                one named is a run you cannot tell from the next customer's. So it moves
                under the profile, where the version already sits.
              */}
              {compact ? (
                <p className="truncate text-xs text-muted-foreground">
                  {subscriptionName(run, byId)}
                </p>
              ) : null}

              {run.templateVersion === null ? null : (
                <p className="font-mono text-xs text-muted-foreground tabular-nums">
                  {messageText("ui.run_table.version_prefix", "en")}{" "}
                  {run.templateVersion}
                </p>
              )}
            </TableCell>

            <TableCell className={`text-sm text-muted-foreground ${connectionAt}`}>
              {subscriptionName(run, byId)}
            </TableCell>

            {/* The zone travels with the dates: "July" means July there. */}
            <TableCell className="font-mono text-xs tabular-nums">
              {periodLine(run)}
            </TableCell>

            <TableCell className={`text-right font-mono tabular-nums ${resourcesAt}`}>
              {run.resourceCount ?? "—"}
            </TableCell>

            <TableCell className={`text-right font-mono tabular-nums ${gapsAt}`}>
              {run.gapCount ?? "—"}
            </TableCell>

            {/*
              The UTC calendar date and minute, with the zone named. Not
              locale-formatted: a locale format differs between the server pass
              and the browser, which on a list that re-renders would flicker.
            */}
            <TableCell className={`font-mono text-xs tabular-nums ${startedAt}`}>
              {run.createdAt.slice(0, 16).replace("T", " ")}
              <span className="ml-1 text-muted-foreground">
                {messageText("ui.run_list.utc_suffix", "en")}
              </span>
            </TableCell>

            <TableCell className="text-right">
              <RunStatusBadge status={run.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
