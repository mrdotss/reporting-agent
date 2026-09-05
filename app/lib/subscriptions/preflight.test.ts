import { beforeEach, describe, expect, test, vi } from "vitest"

import type { AgentInvokeContext, InvokeCommand } from "@/lib/aws/agentcore"

/**
 * `lib/subscriptions/preflight.ts` — the app's half of the preflight gate
 * (Requirements 12.11, 12.12, 12.14).
 *
 * ## What is faked, and what is not
 *
 * Only `invokeAgentRuntime`. Everything else runs: the context construction, the
 * SSE reader, the deadline, the outcome mapping. What is under test is the shape of
 * the invocation this module builds and the answer it derives from a stream — not
 * AWS, and certainly not Azure, which **nothing in `app/` ever calls**
 * (Requirement 12.11).
 *
 * ## The claims worth machine-checking
 *
 *  1. **The 30-second cap covers the whole preflight**, including a runtime that
 *     answers with a heartbeat every few milliseconds forever. A per-read timeout
 *     would be reset by each heartbeat and would never fire, which is precisely the
 *     shape a plausible implementation takes.
 *  2. **The cap releases the stream.** A preflight that timed out and left the
 *     iterator open holds a connection for as long as the container keeps talking.
 *  3. **`run_id`, `progress_url` and `progress_token` are empty**, because a
 *     preflight has no run. Getting this wrong by synthesizing a `progress_url`
 *     would name a callback endpoint that must refuse every request it receives.
 *  4. **A rejection relays the runtime's own code.** `AUTH_EXPIRED` has to survive
 *     the trip distinct from `SCOPE_UNVERIFIED` (Requirement 12.13): one is a role
 *     the customer fixes, the other a secret the consultant rotates.
 *  5. **Nothing derived from the plaintext secret reaches an outcome.**
 */

const { invocations, nextStream, nextFailure } = vi.hoisted(() => ({
  invocations: [] as {
    sessionId: string
    context: AgentInvokeContext
    command: InvokeCommand
  }[],
  nextStream: {
    value: undefined as (() => AsyncIterable<Uint8Array>) | undefined,
  },
  nextFailure: { value: undefined as unknown },
}))

vi.mock("@/lib/aws/agentcore", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/aws/agentcore")>()

  return {
    ...original,
    invokeAgentRuntime: vi.fn(
      async (a: {
        sessionId: string
        context: AgentInvokeContext
        command: InvokeCommand
      }) => {
        invocations.push(a)

        if (nextFailure.value !== undefined) throw nextFailure.value
        if (nextStream.value === undefined) {
          throw new Error("no stream was staged for this test")
        }

        return nextStream.value()
      }
    ),
  }
})

// The frame reader moved to `lib/aws/agent-stream.ts` when the inventory endpoint
// became its second caller. The cases below are unchanged and still live here,
// because what they pin is how *this* module reads a runtime's answer.
import { parseSseFrame, splitSseFrames } from "@/lib/aws/agent-stream"
import { MissingRuntimeConfigError } from "@/lib/aws/agentcore"
import {
  DEFAULT_REJECTION_CODE,
  PREFLIGHT_TIMEOUT_MS,
  outcomeFromDone,
  runPreflight,
  type PreflightSubmission,
} from "@/lib/subscriptions/preflight"

// --- Fixtures ---------------------------------------------------------------

const PLAINTEXT_SECRET = "azure-client-secret-DO-NOT-DISCLOSE-9f13c7"

const SUBMISSION: PreflightSubmission = {
  actorId: "user-01HZX9",
  displayName: "Northwind production",
  subscriptionId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  tenantId: "11111111-2222-3333-4444-555555555555",
  clientId: "66666666-7777-8888-9999-aaaaaaaaaaaa",
  clientSecret: PLAINTEXT_SECRET,
  logAnalyticsWorkspaceId: null,
}

const encoder = new TextEncoder()

/** One SSE frame, as the runtime's serializer writes it. */
function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/** A stream that yields the given text in the given chunks, then ends. */
function streamOf(
  ...chunks: readonly string[]
): () => AsyncIterable<Uint8Array> {
  return function open(): AsyncIterable<Uint8Array> {
    return (async function* bytes() {
      for (const chunk of chunks) yield encoder.encode(chunk)
    })()
  }
}

