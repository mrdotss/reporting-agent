import { describe, expect, test } from "vitest"

import type { ReportRun } from "@/lib/db/schema"
import { EVENT_TYPES, PHASE_PROGRESS_UNIT } from "@/lib/events"
import type { RunGap } from "@/lib/runs/gaps"
import {
  EMPTY_CURSOR,
  deriveRelayEvents,
  heartbeatEvent,
  sseFrame,
  type RelayCursor,
  type RelayEvent,
  type RelayRowState,
} from "@/lib/runs/relay"

/**
 * The relay's event derivation (Requirements 40.5, 40.6, 40.12, 40.14, 40.15).
 *
 * Pure, so the whole contract is assertable without a request, a database or a socket.
 * The cases that matter most are the ones a plausible implementation gets wrong:
 *
 *   * a `progress` event emitted while either count is null — a false determinate bar
 *     for a phase that is not counting anything (40.14);
 *   * a `progress` event re-emitted unchanged every poll — hundreds of events saying
 *     nothing, which is what an implementation without a cursor produces;
 *   * a field renamed or added on a `progress` event (40.15);
 *   * an event emitted after `done` (40.12).
 */

const GAPS: readonly RunGap[] = [
  {
    gapType: "deallocated",
    resourceId: "/subscriptions/x/virtualMachines/prod-batch-02",
    metric: null,
    message: "PowerState/deallocated",
    intervalStart: null,
  },
]

function rowState(over: Partial<RelayRowState> = {}): RelayRowState {
  return {
    status: "collecting",
    errorCode: null,
    errorMessage: null,
    snapshotId: null,
    resourceCount: null,
    gapCount: null,
    progressCurrent: null,
    progressTotal: null,
    progressLabel: null,
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    timezone: "Asia/Jakarta",
    ...over,
  }
}

/** Every event of one type, in emission order. */
function of(events: readonly RelayEvent[], type: string): RelayEvent[] {
  return events.filter((event) => event.type === type)
}

/** Emit one poll and hand back both halves, so a sequence reads as a sequence. */
function poll(
  cursor: RelayCursor,
  row: RelayRowState,
  gaps: readonly RunGap[] = []
): { events: readonly RelayEvent[]; cursor: RelayCursor } {
  const derived = deriveRelayEvents(cursor, row, gaps)
  return { events: derived.events, cursor: derived.cursor }
}

// ---------------------------------------------------------------------------

describe("Requirement 40.5 — only declared types, and only the row's own state", () => {
  test("every emitted type is in the declared vocabulary", () => {
    const declared = new Set<string>(EVENT_TYPES)

    const sequences: readonly RelayRowState[] = [
      rowState({ status: "queued" }),
      rowState({ status: "claimed" }),
      rowState({ status: "collecting", progressCurrent: 1, progressTotal: 2 }),
      rowState({
        status: "completed",
        snapshotId: "a".repeat(64),
        resourceCount: 200,
        gapCount: 1,
      }),
      rowState({ status: "failed", errorCode: "EMPTY_SCOPE" }),
    ]

    for (const row of sequences) {
      for (const event of deriveRelayEvents(EMPTY_CURSOR, row, GAPS).events) {
        expect(declared.has(event.type)).toBe(true)
      }
    }
  })

  test("no event this spec emits is a verification or a report_file", () => {
    // Nothing here compiles, renders or verifies a document, so those two must be
    // unemittable — which is also what makes the "no `report_file` without a passing
    // `verification` before it" ordering guarantee impossible to violate.
    for (const status of [
      "queued",
      "claimed",
      "collecting",
      "completed",
      "failed",
    ] as const) {
      const row = rowState({
        status,
        errorCode: status === "failed" ? "THROTTLED" : null,
      })

      const types = deriveRelayEvents(EMPTY_CURSOR, row, GAPS).events.map(
        (event) => event.type
      )

      expect(types).not.toContain("verification")
      expect(types).not.toContain("report_file")
      expect(types).not.toContain("delta")
      expect(types).not.toContain("chart")
    }
  })
})

