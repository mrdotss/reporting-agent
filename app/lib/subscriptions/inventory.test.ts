import { beforeEach, describe, expect, test, vi } from "vitest"

import type { AgentInvokeContext, InvokeCommand } from "@/lib/aws/agentcore"
import type { ResolvedAzureCredentials } from "@/lib/subscriptions/store"

/**
 * `lib/subscriptions/inventory.ts` — the `list_inventory` invocation
 * (Requirements 9.1, 9.3, 9.8).
 *
 * ## What is faked, and what is not
 *
 * Only `invokeAgentRuntime`, exactly as `preflight.test.ts` does. Everything else
 * runs: the context construction, the frame reader, the deadline, and the mapping
 * from a stream to a listing. Azure is faked nowhere because **nothing in `app/`
 * ever calls it** — that is the property this module exists to preserve, and a fake
 * Azure client here would quietly suggest otherwise.
 *
 * ## The claims worth machine-checking
 *
 *  1. **A command, never a prompt.** The payload carries `list_inventory` and no
 *     prompt field, because the pickers need the subscription's actual inventory and
 *     a model deciding whether to look is not a mechanism.
 *  2. **All four dimensions or none.** A `done` carrying three is not a smaller
 *     answer — a picker handed three would present the fourth as "this subscription
 *     has no tags", which is the empty-list-reads-as-empty-subscription failure the
 *     whole endpoint is shaped around.
 *  3. **The three unavailable reasons are distinguished.** They point at different
 *     things to go and look at, and flattening them removes the only signal a
 *     consultant can act on.
 *  4. **The 30-second cap covers the whole attempt**, including a runtime that
 *     heartbeats forever — the shape a per-read timeout never catches — and it
 *     releases the stream on the way out.
 *  5. **The declared per-dimension bound is refused, not truncated.** An over-long
 *     dimension is not presented at all, which is also what keeps the module-level
 *     cache bounded.
 */

const { invocations, nextStream, nextFailure, nextHang } = vi.hoisted(() => ({
  invocations: [] as {
    sessionId: string
    context: AgentInvokeContext
    command: InvokeCommand
  }[],
  nextStream: {
    value: undefined as (() => AsyncIterable<Uint8Array>) | undefined,
  },
  nextFailure: { value: undefined as unknown },
  /** An invocation that never settles, so the pre-stream half of the cap is real. */
  nextHang: { value: false },
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

        if (nextHang.value) await new Promise(() => {})
        if (nextFailure.value !== undefined) throw nextFailure.value
        if (nextStream.value === undefined) {
          throw new Error("no stream was staged for this test")
        }

        return nextStream.value()
      }
    ),
  }
})

import {
  COMMAND_LIST_INVENTORY,
  MissingRuntimeConfigError,
} from "@/lib/aws/agentcore"
import {
  INVENTORY_TIMEOUT_MS,
  MAX_DIMENSION_VALUES,
  dimensionsFromDone,
  invocationFailureReason,
  listInventory,
} from "@/lib/subscriptions/inventory"

// --- Fixtures ---------------------------------------------------------------

/** Distinctive enough that a substring scan cannot match it by accident. */
const PLAINTEXT_SECRET = "azure-client-secret-INVENTORY-DO-NOT-DISCLOSE-71ac3f"

const CREDENTIALS: ResolvedAzureCredentials = {
  subscriptionId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  tenantId: "11111111-2222-3333-4444-555555555555",
  clientId: "66666666-7777-8888-9999-aaaaaaaaaaaa",
  clientSecret: PLAINTEXT_SECRET,
  fidelityTier: "baseline",
  logAnalyticsWorkspaceId: null,
}

const REQUEST = {
  actorId: "user-01HZX9",
  displayName: "Northwind production",
  credentials: CREDENTIALS,
}

const FOUR_DIMENSIONS = {
  resource_types: {
    values: ["Microsoft.Compute/virtualMachines"],
    truncated: false,
  },
  resource_groups: { values: ["rg-prod-sea"], truncated: false },
  tag_keys: { values: ["env", "owner"], truncated: false },
  tag_values: { values: ["prod", "staging"], truncated: true },
}

const encoder = new TextEncoder()

function frame(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
}

/** A stream that yields each staged chunk and then ends. */
function streamOf(...chunks: Uint8Array[]): () => AsyncIterable<Uint8Array> {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  })
}