function stageStream(open: () => AsyncIterable<Uint8Array>): void {
  nextStream.value = open
  nextFailure.value = undefined
}

function stageFailure(error: unknown): void {
  nextStream.value = undefined
  nextFailure.value = error
}

beforeEach(() => {
  invocations.length = 0
  nextStream.value = undefined
  nextFailure.value = undefined
})

// --- The pure SSE reader ---------------------------------------------------

describe("splitSseFrames", () => {
  test("a buffer ending on a separator yields no phantom trailing frame", () => {
    const { frames, rest } = splitSseFrames("data: 1\n\ndata: 2\n\n")

    expect(frames).toEqual(["data: 1", "data: 2"])
    expect(rest).toBe("")
  })

  test("an incomplete frame is returned as the remainder", () => {
    // The property the whole reader rests on: a frame split across two network
    // chunks is reassembled rather than dropped.
    const { frames, rest } = splitSseFrames('data: 1\n\ndata: {"par')

    expect(frames).toEqual(["data: 1"])
    expect(rest).toBe('data: {"par')
  })

  test("CRLF framing is recognised", () => {
    // The separator is chosen by whatever serialized the stream. A reader that only
    // knew `\n\n` would accumulate the whole stream into one unterminated frame and
    // then time out — a failure indistinguishable from an unresponsive runtime.
    const { frames, rest } = splitSseFrames("data: 1\r\n\r\ndata: 2\r\n\r\n")

    expect(frames).toEqual(["data: 1", "data: 2"])
    expect(rest).toBe("")
  })
})

describe("parseSseFrame", () => {
  test("a single data line parses", () => {
    expect(parseSseFrame('data: {"type":"done"}')).toEqual({ type: "done" })
  })

  test("multiple data lines are joined with a newline", () => {
    expect(parseSseFrame('data: {"type":\ndata:  "done"}')).toEqual({
      type: "done",
    })
  })

  test.each([
    ["a comment line", ": keep alive"],
    ["an event name with no data", "event: done"],
    ["a data line that is not JSON", "data: not json"],
    ["an empty frame", ""],
  ] as const)("%s yields undefined rather than throwing", (_label, text) => {
    // A frame that does not carry the one fact being looked for is simply not that
    // frame; it is no reason to fail a preflight.
    expect(parseSseFrame(text)).toBeUndefined()
  })

  test("only one leading space after the colon is stripped", () => {
    expect(parseSseFrame('data:  "  padded"')).toBe("  padded")
  })
})

// --- The outcome mapping ---------------------------------------------------

