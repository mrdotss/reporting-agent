import { describe, expect, test } from "vitest"

import type { RunStatus } from "@/lib/db/schema"

import {
  buildBoard,
  cellFor,
  outstanding,
  pickRun,
  stateForRun,
  type BoardProject,
  type BoardRun,
} from "./board"

const project = (over: Partial<BoardProject> = {}): BoardProject => ({
  id: "p1",
  name: "Satu Data Labs",
  archived: false,
  createdMonth: "2026-01",
  connector: "satu-data-prod",
  preset: "Monthly Utilization",
  ...over,
})

let seq = 0
const run = (
  status: RunStatus,
  over: Partial<BoardRun> = {}
): BoardRun => ({
  id: `r${++seq}`,
  projectId: "p1",
  month: "2026-08",
  status,
  createdAt: `2026-09-0${Math.min(9, seq)}T00:00:00Z`,
  figures: status === "completed" ? 100 : null,
  ...over,
})

describe("stateForRun", () => {
  test("maps the pipeline's statuses onto close states", () => {
    expect(stateForRun("completed")).toBe("delivered")
    expect(stateForRun("failed")).toBe("undelivered")
    expect(stateForRun("queued")).toBe("queued")
    for (const status of ["claimed", "collecting", "compiling", "rendering", "verifying"] as const) {
      expect(stateForRun(status)).toBe("running")
    }
  })
})

describe("pickRun", () => {
  test("a delivered report is not undone by a later failed re-run", () => {
    const delivered = run("completed", { createdAt: "2026-09-01T00:00:00Z" })
    const failed = run("failed", { createdAt: "2026-09-05T00:00:00Z" })
    expect(pickRun([delivered, failed])).toBe(delivered)
  })

  test("a run in flight outranks an earlier failure", () => {
    const failed = run("failed", { createdAt: "2026-09-01T00:00:00Z" })
    const retry = run("rendering", { createdAt: "2026-09-02T00:00:00Z" })
    expect(pickRun([failed, retry])).toBe(retry)
  })

  test("within a rank the newest run wins", () => {
    const older = run("completed", { createdAt: "2026-09-01T00:00:00Z" })
    const newer = run("completed", { createdAt: "2026-09-03T00:00:00Z" })
    expect(pickRun([newer, older])).toBe(newer)
    expect(pickRun([])).toBeNull()
  })
})

describe("cellFor", () => {
  test("no run in the open month is due; in an earlier month it was never delivered", () => {
    expect(cellFor([], "2026-08", project(), "2026-08").state).toBe("due")
    expect(cellFor([], "2026-07", project(), "2026-08").state).toBe("undelivered")
  })

  test("months before the customer existed are none, not missed", () => {
    const newer = project({ createdMonth: "2026-06" })
    expect(cellFor([], "2026-05", newer, "2026-08").state).toBe("none")
    expect(cellFor([], "2026-06", newer, "2026-08").state).toBe("undelivered")
  })

  test("a customer added after the open month ended still owes it", () => {
    const onboardedDuringClose = project({ createdMonth: "2026-09" })
    expect(cellFor([], "2026-08", onboardedDuringClose, "2026-08").state).toBe("due")
    expect(cellFor([], "2026-07", onboardedDuringClose, "2026-08").state).toBe("none")
  })
})

describe("buildBoard", () => {
  test("counts the open month, sums proven figures, and drops archived customers", () => {
    const projects = [
      project({ id: "p1" }),
      project({ id: "p2", name: "Teluk Energi" }),
      project({ id: "p3", name: "Arunika Health" }),
      project({ id: "p4", name: "Old customer", archived: true }),
    ]
    const runs = [
      run("completed", { projectId: "p1", figures: 566 }),
      run("completed", { projectId: "p1", month: "2026-07", figures: 559 }),
      run("rendering", { projectId: "p2" }),
    ]

    const board = buildBoard(projects, runs, ["2026-07", "2026-08"], "2026-08")

    expect(board.rows.map((row) => row.project.id)).toEqual(["p1", "p2", "p3"])
    expect(board.rows[0].cells.map((cell) => cell.state)).toEqual([
      "delivered",
      "delivered",
    ])
    expect(board.counts.delivered).toBe(1)
    expect(board.counts.running).toBe(1)
    expect(board.counts.due).toBe(1)
    // July's figures are not August's.
    expect(board.figuresProven).toBe(566)
  })

  test("outstanding lists what is in flight, then failed, then unrequested", () => {
    const projects = [
      project({ id: "due" }),
      project({ id: "failed" }),
      project({ id: "running" }),
      project({ id: "done" }),
    ]
    const runs = [
      run("failed", { projectId: "failed" }),
      run("collecting", { projectId: "running" }),
      run("completed", { projectId: "done" }),
    ]
    const board = buildBoard(projects, runs, ["2026-08"], "2026-08")

    expect(outstanding(board).map((row) => row.project.id)).toEqual([
      "running",
      "failed",
      "due",
    ])
  })
})