/** A stream that never ends, recording whether it was released. */
function endlessStream(released: { value: boolean }) {
  return () => ({
    [Symbol.asyncIterator]() {
      return {
        async next() {
          // A heartbeat, forever. A per-read timeout would be reset by each one.
          await new Promise((resolve) => setTimeout(resolve, 5))
          return { done: false, value: frame({ type: "heartbeat", ts: 1 }) }
        },
        async return() {
          released.value = true
          return { done: true as const, value: undefined }
        },
      }
    },
  })
}

/**
 * A flood: `limit` heartbeats with no delay at all, counting the reads.
 *
 * Those reads settle on a **microtask**, so they starve any timer — which is the
 * case a deadline implemented purely as a `Promise.race` against `setTimeout` cannot
 * catch, because its timer arm never gets scheduled. A runtime delivering buffered
 * frames back to back looks exactly like this.
 *
 * Bounded rather than endless on purpose. An unbounded version of this fixture does
 * not *fail* against a reader with no clock check — it **hangs**, starving the very
 * timer Vitest would have used to time the case out, and a test that hangs instead
 * of failing is worse than no test. The bound plus the read count turns the same
 * defect into an assertion that goes red in milliseconds.
 */
function floodStream(reads: { value: number }, limit: number) {
  return () => ({
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          reads.value += 1
          if (reads.value > limit) return { done: true, value: undefined }
          return { done: false, value: frame({ type: "heartbeat", ts: 1 }) }
        },
      }
    },
  })
}

function stage(stream: () => AsyncIterable<Uint8Array>): void {
  nextStream.value = stream
  nextFailure.value = undefined
}

beforeEach(() => {
  invocations.length = 0
  nextStream.value = undefined
  nextFailure.value = undefined
  nextHang.value = false
})

// --- The invocation ---------------------------------------------------------

describe("Requirement 9.3 — a deterministic command carrying the credentials", () => {
  test("the payload is the list_inventory command and carries no prompt", async () => {
    stage(streamOf(frame({ type: "done", ...FOUR_DIMENSIONS })))

    await listInventory(REQUEST)

    expect(invocations).toHaveLength(1)
    expect(invocations[0].command).toEqual({
      command: COMMAND_LIST_INVENTORY,
    })
    // Asserted as an absence, because the invariant is that the deterministic path
    // is reachable without a model: a `prompt` field nothing reads today is a field
    // somebody will eventually expect to matter.
    expect(Object.keys(invocations[0].command)).toEqual(["command"])
    expect(JSON.stringify(invocations[0].command)).not.toContain("prompt")
  })

  test("the context carries the server-resolved Azure credentials", async () => {
    stage(streamOf(frame({ type: "done", ...FOUR_DIMENSIONS })))

    await listInventory(REQUEST)

    const context = invocations[0].context
    expect(context.subscription_id).toBe(CREDENTIALS.subscriptionId)
    expect(context.tenant_id).toBe(CREDENTIALS.tenantId)
    expect(context.client_id).toBe(CREDENTIALS.clientId)
    expect(context.client_secret).toBe(PLAINTEXT_SECRET)
    expect(context.actor_id).toBe(REQUEST.actorId)
    expect(context.display_name).toBe(REQUEST.displayName)
  })

  test("the three run fields are empty, because a listing has no run", async () => {
    stage(streamOf(frame({ type: "done", ...FOUR_DIMENSIONS })))

    await listInventory(REQUEST)

    const context = invocations[0].context
    // Empty rather than synthesized: the runtime treats a progress reporter built
    // without all three as disabled, so this is how "no run" is stated on the wire.
    // A `progress_url` invented from the app's origin would name a callback endpoint
    // that must refuse every request it received.
    expect(context.run_id).toBe("")
    expect(context.progress_url).toBe("")
    expect(context.progress_token).toBe("")
  })

  test("the session id holds the runtime's length bound", async () => {
    stage(streamOf(frame({ type: "done", ...FOUR_DIMENSIONS })))

    await listInventory(REQUEST)

    expect(invocations[0].sessionId.length).toBeGreaterThanOrEqual(33)
    expect(invocations[0].sessionId.length).toBeLessThanOrEqual(128)
  })

  test("an unconfigured runtime throws rather than resolving as unavailable", async () => {
    // Our deployment, not this customer's subscription. Reporting it as an
    // unavailable inventory would send a consultant to look at a role assignment
    // that is fine.
    nextFailure.value = new MissingRuntimeConfigError("RPT_RUNTIME_ARN")

    await expect(listInventory(REQUEST)).rejects.toBeInstanceOf(
      MissingRuntimeConfigError
    )
  })
})

// --- The answer -------------------------------------------------------------

