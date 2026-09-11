import { render, screen, within } from "@testing-library/react"
import { describe, expect, test } from "vitest"

import { RunPhases } from "./run-phases"
import { runStatus } from "@/lib/db/schema"
import { RUN_PHASE_ORDER, runPhases } from "@/lib/runs/presentation"

/**
 * The phase path, and the two things it must not do.
 *
 * It exists because `ActivityTimeline` shows only what the agent has reported, which for
 * the first minute of a twelve-minute run is one line. A reader could not tell a run that
 * was starting from one that was stuck, because there was no path for it to be somewhere
 * along.
 */
describe("the run phase path", () => {
  test("it is the status enum's own order, minus the one that is not a phase", () => {
    // Not a second list. A parallel array would be a second answer to "what happens
    // next", and the one that drifts is the one nobody is looking at.
    expect([...RUN_PHASE_ORDER]).toEqual(
      runStatus.enumValues.filter((value) => value !== "failed")
    )
  })

  test("every phase is behind, current, or ahead — and exactly one is current", () => {
    for (const status of RUN_PHASE_ORDER) {
      const standings = runPhases(status).map((phase) => phase.standing)
      expect(standings.filter((s) => s === "current")).toHaveLength(1)
      // Behind then current then ahead, never interleaved.
      expect([...standings].sort()).toEqual(standings.slice().sort())
      const currentAt = standings.indexOf("current")
      expect(standings.slice(0, currentAt).every((s) => s === "done")).toBe(
        true
      )
      expect(standings.slice(currentAt + 1).every((s) => s === "pending")).toBe(
        true
      )
    }
  })

  test("a failed run claims no phase rather than claiming the first", () => {
    // `failed` is where a run stopped; the row no longer says where. Marking `queued`
    // current would tell a reader it never started.
    const standings = runPhases("failed").map((phase) => phase.standing)
    expect(standings.every((s) => s === "pending")).toBe(true)
  })

  test("it renders the whole path, not only what has happened", () => {
    render(<RunPhases status="compiling" />)
    const items = screen.getAllByRole("listitem")
    expect(items).toHaveLength(RUN_PHASE_ORDER.length)

    const compiling = items.find((li) => li.dataset.phase === "compiling")!
    expect(compiling.dataset.standing).toBe("current")
    expect(within(compiling).getByText("In progress")).toBeTruthy()

    const verifying = items.find((li) => li.dataset.phase === "verifying")!
    expect(verifying.dataset.standing).toBe("pending")
    expect(within(verifying).getByText("Pending")).toBeTruthy()
  })

  test("it states no percentage anywhere", () => {
    // The plan is explicit: show real phases, do not invent percentage progress. A run
    // spends most of its time in `collecting`, so "2 of 6" drawn as a bar would read as
    // a third done and be wrong for most of the run. The counts that are real — resources
    // fetched, of how many — come from the agent and belong to the timeline.
    const { container } = render(<RunPhases status="collecting" />)
    expect(container.textContent ?? "").not.toMatch(/%|\bof\b\s*\d/)
    expect(container.querySelector("progress")).toBeNull()
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
  })
})
