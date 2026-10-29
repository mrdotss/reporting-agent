import { describe, expect, test } from "vitest"

import { actionTally, deliveredByMonth, upcomingRuns } from "./blocks"
import { buildBoard, type BoardProject, type BoardRun } from "./board"

const months = ["2026-07", "2026-08", "2026-09"] as const

const project = (over: Partial<BoardProject>): BoardProject => ({
  id: "p1",
  name: "Satu Data Labs",
  archived: false,
  createdMonth: "2026-01",
  connector: "satu-data-prod",
  preset: "Monthly Utilization",
  ...over,
})

const run = (projectId: string, month: string, status: BoardRun["status"]): BoardRun => ({
  id: `${projectId}-${month}`,
  projectId,
  month,
  status,
  createdAt: `${month}-15T00:00:00Z`,
  figures: status === "completed" ? 100 : null,
})

const board = buildBoard(
  [
    project({ id: "p1", openActions: 3, schedule: { cadence: "on the 1st at 02:00 WIB", next: "1 Oct, 02:00", lastError: null } }),
    project({ id: "p2", name: "Late Co", createdMonth: "2026-08", openActions: 9 }),
  ],
  [run("p1", "2026-07", "completed"), run("p1", "2026-08", "completed"), run("p2", "2026-08", "failed")],
  months,
  "2026-09"
)

describe("deliveredByMonth", () => {
  test("counts verified reports against the customers that owed one", () => {
    expect(deliveredByMonth(board)).toEqual([
      { month: "2026-07", delivered: 1, owed: 1 },
      { month: "2026-08", delivered: 1, owed: 2 },
      { month: "2026-09", delivered: 0, owed: 2 },
    ])
  })
})

describe("upcomingRuns", () => {
  test("lists scheduled customers first, then the ones with no schedule", () => {
    expect(upcomingRuns(board).map((row) => [row.projectId, row.next])).toEqual([
      ["p1", "1 Oct, 02:00"],
      ["p2", null],
    ])
  })
})

describe("actionTally", () => {
  test("totals open actions, largest customer first", () => {
    const tally = actionTally(board)
    expect(tally.total).toBe(12)
    expect(tally.byCustomer.map((row) => row.projectId)).toEqual(["p2", "p1"])
  })
})
