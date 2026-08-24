import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { ReportRun } from "@/lib/db/schema"

/**
 * `GET /api/runs/[runId]/stream` — the cosmetic relay (Requirements 40.1, 40.2,
 * 40.3, 40.9, 40.10, 40.12).
 *
 * ## The assertion that matters most
 *
 * **The relay makes no AgentCore invocation.** This is the single most likely place for
 * an implementer to go wrong, because a relay that invokes the runtime and forwards its
 * stream is the obvious shape and the sibling project has exactly one. It is the wrong
 * precedent here: the invocation was started by the cron tick, **in a different request
 * that has already returned**, so there is no upstream stream to attach to — and
 * attaching would re-run the collection. So `lib/aws/agentcore.ts` is faked with a
 * counter, and every case below asserts it stayed at zero.
 *
 * ## What is faked, and why each one
 *
 * The session guard, the run read and the gap load. What is left is exactly what this
 * route contains: the authorization order, the headers, the poll/heartbeat/idle-close
 * loop, and the wiring into `deriveRelayEvents` — which is pure and separately tested in
 * `lib/runs/relay.test.ts`, so nothing here is the only assertion about it.
 *
 * ## Fake timers
 *
 * The relay polls every 2 seconds and closes after 120 idle seconds, so the idle-close
 * case is 60 polls. Under real timers that is two minutes of wall clock for one
 * assertion; under fake timers it is instant, and `advanceTimersByTimeAsync` is what lets
 * the loop's awaited reads resolve between ticks.
 */

const { guard, runs, gaps, agentcore } = vi.hoisted(() => ({
  guard: { user: undefined as { id: string; email: string } | undefined },
  runs: {
    rows: [] as (ReportRun | undefined)[],
    reads: [] as { userId: string; runId: string }[],
  },
  gaps: { loaded: [] as unknown[], calls: 0 },
  agentcore: { invocations: 0 },
}))

vi.mock("@/lib/auth/guard", () => ({
  requireSessionForApi: async () => guard.user ?? null,
}))

vi.mock("@/lib/runs/state", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/runs/state")>()

  return {
    ...original,
    findOwnedRun: async (userId: string, runId: string) => {
      runs.reads.push({ userId, runId })
      // Each poll takes the next scripted row, and the last one repeats — so a test
      // scripts a *sequence* of polls and the loop keeps seeing the final state after
      // the script runs out.
      return runs.rows.length === 1
        ? runs.rows[0]
        : (runs.rows.shift() ?? undefined)
    },
  }
})

vi.mock("@/lib/runs/gaps", () => ({
  loadRunGaps: async () => {
    gaps.calls += 1
    return gaps.loaded
  },
}))

/**
 * The whole point of this fake: any call is a failure.
 *
 * `resolveRuntimeArn` throws too, so even a caller that only tried to *build* an
 * invocation would fail loudly rather than be counted as absent.
 */
vi.mock("@/lib/aws/agentcore", () => ({
  invokeAgentRuntime: async () => {
    agentcore.invocations += 1
    throw new Error("the relay must make no AgentCore invocation")
  },
  resolveRuntimeArn: () => {
    agentcore.invocations += 1
    throw new Error("the relay must not resolve a runtime ARN")
  },
  MissingRuntimeConfigError: class extends Error {},
}))

const { GET } = await import("@/app/api/runs/[runId]/stream/route")

// --- Fixtures ---------------------------------------------------------------

const USER = { id: "user-1", email: "ada@example.com" }
const RUN_ID = "run-1"

function row(over: Partial<ReportRun> = {}): ReportRun {
  return {
    id: RUN_ID,
    userId: USER.id,
    connectedSubscriptionId: "sub-1",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    timezone: "Asia/Jakarta",
    scope: {
      resource_types: ["Microsoft.Compute/virtualMachines"],
      resource_groups: [],
      tag_filters: {},
    },
    status: "collecting",
    dedupeKey: "dedupe-1",
    claimedAt: null,
    claimedBy: null,
    updatedAt: new Date("2026-08-15T10:00:00Z"),
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
    createdAt: new Date("2026-08-15T09:50:00Z"),
    customerName: null,
    revisionHistoryRow: null,
    ...over,
  }
}

function request(): Request {
  return new Request(`https://app.test/api/runs/${RUN_ID}/stream`)
}

const context = { params: Promise.resolve({ runId: RUN_ID }) }

