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
  COMMAND_PREFLIGHT,
  DEFAULT_TIMEZONE,
  MissingRuntimeConfigError,
  invokeAgentRuntime,
  type AgentInvokeContext,
} from "@/lib/aws/agentcore"
import {
  runErrorCode,
  type FidelityTier,
  type RunErrorCode,
} from "@/lib/db/schema"
import { newSessionId } from "@/lib/session-id"

/**
 * The Preflight_Service's app-side half (Requirements 12.11, 12.12, 12.14).
 *
 * **The app makes no Azure call and holds no Azure access token.** The
 * permissions request of Requirement 12.1 is issued *inside the agent*, by
 * `agent/src/reporting_agent/azure/preflight.py`, and this module invokes the
 * runtime with `command: "preflight"` and reads the answer off the event stream
 * (Requirement 12.11). That is not an arbitrary division of labour:
 *
 *   * There is exactly **one** process that ever holds a token for a customer's
 *     tenant, and it is the container the customer's credentials were shipped to
 *     for the collection anyway. Adding a second token-holder — the web app —
 *     would double the surface for no capability.
 *   * `scope_verified` is then derived in the same place, from the same response,
 *     as every other Azure fact in the product. Requirement 12.4's "solely from
 *     the permissions response, never from an inventory query" is a property of
 *     one function in one language rather than a rule two implementations both
 *     have to keep.
 *
 * The consequence is a bootstrapping order worth knowing about: onboarding cannot
 * be exercised end to end until the runtime is deployed and `RPT_RUNTIME_ARN` is
 * set. {@link MissingRuntimeConfigError} from `lib/aws/agentcore.ts` is what says
 * so, before any SDK call.
 *
 * ## Requirement 12.14 is structural here
 *
 * This module is the **only** producer of a {@link PreflightOutcome}, and
 * `scopeVerified: true` is only reachable on the branch that read
 * `scope_verified: true` off the runtime's own `done` event. Callers pass that
 * value straight into `lib/subscriptions/store.ts`, which derives `status` from it
 * — so there is no code path in `app/` that can write the flag from an inventory
 * result, from a request body, or from an optimistic default.
 *
 * ## The frame reader and the deadline live in `lib/aws/agent-stream.ts`
 *
 * They were written here and moved when `lib/subscriptions/inventory.ts` became the
 * second module to invoke a deterministic command, read its answer off `done` and
 * give up after 30 seconds. What stayed is the part that is *about a preflight*:
 * which shape counts as proof, which code a rejection carries, and what an
 * unanswered question means. Frame splitting is not about any of that.
 *
 * ## The plaintext secret
 *
 * A {@link PreflightSubmission} carries the customer's plaintext client secret,
 * because that is what the runtime needs in order to authenticate as their
 * service principal. It exists for the duration of one call: it goes into the
 * invoke payload and is referenced nowhere else. Nothing in this module logs, and
 * a {@link PreflightOutcome} carries no field derived from it — so a caller cannot
 * echo it back by returning what it got.
 */

// --- The outcome ------------------------------------------------------------

/**
 * The terminal code a rejected preflight carries.
 *
 * Typed as the schema's `RunErrorCode` union rather than a pair of literals, and
 * relayed from the runtime rather than decided here: the agent already
 * distinguishes `SCOPE_UNVERIFIED` from `AUTH_EXPIRED` (Requirements 12.12,
 * 12.13) and from `AUTH_FAILED`, and a second classification in this language
 * would be a second opinion about a fact only the agent observed. An absent or
 * unrecognized code becomes {@link DEFAULT_REJECTION_CODE} — never a new code
 * invented here, and never a code outside the enum the run row can store.
 */
export type PreflightRejectionCode = RunErrorCode

/**
 * What an unproven scope resolves to (Requirements 12.3, 12.12).
 *
 * The default for every unhappy path that did not name a code of its own: a
 * stream that ended without a `done`, a `done` that said nothing about the scope,
 * a rejection carrying an unrecognized code, and the 30-second cap. All of them
 * mean the same thing — subscription-scope read was not proved — and that is what
 * `SCOPE_UNVERIFIED` says.
 */
export const DEFAULT_REJECTION_CODE = "SCOPE_UNVERIFIED" satisfies RunErrorCode

/**
 * The result of one preflight.
 *
 * A discriminated union rather than a record with optional fields, because the
 * two cases carry different things and must not be confusable: a verified
 * connection has a probed `fidelityTier` and no code, a rejected one has a code
 * and a reason and **no tier at all**. A shape carrying both would let a caller
 * read a tier off a rejection and store it.
 */
