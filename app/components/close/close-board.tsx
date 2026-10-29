import Link from "next/link"
import { UsersThreeIcon } from "@phosphor-icons/react/ssr"

import { CloseProgress } from "@/components/close/close-progress"
import { NeedsYou } from "@/components/close/needs-you"
import { OverviewBlocks } from "@/components/close/overview-blocks"
import { MonthStripLegend, PeriodBoard } from "@/components/close/period-board"
import { buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { loadAttention } from "@/lib/close/attention"
import { outstanding, type BoardRow } from "@/lib/close/board"
import { actionTally, deliveredByMonth, upcomingRuns } from "@/lib/close/blocks"
import { loadClose } from "@/lib/close/load"
import { loadOverview } from "@/lib/close/overview"
import { monthName } from "@/lib/close/period"
import { selectedContext } from "@/lib/workspaces/context"
import { can } from "@/lib/workspaces/policy"

/**
 * The close board — the surface a consultant lands on.
 *
 * One question leads, in the largest type on the page: how many customers have their
 * report for the open month proven and delivered. The sentence under it names exactly
 * who is left and why, so the board below is for scanning rather than for finding out.
 * Under the board, the blocks answer what it does not: what runs next, whether each
 * connector can still read, what happened lately, and six months of delivery.
 */
export async function CloseBoard({ userId }: Readonly<{ userId: string }>) {
  const { workspace } = await selectedContext(userId)
  const now = new Date()
  const { period, board } = await loadClose(userId, workspace, now)
  const [attention, overview] = await Promise.all([
    loadAttention(userId, workspace.id, board, now),
    loadOverview(userId, workspace.id),
  ])
  const canRequest = can(workspace.role, "edit")

  const due = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${period.due}T00:00:00Z`))
  const dueDay = due.split(" ")[0]

  if (board.rows.length === 0) {
    return (
      <Empty className="mx-auto max-w-lg py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersThreeIcon />
          </EmptyMedia>
          <EmptyTitle>No customers to close</EmptyTitle>
          <EmptyDescription>
            Add a customer, connect their Azure subscription, and their{" "}
            {monthName(period.month)} report shows up here.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Link
            href="/workspace-settings?tab=customers"
            className={buttonVariants()}
          >
            Add a customer
          </Link>
        </EmptyContent>
      </Empty>
    )
  }

  const left = outstanding(board)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-micro text-muted-foreground uppercase">
            {monthName(period.month)} close · due {due}
          </span>
          <time
            dateTime={now.toISOString()}
            className="font-mono text-xs text-muted-foreground tabular-nums"
          >
            as of{" "}
            {new Intl.DateTimeFormat("en-GB", {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
              timeZone: "Asia/Jakarta",
            }).format(now)}{" "}
            WIB
          </time>
        </p>
        <h1 className="text-display text-balance">
          <span className="font-mono font-medium tracking-[-0.04em]">
            {board.counts.delivered} of {board.rows.length}
          </span>{" "}
          customers delivered
        </h1>
        <p className="max-w-[62ch] text-[15px] leading-relaxed text-muted-foreground">
          <Lede left={left} dueDay={dueDay} daysLeft={period.daysLeft} />
        </p>
      </header>

      <CloseProgress board={board} />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section
          aria-labelledby="period-board-title"
          className="min-w-0 rounded-xl border border-border bg-card"
        >
          <div className="flex flex-wrap items-end justify-between gap-3 p-4 pb-3">
            <div className="flex flex-col gap-0.5">
              <h2 id="period-board-title" className="text-section">
                Customers this period
              </h2>
              <p className="text-meta text-muted-foreground">
                Six months at a glance. The last square is {monthName(period.month, "short")},
                still open.
              </p>
            </div>
            <MonthStripLegend />
          </div>
          <PeriodBoard
            board={board}
            workspaceId={workspace.id}
            canRequest={canRequest}
          />
        </section>

        <NeedsYou
          items={attention}
          board={board}
          workspaceId={workspace.id}
          canRequest={canRequest}
        />
      </div>

      <OverviewBlocks
        upcoming={upcomingRuns(board)}
        connectors={overview.connectors}
        activity={overview.activity}
        delivered={deliveredByMonth(board)}
        actions={actionTally(board)}
        now={now}
      />
    </div>
  )
}

function Lede({
  left,
  dueDay,
  daysLeft,
}: Readonly<{ left: readonly BoardRow[]; dueDay: string; daysLeft: number }>) {
  if (left.length === 0) {
    return <>Every customer’s report is proven and delivered. The close is done.</>
  }

  const phrases = left.map((row) => {
    const name = <strong className="font-semibold text-foreground">{row.project.name}</strong>
    switch (row.current.state) {
      case "running":
        return <>{name} is in flight</>
      case "queued":
        return <>{name} is queued</>
      case "undelivered":
        return <>{name} needs a retry</>
      default:
        return <>{name} hasn’t been requested</>
    }
  })

  const when =
    daysLeft < 0
      ? `${Math.abs(daysLeft)} ${Math.abs(daysLeft) === 1 ? "day" : "days"} past the close`
      : daysLeft === 0
        ? "before today’s close"
        : `before ${dueDay}’s close`

  return (
    <>
      {left.length} to go {when} —{" "}
      {phrases.map((phrase, index) => (
        <span key={left[index].project.id}>
          {index > 0 && (index === phrases.length - 1 ? " and " : ", ")}
          {phrase}
        </span>
      ))}
      .
    </>
  )
}