describe("Requirements 12.3, 12.12, 12.13 — outcomeFromDone", () => {
  test("scope_verified true with a completed status is the accepted shape", () => {
    expect(
      outcomeFromDone(
        {
          type: "done",
          status: "completed",
          scope_verified: true,
          fidelity_tier: "enhanced",
        },
        undefined
      )
    ).toEqual({
      scopeVerified: true,
      fidelityTier: "enhanced",
      // `null` where the runtime said nothing about exported history: a real answer —
      // "live metrics only" — and the fail-closed direction the tier takes too.
      metricsHistorySince: null,
    })
  })

  test("an exported-history date rides on the same accepted shape", () => {
    expect(
      outcomeFromDone(
        {
          type: "done",
          status: "completed",
          scope_verified: true,
          fidelity_tier: "baseline",
          metrics_history_since: "2026-02-14T03:11:00Z",
        },
        undefined
      )
    ).toEqual({
      scopeVerified: true,
      fidelityTier: "baseline",
      metricsHistorySince: "2026-02-14T03:11:00Z",
    })
  })

  test("an explicit null history is read as none, not as missing", () => {
    // The runtime states it as `null` for a subscription with no export, which the schema
    // accepts as `nullable()` rather than only `optional()`.
    expect(
      outcomeFromDone(
        {
          type: "done",
          status: "completed",
          scope_verified: true,
          metrics_history_since: null,
        },
        undefined
      )
    ).toEqual({
      scopeVerified: true,
      fidelityTier: "baseline",
      metricsHistorySince: null,
    })
  })

  test("Requirement 12.9 — an absent tier reads as baseline", () => {
    expect(
      outcomeFromDone(
        { type: "done", status: "completed", scope_verified: true },
        undefined
      )
    ).toEqual({
      scopeVerified: true,
      fidelityTier: "baseline",
      metricsHistorySince: null,
    })
  })

  test.each([
    ["scope_verified false", { scope_verified: false, status: "failed" }],
    ["scope_verified absent", { status: "completed" }],
    [
      "a failed status despite a true flag",
      { scope_verified: true, status: "failed" },
    ],
  ] as const)("%s is a rejection", (_label, fields) => {
    // Fail closed on every one of them. `handle_preflight` seeds its outcome with
    // `false` before any Azure call, so `false` covers every path it can take —
    // and requiring the completed status as well means a failure nobody
    // anticipated is treated as unproven rather than as proved.
    const outcome = outcomeFromDone({ type: "done", ...fields }, undefined)

    expect(outcome.scopeVerified).toBe(false)
  })

  test("the runtime's code and message are relayed", () => {
    const outcome = outcomeFromDone(
      { type: "done", status: "failed", scope_verified: false },
      { code: "AUTH_EXPIRED", message: "Azure rejected the secret as expired." }
    )

    expect(outcome).toEqual({
      scopeVerified: false,
      code: "AUTH_EXPIRED",
      message: "Azure rejected the secret as expired.",
    })
  })

  test("a code outside the run error enum becomes SCOPE_UNVERIFIED", () => {
    // Never a code invented here, and never one the `run_error_code` column would
    // reject at write time.
    const outcome = outcomeFromDone(
      { type: "done", status: "failed" },
      { code: "SOMETHING_NEW", message: "A newer runtime said something." }
    )

    expect(outcome).toMatchObject({
      scopeVerified: false,
      code: DEFAULT_REJECTION_CODE,
    })
    expect(DEFAULT_REJECTION_CODE).toBe("SCOPE_UNVERIFIED")
  })

  test("a rejection with no message states the subscription-scope requirement", () => {
    // Requirement 12.7's substance has to be available even when the runtime said
    // nothing: a resource-group-scoped assignment is the failure being explained.
    const outcome = outcomeFromDone(
      { type: "done", status: "failed" },
      undefined
    )

    expect(outcome.scopeVerified).toBe(false)
    if (outcome.scopeVerified) return
    expect(outcome.message).toContain("Reader")
    expect(outcome.message).toContain("subscription scope")
    expect(outcome.message).toContain("resource group")
  })
})

// --- The invocation --------------------------------------------------------

describe("Requirement 12.11 — the invocation the runtime receives", () => {
  test("the command is preflight and the context carries the submitted credential", async () => {
    stageStream(
      streamOf(
        frame({ type: "done", status: "completed", scope_verified: true })
      )
    )

    await runPreflight(SUBMISSION)

    expect(invocations).toHaveLength(1)
    const { command, context, sessionId } = invocations[0]

    expect(command).toEqual({ command: "preflight" })
    expect(context.actor_id).toBe(SUBMISSION.actorId)
    expect(context.subscription_id).toBe(SUBMISSION.subscriptionId)
    expect(context.tenant_id).toBe(SUBMISSION.tenantId)
    expect(context.client_id).toBe(SUBMISSION.clientId)
    expect(context.client_secret).toBe(PLAINTEXT_SECRET)
    expect(context.display_name).toBe(SUBMISSION.displayName)
    expect(context.log_analytics_workspace_id).toBeNull()

    // Not cosmetic anywhere else in the product, and irrelevant to a preflight —
    // but the field is required, and the default is the one every other invocation
    // uses.
    expect(context.timezone).toBe("Asia/Jakarta")

    // `lib/session-id.ts` keeps the bound `InvokeAgentRuntime` enforces.
    expect(sessionId.length).toBeGreaterThanOrEqual(33)
    expect(sessionId.length).toBeLessThanOrEqual(128)
  })

  test("a preflight carries no run, so the three run fields are empty", async () => {
    stageStream(
      streamOf(
        frame({ type: "done", status: "completed", scope_verified: true })
      )
    )

    await runPreflight(SUBMISSION)

    const { context } = invocations[0]

    // How "no run" is spelled on the wire: `progress.py` treats a reporter built
    // without all three as disabled, so these are not placeholders the agent might
    // try to use. A synthesized `progress_url` would name a callback the endpoint
    // must refuse, since it authorizes by run-scoped HMAC and no token was minted.
    expect(context.run_id).toBe("")
    expect(context.progress_url).toBe("")
    expect(context.progress_token).toBe("")

    // The tier is what this invocation probes, so there is nothing yet to declare.
    expect(context.fidelity_tier).toBe("baseline")
  })

  test("a fresh session id per preflight", async () => {
    for (let i = 0; i < 2; i += 1) {
      stageStream(
        streamOf(
          frame({ type: "done", status: "completed", scope_verified: true })
        )
      )
      await runPreflight(SUBMISSION)
    }

    // Random rather than derived: `sessionIdForRun` needs a run id, and a preflight
    // is one stateless question whose answer gains nothing from continuity.
    expect(invocations[0].sessionId).not.toBe(invocations[1].sessionId)
  })
})

