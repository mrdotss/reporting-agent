import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { ReportRun } from "@/lib/db/schema"
import type { RunStateWrite } from "@/lib/runs/state"

/**
 * `POST /api/internal/runs/[runId]/progress` — the agent advances its own state
 * (Requirements 38.5, 38.6, 38.7, 38.8, 38.11, 38.12, 38.13, 38.14).
 *
 * ## What these tests are, and are not
 *
 * They are about **persistence**: which columns the route hands to the write, and which
 * requests reach a write at all. The *decision* — the transition table, the terminal
 * fields, the monotonicity guard — is pure and asserted exhaustively in
 * `lib/runs/progress.test.ts`, so nothing here is the only assertion about it. What is
 * only assertable here is the wiring: the token check happening before the body parse,
 * every refusal answering with **one identical** response, and the decided write reaching
 * the database call with the row's read status as its guard.
 *
 * The three cases task 13.11 names are the interesting ones, and each fails on a
 * plausible misreading of Requirement 38.13:
 *
 *   * a **same-status** callback writes all three progress columns while leaving `status`
 *     unchanged — an implementation that treated a repeated transition as a no-op would
 *     discard every progress refresh, and the determinate bar would never move;
 *   * an **out-of-order lower `current`** for the same phase leaves all three unchanged
 *     while still applying the rest;
 *   * a **terminal** transition clears all three alongside `phase_deadline`.
 *
 * ## What is faked
 *
 * The row read and the guarded write. The token derivation is **real** — the route has to
 * validate against a hash this test computed with the production function, or the test
 * would be asserting that the route agrees with a stand-in.
 */

const { runs } = vi.hoisted(() => ({
  runs: {
    row: undefined as ReportRun | undefined,
    reads: [] as string[],
    writes: [] as {
      runId: string
      expectedStatus: string
      values: RunStateWrite
      now: Date
    }[],
    /** What the guarded write returns; `undefined` models a status that moved. */
    writeResult: undefined as ReportRun | undefined,
  },
}))

vi.mock("@/lib/runs/state", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/runs/state")>()

  return {
    ...original,
    readRunForTokenHolder: async (runId: string) => {
      runs.reads.push(runId)
      return runs.row
    },
    applyRunWriteIfStatus: async (
      runId: string,
      expectedStatus: string,
      values: RunStateWrite,
      now: Date
    ) => {
      runs.writes.push({ runId, expectedStatus, values, now })
      return runs.writeResult
    },
  }
})

const { POST } = await import("@/app/api/internal/runs/[runId]/progress/route")

const { PROGRESS_TOKEN_HEADER, deriveProgressToken, progressTokenHash } =
  await import("@/lib/runs/progress-token")

// --- Fixtures ---------------------------------------------------------------

const KEY_VAR = "APP_ENCRYPTION_KEY"
const KEY = Buffer.alloc(32, 7).toString("base64")

const RUN_ID = "run-1"

let previousKey: string | undefined

function row(over: Partial<ReportRun> = {}): ReportRun {
  return {
    id: RUN_ID,
    userId: "user-1",
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
    phaseDeadline: new Date("2026-08-15T10:30:00Z"),
    errorCode: null,
    errorMessage: null,
    progressTokenHash: progressTokenHash(deriveProgressToken(RUN_ID)),
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
    reuseSnapshotRunId: null,
    ...over,
  }
}

