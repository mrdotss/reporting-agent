import Link from "next/link"

import { RunStatusBadge } from "@/components/reports/run-status-badge"
import { ProviderMark } from "@/components/subscriptions/provider-mark"
import { StatusBadge } from "@/components/ui/status-mark"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { monthName } from "@/lib/close/period"
import type { ConnectedSubscriptionView, RunView } from "@/lib/db/views"
import type { DeliveryState } from "@/lib/delivery/store"
import { messageText } from "@/lib/messages/catalog"
import {
  RUN_STATUS_PRESENTATION,
  periodLine,
  relativeInstant,
} from "@/lib/runs/presentation"
import { cn } from "@/lib/utils"

/**
 * The run history, as a table (task 2.2).
 *
 * A run carries a handful of aligned values — preset, connector, period, resources, gaps,
 * figures, when — which is a row, not a card. The page pages at `RUN_PAGE_SIZE` and its
 * filters run in SQL, so a filter never answers "no runs" for a preset whose runs are on
 * page three.
 *
 * A **server** component. The toolbar beside it owns the interaction and pushes search
 * params; this only renders what the page read back.
 *
 * ## Columns drop out rather than scrolling out
 *
 * The two that always render are the two a reader came for: which report, and how it
 * went. Every other column declares the width it earns its place at.
 *
 * ## Who it is for, and whether they have it
 *
 * The preset name carries the connector's source mark and the customer it was run for, so
 * a consultant with several customers reads "which report, for whom" in one cell. A
 * verified run says beneath its badge whether the customer has been sent it yet: the list
 * is where the month's remaining sends are found, and opening each report to check was
 * the only way before.
 *
 * ## Time is local
 *
 * "Started" reads in Asia/Jakarta, the zone every period on this page is resolved in, so
 * a run requested at 09:00 on the 14th says so rather than 02:00 UTC. The exact UTC
 * instant is kept in the cell's `title`.
 *
 * ## In flight is one word
 *
 * Five in-flight statuses mean one thing to someone scanning a list: it is still going.
 * The badge says "In flight" and the phase it is in sits beneath it; the page re-reads
 * itself while any row is moving.
 */

const LOCAL_ZONE = "Asia/Jakarta"

const localStarted = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: LOCAL_ZONE,
})

function subscriptionName(
  run: RunView,
  byId: ReadonlyMap<string, ConnectedSubscriptionView>
): string {
  return (
    byId.get(run.connectedSubscriptionId)?.displayName ??
    (messageText("ui.run_list.subscription_removed", "en") ?? "")
  )
}

const sentOn = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: LOCAL_ZONE,
})

/**
 * The line under a verified run's badge: sent, partly sent, failed, or not yet. Only a
 * verified run of a customer can be sent, so every other run gets no line at all.
 */
function deliveryLine(
  run: RunView,
  delivery: DeliveryState | undefined
): { text: string; tone: string } | null {
  if (run.status !== "completed" || run.projectId === null || run.projectId === undefined) {
    return null
  }
  if (delivery === undefined) {
    return {
      text: messageText("ui.run_table.delivery_not_sent", "en") ?? "",
      tone: "text-(--status-attention)",
    }
  }
  const on = sentOn.format(new Date(delivery.approvedAt))
  if (delivery.status === "failed") {
    return { text: messageText("ui.run_table.delivery_failed", "en") ?? "", tone: "text-destructive" }
  }
  const label =
    delivery.status === "partial"
      ? messageText("ui.run_table.delivery_partial", "en")
      : messageText("ui.run_table.delivery_sent", "en")
  return { text: `${label ?? ""} ${on}`, tone: "text-muted-foreground" }
}