describe("the tool step tracks the row's phase", () => {
  test("a fresh cursor opens the step for the phase the row is in", () => {
    // So a client that connected to a run already in flight sees its current step
    // rather than waiting for the next transition to learn there is one.
    const { events } = poll(EMPTY_CURSOR, rowState({ status: "collecting" }))

    const tools = of(events, "tool")
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      phase: "start",
      id: "collecting",
      name: "collect_metrics",
    })
    expect(typeof tools[0].status).toBe("string")
  })

  test("a phase change closes the old step and opens the new one, in that order", () => {
    const first = poll(EMPTY_CURSOR, rowState({ status: "claimed" }))
    const second = poll(first.cursor, rowState({ status: "collecting" }))

    const tools = of(second.events, "tool")
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({ phase: "end", id: "claimed" })
    expect(tools[1]).toMatchObject({ phase: "start", id: "collecting" })
  })

  test("an unchanged phase re-opens nothing", () => {
    // Without this the relay would add a step to the timeline every two seconds.
    const first = poll(EMPTY_CURSOR, rowState({ status: "collecting" }))
    const second = poll(first.cursor, rowState({ status: "collecting" }))

    expect(of(second.events, "tool")).toHaveLength(0)
  })

  test("the step id is the row's status, so it matches the progress event's id", () => {
    // Requirement 40.15 sets a `progress` event's `id` from the row's `status`, so the
    // step and the bar attached to it have to be named the same way — otherwise the
    // client has a bar with no step to attach it to.
    const { events } = poll(
      EMPTY_CURSOR,
      rowState({ status: "collecting", progressCurrent: 5, progressTotal: 10 })
    )

    expect(of(events, "tool")[0].id).toBe("collecting")
    expect(of(events, "progress")[0].id).toBe("collecting")
  })
})

describe("Requirement 40.14 — no progress event without both counts", () => {
  test.each([
    ["both absent", { progressCurrent: null, progressTotal: null }],
    ["current absent", { progressCurrent: null, progressTotal: 200 }],
    ["total absent", { progressCurrent: 142, progressTotal: null }],
  ] as const)("%s emits no progress event", (_label, counts) => {
    // The naive implementation emits `142 / null` or `0 / 200`, and the UI renders a
    // determinate bar for a phase that is not counting anything — which is worse than
    // a spinner, because it claims to know something.
    const { events } = poll(EMPTY_CURSOR, rowState({ ...counts }))

    expect(of(events, "progress")).toHaveLength(0)
  })

  test("both present emits one", () => {
    const { events } = poll(
      EMPTY_CURSOR,
      rowState({
        progressCurrent: 142,
        progressTotal: 200,
        progressLabel: "Metrics",
      })
    )

    expect(of(events, "progress")).toHaveLength(1)
  })

  test("a zero current with a total is a legitimate bar", () => {
    // The ordinary state at the start of a phase, and `0` is falsy — an
    // implementation testing truthiness rather than nullness would drop it.
    const { events } = poll(
      EMPTY_CURSOR,
      rowState({ progressCurrent: 0, progressTotal: 200 })
    )

    expect(of(events, "progress")[0]).toMatchObject({ done: 0, total: 200 })
  })

  test("a phase with no declared unit emits no progress event", () => {
    // Requirement 40.15 takes `unit` from a per-phase constant, so a phase the
    // vocabulary does not describe has no honest unit to name. `queued` is such a
    // phase: it is not counting resources, it is waiting.
    expect(PHASE_PROGRESS_UNIT.queued).toBeUndefined()

    const { events } = poll(
      EMPTY_CURSOR,
      rowState({ status: "queued", progressCurrent: 1, progressTotal: 2 })
    )

    expect(of(events, "progress")).toHaveLength(0)
  })
})

