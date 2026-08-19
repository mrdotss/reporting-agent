import "server-only"

import {
  COMMAND_GENERATE_REPORT,
  MissingRuntimeConfigError,
  invokeAgentRuntime,
  type AgentInvokeContext,
} from "@/lib/aws/agentcore"
import { requireEnv } from "@/lib/env"
import { deriveProgressToken } from "@/lib/runs/progress-token"
import type { ClaimedRun } from "@/lib/runs/claim"
import { failClaimedRun, readRunStatus } from "@/lib/runs/claim"
import { subscriptionRunBlocker } from "@/lib/subscriptions/state"
import { readVersionById } from "@/lib/templates/store"
import {
  SubscriptionNotFoundError,
  SubscriptionSecretUnreadableError,
  getConnectedSubscription,
  resolveSubscriptionCredentials,
} from "@/lib/subscriptions/store"

/**
 * Starting one claimed run's invocation (Requirements 39.6, 39.10, 39.13, 41).
 *
 * `import "server-only"` is the first line: this module resolves and decrypts the
 * customer's Azure client secret and derives the run-scoped progress token.
 *
 * ## The gate runs before the invocation, not after
 *
 * Requirement 39.10 — a subscription whose scope was never verified, or whose secret
 * has expired, fails its run with **no AgentCore invocation at all**. Not a
 * cancelled one: none is started. The order below is therefore load-bearing rather
 * than tidy, and the reason is the failure this product exists to prevent. An
 * expired secret yields zero resources, zero resources yield zero figures, and zero
 * figures pass every verification gate — so a run allowed through would deliver a
 * clean, fully-verified, **empty** report. Refusing it at the gate is cheaper and
 * more honest than detecting it afterwards.
 *
 * ## Requirement 39.6, as a detached drain
 *
 * The tick "leaves the returned event stream unread and releases it". This is
 * implemented as a **detached drain**: a non-awaited task that reads and discards
 * bytes without parsing an event and without holding any run state.
 *
 * It is deliberately **not** an abort. `InvokeAgentRuntime` is a streaming
 * request/response, so aborting the caller's side may terminate the runtime — which
 * would kill every run at second one, a total failure that presents as an agent bug.
 * Draining satisfies both halves of the requirement ("never waits", "never consumes
 * events as state") while leaving the transport intact. The agent's own phase
 * callbacks are what carry run state; this stream is genuinely surplus here.
 */

/**
 * Requirement 39.7's other half, applied to the invocation: an invocation that has
 * not produced a response stream within 10 seconds is a **failure to start**.
 *
 * It bounds the tick's own response (Requirement 39.9): ten concurrent invocations
 * each capped at ten seconds still fit, because none is awaited to completion.
 */
export const RUNTIME_START_TIMEOUT_MS = 10_000

/** What starting one run's invocation did. */
export type InvokeOutcome =
  /** The runtime accepted it and the stream is being drained. */
  | { readonly kind: "invoked" }
  /** The row was failed with this terminal code, and nothing was invoked. */
  | { readonly kind: "failed"; readonly code: string }
  /** The row was no longer `claimed`, so nothing was invoked and nothing written. */
  | { readonly kind: "skipped"; readonly reason: string }
  /** The invocation did not start. The row is left `claimed` for the sweep. */
  | { readonly kind: "not_started"; readonly reason: string }

/**
 * The `progress_url` the agent posts its phase transitions to
 * (Requirement 41.6).
 *
 * Built from `RPT_APP_BASE_URL` at call time, with a trailing slash tolerated so a
 * deployment that set `https://host/` does not produce a double slash. The path
 * mirrors `app/api/internal/runs/[runId]/progress/route.ts`; the token is **not** in
 * it and never will be (Requirement 38.2).
 */
export function progressUrlFor(runId: string): string {
  const base = requireEnv("RPT_APP_BASE_URL").replace(/\/+$/, "")

  return `${base}/api/internal/runs/${encodeURIComponent(runId)}/progress`
}