export type PreflightOutcome =
  | {
      readonly scopeVerified: true
      /** Probed, never submitted (Requirements 12.8–12.10). */
      readonly fidelityTier: FidelityTier
      /**
       * The oldest exported platform metric the workspace holds, or `null`.
       *
       * A **date**, not a number of months: the workspace gains another day every day, so
       * a stored count silently understates the depth until somebody re-probes, while the
       * earliest record is a fixed fact and depth is `now` minus it. A subscription that
       * enables export today therefore offers a deeper lookback three months from now
       * with nobody doing anything.
       *
       * `null` where nothing is exported, which is the common case: the profile wizard
       * reads it as "live metrics only" and bounds Lookback at Azure's 93-day retention.
       */
      readonly metricsHistorySince: string | null
    }
  | {
      readonly scopeVerified: false
      readonly code: PreflightRejectionCode
      /** Prose from the runtime, or this module's own. Never a secret. */
      readonly message: string
    }

// --- The cap ----------------------------------------------------------------

/**
 * Requirement 12.12 — the whole preflight, capped at 30 seconds.
 *
 * The same 30 seconds `azure/preflight.py` caps its own permissions request at
 * (`PERMISSIONS_TIMEOUT_S`), and the duplication is deliberate rather than
 * redundant: the agent's timer bounds the Azure request, this one bounds
 * *everything* — resolving the runtime, the `InvokeAgentRuntime` round trip, the
 * container's cold start and the stream. A cap that only covered the read would
 * leave a runtime that never answers holding the consultant's browser open
 * indefinitely, which is the failure this is actually for.
 *
 * The budget starts **before** the invoke for that reason.
 */
export const PREFLIGHT_TIMEOUT_MS = 30_000

/**
 * The rejection a non-completion produces (Requirement 12.12).
 *
 * `SCOPE_UNVERIFIED`, not a timeout code, because that is what the requirement
 * says and it is also the honest statement: nothing proved subscription-scope
 * read, so the connection is not acceptable. Inventing a `TIMEOUT` here would
 * also collide with the one code the reaper writes (Requirement 39.10) for an
 * entirely different situation.
 */
function timedOut(elapsedMs: number): PreflightOutcome {
  return {
    scopeVerified: false,
    code: DEFAULT_REJECTION_CODE,
    message:
      `The permissions assertion did not complete within ` +
      `${Math.round(elapsedMs / 1000)} seconds, so read at subscription scope ` +
      `was not proved and the connection was not accepted. Reader at ` +
      `subscription scope is required.`,
  }
}

// --- The submission ---------------------------------------------------------

/**
 * One connection, as submitted, plus the signed-in user it belongs to.
 *
 * `actorId` is the signed-in user's id and is resolved from the session by the
 * route, never from the request body — the same rule that makes `actor_id` the
 * run's `user_id` for a report (Requirement 41.11).
 */
export type PreflightSubmission = {
  readonly actorId: string
  readonly displayName: string
  readonly subscriptionId: string
  /** **Secret.** */
  readonly tenantId: string
  /** **Secret.** */
  readonly clientId: string
  /** **Secret, plaintext.** Sent to the runtime; retained nowhere. */
  readonly clientSecret: string
  /** `null` unless the customer opted into the enhanced tier. */
  readonly logAnalyticsWorkspaceId: string | null
}

/**
 * The `context` for a preflight invocation.
 *
 * {@link AgentInvokeContext} is closed at twelve required fields, and a preflight
 * has no run behind it, so three of them have no value to carry:
 *
 *   * **`run_id`, `progress_url`, `progress_token` are empty.** There is no
 *     `report_runs` row, no phase to report and no token minted, and
 *     `agent/src/reporting_agent/progress.py` treats a reporter built without all
 *     three as **disabled** — so an empty string is not a placeholder the agent
 *     might try to use, it is how "no run" is spelled on the wire. Synthesizing a
 *     `progress_url` from `RPT_APP_BASE_URL` would be worse than useless: the
 *     endpoint authorizes by run-scoped HMAC, so a URL with no token behind it
 *     names a callback that must be refused.
 *   * **`fidelity_tier` is `baseline`.** The tier is what this invocation
 *     *probes* (Requirements 12.8–12.10), so there is nothing yet to declare, and
 *     `baseline` is what an unproven enhanced tier means. `azure/preflight.py`
 *     reads the workspace id, not this field, to decide whether to probe at all.
 *
 * A fresh random session id, not a derived one: `sessionIdForRun` needs a run id,
 * and a preflight is a single stateless question whose answer does not benefit
 * from continuity with anything. `lib/session-id.ts` keeps the 33–128 bound.
 */
