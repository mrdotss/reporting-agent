import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { RunStatus } from "@/lib/db/schema"
import type { ClaimedRun } from "@/lib/runs/claim"
import type { InvokeOutcome } from "@/lib/runs/invoke"

/**
 * `POST /api/cron/tick` — the reaper's request handling (Requirements 39.2, 39.3, 39.9,
 * 39.11, 39.13).
 *
 * ## The assertion this file exists for
 *
 * **A rejected request claims nothing and writes nothing, including no `TIMEOUT`**
 * (Requirement 39.3). The two statements that write are the sweep and the claim, so what
 * is asserted is that *neither is called* — which is a stronger and more direct claim
 * than inspecting rows afterwards, because it holds whatever the table happened to
 * contain.
 *
 * That matters because this endpoint's **only** protection is the bearer secret. It can
 * claim work and invoke the runtime, so an unauthenticated tick is a denial-of-wallet
 * hole reachable by anybody who finds the URL — and a check that ran *after* the sweep
 * would already have written `TIMEOUT` to somebody's rows before refusing.
 *
 * The comparison itself is unit-tested in `lib/runs/claim.test.ts`, against every input
 * shape including the ones that would make a naive `timingSafeEqual` throw. This file
 * asserts the ordering and the consequences.
 *
 * ## What is faked
 *
 * The sweep, the claim and the invocation — the three things that touch Postgres or AWS.
 * `bearerMatches` is **real**, because it is the thing under test.
 */

const { claim, invoke } = vi.hoisted(() => ({
  claim: {
    sweepCalls: 0,
    claimCalls: 0,
    swept: [] as { id: string; expiredPhase: RunStatus }[],
    claimed: [] as ClaimedRun[],
    claimedBy: [] as string[],
    sweepThrows: undefined as unknown,
  },
  invoke: {
    calls: [] as { runId: string; sessionId: string }[],
    outcomes: [] as (InvokeOutcome | Error)[],
  },
}))

vi.mock("@/lib/runs/claim", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/runs/claim")>()

  return {
    ...original,
    sweepExpiredRuns: async () => {
      claim.sweepCalls += 1
      if (claim.sweepThrows !== undefined) throw claim.sweepThrows
      return claim.swept
    },
    claimQueuedRuns: async (claimedBy: string) => {
      claim.claimCalls += 1
      claim.claimedBy.push(claimedBy)
      return claim.claimed
    },
  }
})

vi.mock("@/lib/runs/invoke", () => ({
  startRunInvocation: async (run: ClaimedRun, sessionId: string) => {
    invoke.calls.push({ runId: run.id, sessionId })

    const outcome = invoke.outcomes.shift()
    if (outcome instanceof Error) throw outcome

    return outcome ?? { kind: "invoked" }
  },
}))

const { POST } = await import("@/app/api/cron/tick/route")

const { MissingRuntimeConfigError } = await import("@/lib/aws/agentcore")
const { sessionIdForRun } = await import("@/lib/session-id")

// --- Fixtures ---------------------------------------------------------------

const SECRET_VAR = "RPT_CRON_SECRET"
const SECRET = "0123456789abcdef0123456789abcdef"

let previousSecret: string | undefined

function claimed(id: string): ClaimedRun {
  return {
    id,
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
    // The pinned version the claim now returns. `startRunInvocation` is faked in this
    // file, so nothing here reads it — it is present because `ClaimedRun` requires it,
    // and requiring it is the point: a claim that dropped the column would invoke every
    // run as snapshot-only.
    templateVersionId: "ver-1",
    // Same reasoning, for the per-run front-matter columns: `ClaimedRun` requires them
    // present (as a value or `null`) so a claim that dropped them cannot compile.
    customerName: null,
    revisionHistoryRow: null,
  }
}

function tick(authorization: string | null = `Bearer ${SECRET}`): Request {
  return new Request("https://app.test/api/cron/tick", {
    method: "POST",
    headers: authorization === null ? {} : { authorization },
  })
}