// --- Reading the stream ----------------------------------------------------

describe("Requirement 12.12 — reading the answer off the stream", () => {
  test("a verified done resolves to the probed tier", async () => {
    stageStream(
      streamOf(
        frame({
          type: "tool",
          phase: "start",
          id: "p-1",
          name: "preflight_permissions",
        }),
        frame({ type: "tool", phase: "end", id: "p-1" }),
        frame({
          type: "done",
          run_id: null,
          status: "completed",
          scope_verified: true,
          fidelity_tier: "enhanced",
        })
      )
    )

    await expect(runPreflight(SUBMISSION)).resolves.toEqual({
      scopeVerified: true,
      fidelityTier: "enhanced",
      // `null` where the runtime said nothing about exported history, which is the
      // common case and a real answer rather than a missing field.
      metricsHistorySince: null,
    })
  })

  test("an error event before done supplies the code", async () => {
    stageStream(
      streamOf(
        frame({
          type: "error",
          code: "AUTH_EXPIRED",
          terminal: true,
          message: "The client secret has expired.",
        }),
        frame({
          type: "done",
          run_id: null,
          status: "failed",
          scope_verified: false,
        })
      )
    )

    await expect(runPreflight(SUBMISSION)).resolves.toEqual({
      scopeVerified: false,
      code: "AUTH_EXPIRED",
      message: "The client secret has expired.",
    })
  })

  test("a frame split across chunks is reassembled", async () => {
    const whole = frame({
      type: "done",
      status: "completed",
      scope_verified: true,
      fidelity_tier: "baseline",
    })

    stageStream(
      streamOf(whole.slice(0, 12), whole.slice(12, 25), whole.slice(25))
    )

    await expect(runPreflight(SUBMISSION)).resolves.toEqual({
      scopeVerified: true,
      fidelityTier: "baseline",
      metricsHistorySince: null,
    })
  })

  test("an undeclared event type is ignored rather than fatal", async () => {
    // An older client meeting a newer runtime must degrade, not crash.
    stageStream(
      streamOf(
        frame({ type: "something_new", detail: "from a later spec" }),
        ": a comment frame\n\n",
        frame({ type: "heartbeat", ts: 1 }),
        frame({ type: "done", status: "completed", scope_verified: true })
      )
    )

    await expect(runPreflight(SUBMISSION)).resolves.toMatchObject({
      scopeVerified: true,
    })
  })

  test("a stream that ends without a done event proves nothing", async () => {
    // The router emits `done` on every path, so a truncated stream is a proxy or a
    // crash — and either way subscription-scope read was not proved.
    stageStream(streamOf(frame({ type: "heartbeat", ts: 1 })))

    await expect(runPreflight(SUBMISSION)).resolves.toMatchObject({
      scopeVerified: false,
      code: DEFAULT_REJECTION_CODE,
    })
  })

  test("a stream that fails mid-read is a rejection, not a throw", async () => {
    nextFailure.value = undefined
    nextStream.value = function open(): AsyncIterable<Uint8Array> {
      return (async function* bytes() {
        yield encoder.encode(frame({ type: "heartbeat", ts: 1 }))
        throw new Error("the connection dropped")
      })()
    }

    await expect(runPreflight(SUBMISSION)).resolves.toMatchObject({
      scopeVerified: false,
      code: DEFAULT_REJECTION_CODE,
    })
  })

  test("an invocation that fails is a rejection, not a throw", async () => {
    // Nothing proved the scope, so the connection is not acceptable — whatever the
    // reason. A throw here would surface as a 500 on a submission the consultant
    // can act on.
    stageFailure(new Error("the runtime refused the invocation"))

    await expect(runPreflight(SUBMISSION)).resolves.toMatchObject({
      scopeVerified: false,
      code: DEFAULT_REJECTION_CODE,
    })
  })

  test("an unconfigured runtime throws rather than blaming the connection", async () => {
    // A deployment mistake must not be reported as "your customer's role
    // assignment is wrong", which would send a consultant to argue with an
    // administrator about a correct assignment.
    stageFailure(new MissingRuntimeConfigError("RPT_RUNTIME_ARN"))

    await expect(runPreflight(SUBMISSION)).rejects.toBeInstanceOf(
      MissingRuntimeConfigError
    )
  })

  test("no outcome carries the plaintext secret", async () => {
    stageStream(
      streamOf(
        frame({ type: "done", status: "completed", scope_verified: true })
      )
    )
    const verified = await runPreflight(SUBMISSION)

    stageStream(
      streamOf(frame({ type: "done", status: "failed", scope_verified: false }))
    )
    const rejected = await runPreflight(SUBMISSION)

    for (const outcome of [verified, rejected]) {
      expect(JSON.stringify(outcome)).not.toContain(PLAINTEXT_SECRET)
    }
  })
})