function preflightContext(submission: PreflightSubmission): AgentInvokeContext {
  return {
    actor_id: submission.actorId,
    subscription_id: submission.subscriptionId,
    tenant_id: submission.tenantId,
    client_id: submission.clientId,
    client_secret: submission.clientSecret,
    timezone: DEFAULT_TIMEZONE,
    display_name: submission.displayName,
    fidelity_tier: "baseline",
    log_analytics_workspace_id: submission.logAnalyticsWorkspaceId,
    run_id: "",
    progress_url: "",
    progress_token: "",
  }
}

// --- Parsing the stream -----------------------------------------------------

/**
 * The two event shapes this module reads, parsed rather than asserted.
 *
 * The runtime's stream is external input, so it gets the same treatment a request
 * body does (Requirement 7.7's rule, applied one boundary over). Every field is
 * optional and every unknown event type is ignored, which is the degradation rule
 * the vocabulary is designed around: a newer runtime emitting a type this build
 * has never heard of must not fail a preflight (`lib/events.ts`).
 */
const doneEventSchema = z.object({
  type: z.literal("done"),
  status: z.string().optional(),
  scope_verified: z.boolean().optional(),
  fidelity_tier: z.enum(["baseline", "enhanced"]).optional(),
  /**
   * The oldest exported platform metric the workspace holds, as the runtime wrote it.
   *
   * `nullable()` as well as `optional()`: the runtime states it explicitly as `null` for a
   * subscription with no export, which is the common case and a real answer rather than a
   * missing field.
   */
  metrics_history_since: z.string().nullable().optional(),
})

const errorEventSchema = z.object({
  type: z.literal("error"),
  code: z.string().optional(),
  message: z.string().optional(),
})

/** How much runtime prose is relayed to a caller. */
const MAX_RELAYED_MESSAGE_LENGTH = 500

/**
 * The outcome one `done` event states, given the last `error` seen before it.
 *
 * Pure, and the single place a `PreflightOutcome` is decided, so the fail-closed
 * reading is in one function rather than spread across a loop:
 *
 *   * `scope_verified: true` **and** a completed status is the only accepted
 *     shape. `handle_preflight` seeds its outcome with `false` before any Azure
 *     call, so `false` covers every path it can take, including one nobody
 *     anticipated; requiring the completed status as well means a failure after a
 *     successful assertion — which the fidelity probe cannot cause, since every
 *     unhappy path there records `baseline` — is treated as unproven rather than
 *     as proved.
 *   * A rejection relays the runtime's own code and prose when it named them.
 *     `AUTH_EXPIRED` in particular has to survive the trip distinct from
 *     `SCOPE_UNVERIFIED` (Requirement 12.13): they have different remedies, and
 *     the UI says so.
 */
export function outcomeFromDone(
  done: z.output<typeof doneEventSchema>,
  seenError: { readonly code?: string; readonly message?: string } | undefined
): PreflightOutcome {
  const completed = done.status === undefined || done.status === "completed"

  if (done.scope_verified === true && completed) {
    // Requirement 12.9 — an absent tier is `baseline`. The agent always states
    // it, so this is the fail-closed reading of a runtime that did not.
    return {
      scopeVerified: true,
      fidelityTier: done.fidelity_tier ?? "baseline",
      // Absent reads as "none", the same fail-closed direction the tier takes: a runtime
      // that did not say offers the floor rather than an unproven depth.
      metricsHistorySince:
        typeof done.metrics_history_since === "string"
          ? done.metrics_history_since
          : null,
    }
  }

  return {
    scopeVerified: false,
    code: asRejectionCode(seenError?.code),
    message: relayedMessage(seenError?.message),
  }
}

/** The schema's enum is the only vocabulary; anything else is unproven scope. */
function asRejectionCode(code: string | undefined): PreflightRejectionCode {
  return RUN_ERROR_CODES.has(code ?? "")
    ? (code as PreflightRejectionCode)
    : DEFAULT_REJECTION_CODE
}

/**
 * The codes a rejection may carry, read **from the Postgres enum itself**.
 *
 * Derived rather than restated, so a value added to `run_error_code` is relayable
 * without a second list to maintain — and, more to the point, a code the enum does
 * *not* have can never be relayed into a column whose CHECK would reject it at
 * write time, on a path where the write is how a run failure gets recorded.
 */
const RUN_ERROR_CODES: ReadonlySet<string> = new Set<string>(
  runErrorCode.enumValues
)

/**
 * The runtime's prose, bounded, or this module's own sentence.
 *
 * Relayed because it is *our* text — `azure/preflight.py` writes it, and the
 * runtime's redaction guard has already scrubbed every registered secret out of
 * it — and because it is the only place the specific reason lives. Bounded because
 * a message ends up in a browser and in a log, and neither wants an unbounded
 * string from a subprocess.
 */
