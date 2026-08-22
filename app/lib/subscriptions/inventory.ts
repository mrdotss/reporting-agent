import "server-only"

import { z } from "zod"

import {
  TIMED_OUT,
  parseSseFrame,
  releaseIterator,
  settle,
  splitSseFrames,
  withDeadline,
} from "@/lib/aws/agent-stream"
import {
  COMMAND_LIST_INVENTORY,
  DEFAULT_TIMEZONE,
  MissingRuntimeConfigError,
  invokeAgentRuntime,
  type AgentInvokeContext,
} from "@/lib/aws/agentcore"
import { newSessionId } from "@/lib/session-id"
import type {
  InventoryDimension,
  InventoryDimensions,
} from "@/lib/subscriptions/inventory-cache"
import type { ResolvedAzureCredentials } from "@/lib/subscriptions/store"

/**
 * Asking the runtime for one subscription's distinct inventory dimensions
 * (Requirements 9.3, 9.8).
 *
 * The app issues **no Azure request and holds no Azure access token**. The Resource
 * Graph query runs inside the container the customer's credentials were shipped to
 * for the collection anyway, and this module invokes it with
 * `command: "list_inventory"` — a **command**, so no model decides whether to look —
 * and reads the four dimensions off the terminal `done` event. That is the same
 * division of labour `lib/subscriptions/preflight.ts` documents at length, for the
 * same reason: exactly one process ever holds a token for a customer's tenant.
 *
 * ## Why the failure is a value and the misconfiguration is a throw
 *
 * Every way this can fail to produce a listing resolves to an
 * {@link InventoryListing} with `available: false` — because a subscription whose
 * inventory could not be listed is an ordinary, expected state that the scope
 * picker has a designed answer for (free entry, plus a statement of why). The one
 * exception is {@link MissingRuntimeConfigError}, which is rethrown: an
 * unconfigured deployment is *our* mistake, and reporting it as "this customer's
 * inventory is unavailable" would send a consultant to look at a role assignment
 * that is fine.
 *
 * ## Three reasons, and the discrimination behind them
 *
 * Requirement 9.8 names three and they are not interchangeable — each points at a
 * different thing to go and look at:
 *
 *   * **`unreachable`** — nothing answered. No HTTP response came back at all, so
 *     the failure is a network path, a DNS name or a security group.
 *   * **`rejected`** — something answered, and what it said was no. Either the
 *     service refused the invocation (a status code came back) or the runtime
 *     itself emitted a terminal `error`, in which case its own code travels with
 *     the outcome: `AUTH_FAILED` is a credential or a missing role assignment and
 *     `THROTTLED` is a rate limit, and those have different remedies.
 *   * **`no_response`** — the invocation started and the answer never arrived
 *     within the bound, or the stream ended without one. The runtime is up and this
 *     particular question went unanswered.
 *
 * The endpoint writes **no cache entry** for any of the three and issues **no**
 * automatic retry. Both are properties of this module and its caller rather than of
 * whoever is calling the endpoint: a retry here would multiply a throttled
 * subscription's load by however many pickers were on screen.
 */

// --- The outcome ------------------------------------------------------------

/** Requirement 9.8 — the three, and only these three. */
export type InventoryUnavailableReason =
  "unreachable" | "rejected" | "no_response"

/**
 * One listing attempt's result.
 *
 * A discriminated union rather than a record with optional fields, so a caller
 * cannot read `dimensions` off a failure or a `reason` off a success. The pickers
 * branch on exactly this: dimensions drive the option lists, and a reason drives the
 * free-entry fallback and the sentence that explains it.
 */
export type InventoryListing =
  | { readonly available: true; readonly dimensions: InventoryDimensions }
  | {
      readonly available: false
      readonly reason: InventoryUnavailableReason
      /** Safe to display. Never carries a credential or an identifier. */
      readonly message: string
      /** The runtime's own error code, where it named one. */
      readonly code?: string
    }

// --- The bound --------------------------------------------------------------

/**
 * Requirement 9.8 — the whole attempt, capped at 30 seconds.
 *
 * The budget starts **before** the invoke, so it covers resolving the runtime, the
 * `InvokeAgentRuntime` round trip, the container's cold start and the stream. A cap
 * that only covered the read would leave a runtime that never answers holding a
 * consultant's wizard open indefinitely, which is the failure this is for.
 */
