import { act } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, renderHook, waitFor } from "@testing-library/react"

import type { RunView } from "@/lib/db/views"
import { RELAY_REOPEN_MS } from "@/lib/events"
import type { RunGap } from "@/lib/runs/gaps"

import { useRunStream } from "./useRunStream"

/**
 * `useRunStream` (Requirements 40.4, 40.6, 40.8, 40.11, 40.12, 36.7).
 *
 * ## What is faked, and why it has to be
 *
 * `EventSource` and `fetch`. jsdom implements neither in a form a test can drive, and both
 * are exactly the seams: the point of the hook is what it *does* with an event and what it
 * *re-reads* on a reconnect, so the double has to let a test push one event and observe
 * one fetch.
 *
 * The fake `EventSource` records itself, so "the hook opened a stream" and "the hook
 * opened **no** stream" are both directly assertable — the second being Requirement
 * 40.12's half, which no amount of state inspection would establish.
 *
 * ## The cases that matter
 *
 *   * **An undeclared event type is ignored** (Requirement 40.6). An older client meeting a
 *     newer type must degrade, not crash, and the stream must keep being read — so the
 *     assertion is that a later declared event still lands.
 *   * **State is rebuilt from the row on reconnect** (Requirements 40.4, 40.11). The row is
 *     the record; the stream is a view. A hook that reopened without re-reading would
 *     carry stale state across the gap — and would never see a `TIMEOUT`, which arrives
 *     with no event at all (Requirement 36.7).
 *   * **A terminal run opens no stream.** Requirement 40.12, and it also means a completed
 *     run's detail page opens no connection on load.
 */

// --- The EventSource double -------------------------------------------------

type Listener = (event: MessageEvent<string>) => void

class FakeEventSource {
  static instances: FakeEventSource[] = []

  readonly url: string
  closed = false

  onopen: (() => void) | null = null
  onmessage: Listener | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  close(): void {
    this.closed = true
  }

  /** Deliver one frame, as the relay would. */
  emit(payload: unknown): void {
    this.onmessage?.(
      new MessageEvent<string>("message", { data: JSON.stringify(payload) })
    )
  }

  /** Deliver a frame that is not JSON at all. */
  emitRaw(data: string): void {
    this.onmessage?.(new MessageEvent<string>("message", { data }))
  }

  /** What `EventSource` reports when the relay closes — the ordinary path here. */
  fail(): void {
    this.onerror?.()
  }
}

/** The most recently opened stream, or `undefined`. */
function latest(): FakeEventSource | undefined {
  return FakeEventSource.instances.at(-1)
}

// --- Fixtures ---------------------------------------------------------------

const RUN_ID = "run-1"

function view(over: Partial<RunView> = {}): RunView {
  return {
    id: RUN_ID,
    connectedSubscriptionId: "sub-1",
    status: "collecting",
    errorCode: null,
    errorMessage: null,
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    timezone: "Asia/Jakarta",
    resourceCount: null,
    gapCount: null,
    snapshotId: null,
    artifactKeys: [],
    createdAt: "2026-08-15T09:50:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
    ...over,
  }
}

const GAP: RunGap = {
  gapType: "deallocated",
  resourceId: "/subscriptions/x/vm/prod-batch-02",
  metric: null,
  message: "PowerState/deallocated",
}

/** The next `GET /api/runs/[runId]` answer. */
let fetchResponse: { run?: RunView; gaps?: readonly RunGap[] } = {}
let fetchCalls: string[] = []
let fetchOk = true