function relayedMessage(message: string | undefined): string {
  const trimmed = message?.trim() ?? ""

  if (trimmed.length === 0) {
    return (
      "Read at subscription scope was not proved, so the connection was not " +
      "accepted. The service principal needs the Reader role at subscription " +
      "scope: an assignment scoped to a resource group returns that group's " +
      "resources while leaving the report incomplete, so it is rejected."
    )
  }

  return trimmed.slice(0, MAX_RELAYED_MESSAGE_LENGTH)
}

// --- The service ------------------------------------------------------------

/**
 * Invoke the runtime's `preflight` command and read its answer, capped at
 * {@link PREFLIGHT_TIMEOUT_MS} (Requirements 12.11, 12.12, 12.14).
 *
 * Returns an outcome on every path. It throws only for a failure that is *ours*
 * rather than the connection's — {@link MissingRuntimeConfigError} for an
 * unconfigured runtime above all — because a deployment mistake must not be
 * reported to a consultant as "your customer's role assignment is wrong". A
 * failure of the invocation itself is a rejection: nothing proved the scope, so
 * the connection is not acceptable, whatever the reason.
 *
 * `timeoutMs` is injectable purely so the cap is testable in milliseconds instead
 * of in thirty real seconds. Production passes nothing.
 */
export async function runPreflight(
  submission: PreflightSubmission,
  options: { readonly timeoutMs?: number } = {}
): Promise<PreflightOutcome> {
  const timeoutMs = options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs

  // Deliberately outside the try: an unconfigured runtime is a configuration
  // error, not an unverified scope, and `invokeAgentRuntime` resolves the ARN
  // before it builds a client or makes any SDK call (Requirement 41.2).
  const invocation = settle(
    invokeAgentRuntime({
      sessionId: newSessionId(),
      context: preflightContext(submission),
      command: { command: COMMAND_PREFLIGHT },
    })
  )

  const opened = await withDeadline(invocation, deadline - Date.now())

  if (opened === TIMED_OUT) return timedOut(timeoutMs)

  if (!opened.ok) {
    if (opened.error instanceof MissingRuntimeConfigError) throw opened.error

    return {
      scopeVerified: false,
      code: DEFAULT_REJECTION_CODE,
      message:
        "The reporting runtime could not be reached, so read at subscription " +
        "scope was not proved and the connection was not accepted.",
    }
  }

  return await readOutcome(opened.value, deadline, timeoutMs)
}

/**
 * Read frames until `done`, or until the deadline.
 *
 * The deadline is re-checked and re-raced on **every** read rather than applied
 * once around the whole loop, so a runtime that emits a heartbeat every 14 seconds
 * forever is still capped at 30 — a per-read timeout would be reset by each
 * heartbeat and would never fire.
 */
async function readOutcome(
  stream: AsyncIterable<Uint8Array>,
  deadline: number,
  timeoutMs: number
): Promise<PreflightOutcome> {
  const iterator = stream[Symbol.asyncIterator]()
  const decoder = new TextDecoder()

  let buffer = ""
  let seenError: { code?: string; message?: string } | undefined

  try {
    for (;;) {
      const step = await withDeadline(
        settle(iterator.next()),
        deadline - Date.now()
      )

      if (step === TIMED_OUT) return timedOut(timeoutMs)

      if (!step.ok) {
        return {
          scopeVerified: false,
          code: DEFAULT_REJECTION_CODE,
          message:
            "The preflight stream ended in a failure, so read at " +
            "subscription scope was not proved and the connection was not " +
            "accepted.",
        }
      }

      if (step.value.done === true) {
        // The stream ended without a `done` event. The router emits one on every
        // path, so this is a truncated stream — a proxy, a crash — and it proves
        // nothing.
        return outcomeFromDone({ type: "done" }, seenError)
      }

      buffer += decoder.decode(step.value.value, { stream: true })

      const { frames, rest } = splitSseFrames(buffer)
      buffer = rest

      for (const frame of frames) {
        const payload = parseSseFrame(frame)
        if (payload === undefined) continue

        const error = errorEventSchema.safeParse(payload)
        if (error.success) {
          // The last one wins: the router emits at most one terminal `error`,
          // and a later one is the more proximate cause.
          seenError = { code: error.data.code, message: error.data.message }
          continue
        }

        const done = doneEventSchema.safeParse(payload)
        if (done.success) return outcomeFromDone(done.data, seenError)
      }
    }
  } finally {
    await releaseIterator(iterator)
  }
}
