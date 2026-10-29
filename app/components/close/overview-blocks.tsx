import Link from "next/link"
import { ArrowRightIcon } from "@phosphor-icons/react/ssr"

import { ProviderMark } from "@/components/subscriptions/provider-mark"
import type { ActionTally, DeliveredMonth, UpcomingRun } from "@/lib/close/blocks"
import type { ActivityItem, ConnectorHealth } from "@/lib/close/overview"
import { monthName } from "@/lib/close/period"
import { relativeInstant } from "@/lib/runs/presentation"
import { cn } from "@/lib/utils"

/**
 * The blocks under the close board: what runs next, whether each connector can still
 * read, what happened lately, six months of delivery, and where the open actions are.
 *
 * Server-rendered from data the page already loads, so they cost no client JavaScript
 * and never disagree with the board above them.
 */
export function OverviewBlocks({
  upcoming,
  connectors,
  activity,
  delivered,
  actions,
  now,
}: Readonly<{
  upcoming: readonly UpcomingRun[]
  connectors: readonly ConnectorHealth[]
  activity: readonly ActivityItem[]
  delivered: readonly DeliveredMonth[]
  actions: ActionTally
  now: Date
}>) {
  return (
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      <Block id="coming-up" eyebrow="Schedules" title="Coming up">
        {upcoming.length === 0 ? (
          <Quiet>No customers yet.</Quiet>
        ) : (
          <ul className="flex flex-col">
            {upcoming.map((run) => (
              <li key={run.projectId} className="flex items-center gap-3 border-t border-border/60 py-2.5 first:border-t-0">
                <DateChip next={run.next} />
                <div className="flex min-w-0 flex-col gap-px">
                  <span className="truncate text-sm font-medium">{run.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {run.next === null
                      ? "No schedule yet, so request it by hand."
                      : `${run.preset ?? "Report"} · runs at ${run.next.split(", ")[1] ?? ""} WIB on its own`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block
        id="connector-health"
        eyebrow="Connectors"
        title="Connector health"
        more={{ href: "/subscriptions", label: "All connectors" }}
      >
        {connectors.length === 0 ? (
          <Quiet>No connectors yet.</Quiet>
        ) : (
          <ul className="flex flex-col">
            {connectors.map((connector) => (
              <li key={connector.id} className="flex items-center gap-3 border-t border-border/60 py-2.5 first:border-t-0">
                <ProviderMark kind={connector.provider} />
                <div className="flex min-w-0 flex-1 flex-col gap-px">
                  <Link
                    href={`/subscriptions?c=${encodeURIComponent(connector.id)}`}
                    className="truncate rounded-sm font-mono text-sm font-semibold outline-none hover:underline hover:decoration-border hover:underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring/30"
                  >
                    {connector.displayName}
                  </Link>
                  <span className="truncate text-xs text-muted-foreground">
                    {connector.scannedAt
                      ? `Scanned ${relativeInstant(connector.scannedAt, now)}${connector.resourceCount === null ? "" : ` · ${connector.resourceCount.toLocaleString("en-US")} resources`}`
                      : "Not scanned yet"}
                  </span>
                </div>
                <ConnectorLife connector={connector} now={now} />
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block id="recent-activity" eyebrow="Activity" title="Recent activity" className="md:col-span-2 xl:col-span-1">
        {activity.length === 0 ? (
          <Quiet>Nothing has happened in this workspace yet.</Quiet>
        ) : (
          <ol className="flex flex-col">
            {activity.map((item) => (
              <li key={item.key} className="flex items-start gap-3 border-t border-border/60 py-2.5 first:border-t-0">
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    item.kind === "failed"
                      ? "bg-(--status-failed)"
                      : item.kind === "scanned"
                        ? "bg-(--status-inflight)"
                        : "bg-(--status-verified)"
                  )}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="text-sm">
                    {item.href ? (
                      <Link
                        href={item.href}
                        className="rounded-sm font-medium outline-none hover:underline hover:decoration-border hover:underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring/30"
                      >
                        {item.subject}
                      </Link>
                    ) : (
                      <span className="font-medium">{item.subject}</span>
                    )}{" "}
                    <span className="text-muted-foreground">{activityText(item)}</span>
                  </span>
                </div>
                <time dateTime={item.at} className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                  {relativeInstant(item.at, now)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </Block>

      <Block
        id="delivered-by-month"
        eyebrow="Six months"
        title="Delivered by month"
        className="md:col-span-2"
      >
        <DeliveredChart months={delivered} />
      </Block>

      <Block id="open-actions" eyebrow="Actions" title="Open actions" className="md:col-span-2 xl:col-span-1">
        <p className="flex items-baseline gap-2">
          <span className="font-mono text-figure font-medium tracking-[-0.03em] tabular-nums">
            {actions.total.toLocaleString("en-US")}
          </span>
          <span className="text-sm text-muted-foreground">open across every customer</span>
        </p>
        <ul className="flex flex-col gap-2.5">
          {actions.byCustomer.map((row) => (
            <li key={row.projectId} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
              <span className="truncate">{row.name}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${actions.total === 0 ? 0 : Math.round((row.open / actions.total) * 100)}%` }}
                />
              </span>
              <span className="font-mono text-xs tabular-nums">{row.open === 0 ? "–" : row.open}</span>
            </li>
          ))}
        </ul>
        <p className="text-meta text-muted-foreground">
          Right-sizing, backup and access fixes found in each report.
        </p>
      </Block>
    </div>
  )
}

function Block({
  id,
  eyebrow,
  title,
  more,
  className,
  children,
}: Readonly<{
  id: string
  eyebrow: string
  title: string
  more?: { href: string; label: string }
  className?: string
  children: React.ReactNode
}>) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn("flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4", className)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-micro text-muted-foreground uppercase">{eyebrow}</span>
          <h2 id={`${id}-title`} className="text-section">
            {title}
          </h2>
        </div>
        {more ? (
          <Link
            href={more.href}
            className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-primary outline-none hover:underline hover:underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            {more.label}
            <ArrowRightIcon aria-hidden="true" className="size-3" />
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function Quiet({ children }: Readonly<{ children: React.ReactNode }>) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}

/** "1 Nov, 02:00" as a small calendar tile, or a dash for no schedule. */
function DateChip({ next }: Readonly<{ next: string | null }>) {
  const [day, month] = (next?.split(", ")[0] ?? "").split(" ")
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-lg border text-center leading-none",
        next === null ? "border-dashed border-border text-muted-foreground" : "border-border bg-muted"
      )}
    >
      {next === null ? (
        "–"
      ) : (
        <span className="flex flex-col gap-0.5">
          <span className="text-[9px] font-semibold tracking-wide text-muted-foreground uppercase">{month}</span>
          <span className="font-mono text-sm font-semibold">{day}</span>
        </span>
      )}
    </span>
  )
}

function ConnectorLife({ connector, now }: Readonly<{ connector: ConnectorHealth; now: Date }>) {
  if (connector.provider === "aws" || connector.secretExpiresAt === null) {
    return <span className="shrink-0 text-xs text-muted-foreground">Role, no expiry</span>
  }
  const days = Math.floor((Date.parse(connector.secretExpiresAt) - now.getTime()) / 86_400_000)
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-xs tabular-nums",
        days < 0
          ? "text-(--status-failed)"
          : days <= 30
            ? "font-medium text-(--status-attention)"
            : "text-muted-foreground"
      )}
    >
      {days < 0 ? "Secret expired" : `${days} ${days === 1 ? "day" : "days"} left`}
    </span>
  )
}

function activityText(item: ActivityItem): string {
  const month = item.month ? monthName(item.month).split(" ")[0] : ""
  switch (item.kind) {
    case "verified":
      return `${month} report verified${item.count === null ? "" : `, ${item.count.toLocaleString("en-US")} figures`}`
    case "failed":
      return `${month} report was not delivered`
    case "sent":
      return `${month} report sent`
    case "opened":
      return `${month} report opened`
    case "scanned":
      return `scanned${item.count === null ? "" : `, ${item.count.toLocaleString("en-US")} resources`}`
  }
}

/** Columns of customers with a verified report, against how many owed one. */
function DeliveredChart({ months }: Readonly<{ months: readonly DeliveredMonth[] }>) {
  const top = Math.max(1, ...months.map((month) => month.owed))
  const open = months.length - 1
  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="text-meta text-muted-foreground">
        Customers with a verified report, {monthName(months[0].month, "short")} to{" "}
        {monthName(months[open].month, "short")}. The outline is how many owed one.
      </figcaption>
      <ol className="grid h-36 grid-cols-6 items-end gap-3">
        {months.map((month, index) => (
          <li key={month.month} className="flex h-full flex-col items-center justify-end gap-1.5">
            <span className="font-mono text-xs tabular-nums">
              {month.delivered}
              <span className="text-muted-foreground">/{month.owed}</span>
            </span>
            <span
              className="relative flex w-full max-w-12 flex-col justify-end rounded-md border border-dashed border-border"
              style={{ height: `${Math.max(6, (month.owed / top) * 100)}%` }}
            >
              <span
                className={cn("block w-full rounded-[5px]", index === open ? "bg-primary" : "bg-(--status-verified)")}
                style={{ height: `${month.owed === 0 ? 0 : (month.delivered / month.owed) * 100}%` }}
              />
            </span>
            <abbr
              title={monthName(month.month)}
              className={cn(
                "text-xs no-underline",
                index === open ? "font-semibold text-primary" : "text-muted-foreground"
              )}
            >
              {monthName(month.month, "short")}
            </abbr>
            <span className="sr-only">
              {monthName(month.month)}: {month.delivered} of {month.owed} delivered
            </span>
          </li>
        ))}
      </ol>
    </figure>
  )
}
