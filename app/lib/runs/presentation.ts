import type { RunErrorCode, RunStatus } from "@/lib/db/schema"
import type { RunView } from "@/lib/db/views"

/**
 * How a run's state reads on screen — **the single place run copy is written**.
 *
 * **Pure, and deliberately not `server-only`.** No I/O, no clock, no secret: a
 * {@link RunView} in, strings out. It has to be importable from a client leaf, because
 * the run detail screen's timeline and failure notice are client components fed by
 * `useRunStream`, while the run list is a server component — and both must say the same
 * thing about the same row.
 *
 * That is the whole reason this module exists rather than each component composing its
 * own sentence. Two surfaces phrasing one failure differently is how a consultant comes
 * to believe they are looking at two different problems, and Requirement 36.7 requires
 * terminal state to be read from the row on *every* surface, so every surface needs the
 * same vocabulary for it.
 *
 * ## `--destructive` is reserved, and that is decided here
 *
 * `tone` is the token a surface renders with, and it is `"destructive"` for exactly one
 * class of state: a hard run failure. A **gap is neutral information** and a run still
 * in flight is neutral too. In this product red means *this document could not be
 * proven*, and spending the token on an approaching expiry or a recorded gap dilutes
 * the one meaning it has.
 */

/** Which token family a surface should render a state in. */
export type RunTone = "neutral" | "accent" | "positive" | "destructive"

/** How one status reads: a short label, and the tone it is rendered in. */
export type RunStatusPresentation = {
  readonly label: string
  readonly tone: RunTone
  /** True while the run is still working, so a surface knows to show activity. */
  readonly inFlight: boolean
}

/**
 * The eight statuses, including the three this spec does not drive.
 *
 * `compiling`, `rendering` and `verifying` are present because the enum has them and a
 * `Record` keyed by `RunStatus` must be total — which is the point: the day a later spec
 * drives one of them, this file already has a label for it and the compiler will have
 * insisted on it rather than letting a screen render a raw enum value.
 */
export const RUN_STATUS_PRESENTATION: Readonly<
  Record<RunStatus, RunStatusPresentation>
> = Object.freeze({
  queued: { label: "Queued", tone: "neutral", inFlight: true },
  claimed: { label: "Starting", tone: "neutral", inFlight: true },
  collecting: { label: "Collecting", tone: "accent", inFlight: true },
  compiling: { label: "Compiling", tone: "accent", inFlight: true },
  rendering: { label: "Rendering", tone: "accent", inFlight: true },
  verifying: { label: "Verifying", tone: "accent", inFlight: true },
  completed: { label: "Completed", tone: "positive", inFlight: false },
  failed: { label: "Failed", tone: "destructive", inFlight: false },
})

/** How one terminal failure reads: a headline, prose, and what to check. */
export type RunFailurePresentation = {
  /** One line, stating what happened rather than naming the code. */
  readonly headline: string
  /** Whether an artifact was produced. Always `false` in this spec. */
  readonly artifactProduced: boolean
  /** The things a consultant should check, in the order worth checking them. */
  readonly causes: readonly string[]
}

/**
 * `EMPTY_SCOPE`'s copy, named so a test can assert against the constant rather than a
 * paraphrase of it.
 *
 * This is the most important failure message in the product, and the reason is worth
 * stating where the words are: an expired secret or an over-narrow Reader assignment
 * yields **zero resources**, zero resources yield zero figures, and zero figures pass
 * every verification gate — so without this hard failure the run would deliver a clean,
 * fully-verified, **empty** report. The message therefore has to do four things
 * (Requirement 33.4 and task 13.10): say zero resources were found, name the
 * subscription and the period, say **no artifact was produced**, and list the two
 * causes to check.
 *
 * "No report was produced" is stated rather than implied. A failure screen that only
 * said "zero resources" would leave a consultant looking for a download link.
 */
export const EMPTY_SCOPE_HEADLINE =
  "Zero resources were found in scope, so no report was produced."

export const EMPTY_SCOPE_CAUSES: readonly string[] = Object.freeze([
  "The subscription's Azure client secret may have expired. An expired secret " +
    "authenticates but returns nothing, which is why this is a hard failure " +
    "rather than an empty report.",
  "The service principal's Reader role may be assigned below subscription " +
    "scope. An assignment on a single resource group returns that group's " +
    "resources and nothing else, and the inventory query itself is filtered by " +
    "that assignment, so the run cannot tell the difference.",
])