/** Every `data:` payload the response emitted, parsed. */
async function readEvents(
  response: Response,
  limitMs = 0
): Promise<Record<string, unknown>[]> {
  const body = response.body
  if (body === null) return []

  const reader = body.getReader()
  const decoder = new TextDecoder()
  const events: Record<string, unknown>[] = []
  let buffer = ""

  // Advance fake timers alongside the read, so a stream waiting on its poll interval
  // makes progress instead of deadlocking the reader.
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""

      for (const frame of frames) {
        const line = frame
          .split("\n")
          .find((candidate) => candidate.startsWith("data:"))
        if (line === undefined) continue
        events.push(
          JSON.parse(line.slice("data:".length).trim()) as Record<
            string,
            unknown
          >
        )
      }
    }
  })()

  if (limitMs > 0) await vi.advanceTimersByTimeAsync(limitMs)

  // Cancelling ends the pump's pending `read()`, which is what lets a case about an
  // **open** stream finish at all: the relay only closes on a terminal row or after its
  // idle window, so a test that merely wanted to see the first few events would
  // otherwise wait forever. It also models the real teardown — a client navigating away
  // — so the route's abort handling is exercised rather than bypassed.
  await reader.cancel()
  await pump

  return events
}

beforeEach(() => {
  vi.useFakeTimers()
  guard.user = USER
  runs.rows = []
  runs.reads = []
  gaps.loaded = []
  gaps.calls = 0
  agentcore.invocations = 0
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------

describe("Requirements 40.1, 40.2 — the runtime and the headers", () => {
  test("the route declares the Node runtime", async () => {
    // Mandatory, not documentary (Requirement 40.1): a long-lived SSE response and the
    // Postgres driver both need Node, and the edge runtime has neither.
    const route = await import("@/app/api/runs/[runId]/stream/route")

    expect(route.runtime).toBe("nodejs")
  })

  test("a stream carries the three declared headers", async () => {
    runs.rows = [row({ status: "completed", snapshotId: "a".repeat(64) })]

    const response = await GET(request(), context)

    expect(response.headers.get("content-type")).toContain("text/event-stream")
    // `no-transform` is the load-bearing half: a compressing proxy will buffer a stream
    // to find something worth compressing, which turns a live view into a two-minute
    // silence followed by a flush.
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform")
    expect(response.headers.get("x-accel-buffering")).toBe("no")

    await readEvents(response, 5_000)
  })
})

describe("Requirement 40.10 — no AgentCore invocation, ever", () => {
  test("a completed run's stream makes none", async () => {
    runs.rows = [
      row({
        status: "completed",
        snapshotId: "b".repeat(64),
        resourceCount: 200,
        gapCount: 0,
      }),
    ]

    await readEvents(await GET(request(), context), 5_000)

    expect(agentcore.invocations).toBe(0)
  })

  test("an in-flight run polled repeatedly makes none", async () => {
    runs.rows = [row({ status: "collecting" })]

    // Long enough to cover many polls and several heartbeats.
    await readEvents(await GET(request(), context), 130_000)

    expect(agentcore.invocations).toBe(0)
    // And it really did poll, so the assertion above is not vacuous.
    expect(runs.reads.length).toBeGreaterThan(10)
  })
})

describe("Requirement 40.9 — authorization before anything is opened", () => {
  test("no session resolves without a stream", async () => {
    guard.user = undefined

    const response = await GET(request(), context)

    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toContain("application/json")
    // No row was even read.
    expect(runs.reads).toEqual([])
  })

  test("another user's run resolves as not found with no stream opened", async () => {
    // The read is scoped by `user_id` inside the statement, so another user's run
    // matches no row — modelled here by the fake returning `undefined`, which is what
    // that statement produces.
    runs.rows = [undefined]

    const response = await GET(request(), context)

    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toContain("application/json")

    const body = (await response.json()) as { error?: { message?: string } }

    // Not found, never forbidden, and the message names nothing: confirming the run
    // exists would itself be a fact about somebody else's customer.
    expect(body.error?.message).toBe("Not found.")
  })

  test("the read is scoped to the signed-in user's id", async () => {
    runs.rows = [row({ status: "completed", snapshotId: "c".repeat(64) })]

    await readEvents(await GET(request(), context), 5_000)

    expect(runs.reads[0]).toEqual({ userId: USER.id, runId: RUN_ID })
  })
})

describe("Requirement 40.12 — a terminal row is emitted, then the stream closes", () => {
  test("a completed row emits snapshot_ready then done and ends", async () => {
    runs.rows = [
      row({
        status: "completed",
        snapshotId: "d".repeat(64),
        resourceCount: 200,
        gapCount: 1,
      }),
    ]
    gaps.loaded = [
      {
        gapType: "deallocated",
        resourceId: "/subscriptions/x/vm/prod-batch-02",
        metric: null,
        message: "PowerState/deallocated",
      },
    ]

    const events = await readEvents(await GET(request(), context), 5_000)

    expect(events.map((event) => event.type)).toEqual([
      "snapshot_ready",
      "done",
    ])
    expect(events[0]).toMatchObject({
      snapshot_id: "d".repeat(64),
      resource_count: 200,
      gap_count: 1,
    })
    expect(events[1]).toMatchObject({ status: "completed" })
  })

  test("a failed row emits error then done and ends", async () => {
    runs.rows = [
      row({
        status: "failed",
        errorCode: "EMPTY_SCOPE",
        errorMessage: "The requested scope resolved to zero resources.",
      }),
    ]

    const events = await readEvents(await GET(request(), context), 5_000)

    expect(events.map((event) => event.type)).toEqual(["error", "done"])
    expect(events[0]).toMatchObject({ code: "EMPTY_SCOPE", terminal: true })
  })

  test("the gap list is loaded once a row is terminal and not before", async () => {
    // Two polls: collecting, then completed. The gap load is an S3 read, and a relay
    // that made one per poll would cost a request every two seconds for ten minutes.
    runs.rows = [
      row({ status: "collecting" }),
      row({ status: "completed", snapshotId: "e".repeat(64) }),
      row({ status: "completed", snapshotId: "e".repeat(64) }),
    ]

    await readEvents(await GET(request(), context), 10_000)

    expect(gaps.calls).toBe(1)
  })

  test("a run that vanishes mid-stream closes without a terminal event", async () => {
    // Deleted between polls. Nothing to say about a row that is gone, and the client's
    // next fetch of it will 404 — which is the answer.
    runs.rows = [row({ status: "collecting" }), undefined]

    const events = await readEvents(await GET(request(), context), 10_000)

    expect(events.map((event) => event.type)).not.toContain("done")
  })
})

describe("Requirement 40.3 — the stream closes after 120 idle seconds", () => {
  test("a run that says nothing new is closed, having sent only heartbeats", async () => {
    runs.rows = [row({ status: "collecting" })]

    // 130 seconds of simulated time: past the 120-second idle window. If the relay
    // never closed, the reader below would never finish and this test would time out —
    // so completing at all is half the assertion.
    const events = await readEvents(await GET(request(), context), 130_000)

    const types = events.map((event) => event.type)

    // One `tool` start for the phase it is in, then nothing but heartbeats.
    expect(types.filter((type) => type === "tool")).toHaveLength(1)
    expect(types.filter((type) => type === "heartbeat").length).toBeGreaterThan(
      5
    )
    // No terminal event: the run is still going, and the relay closing costs nothing —
    // the client reopens and rebuilds from the row.
    expect(types).not.toContain("done")
  })

  test("a heartbeat carries a timestamp and nothing else", async () => {
    runs.rows = [row({ status: "collecting" })]

    const events = await readEvents(await GET(request(), context), 40_000)
    const heartbeat = events.find((event) => event.type === "heartbeat")

    expect(heartbeat).toBeDefined()
    expect(Object.keys(heartbeat ?? {}).sort()).toEqual(["ts", "type"])
  })

  test("progress on the row keeps the stream alive past the idle window", async () => {
    // The other half of Requirement 40.3: the window counts consecutive seconds in which
    // *nothing but heartbeats* was emitted, so a run reporting progress is not closed at
    // two minutes. Modelled by a row whose count advances on every poll.
    let done = 0
    runs.rows = []

    // A scripted sequence long enough to outlast the idle window.
    for (let index = 0; index < 80; index += 1) {
      done += 1
      runs.rows.push(
        row({
          status: "collecting",
          progressCurrent: done,
          progressTotal: 200,
          progressLabel: "Metrics",
        })
      )
    }

    const events = await readEvents(await GET(request(), context), 130_000)
    const progress = events.filter((event) => event.type === "progress")

    // Many progress events, and the stream was not closed for idleness at 120s.
    expect(progress.length).toBeGreaterThan(20)
    expect(events.map((event) => event.type)).not.toContain("done")
  })
})

describe("Requirements 40.14, 40.15 — progress emission through the route", () => {
  test("no progress event while either count is null", async () => {
    runs.rows = [row({ status: "collecting", progressCurrent: 142 })]

    const events = await readEvents(await GET(request(), context), 40_000)

    expect(events.filter((event) => event.type === "progress")).toHaveLength(0)
  })

  test("id, done, total, unit and label come from the row and the constant", async () => {
    runs.rows = [
      row({
        status: "collecting",
        progressCurrent: 142,
        progressTotal: 200,
        progressLabel: "Metrics",
      }),
    ]

    const events = await readEvents(await GET(request(), context), 5_000)
    const progress = events.find((event) => event.type === "progress")

    expect(progress).toMatchObject({
      id: "collecting",
      done: 142,
      total: 200,
      // From `PHASE_PROGRESS_UNIT`, not from run state (Requirement 40.15).
      unit: "resources",
      label: "Metrics",
    })
  })
})