describe("Requirement 40.15 — the progress event's exact five fields", () => {
  test("it carries id, done, total, unit and label and nothing else", () => {
    const { events } = poll(
      EMPTY_CURSOR,
      rowState({
        progressCurrent: 142,
        progressTotal: 200,
        progressLabel: "Metrics",
      })
    )

    const progress = of(events, "progress")[0]

    // The exact key set, sorted. Renaming none and adding none is the requirement,
    // and an extra key here would be a field the agent's own vocabulary does not have
    // — so a client written against one would break against the other.
    expect(Object.keys(progress).sort()).toEqual([
      "done",
      "id",
      "label",
      "total",
      "type",
      "unit",
    ])
  })

  test("done takes its value from progress_current", () => {
    // The `progress_current → done` mapping happens here and nowhere else: the column
    // is `progress_current`, the callback field is `current`, the event field is
    // `done`. Three names, one number, one place they are reconciled.
    const { events } = poll(
      EMPTY_CURSOR,
      rowState({ progressCurrent: 142, progressTotal: 200 })
    )

    expect(of(events, "progress")[0]).toMatchObject({
      done: 142,
      total: 200,
      unit: "resources",
      label: null,
    })
  })

  test("unit comes from the per-phase constant, not from the row", () => {
    expect(
      of(
        poll(EMPTY_CURSOR, rowState({ progressCurrent: 1, progressTotal: 2 }))
          .events,
        "progress"
      )[0].unit
    ).toBe(PHASE_PROGRESS_UNIT.collecting)
  })

  test("an unchanged triple is not re-emitted", () => {
    // The relay polls every two seconds while the agent posts at most every five, so
    // without this every phase would emit two or three identical events per callback.
    const first = poll(
      EMPTY_CURSOR,
      rowState({ progressCurrent: 142, progressTotal: 200 })
    )
    const second = poll(
      first.cursor,
      rowState({ progressCurrent: 142, progressTotal: 200 })
    )

    expect(of(first.events, "progress")).toHaveLength(1)
    expect(of(second.events, "progress")).toHaveLength(0)
  })

  test("a changed label alone is re-emitted", () => {
    const first = poll(
      EMPTY_CURSOR,
      rowState({
        progressCurrent: 142,
        progressTotal: 200,
        progressLabel: "Inventory",
      })
    )
    const second = poll(
      first.cursor,
      rowState({
        progressCurrent: 142,
        progressTotal: 200,
        progressLabel: "Metrics",
      })
    )

    expect(of(second.events, "progress")[0]).toMatchObject({ label: "Metrics" })
  })

  test("successive done values for one id never decrease", () => {
    // The row already refuses a lower `current` for the same phase, so this is the
    // second line of defence — and it fails closed: a decrease emits nothing rather
    // than moving the bar backwards.
    const first = poll(
      EMPTY_CURSOR,
      rowState({ progressCurrent: 142, progressTotal: 200 })
    )
    const second = poll(
      first.cursor,
      rowState({ progressCurrent: 80, progressTotal: 200 })
    )
    const third = poll(
      second.cursor,
      rowState({ progressCurrent: 190, progressTotal: 200 })
    )

    expect(of(first.events, "progress")[0]).toMatchObject({ done: 142 })
    expect(of(second.events, "progress")).toHaveLength(0)
    expect(of(third.events, "progress")[0]).toMatchObject({ done: 190 })
  })
})

describe("Requirement 40.12 — the terminal state, then close", () => {
  test("a completed row emits snapshot_ready then done, in that order", () => {
    const first = poll(EMPTY_CURSOR, rowState({ status: "collecting" }))
    const { events, cursor } = poll(
      first.cursor,
      rowState({
        status: "completed",
        snapshotId: "a".repeat(64),
        resourceCount: 200,
        gapCount: 1,
      }),
      GAPS
    )

    const types = events.map((event) => event.type)

    // The open step is closed first, so the timeline does not leave a spinner turning
    // beside a finished run.
    expect(types).toEqual(["tool", "snapshot_ready", "done"])
    expect(cursor.finished).toBe(true)
  })

  test("snapshot_ready carries the row's own window and the stored gap list", () => {
    const { events } = poll(
      EMPTY_CURSOR,
      rowState({
        status: "completed",
        snapshotId: "b".repeat(64),
        resourceCount: 200,
        gapCount: 1,
      }),
      GAPS
    )

    expect(of(events, "snapshot_ready")[0]).toMatchObject({
      snapshot_id: "b".repeat(64),
      resource_count: 200,
      gap_count: 1,
      window: {
        start: "2026-07-01",
        end: "2026-07-31",
        timezone: "Asia/Jakarta",
      },
      gaps: GAPS,
    })
  })

  test("snapshot_ready states no grain and no resolved offset", () => {
    // Requirement 40.5 — those live in the snapshot document, not in the row or the
    // gap list, so the relay may not claim them. The provenance panel reads them
    // server-side instead. A stated grain that was not the collector's is worse than
    // an omitted one.
    const event = of(
      poll(
        EMPTY_CURSOR,
        rowState({ status: "completed", snapshotId: "c".repeat(64) }),
        GAPS
      ).events,
      "snapshot_ready"
    )[0]

    expect(event).not.toHaveProperty("grain")
    expect(event).not.toHaveProperty("utc_offset")
    expect(event.window).not.toHaveProperty("start_utc")
  })

  test("a failed row emits error then done, with terminal true", () => {
    const { events } = poll(
      EMPTY_CURSOR,
      rowState({
        status: "failed",
        errorCode: "EMPTY_SCOPE",
        errorMessage: "The requested scope resolved to zero resources.",
      })
    )

    expect(events.map((event) => event.type)).toEqual(["error", "done"])
    expect(of(events, "error")[0]).toMatchObject({
      code: "EMPTY_SCOPE",
      terminal: true,
      message: "The requested scope resolved to zero resources.",
    })
  })

  test("a TIMEOUT row carries prose even though no event ever delivered it", () => {
    // `TIMEOUT` is written by the reaper with no stream left to carry an `error`
    // event, so the *only* source for both the code and an explanation is the row.
    const { events } = poll(
      EMPTY_CURSOR,
      rowState({ status: "failed", errorCode: "TIMEOUT", errorMessage: null })
    )

    const error = of(events, "error")[0]
    expect(error.code).toBe("TIMEOUT")
    expect(String(error.message).length).toBeGreaterThan(0)
  })

  test("done names the terminal status", () => {
    for (const status of ["completed", "failed"] as const) {
      const { events } = poll(
        EMPTY_CURSOR,
        rowState({
          status,
          errorCode: status === "failed" ? "THROTTLED" : null,
          snapshotId: status === "completed" ? "d".repeat(64) : null,
        })
      )

      expect(of(events, "done")[0]).toMatchObject({ status })
    }
  })

  test("nothing is emitted after done", () => {
    // Requirement 40.12's other half. The cursor is checked first, so a poll that
    // somehow ran after the terminal event produces nothing rather than a second
    // `done`.
    const terminal = poll(
      EMPTY_CURSOR,
      rowState({ status: "completed", snapshotId: "e".repeat(64) })
    )

    const after = poll(
      terminal.cursor,
      rowState({ status: "completed", snapshotId: "e".repeat(64) })
    )

    expect(after.events).toEqual([])
    expect(after.cursor.finished).toBe(true)
  })

  test("a run that was already terminal at connect still emits the full picture", () => {
    // A client opening a stream for a finished run — which the hook avoids, but the
    // route cannot assume — gets the terminal state and a close rather than silence.
    const { events } = poll(
      EMPTY_CURSOR,
      rowState({
        status: "completed",
        snapshotId: "f".repeat(64),
        resourceCount: 12,
        gapCount: 0,
      }),
      []
    )

    expect(events.map((event) => event.type)).toEqual([
      "snapshot_ready",
      "done",
    ])
  })
})

