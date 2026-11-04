import { describe, expect, it } from "vitest"

import { timingsFor } from "./run-replay"

const created = "2026-11-04T01:54:42.000Z"
const claimed = "2026-11-04T01:55:41.000Z"
const failedAt = "2026-11-04T02:01:31.000Z"

describe("timingsFor", () => {
  it("gives the phase a failed run died in its real duration", () => {
    // Run 638d4f3b: reaped while still `claimed`, so no phase timing was ever stamped.
    const { phases, recorded, totalMs } = timingsFor(created, claimed, failedAt, null, true)

    expect(phases[0]).toEqual({ status: "queued", ms: 59_000 })
    expect(phases[1]).toEqual({ status: "claimed", ms: 350_000 })
    expect(phases.slice(2).every((phase) => phase.ms === null)).toBe(true)
    expect(phases.findLastIndex((phase) => phase.ms !== null)).toBe(1)
    expect(recorded).toBe(true)
    expect(totalMs).toBe(409_000)
  })

  it("still reports an unrecorded completed run as unrecorded", () => {
    const { recorded } = timingsFor(created, claimed, failedAt, null, false)
    expect(recorded).toBe(false)
  })

  it("measures every phase of a fully recorded run", () => {
    const timings = {
      claimed,
      collecting: "2026-11-04T01:56:00.000Z",
      compiling: "2026-11-04T01:58:00.000Z",
      rendering: "2026-11-04T01:59:00.000Z",
      verifying: "2026-11-04T02:00:00.000Z",
      completed: "2026-11-04T02:00:30.000Z",
    }
    const { phases, recorded } = timingsFor(created, claimed, failedAt, timings, false)
    expect(recorded).toBe(true)
    expect(phases.map((phase) => phase.ms)).toEqual([
      59_000, 19_000, 120_000, 60_000, 60_000, 30_000,
    ])
  })
})