export const INVENTORY_TIMEOUT_MS = 30_000

/**
 * The per-dimension ceiling the runtime declares and this module refuses to exceed
 * (Requirement 9.1).
 *
 * Enforced here as a **parse** constraint rather than by truncating, and that
 * direction is the point. Truncating would make this module a second authority on a
 * bound the runtime already applies, and the two could then disagree about which
 * 2000 values a picker sees. Refusing means a response violating the declared
 * contract is not presented at all — and it also keeps the module-level cache
 * bounded, which a pass-through would not: an entry is at most four arrays of this
 * length, whatever the runtime sends.
 *
 * Ordering, by contrast, is **not** re-derived. The runtime orders each dimension
 * ascending in code-point order and its own suite asserts that; re-sorting here
 * would be a second ordering authority for no gain, and rejecting an out-of-order
 * response would fail a perfectly usable listing over its presentation.
 */
export const MAX_DIMENSION_VALUES = 2000

// --- Parsing the stream -----------------------------------------------------

const dimensionSchema = z.object({
  values: z.array(z.string()).max(MAX_DIMENSION_VALUES),
  truncated: z.boolean(),
})

/**
 * The terminal event, with every dimension optional.
 *
 * Optional because *the absence is the signal*: the runtime's contract states that
 * a listing which did not answer carries **no dimension key at all**, rather than
 * four empty ones. Four empty dimensions would be the claim that the subscription
 * holds nothing — an empty option list a consultant reads as an empty subscription —
 * and that is the single reading this endpoint must never present. So the test is
 * "are all four keys here", and nothing has to be correlated against an `error`
 * event to know whether the answer is real.
 */
const doneEventSchema = z.object({
  type: z.literal("done"),
  status: z.string().optional(),
  resource_types: dimensionSchema.optional(),
  resource_groups: dimensionSchema.optional(),
  tag_keys: dimensionSchema.optional(),
  tag_values: dimensionSchema.optional(),
})

/** Enough to recognise the terminal event when its dimensions do not parse. */
const terminalEventSchema = z.object({ type: z.literal("done") })

const errorEventSchema = z.object({
  type: z.literal("error"),
  code: z.string().optional(),
  message: z.string().optional(),
})

type SeenError = { readonly code?: string; readonly message?: string }

/** How much runtime prose is relayed to a caller. */
const MAX_RELAYED_MESSAGE_LENGTH = 500

/**
 * The four dimensions a `done` event carries, or `undefined` if it carries fewer.
 *
 * Pure and exported for its own test. All four or none: a partial answer is not a
 * smaller answer, it is an answer about a different question, and a picker handed
 * three dimensions would present the fourth as "this subscription has no tags".
 */
export function dimensionsFromDone(
  done: z.output<typeof doneEventSchema>
): InventoryDimensions | undefined {
  const types: InventoryDimension | undefined = done.resource_types
  const groups: InventoryDimension | undefined = done.resource_groups
  const keys: InventoryDimension | undefined = done.tag_keys
  const values: InventoryDimension | undefined = done.tag_values

  if (
    types === undefined ||
    groups === undefined ||
    keys === undefined ||
    values === undefined
  ) {
    return undefined
  }

  // Written out rather than assembled in a loop over
  // {@link INVENTORY_DIMENSION_KEYS}, so the result is typed by construction: a
  // fifth dimension added to `InventoryDimensions` makes this object literal a
  // compile error, where a loop would have needed a cast to satisfy the return type
  // and would then have shipped a listing missing that dimension.
  return {
    resource_types: types,
    resource_groups: groups,
    tag_keys: keys,
    tag_values: values,
  }
}

/**
 * The runtime's prose, bounded, or nothing.
 *
 * Relayed because it is *our* text — the runtime writes it, and its redaction guard
 * has already scrubbed every registered secret out of it. Bounded because it ends up
 * in a browser and in a log, and neither wants an unbounded string from a
 * subprocess.
 */
function relayedMessage(message: string | undefined): string {
  const trimmed = message?.trim() ?? ""

  return trimmed.length === 0
    ? ""
    : ` ${trimmed.slice(0, MAX_RELAYED_MESSAGE_LENGTH)}`
}

// --- The three failures -----------------------------------------------------

