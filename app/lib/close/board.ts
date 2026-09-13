import type { CloseState } from "@/components/ui/status-mark"
import type { RunStatus } from "@/lib/db/schema"

/**
 * The period board: every customer, month by month, as a close state.
 *
 * A customer is a project. A month is the `period_start` month of the runs reported on
 * it. The cell is the answer to one question — was this customer's report for this
 * month proven and handed over — so a delivered report is never undone by a later
 * re-run that failed, and an in-flight run outranks an earlier failure because the
 * consultant is already fixing it.
 *
 * `buildBoard` is pure and carries every rule; `loadBoard` is the one query that feeds
 * it, scoped through workspace membership like every other workspace read.
 */

export type BoardRun = Readonly<{
  id: string
  projectId: string
  /** `YYYY-MM` of the run's period start. */
  month: string
  status: RunStatus
  /** ISO instant the run was created. */
  createdAt: string
  /** Figures proven by verification, when the run completed. */
  figures: number | null
}>

export type BoardProject = Readonly<{
  id: string
  name: string
  archived: boolean
  /** `YYYY-MM` the project was created, in the workspace's timezone. */
  createdMonth: string
  connector: string | null
  preset: string | null
}>

export type BoardCell = Readonly<{
  state: CloseState
  run: BoardRun | null
}>

export type BoardRow = Readonly<{
  project: BoardProject
  /** One cell per requested month, oldest first. */
  cells: readonly BoardCell[]
  /** The open month's cell — the last of `cells`. */
  current: BoardCell
}>

export type Board = Readonly<{
  months: readonly string[]
  openMonth: string
  rows: readonly BoardRow[]
  counts: Readonly<Record<CloseState, number>>
  /** Figures proven across the open month's delivered reports. */
  figuresProven: number
}>

const IN_FLIGHT: ReadonlySet<RunStatus> = new Set([
  "claimed",
  "collecting",
  "compiling",
  "rendering",
  "verifying",
])

export function stateForRun(status: RunStatus): CloseState {
  if (status === "completed") return "delivered"
  if (status === "failed") return "undelivered"
  if (status === "queued") return "queued"
  return IN_FLIGHT.has(status) ? "running" : "queued"
}

/** Delivered beats in flight beats failed; within a rank, the newest run wins. */
function rank(status: RunStatus): number {
  if (status === "completed") return 3
  if (status === "failed") return 1
  return 2
}

export function pickRun(runs: readonly BoardRun[]): BoardRun | null {
  let best: BoardRun | null = null
  for (const run of runs) {
    if (
      best === null ||
      rank(run.status) > rank(best.status) ||
      (rank(run.status) === rank(best.status) && run.createdAt > best.createdAt)
    ) {
      best = run
    }
  }
  return best
}

export function cellFor(
  runs: readonly BoardRun[],
  month: string,
  project: BoardProject,
  openMonth: string
): BoardCell {
  const run = pickRun(runs)
  if (run) return { state: stateForRun(run.status), run }
  // The open month is owed by every live customer, including one added after it
  // ended: onboarding in September still means reporting on August's usage.
  if (month === openMonth) return { state: "due", run: null }
  if (month < project.createdMonth) return { state: "none", run: null }
  // Any earlier month with nothing requested was simply never delivered.
  return { state: "undelivered", run: null }
}

export function buildBoard(
  projects: readonly BoardProject[],
  runs: readonly BoardRun[],
  months: readonly string[],
  openMonth: string
): Board {
  const byKey = new Map<string, BoardRun[]>()
  for (const run of runs) {
    const key = `${run.projectId}|${run.month}`
    const list = byKey.get(key)
    if (list) list.push(run)
    else byKey.set(key, [run])
  }

  const counts: Record<CloseState, number> = {
    delivered: 0,
    running: 0,
    queued: 0,
    due: 0,
    undelivered: 0,
    attention: 0,
    none: 0,
  }
  let figuresProven = 0

  const rows = projects
    .filter((project) => !project.archived)
    .map((project) => {
      const cells = months.map((month) =>
        cellFor(byKey.get(`${project.id}|${month}`) ?? [], month, project, openMonth)
      )
      const current =
        cellFor(
          byKey.get(`${project.id}|${openMonth}`) ?? [],
          openMonth,
          project,
          openMonth
        )
      counts[current.state] += 1
      if (current.state === "delivered") figuresProven += current.run?.figures ?? 0
      return { project, cells, current }
    })

  return { months, openMonth, rows, counts, figuresProven }
}

/**
 * The customers still between the open month and done, in the order the board asks
 * about them: what is being fixed, what failed, what nobody has requested.
 */
export function outstanding(board: Board): readonly BoardRow[] {
  const order: CloseState[] = ["running", "queued", "undelivered", "due"]
  return board.rows
    .filter((row) => order.includes(row.current.state))
    .sort(
      (a, b) => order.indexOf(a.current.state) - order.indexOf(b.current.state)
    )
}