/**
 * Drain a response stream in the background, discarding every byte.
 *
 * Not awaited by the caller, and every failure is swallowed: by the time this runs
 * the invocation has already started, so nothing it observes can change the run's
 * outcome — the agent's callbacks and the reaper's sweep decide that. An unhandled
 * rejection here would take the process down for a stream that carries nothing this
 * request needs.
 *
 * It parses no frame and holds no state, which is the half of Requirement 39.6 that
 * matters: the tick must not be a second consumer of the event stream, because a
 * second consumer is a second opinion about what happened.
 */
function drainDetached(stream: AsyncIterable<Uint8Array>, runId: string): void {
  void (async () => {
    try {
      // `for await` rather than a manual iterator: it calls `return()` on the
      // iterator when the loop ends, which is what releases the underlying socket.
      for await (const chunk of stream) {
        // Requirement 39.6 — read and released, never parsed. `void` rather than an
        // empty body so the binding is explicitly discarded rather than merely
        // unused, which is the same statement in one fewer lint suppression.
        void chunk
      }
    } catch (thrown) {
      console.warn(
        `[runs/invoke] the response stream for run ${runId} ended in a ` +
          `failure while being drained. The run's own progress callbacks are ` +
          `authoritative, so this affects nothing: ` +
          `${thrown instanceof Error ? thrown.name : typeof thrown}`
      )
    }
  })()
}

/**
 * Race the invocation against the start budget.
 *
 * The work is settled **before** the race, so an invocation that rejects after the
 * timer won is not an unhandled rejection — which in a Node server is a
 * process-level warning, triggered by nothing worse than a slow runtime. The timer
 * is always cleared, so a fast answer does not leave a ten-second handle holding the
 * event loop open.
 *
 * On the timeout path the invocation is **not** abandoned silently: if it later
 * resolves with a stream, that stream is drained, because a stream nobody reads
 * holds a socket until the runtime closes it.
 */
async function startWithin(
  work: Promise<AsyncIterable<Uint8Array>>,
  runId: string,
  timeoutMs: number
): Promise<AsyncIterable<Uint8Array> | { readonly timedOut: true }> {
  let handle: ReturnType<typeof setTimeout> | undefined

  const settled = work.then(
    (stream) => ({ ok: true, stream }) as const,
    (error: unknown) => ({ ok: false, error }) as const
  )

  const deadline = new Promise<{ readonly timedOut: true }>((resolve) => {
    handle = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
  })

  try {
    const outcome = await Promise.race([settled, deadline])

    if ("timedOut" in outcome) {
      // Late arrivals still have to be released.
      void settled.then((late) => {
        if (late.ok) drainDetached(late.stream, runId)
      })
      return outcome
    }

    if (!outcome.ok) throw outcome.error

    return outcome.stream
  } finally {
    if (handle !== undefined) clearTimeout(handle)
  }
}

/**
 * Gate one claimed run and start its invocation (Requirements 39.6, 39.10, 39.13,
 * 41.3, 41.5, 41.8, 41.9, 41.10, 41.11).
 *
 * `now` is injectable so the expiry boundary is assertable at an instant a test
 * picks. `sessionId` is supplied by the caller, derived from the run's id, so the
 * 33–128 character bound stays satisfied in `lib/session-id.ts` alone.
 *
 * Steps, in this order, each of which can end the function:
 *
 *  1. **Read the subscription's browser-safe projection** and apply
 *     `subscriptionRunBlocker` — the same predicate the expiry banner renders from
 *     and the enqueue rejects with. A gate with its own expiry arithmetic is how a
 *     screen warns about a secret the reaper happily invokes with. A blocked
 *     subscription fails the run and **invokes nothing** (Requirement 39.10).
 *  2. **Resolve and decrypt the credentials** (Requirement 41.3). A failure fails the
 *     run as `SECRET_UNREADABLE` with the ciphertext and key material excluded from
 *     the message (Requirement 41.10) — the store's error carries neither, and this
 *     module writes its own sentence rather than relaying a driver's.
 *  3. **Re-read the row's status** (Requirement 41.9). Anything other than `claimed`
 *     skips the invoke, so a retried tick cannot invoke one run twice.
 *  4. **Read the pinned template version's definition** (Requirement 9.6), which is
 *     what makes this a report run rather than a collection — see the comment at the
 *     read. A pinned version that cannot be read fails the run as
 *     `TEMPLATE_INVALID`; a row pinning none is the legal snapshot-only shape.
 *  5. **Invoke**, with a 10-second start budget, and release the stream with a
 *     detached drain (Requirement 39.6).
 *
 * A failure to start is logged with secrets excluded, the row is **left at
 * `claimed`** for the deadline sweep, and the caller continues with its remaining
 * rows (Requirement 39.13). Deliberately not failed here: a transient invoke failure
 * is a candidate for the next tick, and the 300-second `claimed` budget is what
 * bounds how long that stays true.
 */