describe("Requirements 9.1, 9.5 — the four dimensions, or no listing", () => {
  test("a done carrying all four resolves as available", async () => {
    stage(streamOf(frame({ type: "done", ...FOUR_DIMENSIONS })))

    const listing = await listInventory(REQUEST)

    expect(listing).toEqual({ available: true, dimensions: FOUR_DIMENSIONS })
  })

  test("truncated travels with the values it describes", async () => {
    stage(streamOf(frame({ type: "done", ...FOUR_DIMENSIONS })))

    const listing = await listInventory(REQUEST)

    expect(listing.available).toBe(true)
    if (!listing.available) return
    // 2000 values with `truncated: false` is a subscription with 2000 groups; the
    // same array with `true` is a subscription with an unknown number more. A picker
    // that could not tell them apart presents "these are the options" for a list
    // that is not.
    expect(listing.dimensions.tag_values.truncated).toBe(true)
    expect(listing.dimensions.tag_keys.truncated).toBe(false)
  })

  test.each([
    "resource_types",
    "resource_groups",
    "tag_keys",
    "tag_values",
  ] as const)("a done missing %s carries no listing at all", async (absent) => {
    const partial: Record<string, unknown> = { ...FOUR_DIMENSIONS }
    delete partial[absent]
    stage(streamOf(frame({ type: "done", ...partial })))

    const listing = await listInventory(REQUEST)

    // Not three dimensions and a gap. Requirement 9.5's shape is all four or none.
    expect(listing.available).toBe(false)
  })

  test("a done carrying no dimension and no error is no_response", async () => {
    // The contract's own signal: a listing that did not answer carries no dimension
    // key, rather than four empty ones.
    stage(streamOf(frame({ type: "done", status: "completed" })))

    const listing = await listInventory(REQUEST)

    expect(listing).toMatchObject({ available: false, reason: "no_response" })
  })

  test("four empty dimensions are still an available listing", async () => {
    // The other direction, and the one worth stating: an empty subscription is a
    // legitimate answer *when the runtime says so by sending the keys*. What must
    // never happen is this module inventing that answer from silence.
    stage(
      streamOf(
        frame({
          type: "done",
          resource_types: { values: [], truncated: false },
          resource_groups: { values: [], truncated: false },
          tag_keys: { values: [], truncated: false },
          tag_values: { values: [], truncated: false },
        })
      )
    )

    const listing = await listInventory(REQUEST)

    expect(listing.available).toBe(true)
  })

  test("dimensionsFromDone is all-or-nothing over the parsed event", () => {
    // The predicate on its own, so a loop that returned a partial record fails here
    // rather than one layer up where a message could mask it.
    expect(dimensionsFromDone({ type: "done", ...FOUR_DIMENSIONS })).toEqual(
      FOUR_DIMENSIONS
    )
    expect(
      dimensionsFromDone({
        type: "done",
        resource_types: FOUR_DIMENSIONS.resource_types,
        resource_groups: FOUR_DIMENSIONS.resource_groups,
        tag_keys: FOUR_DIMENSIONS.tag_keys,
      })
    ).toBeUndefined()
    expect(dimensionsFromDone({ type: "done" })).toBeUndefined()
  })
})