function callbackRequest(
  body: unknown,
  token: string | null = deriveProgressToken(RUN_ID)
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (token !== null) headers[PROGRESS_TOKEN_HEADER] = token

  return new Request(`https://app.test/api/internal/runs/${RUN_ID}/progress`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

const context = { params: Promise.resolve({ runId: RUN_ID }) }

/** The single write this request applied, or `undefined`. */
function onlyWrite(): RunStateWrite | undefined {
  expect(runs.writes.length).toBeLessThanOrEqual(1)
  return runs.writes[0]?.values
}

beforeEach(() => {
  previousKey = process.env[KEY_VAR]
  process.env[KEY_VAR] = KEY

  runs.row = row()
  runs.reads = []
  runs.writes = []
  runs.writeResult = row()

  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  if (previousKey === undefined) delete process.env[KEY_VAR]
  else process.env[KEY_VAR] = previousKey

  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------

describe("Requirements 38.5, 38.6 — one response for a bad token and an unknown run", () => {
  test("a valid token on a known run is accepted", async () => {
    const response = await POST(
      callbackRequest({
        run_id: RUN_ID,
        phase: "completed",
        snapshot_id: "a".repeat(64),
      }),
      context
    )

    expect(response.status).toBe(200)
  })

  test("a wrong token and an unknown run give byte-identical responses", async () => {
    // Requirement 38.6 — "one response identical for both cases", so a caller cannot use
    // the difference to learn whether a run id exists.
    const badToken = await POST(
      callbackRequest({ run_id: RUN_ID, phase: "completed" }, "not-the-token"),
      context
    )
    const badTokenBody = await badToken.text()

    runs.row = undefined
    const unknownRun = await POST(
      callbackRequest({ run_id: RUN_ID, phase: "completed" }),
      context
    )
    const unknownRunBody = await unknownRun.text()

    expect(badToken.status).toBe(unknownRun.status)
    expect(badToken.status).toBe(404)
    expect(badTokenBody).toBe(unknownRunBody)
  })

  test("an absent token header is the same refusal", async () => {
    const response = await POST(
      callbackRequest({ run_id: RUN_ID, phase: "completed" }, null),
      context
    )

    expect(response.status).toBe(404)
    expect(runs.writes).toEqual([])
  })

  test("no refusal applies a write", async () => {
    for (const token of [null, "wrong", ""]) {
      runs.writes = []

      await POST(
        callbackRequest({ run_id: RUN_ID, phase: "completed" }, token),
        context
      )

      expect(runs.writes).toEqual([])
    }
  })

  test("the token is checked before the body is parsed", async () => {
    // So an unauthorized caller cannot use validation messages to probe the schema. A
    // malformed body with a wrong token answers the shared 404, not a 400 with field
    // paths.
    const response = await POST(
      callbackRequest({ nonsense: true }, "wrong-token"),
      context
    )

    expect(response.status).toBe(404)
  })

  test("a body naming a different run than the path is refused", async () => {
    // The path is what the token authorized, so the body's `run_id` cannot redirect the
    // write.
    const response = await POST(
      callbackRequest({ run_id: "some-other-run", phase: "collecting" }),
      context
    )

    expect(response.status).toBe(404)
    expect(runs.writes).toEqual([])
  })

  test("a malformed body from an authorized caller answers 400 with field paths", async () => {
    // The one exception to the uniform refusal, and it is not a leak: the response
    // describes the *request*, not the row, and it is what makes a wrong callback shape
    // debuggable instead of indistinguishable from a wrong token.
    const response = await POST(
      callbackRequest({ run_id: RUN_ID, phase: "not-a-phase" }),
      context
    )

    expect(response.status).toBe(400)
    expect(runs.writes).toEqual([])
  })
})

describe("Requirement 38.13 — a same-status callback persists all three columns", () => {
  test("it writes progress_current, progress_total and progress_label", async () => {
    // The case an "idempotent means no-op" reading discards. Without this write the
    // determinate bar would never move, because the agent reports progress by repeating
    // the phase it is already in.
    runs.row = row({
      status: "collecting",
      progressCurrent: 100,
      progressTotal: 200,
    })

    const response = await POST(
      callbackRequest({
        run_id: RUN_ID,
        phase: "collecting",
        current: 142,
        total: 200,
        label: "Metrics",
      }),
      context
    )

    expect(response.status).toBe(200)

    const write = onlyWrite()
    expect(write?.progressCurrent).toBe(142)
    expect(write?.progressTotal).toBe(200)
    expect(write?.progressLabel).toBe("Metrics")
  })

  test("it leaves status unchanged", async () => {
    runs.row = row({ status: "collecting", progressCurrent: 100 })

    await POST(
      callbackRequest({
        run_id: RUN_ID,
        phase: "collecting",
        current: 142,
        total: 200,
      }),
      context
    )

    // Absent, not set to the same value: omission is what a partial UPDATE expresses as
    // "leave the column alone".
    expect(onlyWrite()).not.toHaveProperty("status")
  })

  test("it refreshes the phase deadline", async () => {
    runs.row = row({ status: "collecting" })

    await POST(
      callbackRequest({
        run_id: RUN_ID,
        phase: "collecting",
        current: 1,
        total: 2,
      }),
      context
    )

    // So a phase making visible progress is not reaped for taking a while.
    expect(onlyWrite()?.phaseDeadline).toBeInstanceOf(Date)
  })

  test("the write is guarded on the status that was read", async () => {
    // The optimistic-concurrency predicate. A row the reaper's sweep failed between the
    // read and the write matches nothing, so a decision made against a stale status
    // cannot reopen a terminal row.
    runs.row = row({ status: "collecting" })

    await POST(
      callbackRequest({
        run_id: RUN_ID,
        phase: "collecting",
        current: 1,
        total: 2,
      }),
      context
    )

    expect(runs.writes[0].expectedStatus).toBe("collecting")
    expect(runs.writes[0].runId).toBe(RUN_ID)
  })

  test("a write that matched no row is the shared refusal", async () => {
    runs.row = row({ status: "collecting" })
    runs.writeResult = undefined

    const response = await POST(
      callbackRequest({
        run_id: RUN_ID,
        phase: "collecting",
        current: 1,
        total: 2,
      }),
      context
    )

    expect(response.status).toBe(404)
  })
})

describe("Requirement 38.14 — an out-of-order lower current changes nothing", () => {
  test("all three columns are left unchanged", async () => {
    // The reporter retries once, so a callback can land out of order. The **row**
    // enforces monotonicity rather than trusting the caller, and all three move together
    // — a new total beside a retained current would make the bar jump backwards anyway.
    runs.row = row({
      status: "collecting",
      progressCurrent: 142,
      progressTotal: 200,
      progressLabel: "Metrics",
    })

    const response = await POST(
      callbackRequest({
        run_id: RUN_ID,
        phase: "collecting",
        current: 80,
        total: 200,
        label: "Metrics",
      }),
      context
    )

    expect(response.status).toBe(200)

    const write = onlyWrite()
    expect(write).not.toHaveProperty("progressCurrent")
    expect(write).not.toHaveProperty("progressTotal")
    expect(write).not.toHaveProperty("progressLabel")
  })

  test("the remainder of the request still applies", async () => {
    runs.row = row({
      status: "collecting",
      progressCurrent: 142,
      progressTotal: 200,
    })

    await POST(
      callbackRequest({ run_id: RUN_ID, phase: "collecting", current: 80 }),
      context
    )

    // The deadline is still refreshed and the row is still touched.
    expect(onlyWrite()?.phaseDeadline).toBeInstanceOf(Date)
  })
})

describe("Requirement 38.12 — a terminal transition clears the in-flight count", () => {
  test("completed clears all three alongside phase_deadline", async () => {
    runs.row = row({
      status: "collecting",
      progressCurrent: 200,
      progressTotal: 200,
      progressLabel: "Metrics",
    })

    await POST(
      callbackRequest({
        run_id: RUN_ID,
        phase: "completed",
        snapshot_id: "b".repeat(64),
        resource_count: 200,
        gap_count: 3,
      }),
      context
    )

    const write = onlyWrite()

    expect(write?.status).toBe("completed")
    expect(write?.snapshotId).toBe("b".repeat(64))
    expect(write?.resourceCount).toBe(200)
    expect(write?.gapCount).toBe(3)
    // A terminal row is never swept and carries no stale in-flight count, so a
    // reconnecting client cannot render a determinate bar for a run that is over.
    expect(write?.phaseDeadline).toBeNull()
    expect(write?.progressCurrent).toBeNull()
    expect(write?.progressTotal).toBeNull()
    expect(write?.progressLabel).toBeNull()
  })

  test("failed clears all three and records its code", async () => {
    runs.row = row({
      status: "collecting",
      progressCurrent: 12,
      progressTotal: 200,
      progressLabel: "Inventory",
    })

    await POST(
      callbackRequest({
        run_id: RUN_ID,
        phase: "failed",
        error_code: "EMPTY_SCOPE",
        error_message: "The requested scope resolved to zero resources.",
      }),
      context
    )

    const write = onlyWrite()

    expect(write?.status).toBe("failed")
    expect(write?.errorCode).toBe("EMPTY_SCOPE")
    expect(write?.phaseDeadline).toBeNull()
    expect(write?.progressCurrent).toBeNull()
    expect(write?.progressTotal).toBeNull()
    expect(write?.progressLabel).toBeNull()
  })

  test("no write carries a column derived from the presented token", async () => {
    // Requirement 38.12's last clause. The `ProgressWrite` type holds it at compile time;
    // this is the assertion that survives erasure.
    runs.row = row({ status: "collecting" })

    await POST(
      callbackRequest({
        run_id: RUN_ID,
        phase: "completed",
        snapshot_id: "c".repeat(64),
      }),
      context
    )

    expect(Object.keys(onlyWrite() ?? {})).not.toContain("progressTokenHash")
  })
})

describe("Requirements 38.8, 38.11 — refusals that reach no write", () => {
  test("a terminal row refuses every transition, including its own status", async () => {
    for (const status of ["completed", "failed"] as const) {
      runs.writes = []
      runs.row = row({
        status,
        errorCode: status === "failed" ? "THROTTLED" : null,
        phaseDeadline: null,
      })

      const response = await POST(
        callbackRequest({
          run_id: RUN_ID,
          phase: status,
          ...(status === "failed"
            ? { error_code: "THROTTLED" as const }
            : { snapshot_id: "d".repeat(64) }),
        }),
        context
      )

      expect(response.status).toBe(404)
      expect(runs.writes).toEqual([])
    }
  })

  test("a presented TIMEOUT is refused with no write", async () => {
    // The reaper is its only writer, because a timed-out run's container may already be
    // gone — so a callback presenting it is claiming to have observed something it
    // cannot have.
    runs.row = row({ status: "collecting" })

    const response = await POST(
      callbackRequest({
        run_id: RUN_ID,
        phase: "failed",
        error_code: "TIMEOUT",
      }),
      context
    )

    expect(response.status).toBe(404)
    expect(runs.writes).toEqual([])
  })

  test("an unreachable target is refused with no write", async () => {
    runs.row = row({ status: "queued", phaseDeadline: new Date() })

    const response = await POST(
      callbackRequest({ run_id: RUN_ID, phase: "collecting" }),
      context
    )

    expect(response.status).toBe(404)
    expect(runs.writes).toEqual([])
  })
})