beforeEach(() => {
  FakeEventSource.instances = []
  fetchCalls = []
  fetchOk = true
  fetchResponse = { run: view(), gaps: [] }

  vi.stubGlobal("EventSource", FakeEventSource)
  vi.stubGlobal("fetch", (input: string | URL) => {
    fetchCalls.push(String(input))

    return Promise.resolve({
      ok: fetchOk,
      json: () => Promise.resolve(fetchResponse),
    } as Response)
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------

describe("Requirement 40.12 — a terminal run opens no stream", () => {
  test.each(["completed", "failed"] as const)(
    "a %s run opens nothing on mount",
    (status) => {
      renderHook(() =>
        useRunStream({
          initialRun: view({
            status,
            errorCode: status === "failed" ? "EMPTY_SCOPE" : null,
          }),
        })
      )

      expect(FakeEventSource.instances).toEqual([])
    }
  )

  test("a non-terminal run opens one", () => {
    renderHook(() => useRunStream({ initialRun: view() }))

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(latest()?.url).toBe(`/api/runs/${RUN_ID}/stream`)
  })

  test("the stream is closed when the run goes terminal", async () => {
    const { result } = renderHook(() => useRunStream({ initialRun: view() }))

    const source = latest()
    expect(source?.closed).toBe(false)

    // The relay's own terminal sequence: the row is re-read on `done`, and the re-read
    // reports the terminal status.
    fetchResponse = { run: view({ status: "completed" }), gaps: [GAP] }

    await act(async () => {
      source?.emit({ type: "done", status: "completed" })
    })

    await waitFor(() => {
      expect(result.current.finished).toBe(true)
    })

    // No further stream, and the one that was open is closed.
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(source?.closed).toBe(true)
  })
})

describe("Requirement 40.6 — an undeclared event type is ignored", () => {
  test("it applies no state change and the stream keeps being read", async () => {
    const { result } = renderHook(() => useRunStream({ initialRun: view() }))

    const source = latest()

    await act(async () => {
      // A type from a newer runtime this build has never heard of.
      source?.emit({ type: "quantum_flux", id: "collecting", done: 1 })
      // And one it has, arriving afterwards — the assertion that reading continued.
      source?.emit({
        type: "tool",
        phase: "start",
        id: "collecting",
        name: "collect_metrics",
        label: "Collecting",
        status: "Enumerating resources",
      })
    })

    expect(result.current.steps).toHaveLength(1)
    expect(result.current.steps[0]).toMatchObject({ id: "collecting" })
    expect(source?.closed).toBe(false)
  })

  test("a frame that is not JSON is ignored too", async () => {
    const { result } = renderHook(() => useRunStream({ initialRun: view() }))

    const source = latest()

    await act(async () => {
      source?.emitRaw("not json at all")
      source?.emit({
        type: "tool",
        phase: "start",
        id: "collecting",
        name: "collect_metrics",
        label: "Collecting",
        status: "Working",
      })
    })

    expect(result.current.steps).toHaveLength(1)
  })

  test("a heartbeat changes nothing", async () => {
    const { result } = renderHook(() => useRunStream({ initialRun: view() }))

    await act(async () => {
      latest()?.emit({ type: "heartbeat", ts: "2026-08-15T10:00:00Z" })
    })

    expect(result.current.steps).toEqual([])
    expect(result.current.run.status).toBe("collecting")
  })
})

describe("Requirement 40.8 — events map to steps, and parsing lives here", () => {
  test("a tool start opens a step and a tool end completes it", async () => {
    const { result } = renderHook(() => useRunStream({ initialRun: view() }))

    const source = latest()

    await act(async () => {
      source?.emit({
        type: "tool",
        phase: "start",
        id: "collecting",
        name: "collect_metrics",
        label: "Collecting",
        status: "Enumerating resources",
      })
    })

    expect(result.current.steps[0]).toMatchObject({
      id: "collecting",
      label: "Collecting",
      complete: false,
      progress: null,
    })

    await act(async () => {
      source?.emit({
        type: "tool",
        phase: "end",
        id: "collecting",
        name: "collect_metrics",
      })
    })

    expect(result.current.steps[0].complete).toBe(true)
  })

  test("a replayed tool start refreshes the step rather than duplicating it", async () => {
    // A reconnect replays the open step. Without this, every reconnect would add another
    // "Collecting" row to a timeline describing one phase.
    const { result } = renderHook(() => useRunStream({ initialRun: view() }))

    const source = latest()

    await act(async () => {
      for (let index = 0; index < 3; index += 1) {
        source?.emit({
          type: "tool",
          phase: "start",
          id: "collecting",
          name: "collect_metrics",
          label: "Collecting",
          status: "Enumerating resources",
        })
      }
    })

    expect(result.current.steps).toHaveLength(1)
  })

  test("a progress event attaches counts to its open step", async () => {
    const { result } = renderHook(() => useRunStream({ initialRun: view() }))

    const source = latest()

    await act(async () => {
      source?.emit({
        type: "tool",
        phase: "start",
        id: "collecting",
        name: "collect_metrics",
        label: "Collecting",
        status: "Working",
      })
      source?.emit({
        type: "progress",
        id: "collecting",
        done: 142,
        total: 200,
        unit: "resources",
        label: "Metrics",
      })
    })

    expect(result.current.steps[0].progress).toEqual({
      done: 142,
      total: 200,
      unit: "resources",
      label: "Metrics",
    })
  })

  test("a progress event naming an unknown step is dropped", async () => {
    // Requirement 14.8 — a `progress` event references an **open** step. Inventing one
    // would put a bar on the timeline with no name beside it.
    const { result } = renderHook(() => useRunStream({ initialRun: view() }))

    await act(async () => {
      latest()?.emit({
        type: "progress",
        id: "not-a-step",
        done: 1,
        total: 2,
        unit: "resources",
      })
    })

    expect(result.current.steps).toEqual([])
  })

  test("a progress event with no unit is dropped", async () => {
    const { result } = renderHook(() => useRunStream({ initialRun: view() }))

    const source = latest()

    await act(async () => {
      source?.emit({
        type: "tool",
        phase: "start",
        id: "collecting",
        name: "collect_metrics",
        label: "Collecting",
        status: "Working",
      })
      source?.emit({ type: "progress", id: "collecting", done: 1, total: 2 })
    })

    // A bar labelled "1 / 2" with no noun is a number without a meaning.
    expect(result.current.steps[0].progress).toBeNull()
  })

  test("a lower done value never moves the bar backwards", async () => {
    // The third line of defence: the row refuses it, the relay refuses it, and this
    // clamps it. Cheap, and it means a bar can never visibly jump backwards whatever
    // arrives.
    const { result } = renderHook(() => useRunStream({ initialRun: view() }))

    const source = latest()

    await act(async () => {
      source?.emit({
        type: "tool",
        phase: "start",
        id: "collecting",
        name: "collect_metrics",
        label: "Collecting",
        status: "Working",
      })
      source?.emit({
        type: "progress",
        id: "collecting",
        done: 142,
        total: 200,
        unit: "resources",
      })
      source?.emit({
        type: "progress",
        id: "collecting",
        done: 80,
        total: 200,
        unit: "resources",
      })
    })

    expect(result.current.steps[0].progress?.done).toBe(142)
  })
})

describe("Requirements 40.4, 40.11 — a reconnect rebuilds from the row", () => {
  test("the row is re-fetched and a new stream opens", async () => {
    vi.useFakeTimers()

    const { result } = renderHook(() => useRunStream({ initialRun: view() }))

    expect(FakeEventSource.instances).toHaveLength(1)

    // The relay closing after its idle window, which `EventSource` reports as an error.
    // The ordinary path, not an exceptional one.
    await act(async () => {
      latest()?.fail()
    })

    expect(result.current.connected).toBe(false)

    // Requirement 40.11 — within 5 seconds. And the row is read **before** the new
    // stream opens, so displayed state is rebuilt rather than carried across the gap.
    fetchResponse = {
      run: view({ status: "collecting", resourceCount: 12 }),
      gaps: [],
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELAY_REOPEN_MS + 100)
    })

    expect(fetchCalls).toContain(`/api/runs/${RUN_ID}`)
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(result.current.run.resourceCount).toBe(12)
  })

  test("a run that went terminal during the gap opens no new stream", async () => {
    // The case that makes `TIMEOUT` visible at all (Requirement 36.7): the reaper wrote
    // it with no event to carry it, so the *only* way this client learns of it is the
    // re-read on reconnect.
    vi.useFakeTimers()

    const { result } = renderHook(() => useRunStream({ initialRun: view() }))

    await act(async () => {
      latest()?.fail()
    })

    fetchResponse = {
      run: view({
        status: "failed",
        errorCode: "TIMEOUT",
        errorMessage: "Phase collecting exceeded its deadline.",
      }),
      gaps: [],
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELAY_REOPEN_MS + 100)
    })

    expect(result.current.run.errorCode).toBe("TIMEOUT")
    expect(result.current.finished).toBe(true)
    // One stream, ever: the reopen was abandoned because the re-read said terminal.
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  test("a failed re-fetch leaves the row unchanged and retries later", async () => {
    // Reporting a fetch failure as terminal would show a running run as finished, which
    // is strictly worse than another attempt.
    vi.useFakeTimers()

    const { result } = renderHook(() => useRunStream({ initialRun: view() }))

    fetchOk = false

    await act(async () => {
      latest()?.fail()
      await vi.advanceTimersByTimeAsync(RELAY_REOPEN_MS + 100)
    })

    expect(result.current.run.status).toBe("collecting")
    expect(result.current.finished).toBe(false)
    // The reopen still happened: a failed read is not a reason to stop watching.
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  test("the gap list arrives with the row", async () => {
    const { result } = renderHook(() =>
      useRunStream({ initialRun: view(), initialGaps: [] })
    )

    fetchResponse = {
      run: view({ status: "completed", gapCount: 1 }),
      gaps: [GAP],
    }

    await act(async () => {
      latest()?.emit({ type: "done", status: "completed" })
    })

    await waitFor(() => {
      expect(result.current.gaps).toEqual([GAP])
    })
  })

  test("the initial row and gaps are used before any connection", () => {
    // The first paint is correct from the server render, which is what makes a completed
    // run's page open no connection at all.
    const { result } = renderHook(() =>
      useRunStream({
        initialRun: view({ status: "completed", gapCount: 1 }),
        initialGaps: [GAP],
      })
    )

    expect(result.current.run.status).toBe("completed")
    expect(result.current.gaps).toEqual([GAP])
    expect(result.current.finished).toBe(true)
    expect(FakeEventSource.instances).toEqual([])
  })
})

describe("teardown", () => {
  test("unmounting closes the stream", () => {
    const { unmount } = renderHook(() => useRunStream({ initialRun: view() }))

    const source = latest()
    unmount()

    expect(source?.closed).toBe(true)
  })
})