function unreachable(): InventoryListing {
  return {
    available: false,
    reason: "unreachable",
    message:
      "The reporting runtime could not be reached, so this subscription's " +
      "inventory was not listed.",
  }
}

function rejected(seen: SeenError | undefined): InventoryListing {
  return {
    available: false,
    reason: "rejected",
    message:
      "The reporting runtime did not list this subscription's inventory." +
      relayedMessage(seen?.message),
    ...(seen?.code === undefined ? {} : { code: seen.code }),
  }
}

function noResponse(elapsedMs: number): InventoryListing {
  return {
    available: false,
    reason: "no_response",
    message:
      `The reporting runtime returned no inventory within ` +
      `${Math.round(elapsedMs / 1000)} seconds, so this subscription's ` +
      `inventory was not listed.`,
  }
}

/**
 * Error codes that mean the connection never happened, on Node and in the SDK.
 *
 * Matched against the whole `cause` chain because the SDK wraps: a
 * `getaddrinfo ENOTFOUND` surfaces as an SDK error whose `cause` carries the code,
 * and a check on the outer error alone would classify a DNS failure as a rejection.
 */
const TRANSPORT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
])

/**
 * Whether a thrown invocation failure means *nothing answered* or *the answer was
 * no* (Requirement 9.8).
 *
 * Exported for its own test, because the discrimination is the whole content of two
 * of the three reasons and it is decided by reading a shape the SDK is not obliged
 * to document.
 *
 * An error carrying `$metadata.httpStatusCode` came back **from** the service, so
 * something answered and the answer was a refusal. A recognised transport code
 * anywhere in the `cause` chain is the opposite. Anything else defaults to
 * `rejected`, which is the honest default rather than the cautious-sounding one: an
 * unrecognised failure out of the SDK is in practice one the service produced — a
 * validation error, a throttle, an authorization refusal — while a genuine network
 * failure always arrives with one of the codes above.
 */
export function invocationFailureReason(
  error: unknown
): "unreachable" | "rejected" {
  const statusCode = (error as { $metadata?: { httpStatusCode?: unknown } })
    ?.$metadata?.httpStatusCode

  if (typeof statusCode === "number") return "rejected"

  for (let cursor: unknown = error, depth = 0; depth < 8; depth += 1) {
    if (typeof cursor !== "object" || cursor === null) break

    const code = (cursor as { code?: unknown }).code
    const name = (cursor as { name?: unknown }).name

    if (typeof code === "string" && TRANSPORT_ERROR_CODES.has(code)) {
      return "unreachable"
    }
    if (typeof name === "string" && TRANSPORT_ERROR_CODES.has(name)) {
      return "unreachable"
    }

    cursor = (cursor as { cause?: unknown }).cause
  }

  return "rejected"
}

// --- The context ------------------------------------------------------------

/**
 * The `context` for a listing invocation.
 *
 * {@link AgentInvokeContext} is closed at twelve required fields and a listing has
 * no run behind it, so `run_id`, `progress_url` and `progress_token` are empty —
 * the same spelling `preflight` uses, and for the same reason: the runtime's
 * progress reporter treats a reporter built without all three as **disabled**, so
 * an empty string is how "no run" is stated on the wire rather than a placeholder
 * something might try to use.
 *
 * `fidelity_tier` and `log_analytics_workspace_id` come off the stored row and are
 * carried because the context's shape requires them, not because the query reads
 * them: a distinct-dimensions projection is the same query at either tier.
 */
function inventoryContext(
  actorId: string,
  displayName: string,
  credentials: ResolvedAzureCredentials
): AgentInvokeContext {
  return {
    actor_id: actorId,
    subscription_id: credentials.subscriptionId,
    tenant_id: credentials.tenantId,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    timezone: DEFAULT_TIMEZONE,
    display_name: displayName,
    fidelity_tier: credentials.fidelityTier,
    log_analytics_workspace_id: credentials.logAnalyticsWorkspaceId,
    run_id: "",
    progress_url: "",
    progress_token: "",
  }
}

// --- The service ------------------------------------------------------------

export type InventoryRequest = {
  /** The signed-in user's id, from the session and never from a request. */
  readonly actorId: string
  readonly displayName: string
  /** **Secret.** Resolved server-side, decrypted at invoke time. */
  readonly credentials: ResolvedAzureCredentials
}