type TickBody = {
  swept: number
  claimed: number
  invoked: number
  failed: number
  skipped: number
  notStarted: number
}

beforeEach(() => {
  previousSecret = process.env[SECRET_VAR]
  process.env[SECRET_VAR] = SECRET

  claim.sweepCalls = 0
  claim.claimCalls = 0
  claim.swept = []
  claim.claimed = []
  claim.claimedBy = []
  claim.sweepThrows = undefined
  invoke.calls = []
  invoke.outcomes = []

  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  if (previousSecret === undefined) delete process.env[SECRET_VAR]
  else process.env[SECRET_VAR] = previousSecret

  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------

describe("Requirement 39.3 — a rejected request writes nothing at all", () => {
  test.each([
    ["an absent header", null],
    ["the bare secret with no scheme", SECRET],
    ["a wrong secret", `Bearer ${SECRET.slice(0, -1)}0`],
    ["an empty bearer", "Bearer "],
    ["a different scheme", `Basic ${SECRET}`],
  ] as const)(
    "%s claims nothing and sweeps nothing",
    async (_label, header) => {
      const response = await POST(tick(header))

      expect(response.status).toBe(401)

      // The two statements that write. Neither was reached, so no row was touched — and in
      // particular no `TIMEOUT` was written, which a check placed after the sweep would
      // already have done.
      expect(claim.sweepCalls).toBe(0)
      expect(claim.claimCalls).toBe(0)
      expect(invoke.calls).toEqual([])
    }
  )

  test("the rejection body says nothing about the configuration", async () => {
    // A message distinguishing "no secret is set" from "your secret is wrong" would tell
    // an unauthorized caller which of the two it is looking at.
    const response = await POST(tick("Bearer wrong"))

    expect(await response.text()).toBe("")
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})

describe("Requirement 39.2 — it fails closed on an unset secret", () => {
  test.each([undefined, "", "   "])(
    "a secret of %j rejects even a matching presentation",
    async (configured) => {
      if (configured === undefined) delete process.env[SECRET_VAR]
      else process.env[SECRET_VAR] = configured

      const response = await POST(tick(`Bearer ${configured ?? ""}`))

      expect(response.status).toBe(401)
      expect(claim.sweepCalls).toBe(0)
      expect(claim.claimCalls).toBe(0)
    }
  )
})

describe("Requirement 39.11 — the sweep runs before the claim", () => {
  test("both run, and the sweep first", async () => {
    // Modelled by call counters rather than by ordering the fakes' side effects, because
    // what the requirement fixes is that the sweep has *completed* before the claim
    // selects — the claim's `status = 'queued'` predicate is what excludes the swept rows,
    // and it can only do that if the sweep already committed.
    const order: string[] = []

    claim.sweepThrows = undefined
    claim.swept = [{ id: "expired-1", expiredPhase: "collecting" }]
    claim.claimed = [claimed("run-1")]

    const sweepSpy = vi.fn(() => order.push("sweep"))
    const claimSpy = vi.fn(() => order.push("claim"))

    // Re-wire the hoisted fakes to record order for this case only.
    const claimModule = await import("@/lib/runs/claim")
    vi.spyOn(claimModule, "sweepExpiredRuns").mockImplementation(async () => {
      sweepSpy()
      return claim.swept
    })
    vi.spyOn(claimModule, "claimQueuedRuns").mockImplementation(async () => {
      claimSpy()
      return claim.claimed
    })

    const response = await POST(tick())

    expect(response.status).toBe(200)
    expect(order).toEqual(["sweep", "claim"])
  })

  test("the response reports both counts", async () => {
    claim.swept = [
      { id: "expired-1", expiredPhase: "collecting" },
      { id: "expired-2", expiredPhase: "queued" },
    ]
    claim.claimed = [claimed("run-1"), claimed("run-2")]

    const body = (await (await POST(tick())).json()) as TickBody

    expect(body).toMatchObject({ swept: 2, claimed: 2, invoked: 2 })
  })
})

describe("Requirements 39.4, 39.9 — one claimer per request, and it never waits", () => {
  test("claimed_by is one value per request and differs between requests", async () => {
    claim.claimed = [claimed("run-1")]
    await POST(tick())

    claim.claimed = [claimed("run-2")]
    await POST(tick())

    expect(claim.claimedBy).toHaveLength(2)
    expect(claim.claimedBy[0]).not.toBe(claim.claimedBy[1])
  })

  test("the session id is derived from the run's id", async () => {
    // Requirements 8.5, 41.7 — so a retried invocation of one run presents the same id
    // and the agent's memory stays continuous across it.
    claim.claimed = [claimed("run-42")]

    await POST(tick())

    expect(invoke.calls[0]).toEqual({
      runId: "run-42",
      sessionId: sessionIdForRun("run-42"),
    })
  })

  test("every claimed row is attempted", async () => {
    claim.claimed = [claimed("a"), claimed("b"), claimed("c")]

    await POST(tick())

    expect(invoke.calls.map((call) => call.runId)).toEqual(["a", "b", "c"])
  })
})

describe("Requirement 39.13 — one row's failure does not abandon the others", () => {
  test("a raising gate leaves the remaining rows invoked", async () => {
    claim.claimed = [claimed("a"), claimed("b"), claimed("c")]
    invoke.outcomes = [
      { kind: "invoked" },
      new Error("the gate blew up"),
      { kind: "invoked" },
    ]

    const body = (await (await POST(tick())).json()) as TickBody

    // All three attempted, two started, one left `claimed` for the deadline sweep.
    expect(invoke.calls).toHaveLength(3)
    expect(body.invoked).toBe(2)
    expect(body.notStarted).toBe(1)
  })

  test("the outcome counts are reported separately", async () => {
    // Each kind means something different to an operator: `failed` is a gate refusal that
    // wrote a terminal code, `skipped` is a row that had already moved on, and
    // `notStarted` is a row left `claimed` for the sweep. Flattening them would remove
    // the only signal that distinguishes a configuration problem from a busy runtime.
    claim.claimed = [claimed("a"), claimed("b"), claimed("c"), claimed("d")]
    invoke.outcomes = [
      { kind: "invoked" },
      { kind: "failed", code: "AUTH_EXPIRED" },
      { kind: "skipped", reason: "the row is collecting rather than claimed" },
      { kind: "not_started", reason: "no response stream within 10000ms" },
    ]

    const body = (await (await POST(tick())).json()) as TickBody

    expect(body).toMatchObject({
      claimed: 4,
      invoked: 1,
      failed: 1,
      skipped: 1,
      notStarted: 1,
    })
  })

  test("an unconfigured runtime answers 503 after attempting every row", async () => {
    // Not this run's problem, and not one the next tick will solve — but the rows are
    // still left `claimed` for the sweep rather than each failed in turn for something no
    // run can recover from.
    claim.claimed = [claimed("a"), claimed("b")]
    invoke.outcomes = [
      new MissingRuntimeConfigError("RPT_RUNTIME_ARN"),
      new MissingRuntimeConfigError("RPT_RUNTIME_ARN"),
    ]

    const response = await POST(tick())

    expect(response.status).toBe(503)
    expect(invoke.calls).toHaveLength(2)

    const body = (await response.json()) as {
      error?: { code?: string; message?: string }
    }

    expect(body.error?.code).toBe("RUNTIME_UNCONFIGURED")
    // The message names no variable: that is a fact about our deployment, and the
    // consultant reading it can act on neither it nor its absence.
    expect(body.error?.message).not.toContain("RPT_RUNTIME_ARN")
  })
})

describe("a failed sweep or claim is a 500, not a partial report", () => {
  test("the response says nothing about what half-happened", async () => {
    // The two statements are each atomic, and the next tick 60 seconds from now repeats
    // whichever did not land — so a partial count would be a number nobody can act on.
    claim.sweepThrows = new Error("connection lost")

    const response = await POST(tick())

    expect(response.status).toBe(500)
    expect(claim.claimCalls).toBe(0)
  })
})
