import { describe, expect, test } from "vitest"

import type { RunStatus } from "@/lib/db/schema"
import {
  DEFAULT_FAILURE_MESSAGE,
  decideTransition,
  progressCallbackSchema,
  type ProgressCallback,
  type ProgressRowState,
} from "@/lib/runs/progress"
import {
  AGENT_ERROR_CODES,
  APP_WRITTEN_CODES,
  DRIVEN,
  acceptedTargets,
  phaseDeadlineFor,
} from "@/lib/runs/state"

/**
 * The progress callback's schema and its transition decision (Requirements 38.7,
 * 38.8, 38.10–38.14).
 *
 * The decision is pure, so the whole table is assertable here without a request, a
 * database or a clock. Each case is written to fail on the specific wrong
 * implementation it exists to rule out — the ones worth naming being: a repeat of a
 * **non**-terminal status treated as a no-op (which would silently discard every
 * progress refresh), a repeat of a **terminal** status treated as idempotent (which
 * would let a delivered run's audit row be rewritten), and an out-of-order retry
 * that moves the count backwards.
 *
 * The real dependencies are passed in rather than faked. They are pure themselves,
 * and using the genuine transition table is the point: a test against a fake table
 * would keep passing after the real one changed.
 */

const DEPS = {
  acceptedTargets,
  phaseDeadlineFor,
  agentErrorCodes: AGENT_ERROR_CODES,
  appWrittenCodes: APP_WRITTEN_CODES,
} as const

const NOW = new Date("2026-08-15T10:00:00Z")

const RUN_ID = "run-1"

const SNAPSHOT_ID = "a".repeat(64)

function row(
  status: RunStatus,
  progress: Partial<Omit<ProgressRowState, "status">> = {}
): ProgressRowState {
  return {
    status,
    progressCurrent: progress.progressCurrent ?? null,
    progressTotal: progress.progressTotal ?? null,
    progressLabel: progress.progressLabel ?? null,
  }
}

function callback(fields: Partial<ProgressCallback>): ProgressCallback {
  return progressCallbackSchema.parse({
    run_id: RUN_ID,
    phase: "collecting",
    ...fields,
  })
}

// ---------------------------------------------------------------------------

describe("Requirement 38.2 — the schema has no token field", () => {
  test("a body carrying a token is rejected, not quietly stripped", () => {
    // `.strict()`. A caller that put a credential in a body it believed was
    // accepted would otherwise have no signal that it had done so.
    for (const key of ["progress_token", "token", "client_secret"]) {
      expect(
        progressCallbackSchema.safeParse({
          run_id: RUN_ID,
          phase: "collecting",
          [key]: "s3cret",
        }).success
      ).toBe(false)
    }
  })
})

describe("the schema's accepted phases mirror the agent's", () => {
  test("the agent may present only collecting, completed and failed", () => {
    for (const phase of ["collecting", "completed", "failed"]) {
      expect(
        progressCallbackSchema.safeParse({ run_id: RUN_ID, phase }).success
      ).toBe(true)
    }
  })

  test("claimed and queued are refused — the reaper owns them", () => {
    // An agent presenting `claimed` is claiming to have done the claiming.
    for (const phase of ["queued", "claimed"]) {
      expect(
        progressCallbackSchema.safeParse({ run_id: RUN_ID, phase }).success
      ).toBe(false)
    }
  })

  test("the undriven phases are refused", () => {
    for (const phase of ["compiling", "rendering", "verifying"]) {
      expect(
        progressCallbackSchema.safeParse({ run_id: RUN_ID, phase }).success
      ).toBe(false)
    }
  })
})