/**
 * Invoke `list_inventory` and read its answer, capped at
 * {@link INVENTORY_TIMEOUT_MS} (Requirements 9.3, 9.8).
 *
 * Returns a listing on every path but one: {@link MissingRuntimeConfigError}
 * propagates, so the route can say the deployment is unconfigured instead of
 * blaming the subscription.
 *
 * `timeoutMs` is injectable purely so the cap is testable in milliseconds instead
 * of in thirty real seconds. Production passes nothing.
 */
export async function listInventory(
  request: InventoryRequest,
  options: { readonly timeoutMs?: number } = {}
): Promise<InventoryListing> {
  const timeoutMs = options.timeoutMs ?? INVENTORY_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  // Deliberately outside any try: an unconfigured runtime is a configuration error,
  // not an unavailable inventory, and `invokeAgentRuntime` resolves the ARN before
  // it builds a client or makes any SDK call.
  const invocation = settle(
    invokeAgentRuntime({
      sessionId: newSessionId(),
      context: inventoryContext(
        request.actorId,
        request.displayName,
        request.credentials
      ),
      command: { command: COMMAND_LIST_INVENTORY },
    })
  )

  const opened = await withDeadline(invocation, deadline - Date.now())

  if (opened === TIMED_OUT) return noResponse(timeoutMs)

  if (!opened.ok) {
    if (opened.error instanceof MissingRuntimeConfigError) throw opened.error

    return invocationFailureReason(opened.error) === "unreachable"
      ? unreachable()
      : rejected(undefined)
  }

  return await readListing(opened.value, deadline, timeoutMs)
}

/**
 * Read frames until `done`, or until the deadline.
 *
 * The deadline is re-checked and re-raced on **every** read rather than applied once
 * around the whole loop, so a runtime that emits a heartbeat every 14 seconds
 * forever is still capped at 30 — a per-read timeout would be reset by each
 * heartbeat and would never fire.
 */
async function readListing(
  stream: AsyncIterable<Uint8Array>,
  deadline: number,
  timeoutMs: number
): Promise<InventoryListing> {
  const iterator = stream[Symbol.asyncIterator]()
  const decoder = new TextDecoder()

  let buffer = ""
  let seenError: SeenError | undefined

  try {
    for (;;) {
      const step = await withDeadline(
        settle(iterator.next()),
        deadline - Date.now()
      )

      if (step === TIMED_OUT) return noResponse(timeoutMs)

      // A stream that broke mid-read is `no_response`, not `unreachable`: the
      // invocation reached the runtime and started, and what is missing is the
      // answer rather than the route to it.
      if (!step.ok) return noResponse(timeoutMs)

      if (step.value.done === true) {
        // The stream ended with no terminal event. The router emits one on every
        // path, so this is a truncated stream — a proxy, a crash — and it carries
        // no listing.
        return seenError === undefined
          ? noResponse(timeoutMs)
          : rejected(seenError)
      }

      buffer += decoder.decode(step.value.value, { stream: true })

      const { frames, rest } = splitSseFrames(buffer)
      buffer = rest

      for (const frame of frames) {
        const payload = parseSseFrame(frame)
        if (payload === undefined) continue

        const error = errorEventSchema.safeParse(payload)
        if (error.success) {
          // The last one wins: the router emits at most one terminal `error`, and a
          // later one is the more proximate cause.
          seenError = { code: error.data.code, message: error.data.message }
          continue
        }

        const done = doneEventSchema.safeParse(payload)
        if (done.success) {
          const dimensions = dimensionsFromDone(done.data)

          if (dimensions !== undefined) return { available: true, dimensions }

          // Terminal, and it carried no listing. With a code from the runtime this
          // is a rejection naming why; without one, the question simply went
          // unanswered.
          return seenError === undefined
            ? noResponse(timeoutMs)
            : rejected(seenError)
        }

        // The terminal event arrived and its dimensions did not parse — an
        // over-long array, or a shape the contract does not admit. Recognised as
        // terminal so the read stops here rather than waiting out the deadline,
        // and reported as no listing, which is what it is.
        if (terminalEventSchema.safeParse(payload).success) {
          return seenError === undefined
            ? noResponse(timeoutMs)
            : rejected(seenError)
        }
      }
    }
  } finally {
    await releaseIterator(iterator)
  }
}
