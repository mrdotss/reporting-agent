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
 * Every customer down the side, six months across, the open month tinted and last.
 *
 * History is marks only — a row of filled circles is a customer who never misses, a
 * diamond among them is the month that went wrong. The open month carries the words,
 * the note and the one action that moves it forward.
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
  const history = board.months.slice(0, -1)

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[46rem] border-separate border-spacing-0 text-sm">
        <caption className="sr-only">
          Each customer’s report by month, ending with {monthName(board.openMonth)}
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="h-10 border-b border-border pr-3 pl-4 text-left text-xs font-medium text-muted-foreground"
            >
              Customer
            </th>
            {history.map((month) => (
              <th
                key={month}
                scope="col"
                className="h-10 border-b border-border px-2 text-center text-xs font-medium text-muted-foreground"
              >
                <abbr title={monthName(month)} className="no-underline">
                  {monthName(month, "short")}
                </abbr>
              </th>
            ))}
            <th
              scope="col"
              className="h-10 border-b border-border bg-primary/[0.045] pr-3 pl-3.5 text-left text-xs font-semibold text-primary shadow-[inset_0_2px_0_var(--primary)]"
            >
              {monthName(board.openMonth, "short")}
              <span className="ml-1.5 font-medium text-muted-foreground">open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {board.rows.map((row, index) => (
            <tr
              key={row.project.id}
              className="group/row [&>*]:transition-colors hover:[&>*]:bg-muted/50"
            >
              <th
                scope="row"
                className={cn(
                  "h-15 pr-3 pl-4 text-left font-normal",
                  index < board.rows.length - 1 && "border-b border-border/60"
                )}
              >
                <CustomerName row={row} />
                <span className="block truncate text-xs text-muted-foreground">
                  {[row.project.connector, row.project.preset]
                    .filter(Boolean)
                    .join(" · ") || "No connector yet"}
                </span>
              </th>
              {row.cells.slice(0, -1).map((cell, cellIndex) => (
                <td
                  key={history[cellIndex]}
                  className={cn(
                    "h-15 px-2 text-center",
                    index < board.rows.length - 1 && "border-b border-border/60"
                  )}
                >
                  <StatusMark state={cell.state} />
                  <span className="sr-only">
                    {monthName(history[cellIndex])}: {CLOSE_STATE_LABEL[cell.state]}
                  </span>
                </td>
              ))}
              <td
                className={cn(
                  "h-15 min-w-[17rem] bg-primary/[0.045] pr-2.5 pl-3.5",
                  index < board.rows.length - 1 && "border-b border-border/60"
                )}
              >
                <CurrentCell
                  row={row}
                  workspaceId={workspaceId}
                  canRequest={canRequest}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

function note(cell: BoardCell, now: Date = new Date()): string {
  const run = cell.run
  const when = run ? ` · ${relativeInstant(run.createdAt, now)}` : ""
  switch (cell.state) {
    case "delivered":
      return run?.figures != null
        ? `${run.figures.toLocaleString("en-US")} figures${when}`
        : `Delivered${when}`
    case "running":
      return run
        ? `${RUN_STATUS_PRESENTATION[run.status].label}${when}`
        : "In flight"
    case "queued":
      return `Waiting for a worker${when}`
    case "undelivered":
      return "No document went out"
    case "due":
      return "Nothing requested yet"
    default:
      return ""
  }
}

function CurrentCell({
  row,
  workspaceId,
  canRequest,
}: Readonly<{ row: BoardRow; workspaceId: string; canRequest: boolean }>) {
  const { state, run } = row.current

  let action: React.ReactNode = null
  if ((state === "due" || state === "undelivered") && canRequest) {
    action = (
      <RequestButton
        workspaceId={workspaceId}
        projectId={row.project.id}
        customerName={row.project.name}
        label={state === "due" ? "Request" : "Retry"}
        size="xs"
      />
    )
  } else if (run) {
    action = (
      <Link
        href={`/reports/${run.id}`}
        aria-label={`Open ${row.project.name}’s report`}
        className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
      >
        <ArrowUpRightIcon aria-hidden="true" />
      </Link>
    )
  }

  return (
    <div className="flex items-center justify-between gap-2.5">
      <div className="flex min-w-0 flex-col gap-px">
        <span className="flex items-center gap-1.5 font-medium">
          <StatusMark state={state} />
          {CLOSE_STATE_LABEL[state]}
        </span>
        <span className="truncate text-xs text-muted-foreground">{note(row.current)}</span>
      </div>
      {action}
    </div>
  )
}