/**
 * The per-code failure copy.
 *
 * Every code the column can hold has an entry, because a `Record` keyed by
 * `RunErrorCode` must be total — so a code added to the Postgres enum is a compile
 * error here rather than a screen showing `NO_STATISTICS` verbatim.
 *
 * `artifactProduced` is `false` for every one of them, and it stays false for the six
 * document-phase codes (Requirement 41.2) even though two of those phases run *after*
 * something has been emitted. That is the delivery gate rather than an oversight:
 *
 *   * `PDF_CONVERSION_FAILED` means a `.docx` exists and its `.pdf` does not. The pair
 *     is delivered together or not at all, because a Word file whose PDF could not be
 *     produced from it is a pair whose halves have never been shown to agree.
 *   * `VERIFICATION_FAILED` and `REPLAY_MISMATCH` mean a document exists and could not
 *     be proven. There is no "verification failed but here it is anyway" path, so
 *     announcing an artifact would announce one nobody may download.
 *
 * The field reads "an artifact the consultant has", not "bytes were written somewhere",
 * which is the only reading a failure screen can act on.
 */
export const RUN_FAILURE_PRESENTATION: Readonly<
  Record<RunErrorCode, RunFailurePresentation>
> = Object.freeze({
  EMPTY_SCOPE: {
    headline: EMPTY_SCOPE_HEADLINE,
    artifactProduced: false,
    causes: EMPTY_SCOPE_CAUSES,
  },
  AUTH_EXPIRED: {
    headline:
      "The subscription's Azure client secret has expired, so nothing was " +
      "collected and no report was produced.",
    artifactProduced: false,
    causes: [
      "Ask the customer to issue a new client secret for the service " +
        "principal, then rotate it on the subscription and run again.",
    ],
  },
  AUTH_FAILED: {
    headline:
      "Azure refused the stored credential, so nothing was collected and no " +
      "report was produced.",
    artifactProduced: false,
    causes: [
      "The client secret may have been revoked or replaced in Azure without " +
        "being rotated here.",
      "The tenant or client id recorded for this connection may no longer " +
        "match the app registration.",
    ],
  },
  SCOPE_UNVERIFIED: {
    headline:
      "Read at subscription scope could not be proved, so the run was not " +
      "started and no report was produced.",
    artifactProduced: false,
    causes: [
      "The Reader role must be assigned at the subscription's own scope. " +
        "Monitoring Reader alone does not grant the Resource Graph inventory " +
        "the collection needs.",
    ],
  },
  SECRET_UNREADABLE: {
    headline:
      "The stored Azure client secret could not be decrypted, so nothing was " +
      "collected and no report was produced.",
    artifactProduced: false,
    causes: [
      "Rotate the client secret on this subscription. The stored value cannot " +
        "be recovered, and re-entering it is the repair.",
    ],
  },
  CATALOG_UNUSABLE: {
    headline:
      "The metric catalog this deployment ships could not be used, so nothing " +
      "was collected and no report was produced.",
    artifactProduced: false,
    causes: [
      "This is a deployment fault rather than a problem with the " +
        "subscription. The runtime image needs attention.",
    ],
  },
  NO_STATISTICS: {
    headline:
      "No metric values could be collected for anything in scope, so no " +
      "report was produced.",
    artifactProduced: false,
    causes: [
      "Every resource in scope may be deallocated for the whole period. A " +
        "stopped machine emits no metrics, which is recorded rather than " +
        "reported as zero utilization.",
      "The requested resource types may not emit the metrics this report " +
        "needs.",
    ],
  },
  REGION_UNREACHABLE: {
    headline:
      "No metrics endpoint could be reached for a region in scope, so no " +
      "report was produced.",
    artifactProduced: false,
    causes: [
      "Some Azure regions have no regional metrics host. The run retries " +
        "per resource against the control plane, and this failure means that " +
        "fallback did not succeed either.",
    ],
  },
  THROTTLED: {
    headline:
      "Azure's rate limits were exhausted, so the run stopped and no report " +
      "was produced.",
    artifactProduced: false,
    causes: [
      "Rate limits are per subscription. Running the same subscription again " +
        "shortly afterwards will hit them again; running a different " +
        "subscription will not.",
    ],
  },
  TIMEOUT: {
    headline:
      "This run exceeded its phase deadline and was failed automatically, so " +
      "no report was produced.",
    artifactProduced: false,
    causes: [
      "The collection container most likely stopped before it could report a " +
        "result. Nothing was delivered, and running again is safe.",
    ],
  },

  // Requirement 41.2 — the document phases. The data was collected; the document
  // could not be built from it, or could not be proven once it was.
  TEMPLATE_INVALID: {
    headline:
      "The template version this run was pinned to did not validate, so no " +
      "report was produced.",
    artifactProduced: false,
    causes: [
      "Open the template and re-save it. The run used the version pinned at " +
        "the time it was submitted, and editing the template creates a new " +
        "version rather than changing that one.",
      "A template the builder accepted and the compiler rejects is a fault on " +
        "this side rather than in your report. It is worth reporting.",
    ],
  },
  COMPILE_FAILED: {
    headline:
      "The report could not be compiled from the collected data, so no report " +
      "was produced.",
    artifactProduced: false,
    causes: [
      "The collected data is intact and is kept. Nothing needs re-collecting " +
        "to retry this.",
      "A block may be asking for a figure the period's data cannot supply. " +
        "The detail below names the block.",
    ],
  },
  RENDER_FAILED: {
    headline:
      "The Word document could not be written, so no report was produced.",
    artifactProduced: false,
    causes: [
      "The style preset this template uses may be missing a style the " +
        "document needs. That is a deployment fault rather than a problem " +
        "with your template.",
      "The collected data is intact and is kept, so a retry does not " +
        "re-collect anything.",
    ],
  },
  PDF_CONVERSION_FAILED: {
    headline:
      "The PDF could not be produced from the Word document, so neither file " +
      "was delivered.",
    artifactProduced: false,
    causes: [
      "The PDF is converted from the delivered Word file rather than rendered " +
        "separately, so the two can never disagree — which is why a failed " +
        "conversion withholds both rather than delivering one.",
      "This is a deployment fault rather than a problem with the " +
        "subscription or the template. Running again is safe.",
    ],
  },
  VERIFICATION_FAILED: {
    headline:
      "The document could not be proven against the collected data, so it was " +
      "not delivered.",
    artifactProduced: false,
    causes: [
      "Every figure in a delivered report has to trace to the stored " +
        "snapshot. One did not, so the report was withheld rather than " +
        "delivered with a warning.",
      "The verification panel lists every finding and where in the document " +
        "it occurred.",
    ],
  },
  REPLAY_MISMATCH: {
    headline:
      "Re-running the aggregation over the stored responses produced a " +
      "different snapshot, so no report was delivered.",
    artifactProduced: false,
    causes: [
      "The snapshot could not be reproduced from its own recorded inputs. " +
        "That is a fault in this system rather than in the subscription, and " +
        "it is worth reporting.",
      "Both digests are recorded on the verification, so the run remains " +
        "auditable.",
    ],
  },
  INTERNAL_ERROR: {
    headline:
      "The runtime failed for a reason of its own, so no report was produced.",
    artifactProduced: false,
    causes: [
      "This is a fault in this system rather than a problem with the " +
        "subscription. Nothing about the customer's Azure needs changing, and " +
        "re-running is unlikely to help until the fault is fixed.",
      "The specific failure is in the runtime log for this run, which is " +
        "where it is actionable. It is deliberately not shown here: the " +
        "message is our own internal detail, and a consultant reading this " +
        "screen cannot act on a stack frame.",
    ],
  },
})