describe("the heartbeat and the frame format", () => {
  test("a heartbeat is a timestamp and nothing else", () => {
    // No phase, no counts, no run id. A heartbeat that carried state would be a second
    // source for something the row already holds.
    const event = heartbeatEvent(new Date("2026-08-15T09:14:22.000Z"))

    expect(Object.keys(event).sort()).toEqual(["ts", "type"])
    expect(event).toMatchObject({
      type: "heartbeat",
      ts: "2026-08-15T09:14:22.000Z",
    })
  })

  test("a frame is a single data line terminated by a blank line", () => {
    const frame = sseFrame({ type: "done", status: "completed" })

    expect(frame).toBe(`data: {"type":"done","status":"completed"}\n\n`)
  })

  test("the type travels inside the payload, not in an event: field", () => {
    // Which is what lets one `onmessage` handler ignore an undeclared type
    // (Requirement 40.6). Per-type listeners would drop it at no listener at all —
    // the same behaviour for the wrong reason, and impossible to assert.
    const frame = sseFrame({ type: "heartbeat", ts: "x" })

    expect(frame).not.toContain("event:")
    expect(frame).toContain(`"type":"heartbeat"`)
  })

  test("a payload cannot split a frame", () => {
    // `JSON.stringify` escapes a newline, so a gap message carrying one cannot
    // terminate the frame early and desynchronize the reader.
    const frame = sseFrame({
      type: "error",
      code: "THROTTLED",
      message: "line one\nline two\n\nline three",
    })

    expect(frame.split("\n\n")).toHaveLength(2)
    expect(frame.endsWith("\n\n")).toBe(true)
  })
})

describe("the row state type is a projection of report_runs", () => {
  test("a RelayRowState is satisfied by a report_runs row", () => {
    // A compile-time assertion with a runtime shell: `RelayRowState` is a `Pick` of
    // `ReportRun`, so a column added to the table cannot silently become relay state
    // and a column renamed breaks the build here rather than at runtime.
    const row: ReportRun = {
      id: "run-1",
      userId: "user-1",
      connectedSubscriptionId: "sub-1",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      timezone: "Asia/Jakarta",
      scope: { resource_types: ["A"], resource_groups: [], tag_filters: {} },
      status: "collecting",
      dedupeKey: "key",
      claimedAt: null,
      claimedBy: null,
      updatedAt: new Date(),
      phaseDeadline: null,
      errorCode: null,
      errorMessage: null,
      progressTokenHash: "hash",
      progressCurrent: null,
      progressTotal: null,
      progressLabel: null,
      snapshotId: null,
      resourceCount: null,
      gapCount: null,
      templateVersionId: null,
      createdAt: new Date(),
      customerName: null,
      revisionHistoryRow: null,
    }

    const projected: RelayRowState = row

    expect(deriveRelayEvents(EMPTY_CURSOR, projected, []).events.length).toBe(1)
  })
})