describe("Requirement 9.1 — the per-dimension bound is refused, not truncated", () => {
  test("the declared bound is 2000", () => {
    expect(MAX_DIMENSION_VALUES).toBe(2000)
  })

  test("a dimension at the bound is accepted", async () => {
    const atBound = Array.from({ length: MAX_DIMENSION_VALUES }, (_v, i) =>
      String(i).padStart(6, "0")
    )
    stage(
      streamOf(
        frame({
          type: "done",
          ...FOUR_DIMENSIONS,
          tag_values: { values: atBound, truncated: true },
        })
      )
    )

    const listing = await listInventory(REQUEST)

    expect(listing.available).toBe(true)
    if (!listing.available) return
    expect(listing.dimensions.tag_values.values).toHaveLength(
      MAX_DIMENSION_VALUES
    )
  })

  test("a dimension over the bound produces no listing, and none is truncated into one", async () => {
    const overBound = Array.from(
      { length: MAX_DIMENSION_VALUES + 1 },
      (_v, i) => String(i).padStart(6, "0")
    )
    stage(
      streamOf(
        frame({
          type: "done",
          ...FOUR_DIMENSIONS,
          tag_values: { values: overBound, truncated: false },
        })
      )
    )

    const listing = await listInventory(REQUEST)

    // Refused rather than trimmed to 2000. Trimming would make this module a second
    // authority on a bound the runtime already applies, and the two could then
    // disagree about which 2000 values a picker sees.
    expect(listing.available).toBe(false)
  })

  test("a malformed dimension is recognised as terminal rather than waited out", async () => {
    // The read must stop at the terminal event even when its payload does not parse,
    // or a malformed answer costs the caller the whole 30 seconds.
    stage(
      streamOf(
        frame({
          type: "done",
          ...FOUR_DIMENSIONS,
          tag_keys: { values: "env", truncated: false },
        })
      )
    )

    const started = Date.now()
    const listing = await listInventory(REQUEST, { timeoutMs: 5_000 })

    expect(listing.available).toBe(false)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

// --- The three reasons ------------------------------------------------------

describe("Requirement 9.8 — unavailable names which of three occurred", () => {
  test("a transport failure is unreachable", async () => {
    nextFailure.value = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
      code: "ENOTFOUND",
    })

    const listing = await listInventory(REQUEST)

    expect(listing).toMatchObject({ available: false, reason: "unreachable" })
  })

  test("a wrapped transport failure is unreachable too", async () => {
    // The SDK wraps, so the code is on the cause. A check on the outer error alone
    // classifies a DNS failure as a rejection and sends the reader to the wrong
    // place.
    nextFailure.value = new Error("invocation failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    })

    const listing = await listInventory(REQUEST)

    expect(listing).toMatchObject({ available: false, reason: "unreachable" })
  })

  test("a service error carrying a status code is rejected", async () => {
    nextFailure.value = Object.assign(new Error("AccessDeniedException"), {
      $metadata: { httpStatusCode: 403 },
    })

    const listing = await listInventory(REQUEST)

    expect(listing).toMatchObject({ available: false, reason: "rejected" })
  })

  test("a runtime error event is rejected and relays its code", async () => {
    stage(
      streamOf(
        frame({
          type: "error",
          code: "AUTH_FAILED",
          message: "The service principal was refused.",
          terminal: true,
        }),
        frame({ type: "done", status: "failed" })
      )
    )

    const listing = await listInventory(REQUEST)

    expect(listing.available).toBe(false)
    if (listing.available) return
    // `AUTH_FAILED` and `THROTTLED` have different remedies — a secret to rotate
    // versus a wait — so the code has to survive the trip.
    expect(listing.reason).toBe("rejected")
    expect(listing.code).toBe("AUTH_FAILED")
    expect(listing.message).toContain("The service principal was refused.")
  })

  test.each(["THROTTLED", "AUTH_FAILED", "INTERNAL_ERROR"])(
    "the %s code reaches the caller unchanged",
    async (code) => {
      stage(
        streamOf(
          frame({ type: "error", code, terminal: true }),
          frame({ type: "done", status: "failed" })
        )
      )

      const listing = await listInventory(REQUEST)

      expect(listing.available).toBe(false)
      if (listing.available) return
      expect(listing.code).toBe(code)
    }
  )

  test("a stream that ends without a terminal event is no_response", async () => {
    stage(streamOf(frame({ type: "heartbeat", ts: 1 })))

    const listing = await listInventory(REQUEST)

    expect(listing).toMatchObject({ available: false, reason: "no_response" })
  })

  test("a stream that breaks mid-read is no_response, not unreachable", async () => {
    // The invocation reached the runtime and started; what is missing is the answer
    // rather than the route to it.
    stage(() => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            throw new Error("socket hang up")
          },
        }
      },
    }))

    const listing = await listInventory(REQUEST)

    expect(listing).toMatchObject({ available: false, reason: "no_response" })
  })

  test("no message names a credential or an identifier", async () => {
    nextFailure.value = Object.assign(new Error("AccessDeniedException"), {
      $metadata: { httpStatusCode: 403 },
    })

    const listing = await listInventory(REQUEST)

    expect(listing.available).toBe(false)
    if (listing.available) return
    for (const secret of [
      PLAINTEXT_SECRET,
      CREDENTIALS.tenantId,
      CREDENTIALS.clientId,
      CREDENTIALS.subscriptionId,
    ]) {
      expect(JSON.stringify(listing)).not.toContain(secret)
    }
  })

  test("the failure classifier distinguishes the two invocation cases", () => {
    // The discrimination is the whole content of two of the three reasons and it
    // reads a shape the SDK is not obliged to document, so it is pinned directly.
    expect(
      invocationFailureReason({ $metadata: { httpStatusCode: 429 } })
    ).toBe("rejected")
    expect(invocationFailureReason({ code: "ETIMEDOUT" })).toBe("unreachable")
    expect(
      invocationFailureReason({ cause: { cause: { code: "ENOTFOUND" } } })
    ).toBe("unreachable")
    // An unrecognised failure out of the SDK is in practice one the service
    // produced; a genuine network failure always arrives with one of the codes.
    expect(invocationFailureReason(new Error("something else"))).toBe(
      "rejected"
    )
    expect(invocationFailureReason(undefined)).toBe("rejected")
    // A status code that is not a number is not a status code.
    expect(
      invocationFailureReason({ $metadata: { httpStatusCode: "403" } })
    ).toBe("rejected")
  })

  test("a status code takes precedence over a transport code in the chain", () => {
    // The case that makes the `$metadata` check load-bearing rather than redundant
    // with the default. The SDK retries: an earlier attempt reset its connection and
    // the last one came back 429, so the chain carries `ECONNRESET` **and** a status
    // code. Something answered, and what it said was "too many requests" — the
    // remedy is a wait, not a network path to go and look at.
    //
    // Without this case the check is behaviourally dead: everything it catches, the
    // default catches anyway, so deleting it changes nothing any test observes. That
    // is exactly what the mutation run reported, and this is the case that closed it.
    expect(
      invocationFailureReason(
        Object.assign(new Error("ThrottlingException"), {
          $metadata: { httpStatusCode: 429 },
          cause: Object.assign(new Error("read ECONNRESET"), {
            code: "ECONNRESET",
          }),
        })
      )
    ).toBe("rejected")
  })

  test("a self-referential cause chain does not hang the classifier", () => {
    // The shape that turns a chain walk into an infinite loop. An unbounded walk
    // would hang the request rather than answer it, which is why the walk is capped.
    const looping: { cause?: unknown } = {}
    looping.cause = looping

    expect(invocationFailureReason(looping)).toBe("rejected")
  })
})

