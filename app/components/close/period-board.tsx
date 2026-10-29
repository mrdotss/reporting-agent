import Link from "next/link"
import { ArrowUpRightIcon } from "@phosphor-icons/react/ssr"

import { RequestButton } from "@/components/close/request-button"
import { buttonVariants } from "@/components/ui/button"
import {
  CLOSE_STATE_LABEL,
  StatusMark,
} from "@/components/ui/status-mark"
import type { Board, BoardCell, BoardRow } from "@/lib/close/board"
import { monthName } from "@/lib/close/period"
import { RUN_STATUS_PRESENTATION, relativeInstant } from "@/lib/runs/presentation"
import { cn } from "@/lib/utils"

/**
 * Every customer as one row: who they are, six months as a strip of marks, and the open
 * month's state with the one action that moves it forward.
 *
 * The strip replaces a table of month columns, so the board fits its column at any
 * width instead of scrolling sideways. History is marks only: a strip of filled circles
 * is a customer who never misses, and a diamond among them is the month that went
 * wrong. The open month is last and outlined.
 */
export function PeriodBoard({
  board,
  workspaceId,
  canRequest,
}: Readonly<{
  board: Board
  workspaceId: string
  canRequest: boolean
}>) {
  return (
    <ul
      aria-label={`Each customer’s report by month, ending with ${monthName(board.openMonth)}`}
      className="flex flex-col"
    >
      {board.rows.map((row) => (
        <li
          key={row.project.id}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-3 border-t border-border/60 px-4 py-3.5 transition-colors hover:bg-muted/50 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,15rem)_auto]"
        >
          <div className="col-span-2 flex min-w-0 flex-col gap-0.5 md:col-span-1">
            <CustomerName row={row} />
            <span className="truncate text-xs text-muted-foreground">
              {[
                row.project.connector,
                row.project.preset,
                row.project.schedule ? `Monthly ${row.project.schedule.cadence.replace(/^on the /, "")}` : null,
                row.project.openActions
                  ? `${row.project.openActions} open ${row.project.openActions === 1 ? "action" : "actions"}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ") || "No connector yet"}
            </span>
          </div>

          <MonthStrip row={row} months={board.months} />

          <CurrentState row={row} />

          <div className="flex justify-end">
            <CurrentAction row={row} workspaceId={workspaceId} canRequest={canRequest} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** The legend for {@link MonthStrip}, for the section header. */
export function MonthStripLegend() {
  return (
    <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {(["delivered", "undelivered", "none"] as const).map((state) => (
        <li key={state} className="flex items-center gap-1.5">
          <StatusMark state={state} />
          {state === "delivered" ? "Delivered" : state === "undelivered" ? "Missed" : "No report"}
        </li>
      ))}
    </ul>
  )
}

function MonthStrip({ row, months }: Readonly<{ row: BoardRow; months: readonly string[] }>) {
  const open = months.length - 1
  return (
    <ol className="flex items-end gap-1" aria-label={`${row.project.name}, month by month`}>
      {row.cells.map((cell, index) => (
        <li key={months[index]} className="flex flex-col items-center gap-1">
          <span
            className={cn(
              "grid size-6 place-items-center rounded-md",
              index === open
                ? "border-[1.5px] border-primary bg-primary/[0.06]"
                : "bg-muted"
            )}
          >
            <StatusMark state={cell.state} />
          </span>
          <abbr
            title={monthName(months[index])}
            className={cn(
              "text-[10px] leading-none no-underline",
              index === open ? "font-semibold text-primary" : "text-muted-foreground"
            )}
          >
            {monthName(months[index], "short").slice(0, 1)}
          </abbr>
          <span className="sr-only">
            {monthName(months[index])}: {CLOSE_STATE_LABEL[cell.state]}
          </span>
        </li>
      ))}
    </ol>
  )
}

function CustomerName({ row }: Readonly<{ row: BoardRow }>) {
  const run = row.current.run
  return run ? (
    <Link
      href={`/reports/${run.id}`}
      className="rounded-sm font-medium outline-none hover:underline hover:decoration-border hover:underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring/30"
    >
      {row.project.name}
    </Link>
  ) : (
    <span className="font-medium">{row.project.name}</span>
  )
}

function note(cell: BoardCell, schedule: BoardRow["project"]["schedule"], now: Date = new Date()): string {
  const run = cell.run
  const when = run ? ` · ${relativeInstant(run.createdAt, now)}` : ""
  switch (cell.state) {
    case "delivered": {
      const sent = run?.sent ? (run.opened ? " · sent, opened" : " · sent, not opened yet") : ""
      return run?.figures != null
        ? `${run.figures.toLocaleString("en-US")} figures${sent}${when}`
        : `Delivered${sent}${when}`
    }
    case "running":
      return run
        ? `${RUN_STATUS_PRESENTATION[run.status].label}${when}`
        : "In flight"
    case "queued":
      return `Waiting for a worker${when}`
    case "undelivered":
      return "No document went out"
    case "due":
      if (schedule?.lastError) return "Scheduled run didn’t start"
      return schedule ? `Runs automatically ${schedule.next} WIB` : "Nothing requested yet"
    default:
      return ""
  }
}

function CurrentState({ row }: Readonly<{ row: BoardRow }>) {
  const { state } = row.current
  return (
    <div className="flex min-w-0 flex-col gap-px">
      <span className="flex items-center gap-1.5 text-sm font-medium">
        <StatusMark state={state} />
        {CLOSE_STATE_LABEL[state]}
      </span>
      <span className="truncate text-xs text-muted-foreground">{note(row.current, row.project.schedule)}</span>
    </div>
  )
}

function CurrentAction({
  row,
  workspaceId,
  canRequest,
}: Readonly<{ row: BoardRow; workspaceId: string; canRequest: boolean }>) {
  const { state, run } = row.current

  if ((state === "due" || state === "undelivered") && canRequest) {
    return (
      <RequestButton
        workspaceId={workspaceId}
        projectId={row.project.id}
        customerName={row.project.name}
        label={state === "due" ? "Request" : "Retry"}
        size="xs"
      />
    )
  }
  if (run) {
    return (
      <Link
        href={`/reports/${run.id}`}
        className={buttonVariants({ variant: "outline", size: "xs" })}
      >
        Open report<span className="sr-only"> for {row.project.name}</span>
        <ArrowUpRightIcon aria-hidden="true" />
      </Link>
    )
  }
  return null
}
