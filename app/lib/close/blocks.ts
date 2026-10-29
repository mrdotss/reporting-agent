import type { Board } from "./board"

/**
 * The blocks under the close board, as pure shapes of data the page already has.
 *
 * Each one answers a question the board itself does not: what runs next, how the last
 * six months went as a whole, and where the open actions are. The connector and
 * activity blocks need their own reads; those are in `overview.ts`.
 */

export type DeliveredMonth = Readonly<{
  month: string
  delivered: number
  /** Customers the month was owed by: everyone but those not yet a customer. */
  owed: number
}>

/** Customers with a verified report, month by month, oldest first. */
export function deliveredByMonth(board: Board): readonly DeliveredMonth[] {
  return board.months.map((month, index) => {
    let delivered = 0
    let owed = 0
    for (const row of board.rows) {
      const state = row.cells[index]?.state
      if (state === undefined || state === "none") continue
      owed += 1
      if (state === "delivered") delivered += 1
    }
    return { month, delivered, owed }
  })
}

export type UpcomingRun = Readonly<{
  projectId: string
  name: string
  preset: string | null
  /** "1 Nov, 02:00" in WIB, or null for a customer with no schedule. */
  next: string | null
}>

/**
 * Every customer's next scheduled run, scheduled ones first in the order the board
 * lists them, then the customers with no schedule, so the block shows the gap too.
 */
export function upcomingRuns(board: Board): readonly UpcomingRun[] {
  const rows = board.rows.map((row) => ({
    projectId: row.project.id,
    name: row.project.name,
    preset: row.project.preset,
    next: row.project.schedule?.next ?? null,
  }))
  return [...rows.filter((row) => row.next !== null), ...rows.filter((row) => row.next === null)]
}

export type ActionTally = Readonly<{
  total: number
  byCustomer: readonly Readonly<{ projectId: string; name: string; open: number }>[]
}>

/** Open and accepted Action register items, largest customer first. */
export function actionTally(board: Board): ActionTally {
  const byCustomer = board.rows
    .map((row) => ({
      projectId: row.project.id,
      name: row.project.name,
      open: row.project.openActions ?? 0,
    }))
    .sort((a, b) => b.open - a.open)
  return { total: byCustomer.reduce((sum, row) => sum + row.open, 0), byCustomer }
}