// --- The bound --------------------------------------------------------------

describe("Requirement 9.8 — the 30-second bound on the whole attempt", () => {
  test("the declared cap is 30 seconds", () => {
    expect(INVENTORY_TIMEOUT_MS).toBe(30_000)
  })

  test("a runtime that heartbeats forever is capped, and the stream is released", async () => {
    // The test a per-read timeout fails: every chunk resets a per-read timer, so an
    // implementation applying the deadline once per `next()` would never fire.
    const released = { value: false }
    stage(endlessStream(released))

    const listing = await listInventory(REQUEST, { timeoutMs: 60 })

    expect(listing).toMatchObject({ available: false, reason: "no_response" })
    // Without the release, an attempt that timed out keeps consuming a connection
    // for as long as the container keeps talking.
    expect(released.value).toBe(true)
  })

  test("a runtime flooding frames with no delay stops at the budget", async () => {
    // The starvation case, and the reason `withDeadline` reads the clock before it
    // races. The assertion is on the **read count**: an exhausted budget must stop
    // the reader on its next read, so a handful of reads is the passing shape and
    // draining thousands of frames is the failing one. Written this way because the
    // unbounded version of this fixture hangs rather than fails — it starves the
    // timer that would have timed the case out.
    const reads = { value: 0 }
    const limit = 5_000
    stage(floodStream(reads, limit))

    const listing = await listInventory(REQUEST, { timeoutMs: 0 })

    expect(listing).toMatchObject({ available: false, reason: "no_response" })
    expect(reads.value).toBeLessThan(100)
    expect(reads.value).toBeLessThan(limit)
  }, 5_000)

  test("an invocation that never settles is capped before a stream exists", async () => {
    // The budget starts **before** the invoke, so a runtime that never answers the
    // `InvokeAgentRuntime` call is capped too. A cap applied only around the read
    // would leave this one waiting forever, which is the failure the wizard would
    // experience as a hang.
    nextHang.value = true

    const listing = await listInventory(REQUEST, { timeoutMs: 30 })

    expect(listing).toMatchObject({ available: false, reason: "no_response" })
    expect(invocations).toHaveLength(1)
  })

  test("the message states the bound in whole seconds", async () => {
    // Asserted at 2 seconds rather than 30, so the arithmetic is checked without the
    // suite waiting out the real cap. `Math.round(ms / 1000)` is what turns a
    // millisecond bound into the sentence a consultant reads.
    const released = { value: false }
    stage(endlessStream(released))

    const listing = await listInventory(REQUEST, { timeoutMs: 2_000 })

    expect(listing.available).toBe(false)
    if (listing.available) return
    expect(listing.message).toContain("2 seconds")
  }, 10_000)
})