// --- The cap ---------------------------------------------------------------

describe("Requirement 12.12 — the 30-second cap", () => {
  test("the declared cap is 30 seconds", () => {
    // The same 30 seconds `azure/preflight.py` caps its permissions request at, and
    // asserted here so the two cannot drift silently apart.
    expect(PREFLIGHT_TIMEOUT_MS).toBe(30_000)
  })

  test("a runtime that heartbeats forever is capped, and the stream is released", async () => {
    // The test a per-read timeout fails: every chunk resets a per-read timer, so an
    // implementation that applied the deadline once per `next()` would never fire.
    let returned = false

    nextFailure.value = undefined
    nextStream.value = function open(): AsyncIterable<Uint8Array> {
      const iterable = {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            async next() {
              await new Promise((resolve) => setTimeout(resolve, 5))
              return {
                done: false,
                value: encoder.encode(frame({ type: "heartbeat", ts: 1 })),
              }
            },
            async return() {
              returned = true
              return { done: true as const, value: undefined }
            },
          }
        },
      }
      return iterable
    }

    const outcome = await runPreflight(SUBMISSION, { timeoutMs: 60 })

    expect(outcome).toMatchObject({
      scopeVerified: false,
      code: DEFAULT_REJECTION_CODE,
    })

    // An abandoned iterator holds a connection for as long as the container keeps
    // talking, so the reader releases it.
    expect(returned).toBe(true)
  })

  test("an invocation that never returns a stream is capped too", async () => {
    // The budget starts before the invoke, so a runtime that never answers at all
    // is bounded by the same 30 seconds rather than holding the browser open.
    nextStream.value = undefined
    nextFailure.value = undefined

    const { invokeAgentRuntime } = await import("@/lib/aws/agentcore")
    vi.mocked(invokeAgentRuntime).mockImplementationOnce(
      () => new Promise<AsyncIterable<Uint8Array>>(() => {})
    )

    const outcome = await runPreflight(SUBMISSION, { timeoutMs: 30 })

    expect(outcome).toMatchObject({
      scopeVerified: false,
      code: DEFAULT_REJECTION_CODE,
    })
  })

  test("the timeout message names the 30-second budget and the requirement", async () => {
    // Fake timers so the real cap is exercised at its real value without the suite
    // waiting half a minute for it.
    vi.useFakeTimers()

    nextStream.value = undefined
    nextFailure.value = undefined

    const { invokeAgentRuntime } = await import("@/lib/aws/agentcore")
    vi.mocked(invokeAgentRuntime).mockImplementationOnce(
      () => new Promise<AsyncIterable<Uint8Array>>(() => {})
    )

    try {
      const pending = runPreflight(SUBMISSION)
      await vi.advanceTimersByTimeAsync(PREFLIGHT_TIMEOUT_MS)
      const outcome = await pending

      expect(outcome.scopeVerified).toBe(false)
      if (outcome.scopeVerified) return
      expect(outcome.message).toContain("30 seconds")
      expect(outcome.message).toContain("subscription scope")
    } finally {
      vi.useRealTimers()
    }
  })
})
