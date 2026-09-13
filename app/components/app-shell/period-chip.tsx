import type { ClosePeriod } from "@/lib/close/period"
import { monthName } from "@/lib/close/period"
import { cn } from "@/lib/utils"

/**
 * The close window, always in view: the month being reported on, how long is left,
 * and one tick per day from the 1st to the close day.
 *
 * The strip is what makes the deadline ambient. A number of days reads once; a row of
 * spent ticks with today standing taller reads every time the eye passes the sidebar.
 * In the icon rail it collapses to the days-left figure alone.
 */
export function PeriodChip({ period }: Readonly<{ period: ClosePeriod }>) {
  const overdue = period.daysLeft < 0
  const left = overdue
    ? `${Math.abs(period.daysLeft)}d over`
    : period.daysLeft === 0
      ? "due today"
      : `${period.daysLeft}d left`
  const dueLabel = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${period.due}T00:00:00Z`))

  return (
    <div
      data-slot="period-chip"
      role="group"
      aria-label={`Reporting period ${monthName(period.month)}, due ${dueLabel}, ${left}`}
      className="mx-2 flex flex-col gap-1.5 rounded-lg bg-background p-2.5 shadow-[0_0_0_1px_var(--sidebar-border)] group-data-[collapsible=icon]:mx-0 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:p-1.5"
    >
      <div
        aria-hidden="true"
        className="flex flex-col gap-1.5 group-data-[collapsible=icon]:hidden"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-micro text-muted-foreground uppercase">
            Reporting period
          </span>
          <span
            className={cn(
              "font-mono text-[11.5px] font-medium tabular-nums",
              overdue ? "text-(--status-failed)" : "text-(--status-attention)"
            )}
          >
            {left}
          </span>
        </div>
        <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">
          {monthName(period.month)}
        </span>
        <div
          className="grid h-3.5 items-end gap-0.5"
          style={{ gridTemplateColumns: `repeat(${period.ticks.length}, minmax(0, 1fr))` }}
        >
          {period.ticks.map((tick, index) => (
            <i
              key={index}
              className={cn(
                "block rounded-[1px]",
                tick === "today" && "h-3.5 bg-primary",
                tick === "past" && "h-1.5 bg-muted-foreground/50",
                tick === "ahead" && "h-1.5 bg-sidebar-border",
                tick === "due" &&
                  "h-2.5 shadow-[inset_0_0_0_1.5px_var(--status-attention)]"
              )}
            />
          ))}
        </div>
        <div className="flex justify-between font-mono text-[10.5px] text-muted-foreground tabular-nums">
          <span>1st</span>
          <span>due {period.due.slice(8).replace(/^0/, "")}th</span>
        </div>
      </div>
      <span
        aria-hidden="true"
        className="hidden font-mono text-[11px] font-semibold text-(--status-attention) tabular-nums group-data-[collapsible=icon]:block"
      >
        {overdue ? `+${Math.abs(period.daysLeft)}` : `${period.daysLeft}d`}
      </span>
    </div>
  )
}