export async function startRunInvocation(
  run: ClaimedRun,
  sessionId: string,
  now: Date = new Date(),
  timeoutMs: number = RUNTIME_START_TIMEOUT_MS
): Promise<InvokeOutcome> {
  // 1 — the gate (Requirement 39.10).
  let view
  try {
    view = await getConnectedSubscription(
      run.userId,
      run.connectedSubscriptionId
    )
  } catch (thrown) {
    if (thrown instanceof SubscriptionNotFoundError) {
      // The subscription was deleted between enqueue and claim. There is nothing
      // to authenticate as, and no scope was ever proved for a row that is gone.
      await failClaimedRun({
        runId: run.id,
        errorCode: "SCOPE_UNVERIFIED",
        errorMessage:
          "The connected subscription this run targets no longer exists, so " +
          "read at subscription scope cannot be proved for it and no " +
          "collection was attempted.",
      })
      return { kind: "failed", code: "SCOPE_UNVERIFIED" }
    }
    throw thrown
  }

  const blocker = subscriptionRunBlocker(view, now)

  if (blocker !== null) {
    await failClaimedRun({
      runId: run.id,
      errorCode: blocker,
      errorMessage:
        blocker === "AUTH_EXPIRED"
          ? "The Azure client secret for this subscription has expired, so no " +
            "collection was attempted. An expired secret returns zero " +
            "resources, which would otherwise deliver a fully-verified, empty " +
            "report. Rotate the secret and run again."
          : "Read at subscription scope has not been proved for this " +
            "subscription, so no collection was attempted. The service " +
            "principal needs the Reader role at subscription scope.",
    })

    return { kind: "failed", code: blocker }
  }

  // 2 — the credentials, decrypted at invoke time (Requirement 41.3).
  let credentials
  try {
    credentials = await resolveSubscriptionCredentials(
      run.userId,
      run.connectedSubscriptionId
    )
  } catch (thrown) {
    if (thrown instanceof SubscriptionSecretUnreadableError) {
      // Requirement 41.10 — no SDK call, and the message carries neither the
      // ciphertext nor the key material. Written here rather than relayed, so
      // there is no path on which a `cause` chain adds either.
      await failClaimedRun({
        runId: run.id,
        errorCode: "SECRET_UNREADABLE",
        errorMessage:
          "The stored Azure client secret for this subscription could not be " +
          "decrypted, so no collection was attempted. The secret must be " +
          "rotated. Neither the stored value nor the key is included here.",
      })
      return { kind: "failed", code: "SECRET_UNREADABLE" }
    }
    throw thrown
  }

  // 3 — Requirement 41.9. Between the claim and here, the agent from a previous
  //     tick's invocation could have posted `collecting`, or the sweep could have
  //     failed this row. Invoking either would start a second collection for one
  //     run.
  const status = await readRunStatus(run.id)
  if (status !== "claimed") {
    return {
      kind: "skipped",
      reason: `the row is ${status ?? "gone"} rather than claimed`,
    }
  }

  // Requirement 41.5 — exactly the twelve fields, and the type is closed, so an
  // extra key is a compile error at the one place the object is constructed.
  const context: AgentInvokeContext = {
    // Requirement 41.11 — the run's `user_id`, which is what makes the artifact
    // prefix the runtime writes under the prefix download authorization compares
    // against.
    actor_id: run.userId,
    subscription_id: credentials.subscriptionId,
    tenant_id: credentials.tenantId,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    timezone: run.timezone,
    display_name: view.displayName,
    fidelity_tier: credentials.fidelityTier,
    log_analytics_workspace_id: credentials.logAnalyticsWorkspaceId,
    run_id: run.id,
    progress_url: progressUrlFor(run.id),
    // Requirement 37.3 — recomputed from the run's id, never read from a column.
    // This is the request the derivation exists for: it is a *later* request than
    // the enqueue, and the only stored form is a one-way hash.
    progress_token: deriveProgressToken(run.id),
  }

  // 4 — the pinned version's definition, read by the version id the row pinned at
  //     enqueue (Requirement 9.6).
  //
  //     This read is what makes the invocation a **report** run. The runtime holds no
  //     connection to this database, and its contract is explicit that a payload
  //     carrying no `definition` is a *snapshot-only* run — so a `generate_report`
  //     that sent only the version id would collect a snapshot, emit no
  //     `verification`, write no `.docx` and present no download, on every run,
  //     without failing anything.
  //
  //     Read here rather than carried through the claim's `RETURNING` for the reason
  //     the credentials are: the definition is up to a few hundred kilobytes of jsonb
  //     and only the row that is actually about to be invoked needs it, whereas the
  //     claim returns up to ten rows some of which the gate above will refuse.
  let pinned
  if (run.templateVersionId !== null) {
    pinned = await readVersionById(run.templateVersionId)

    if (pinned === undefined) {
      // The row pins a version that no longer exists. `TEMPLATE_INVALID` rather than
      // a silent snapshot-only run: a run whose pinned version cannot be read cannot
      // render the report it was submitted for, and degrading it to a collection
      // would deliver a run that reports success and produces no document.
      await failClaimedRun({
        runId: run.id,
        errorCode: "TEMPLATE_INVALID",
        errorMessage:
          "The template version this run pinned could not be read, so no " +
          "collection was attempted. A run renders the version pinned when it " +
          "was submitted, and that version is no longer present.",
      })
      return { kind: "failed", code: "TEMPLATE_INVALID" }
    }
  }

  try {
    const started = await startWithin(
      invokeAgentRuntime({
        sessionId,
        context,
        // Requirement 41.8 — a deterministic command, and **no `prompt` field**, so
        // the pipeline is reachable without a model decision. The type has no
        // `prompt` member, which is that requirement expressed as a type.
        command:
          pinned === undefined
            ? {
                command: COMMAND_GENERATE_REPORT,
                period: { start: run.periodStart, end: run.periodEnd },
                scope: run.scope,
              }
            : {
                command: COMMAND_GENERATE_REPORT,
                template_version_id: pinned.id,
                definition: pinned.definition,
                period: { start: run.periodStart, end: run.periodEnd },
                scope: run.scope,
              },
      }),
      run.id,
      timeoutMs
    )

    if ("timedOut" in started) {
      return {
        kind: "not_started",
        reason: `no response stream within ${timeoutMs}ms`,
      }
    }

    // Requirement 39.6 — released, unread, and the tick returns without waiting.
    drainDetached(started, run.id)

    return { kind: "invoked" }
  } catch (thrown) {
    if (thrown instanceof MissingRuntimeConfigError) {
      // A configuration problem, not this run's problem. Re-thrown so the caller
      // stops claiming rather than failing each claimed row in turn for something
      // no run can recover from.
      throw thrown
    }

    // Requirement 39.13 — logged with every secret excluded, the row left at
    // `claimed` for the sweep, and the caller continues. The name and message of
    // the thrown value only: an AWS SDK error's own serialization can quote the
    // request it failed on, and that request carries the customer's client secret.
    return {
      kind: "not_started",
      reason: thrown instanceof Error ? thrown.name : typeof thrown,
    }
  }
}