describe("the schema's field bounds", () => {
  test("a snapshot id must be 64 lowercase hex characters", () => {
    for (const snapshot_id of [
      "",
      "A".repeat(64),
      "a".repeat(63),
      "z".repeat(64),
    ]) {
      expect(
        progressCallbackSchema.safeParse({
          run_id: RUN_ID,
          phase: "completed",
          snapshot_id,
        }).success
      ).toBe(false)
    }

    expect(
      progressCallbackSchema.safeParse({
        run_id: RUN_ID,
        phase: "completed",
        snapshot_id: SNAPSHOT_ID,
      }).success
    ).toBe(true)
  })

  test("total must be positive and current merely non-negative", () => {
    // A total of zero would make the bar a division by zero; a current of zero is
    // the ordinary state at the start of a phase.
    expect(
      progressCallbackSchema.safeParse({
        run_id: RUN_ID,
        phase: "collecting",
        total: 0,
      }).success
    ).toBe(false)

    expect(
      progressCallbackSchema.safeParse({
        run_id: RUN_ID,
        phase: "collecting",
        current: 0,
        total: 1,
      }).success
    ).toBe(true)
  })

  test("a label longer than 64 characters is refused", () => {
    expect(
      progressCallbackSchema.safeParse({
        run_id: RUN_ID,
        phase: "collecting",
        label: "x".repeat(65),
      }).success
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe("Requirement 38.8 — a terminal row rejects everything", () => {
  test.each(["completed", "failed"] as const)(
    "a %s row refuses a collecting callback",
    (status) => {
      const decision = decideTransition(
        row(status),
        callback({ phase: "collecting" }),
        NOW,
        DEPS
      )

      expect(decision).toEqual({ ok: false, rejection: "terminal_row" })
    }
  )

  test("a completed row refuses a repeat of its own terminal status", () => {
    // The case an "idempotent transitions are fine" reading gets wrong. A repeated
    // `completed` callback carrying different counts would otherwise rewrite a
    // delivered run's audit row.
    const decision = decideTransition(
      row("completed"),
      callback({
        phase: "completed",
        snapshot_id: SNAPSHOT_ID,
        resource_count: 999,
        gap_count: 999,
      }),
      NOW,
      DEPS
    )

    expect(decision.ok).toBe(false)
  })

  test("a failed row refuses a repeat of failed", () => {
    const decision = decideTransition(
      row("failed"),
      callback({ phase: "failed", error_code: "THROTTLED" }),
      NOW,
      DEPS
    )

    expect(decision.ok).toBe(false)
  })
})

describe("Requirement 38.11 — TIMEOUT and SECRET_UNREADABLE are the app's", () => {
  test.each(["TIMEOUT", "SECRET_UNREADABLE"] as const)(
    "a failed callback presenting %s is refused",
    (error_code) => {
      const decision = decideTransition(
        row("collecting"),
        callback({ phase: "failed", error_code }),
        NOW,
        DEPS
      )

      expect(decision).toEqual({ ok: false, rejection: "timeout_reserved" })
    }
  )

  test("the reservation is checked before the transition table", () => {
    // So the refusal's reason is "TIMEOUT is reserved" rather than an anonymous
    // "unreachable target" — which is the only difference visible in the log, and
    // the log is the only place any reason is visible at all.
    const decision = decideTransition(
      row("queued"),
      callback({ phase: "collecting", error_code: "TIMEOUT" }),
      NOW,
      DEPS
    )

    expect(decision).toEqual({ ok: false, rejection: "timeout_reserved" })
  })

  test("a failed transition with no code at all is refused", () => {
    // The CHECK constraint requires a code on a `failed` row, so admitting this
    // would turn a callback into a write the database rejects — a 500 for what is
    // really a malformed callback.
    const decision = decideTransition(
      row("collecting"),
      callback({ phase: "failed" }),
      NOW,
      DEPS
    )

    expect(decision).toEqual({ ok: false, rejection: "missing_error_code" })
  })

  test("every other declared code is permitted", () => {
    for (const code of AGENT_ERROR_CODES) {
      const decision = decideTransition(
        row("collecting"),
        callback({ phase: "failed", error_code: code }),
        NOW,
        DEPS
      )

      expect(decision.ok, `${code} should be permitted`).toBe(true)
    }
  })
})

describe("Requirement 38.10 — only reachable targets", () => {
  test("queued cannot jump straight to collecting", () => {
    // `queued → claimed` is the reaper's, and the agent cannot present `claimed`,
    // so an agent callback on a `queued` row can only fail it.
    const decision = decideTransition(
      row("queued"),
      callback({ phase: "collecting" }),
      NOW,
      DEPS
    )

    expect(decision).toEqual({ ok: false, rejection: "unreachable_target" })
  })

  test("queued cannot jump straight to completed", () => {
    const decision = decideTransition(
      row("queued"),
      callback({ phase: "completed", snapshot_id: SNAPSHOT_ID }),
      NOW,
      DEPS
    )

    expect(decision.ok).toBe(false)
  })

  test("claimed reaches collecting", () => {
    const decision = decideTransition(
      row("claimed"),
      callback({ phase: "collecting" }),
      NOW,
      DEPS
    )

    expect(decision.ok).toBe(true)
    expect(decision.ok && decision.changesStatus).toBe(true)
    expect(decision.ok && decision.write.status).toBe("collecting")
  })

  test("claimed cannot reach completed without collecting first", () => {
    // A run that never collected cannot be completed. Admitting this is how a run
    // with no snapshot behind it presents as delivered.
    const decision = decideTransition(
      row("claimed"),
      callback({ phase: "completed", snapshot_id: SNAPSHOT_ID }),
      NOW,
      DEPS
    )

    expect(decision.ok).toBe(false)
  })

  test("the undriven phases are unreachable from every driven status", () => {
    // Requirement 36.2. Asserted against the table rather than through the
    // decision, because the schema refuses these before a decision is reached —
    // and the property is about the table.
    for (const targets of Object.values(DRIVEN)) {
      for (const undriven of ["compiling", "rendering", "verifying"] as const) {
        expect(targets).not.toContain(undriven)
      }
    }
  })
})

describe("Requirement 38.13 — a same-status callback is not a no-op", () => {
  test("it writes all three progress columns and leaves status unset", () => {
    const decision = decideTransition(
      row("collecting", { progressCurrent: 100, progressTotal: 200 }),
      callback({
        phase: "collecting",
        current: 142,
        total: 200,
        label: "Metrics",
      }),
      NOW,
      DEPS
    )

    expect(decision.ok).toBe(true)
    if (!decision.ok) return

    expect(decision.changesStatus).toBe(false)
    // `status` is **absent**, not set to the same value: omission is what a
    // partial UPDATE expresses as "leave the column alone".
    expect("status" in decision.write).toBe(false)

    expect(decision.write.progressCurrent).toBe(142)
    expect(decision.write.progressTotal).toBe(200)
    expect(decision.write.progressLabel).toBe("Metrics")
  })

  test("it refreshes phase_deadline to that phase's budget", () => {
    // So a phase making visible progress is not reaped for taking a while.
    const decision = decideTransition(
      row("collecting"),
      callback({ phase: "collecting", current: 1, total: 2 }),
      NOW,
      DEPS
    )

    expect(decision.ok && decision.write.phaseDeadline).toEqual(
      phaseDeadlineFor("collecting", NOW)
    )
  })

  test("a callback carrying no counts clears all three columns", () => {
    // A phase that stops carrying a countable unit of work must clear the bar
    // rather than leave the previous numbers on screen — and a null count is what
    // makes the relay emit no `progress` event at all (Requirement 40.14).
    const decision = decideTransition(
      row("collecting", {
        progressCurrent: 100,
        progressTotal: 200,
        progressLabel: "Metrics",
      }),
      callback({ phase: "collecting" }),
      NOW,
      DEPS
    )

    expect(decision.ok).toBe(true)
    if (!decision.ok) return

    expect(decision.write.progressCurrent).toBeNull()
    expect(decision.write.progressTotal).toBeNull()
    expect(decision.write.progressLabel).toBeNull()
  })
})

describe("Requirement 38.14 — an out-of-order retry moves nothing backwards", () => {
  test("a lower current for the same phase leaves all three columns unchanged", () => {
    const decision = decideTransition(
      row("collecting", {
        progressCurrent: 142,
        progressTotal: 200,
        progressLabel: "Metrics",
      }),
      callback({
        phase: "collecting",
        current: 80,
        total: 200,
        label: "Metrics",
      }),
      NOW,
      DEPS
    )

    expect(decision.ok).toBe(true)
    if (!decision.ok) return

    // All three omitted — not just `progress_current`. Writing a new total beside
    // a retained current would make the bar jump backwards anyway.
    expect("progressCurrent" in decision.write).toBe(false)
    expect("progressTotal" in decision.write).toBe(false)
    expect("progressLabel" in decision.write).toBe(false)
  })

  test("the rest of the request still applies", () => {
    // Requirement 38.14 says "apply the remainder of that request as 38.13
    // declares" — so the deadline is still refreshed and the row is still touched.
    const decision = decideTransition(
      row("collecting", { progressCurrent: 142, progressTotal: 200 }),
      callback({ phase: "collecting", current: 80 }),
      NOW,
      DEPS
    )

    expect(decision.ok && decision.write.phaseDeadline).toEqual(
      phaseDeadlineFor("collecting", NOW)
    )
  })

  test("an equal current is written, not treated as backwards", () => {
    // Non-decreasing, not strictly increasing. A repeated count with a corrected
    // total or label is a legitimate refresh.
    const decision = decideTransition(
      row("collecting", { progressCurrent: 142, progressTotal: 200 }),
      callback({ phase: "collecting", current: 142, total: 210 }),
      NOW,
      DEPS
    )

    expect(decision.ok && decision.write.progressTotal).toBe(210)
  })

  test("a transition into a phase may reset the count to zero", () => {
    // The `status` equality is part of the guard, not incidental: entering a new
    // phase legitimately starts at zero, and treating that as an out-of-order
    // arrival would freeze the bar at the previous phase's total.
    const decision = decideTransition(
      row("claimed", { progressCurrent: 500, progressTotal: 500 }),
      callback({
        phase: "collecting",
        current: 0,
        total: 200,
        label: "Inventory",
      }),
      NOW,
      DEPS
    )

    expect(decision.ok).toBe(true)
    if (!decision.ok) return

    expect(decision.write.status).toBe("collecting")
    expect(decision.write.progressCurrent).toBe(0)
    expect(decision.write.progressTotal).toBe(200)
  })

  test("a stored null current admits any presented current", () => {
    // Nothing to compare against, so nothing to refuse.
    const decision = decideTransition(
      row("collecting", { progressCurrent: null }),
      callback({ phase: "collecting", current: 5, total: 10 }),
      NOW,
      DEPS
    )

    expect(decision.ok && decision.write.progressCurrent).toBe(5)
  })
})

describe("Requirement 38.12 — a terminal transition clears the in-flight count", () => {
  test("completed records its terminal fields and clears all four", () => {
    const decision = decideTransition(
      row("collecting", {
        progressCurrent: 200,
        progressTotal: 200,
        progressLabel: "Metrics",
      }),
      callback({
        phase: "completed",
        snapshot_id: SNAPSHOT_ID,
        resource_count: 200,
        gap_count: 3,
      }),
      NOW,
      DEPS
    )

    expect(decision.ok).toBe(true)
    if (!decision.ok) return

    expect(decision.write).toEqual({
      status: "completed",
      errorCode: null,
      errorMessage: null,
      snapshotId: SNAPSHOT_ID,
      resourceCount: 200,
      gapCount: 3,
      phaseDeadline: null,
      progressCurrent: null,
      progressTotal: null,
      progressLabel: null,
    })
  })

  test("failed records its code and message and clears all four", () => {
    const decision = decideTransition(
      row("collecting", { progressCurrent: 12, progressTotal: 200 }),
      callback({
        phase: "failed",
        error_code: "EMPTY_SCOPE",
        error_message: "The requested scope resolved to zero resources.",
      }),
      NOW,
      DEPS
    )

    expect(decision.ok).toBe(true)
    if (!decision.ok) return

    expect(decision.write).toEqual({
      status: "failed",
      errorCode: "EMPTY_SCOPE",
      errorMessage: "The requested scope resolved to zero resources.",
      phaseDeadline: null,
      progressCurrent: null,
      progressTotal: null,
      progressLabel: null,
    })
  })

  test("a failed transition with no message still records one", () => {
    // `error_message` is nullable on the row, but a terminal state the UI cannot
    // explain is the thing Requirement 36.6 is about, so a default is recorded
    // rather than a null.
    const decision = decideTransition(
      row("collecting"),
      callback({ phase: "failed", error_code: "THROTTLED" }),
      NOW,
      DEPS
    )

    expect(decision.ok && decision.write.errorMessage).toBe(
      DEFAULT_FAILURE_MESSAGE
    )
  })

  test("a completed callback omitting a terminal field does not blank it", () => {
    // Each of the three is written only when presented, so a partial terminal
    // callback cannot erase a value already recorded.
    const decision = decideTransition(
      row("collecting"),
      callback({ phase: "completed" }),
      NOW,
      DEPS
    )

    expect(decision.ok).toBe(true)
    if (!decision.ok) return

    expect("snapshotId" in decision.write).toBe(false)
    expect("resourceCount" in decision.write).toBe(false)
    expect("gapCount" in decision.write).toBe(false)
  })

  test("no terminal write carries a column derived from the token", () => {
    // Requirement 38.12's last clause, held by the `ProgressWrite` type — asserted
    // anyway, because the type is erased at runtime and this is the assertion that
    // survives.
    for (const phase of ["completed", "failed"] as const) {
      const decision = decideTransition(
        row("collecting"),
        callback(
          phase === "failed"
            ? { phase, error_code: "THROTTLED" }
            : { phase, snapshot_id: SNAPSHOT_ID }
        ),
        NOW,
        DEPS
      )

      expect(decision.ok).toBe(true)
      if (!decision.ok) return

      expect(Object.keys(decision.write)).not.toContain("progressTokenHash")
    }
  })
})