/** The fallback for a `failed` row whose code the database somehow admitted. */
const UNKNOWN_FAILURE: RunFailurePresentation = Object.freeze({
  headline: "This run failed, so no report was produced.",
  artifactProduced: false,
  causes: Object.freeze([]),
})

/**
 * How this run's failure reads, or `null` if it did not fail.
 *
 * Reads `status` **and** `errorCode` from the row (Requirement 36.7). Both, because
 * `TIMEOUT` arrives with no event to carry it — the reaper writes it when the run's
 * container may already be gone — so a surface that took its terminal state from the
 * event stream alone would show a timed-out run as still collecting, forever.
 *
 * The row's own `errorMessage` is **not** used for the headline. It is the runtime's
 * prose, written for a log, and it varies with whichever code path produced it; the
 * headline here is the same sentence every time for a given code, which is what makes
 * the screen legible and the copy assertable. A surface that wants the runtime's own
 * words renders `run.errorMessage` beside this as supporting detail.
 */
export function runFailurePresentation(
  run: Pick<RunView, "status" | "errorCode">
): RunFailurePresentation | null {
  if (run.status !== "failed") return null

  if (run.errorCode === null) return UNKNOWN_FAILURE

  return RUN_FAILURE_PRESENTATION[run.errorCode] ?? UNKNOWN_FAILURE
}

/**
 * The period, as one line naming the zone.
 *
 * The zone is named because that is the product's whole position on periods: "July
 * 2026" means July in Asia/Jakarta, not July in UTC, and a reader checking a figure
 * against their own records needs to know which seven hours were included. Rendering
 * the dates without the zone would be the omission that makes the two disagree
 * silently.
 *
 * The dates pass through as the `YYYY-MM-DD` strings the column holds. Deliberately not
 * locale-formatted: a locale format differs between the server pass and the browser,
 * and a report period is exactly the value nobody should have to wonder about.
 */
export function periodLine(
  run: Pick<RunView, "periodStart" | "periodEnd" | "timezone">
): string {
  const range =
    run.periodStart === run.periodEnd
      ? run.periodStart
      : `${run.periodStart} to ${run.periodEnd}`

  return `${range} · ${run.timezone}`
}