export function RunTable({
  runs,
  subscriptions,
  figures,
  customers,
  deliveries,
  variant = "full",
}: Readonly<{
  runs: readonly RunView[]
  subscriptions: readonly ConnectedSubscriptionView[]
  /** Figures proven by each run's passing verification, by run id. */
  figures?: ReadonlyMap<string, number>
  /** Customer names by project id; a run with no customer shows none. */
  customers?: ReadonlyMap<string, string>
  /** The latest send of each run, by run id; a run never sent is absent. */
  deliveries?: ReadonlyMap<string, DeliveryState>
  /** `compact` drops the columns a summary does not need. Defaults to the history's. */
  variant?: "full" | "compact"
}>) {
  const byId = new Map(
    subscriptions.map((subscription) => [subscription.id, subscription])
  )

  const compact = variant === "compact"

  // Read once for the whole table, so every row in one render is relative to the same
  // instant.
  const now = new Date()

  // Declared once and spread onto the header and the cell together.
  const connectionAt = compact ? "hidden" : "hidden lg:table-cell"
  const resourcesAt = compact ? "hidden" : "hidden sm:table-cell"
  const gapsAt = "hidden sm:table-cell"
  const figuresAt = compact ? "hidden" : "hidden md:table-cell"
  const startedAt = compact ? "w-24 text-right" : "hidden xl:table-cell"

  const headCell = compact ? "h-8 px-0 first:pl-0 last:pr-0" : ""
  const bodyCell = compact ? "py-2.5 px-0 first:pl-0 last:pr-0" : ""

  // Grouped by the month each run reports on, in the order the months first appear —
  // the list is newest first, so the open period leads.
  const groups = new Map<string, RunView[]>()
  for (const run of runs) {
    const month = run.periodStart.slice(0, 7)
    const list = groups.get(month)
    if (list) list.push(run)
    else groups.set(month, [run])
  }

  return (
    <Table aria-label={messageText("ui.run_list.aria_label", "en") ?? undefined}>
      <TableHeader>
        <TableRow>
          <TableHead className={headCell}>
            {messageText("ui.run_table.profile", "en")}
          </TableHead>
          <TableHead className={cn(connectionAt, headCell)}>
            {messageText("ui.run_table.connection", "en")}
          </TableHead>
          <TableHead className={headCell}>
            {messageText("ui.run_list.period", "en")}
          </TableHead>
          <TableHead className={cn("w-24 text-right", resourcesAt, headCell)}>
            {messageText("ui.run_list.resources", "en")}
          </TableHead>
          <TableHead className={cn("w-20 text-right", gapsAt, headCell)}>
            {messageText("ui.run_list.gaps", "en")}
          </TableHead>
          <TableHead className={cn("w-24 text-right", figuresAt, headCell)}>
            {messageText("ui.run_table.figures", "en")}
          </TableHead>
          <TableHead className={cn("w-44", startedAt, headCell)}>
            {messageText("ui.run_list.started", "en")}
          </TableHead>
          <TableHead className={cn("w-32 text-right", headCell)}>
            {messageText("ui.run_table.status", "en")}
          </TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {[...groups].flatMap(([month, monthRuns]) => [
          compact ? null : (
            <TableRow
              key={`period-${month}`}
              data-slot="run-period-group"
              className="hover:bg-transparent"
            >
              <TableHead
                colSpan={8}
                scope="colgroup"
                className="h-8 bg-muted text-xs font-semibold text-muted-foreground"
              >
                {monthName(month)}
                <span className="ml-2 font-mono font-medium tabular-nums">
                  {monthRuns.length} {monthRuns.length === 1 ? "run" : "runs"}
                </span>
              </TableHead>
            </TableRow>
          ),
          ...monthRuns.map((run) => {
            const inFlight = RUN_STATUS_PRESENTATION[run.status].inFlight
            const figureCount = figures?.get(run.id)
            const started = new Date(run.createdAt)
            const subscription = byId.get(run.connectedSubscriptionId)
            const customer =
              run.projectId === null || run.projectId === undefined
                ? undefined
                : customers?.get(run.projectId)
            const sent = deliveryLine(run, deliveries?.get(run.id))

            return (
              <TableRow key={run.id} data-slot="run-row" data-run-status={run.status}>
                <TableCell className={bodyCell}>
                  <div className="flex items-start gap-2.5">
                    {subscription === undefined ? null : (
                      <ProviderMark
                        kind={subscription.provider}
                        className="mt-0.5 shrink-0 [&_svg]:size-4"
                      />
                    )}
                    <div className="flex min-w-0 flex-col">
                      <Link
                        href={`/reports/${run.id}`}
                        className="rounded-lg font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
                      >
                        {run.templateName ?? "—"}
                      </Link>
                      {compact ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {subscriptionName(run, byId)}
                        </p>
                      ) : null}

                      {customer === undefined && run.templateVersion === null ? null : (
                        <p className="truncate text-xs text-muted-foreground">
                          {customer}
                          {customer !== undefined && run.templateVersion !== null ? " · " : null}
                          {run.templateVersion === null ? null : (
                            <span className="font-mono tabular-nums">
                              {messageText("ui.run_table.version_prefix", "en")}{" "}
                              {run.templateVersion}
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                </TableCell>

                <TableCell
                  className={cn("text-sm text-muted-foreground", connectionAt, bodyCell)}
                >
                  {subscriptionName(run, byId)}
                </TableCell>

                {/* The zone travels with the dates: "July" means July there. */}
                <TableCell className={cn("font-mono text-xs tabular-nums", bodyCell)}>
                  {periodLine(run)}
                </TableCell>

                <TableCell
                  className={cn("text-right font-mono tabular-nums", resourcesAt, bodyCell)}
                >
                  {run.resourceCount ?? "—"}
                </TableCell>

                <TableCell
                  className={cn("text-right font-mono tabular-nums", gapsAt, bodyCell)}
                >
                  {run.gapCount ?? "—"}
                </TableCell>

                <TableCell
                  className={cn("text-right font-mono tabular-nums", figuresAt, bodyCell)}
                >
                  {figureCount === undefined
                    ? "—"
                    : figureCount.toLocaleString("en-US")}
                </TableCell>

                <TableCell
                  className={cn("text-xs tabular-nums", startedAt, bodyCell)}
                  title={`${run.createdAt.slice(0, 16).replace("T", " ")} UTC`}
                >
                  {compact ? (
                    <span className="text-muted-foreground">
                      {relativeInstant(run.createdAt, now)}
                    </span>
                  ) : (
                    <span className="flex flex-col">
                      <span className="font-mono">
                        {localStarted.format(started)}{" "}
                        <span className="text-muted-foreground">
                          {messageText("ui.run_table.local_zone", "en")}
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        {relativeInstant(run.createdAt, now)}
                      </span>
                    </span>
                  )}
                </TableCell>

                <TableCell className={cn("text-right", bodyCell)}>
                  {inFlight ? (
                    <span className="inline-flex flex-col items-end gap-0.5">
                      <StatusBadge
                        data-slot="run-status-badge"
                        data-status={run.status}
                        state={run.status === "queued" ? "queued" : "running"}
                        label="In flight"
                      />
                      <span className="text-xs text-muted-foreground">
                        {RUN_STATUS_PRESENTATION[run.status].label}
                      </span>
                    </span>
                  ) : (
                    <span className="inline-flex flex-col items-end gap-0.5">
                      <RunStatusBadge status={run.status} />
                      {sent === null ? null : (
                        <span
                          data-slot="run-delivery"
                          className={cn("text-xs", sent.tone)}
                        >
                          {sent.text}
                        </span>
                      )}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            )
          }),
        ])}
      </TableBody>
    </Table>
  )
}
