import "server-only"

/**
 * Execute a subscription scan: invoke `list_inventory` and write the outcome
 * onto the scan row.
 *
 * ## Design decision: where the invocation lives
 *
 * **Chosen:** a fire-and-forget server-side call initiated from the POST route
 * handler. The POST writes `queued`, transitions the row to `running`, invokes
 * the runtime, reads the streaming response in full, writes the row to
 * `complete` or `failed`, and returns the final `ScanView`.
 *
 * **Rejected — the `report_runs` state machine (reaper/progress-callback):**
 * Design §4.3 states a scan produces no snapshot, no ledger and no artifact, so
 * the reaper and phase deadlines would protect nothing. A dead `running` row is
 * superseded by the next scan.
 *
 * **Rejected — a browser-held request:** the row carries `status` and the screen
 * polls `GET`; decoupling is free. But making this a *separate* background
 * process (e.g. cron-claimed) would add machinery for a task that takes seconds.
 * The POST handler can afford to hold its own request open for the ~5–20 seconds
 * a list_inventory takes, because it is an API request that returns JSON, not a
 * page render. The screen polls with `GET`.
 *
 * **However:** if the invocation takes too long and the request is killed by a
 * proxy (ALB 60s default), the row stays `running`. The next re-scan supersedes
 * it. This is acceptable because the scan carries no artifact worth protecting.
 *
 * @module
 */

import { eq } from "drizzle-orm"

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
import { getDb } from "@/lib/db"
import { subscriptionScans } from "@/lib/db/schema"
import { toScanView, type ScanView } from "@/lib/db/views"
import { newSessionId } from "@/lib/session-id"
import type { ResolvedAzureCredentials } from "@/lib/subscriptions/store"

// --- Timeout ----------------------------------------------------------------

/**
 * A scan invocation's total time budget. list_inventory is short (typically 5–20s),
 * but a slow subscription or a large estate can stretch it. 55 seconds keeps us
 * under ALB's 60-second default idle timeout.
 */
const SCAN_TIMEOUT_MS = 55_000

// --- The done event schema --------------------------------------------------

/**
 * The keys `handle_list_inventory` writes onto `invocation.outcome`.
 *
 * Parsed leniently: absent keys stay absent, and a field with a wrong type is
 * treated as absent rather than throwing. A scan screen that shows dashes is
 * recoverable; one that crashes is not.
 */
type ScanOutcome = {
  resource_count?: number
  type_counts?: Record<string, number>
  child_type_counts?: Record<string, number>
  region_counts?: Record<string, number>
  resource_groups?: { values: string[]; truncated: boolean }
  regions?: { values: string[]; truncated: boolean }
  resource_types?: { values: string[]; truncated: boolean }
  tag_keys?: { values: string[]; truncated: boolean }
  tag_values?: { values: string[]; truncated: boolean }
  region_probes?: Array<{
    region: string
    status_code: number | null
    verdict: string
    probed_at: string
  }>
}

// --- Public API --------------------------------------------------------------

export type ExecuteScanRequest = {
  readonly scanId: string
  readonly actorId: string
  readonly displayName: string
  readonly credentials: ResolvedAzureCredentials
}

/**
 * Run the scan to completion and write the outcome onto the row.
 *
 * On success writes `status = 'complete'` with every column task 1.8 lists.
 * On failure writes `status = 'failed'` with a scrubbed `error_message` and an
 * `error_code`. **Never** leaves the row stuck in `running`.
 */
export async function executeScan(request: ExecuteScanRequest): Promise<ScanView> {
  const db = getDb()
  const now = new Date()

  // Transition queued -> running before invoking.
  await db
    .update(subscriptionScans)
    .set({ status: "running", updatedAt: now })
    .where(eq(subscriptionScans.id, request.scanId))

  try {
    const outcome = await invokeScanAndRead(request)

    // Write the outcome onto the row.
    const [updated] = await db
      .update(subscriptionScans)
      .set({
        status: "complete",
        resourceCount:
          typeof outcome.resource_count === "number"
            ? outcome.resource_count
            : null,
        typeCounts: outcome.type_counts ?? null,
        childTypeCounts: outcome.child_type_counts ?? null,
        regionCounts: outcome.region_counts ?? null,
        resourceGroups: outcome.resource_groups ?? null,
        regions: outcome.regions ?? null,
        regionProbes: outcome.region_probes ?? null,
        truncated: isTruncated(outcome),
        catalogVersion: null, // set when the catalog version travels on done
        sectionsCatalogueVersion: null,
        errorCode: null,
        errorMessage: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(subscriptionScans.id, request.scanId))
      .returning()

    return toScanView(updated as typeof subscriptionScans.$inferSelect)
  } catch (thrown) {
    // A failure MUST write the row to `failed` and NEVER leave it `running`.
    const code = errorCodeFrom(thrown)
    const message = scrubErrorMessage(thrown)

    const [failed] = await db
      .update(subscriptionScans)
      .set({
        status: "failed",
        errorCode: code,
        errorMessage: message,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(subscriptionScans.id, request.scanId))
      .returning()

    return toScanView(failed as typeof subscriptionScans.$inferSelect)
  }
}

// --- The invocation ---------------------------------------------------------

function scanContext(
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
    // No report run — these fields are empty/placeholder.
    run_id: "",
    progress_url: "",
    progress_token: "",
  }
}

/**
 * Invoke `list_inventory`, read the stream to the terminal `done` event, and
 * return the outcome keys. Throws on any failure — the caller writes `failed`.
 */
async function invokeScanAndRead(request: ExecuteScanRequest): Promise<ScanOutcome> {
  const deadline = Date.now() + SCAN_TIMEOUT_MS

  const stream = await invokeAgentRuntime({
    sessionId: newSessionId(),
    context: scanContext(
      request.actorId,
      request.displayName,
      request.credentials
    ),
    command: { command: COMMAND_LIST_INVENTORY },
  })

  return await readScanOutcome(stream, deadline)
}

/**
 * Read SSE frames from the stream until a `done` event, collecting error and
 * outcome data. Throws a descriptive error on timeout, stream failure, or a
 * terminal error event.
 */
async function readScanOutcome(
  stream: AsyncIterable<Uint8Array>,
  deadline: number
): Promise<ScanOutcome> {
  const iterator = stream[Symbol.asyncIterator]()
  const decoder = new TextDecoder()

  let buffer = ""
  let seenError: { code?: string; message?: string } | undefined

  try {
    for (;;) {
      const remaining = deadline - Date.now()
      const step = await withDeadline(settle(iterator.next()), remaining)

      if (step === TIMED_OUT) {
        throw new ScanInvocationError("SCAN_TIMEOUT", "The scan timed out.")
      }

      if (!step.ok) {
        throw new ScanInvocationError(
          "STREAM_FAILED",
          "The response stream failed before a terminal event was received."
        )
      }

      if (step.value.done === true) {
        // Stream ended without a `done` event — truncated.
        if (seenError !== undefined) {
          throw new ScanInvocationError(
            seenError.code ?? "SCAN_ERROR",
            seenError.message ?? "The scan returned a terminal error."
          )
        }
        throw new ScanInvocationError(
          "STREAM_TRUNCATED",
          "The stream ended without a terminal event."
        )
      }

      buffer += decoder.decode(step.value.value, { stream: true })

      const frames = splitSseFrames(buffer)
      buffer = frames.rest

      for (const raw of frames.frames) {
        const parsed = parseSseFrame(raw)
        if (parsed === undefined) continue

        const event = parsed as Record<string, unknown>

        if (event.type === "error") {
          seenError = {
            code: typeof event.code === "string" ? event.code : undefined,
            message:
              typeof event.message === "string" ? event.message : undefined,
          }
        }

        if (event.type === "done") {
          // If we saw an error before done, propagate it.
          if (seenError !== undefined) {
            throw new ScanInvocationError(
              seenError.code ?? "SCAN_ERROR",
              seenError.message ?? "The scan returned a terminal error."
            )
          }
          // The done event itself carries the outcome keys at the top level.
          return extractOutcome(event)
        }
      }
    }
  } finally {
    await releaseIterator(iterator)
  }
}

/**
 * Extract the scan-relevant keys from the parsed `done` event object.
 * Every field is read defensively — a wrong type means absent, not a crash.
 */
function extractOutcome(done: Record<string, unknown>): ScanOutcome {
  return {
    resource_count: safeInt(done.resource_count),
    type_counts: safeRecord(done.type_counts),
    child_type_counts: safeRecord(done.child_type_counts),
    region_counts: safeRecord(done.region_counts),
    resource_groups: safeDimension(done.resource_groups),
    regions: safeDimension(done.regions),
    resource_types: safeDimension(done.resource_types),
    tag_keys: safeDimension(done.tag_keys),
    tag_values: safeDimension(done.tag_values),
    region_probes: safeProbes(done.region_probes),
  }
}

function safeInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined
}

function safeRecord(v: unknown): Record<string, number> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined
  const result: Record<string, number> = {}
  for (const [key, val] of Object.entries(v)) {
    if (typeof val === "number" && Number.isInteger(val) && val >= 0) {
      result[key] = val
    }
  }
  return result
}

function safeDimension(
  v: unknown
): { values: string[]; truncated: boolean } | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined
  const obj = v as Record<string, unknown>
  if (!Array.isArray(obj.values)) return undefined
  const values = obj.values.filter(
    (item): item is string => typeof item === "string"
  )
  return {
    values,
    truncated: typeof obj.truncated === "boolean" ? obj.truncated : false,
  }
}

function safeProbes(
  v: unknown
): ScanOutcome["region_probes"] | undefined {
  if (!Array.isArray(v)) return undefined
  const result: NonNullable<ScanOutcome["region_probes"]> = []
  for (const item of v) {
    if (typeof item !== "object" || item === null) continue
    const obj = item as Record<string, unknown>
    if (typeof obj.region !== "string") continue
    if (typeof obj.verdict !== "string") continue
    if (typeof obj.probed_at !== "string") continue
    result.push({
      region: obj.region,
      status_code:
        typeof obj.status_code === "number" ? obj.status_code : null,
      verdict: obj.verdict,
      probed_at: obj.probed_at,
    })
  }
  return result.length > 0 ? result : undefined
}

function isTruncated(outcome: ScanOutcome): boolean {
  return !!(
    outcome.resource_groups?.truncated ||
    outcome.regions?.truncated ||
    outcome.resource_types?.truncated ||
    outcome.tag_keys?.truncated ||
    outcome.tag_values?.truncated
  )
}

// --- Error handling ----------------------------------------------------------

class ScanInvocationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "ScanInvocationError"
    this.code = code
  }
}

/**
 * Derive an error code from whatever was thrown. Never surfaces credentials
 * or internal details — just a stable code the UI can key off.
 */
function errorCodeFrom(thrown: unknown): string {
  if (thrown instanceof ScanInvocationError) return thrown.code
  if (thrown instanceof MissingRuntimeConfigError) return "RUNTIME_UNCONFIGURED"
  return "INTERNAL_ERROR"
}

/**
 * Produce a scrubbed, human-readable error message from whatever was thrown.
 * MUST NOT include tenant_id, client_id, client_secret, or any credential
 * fragment. Safe to store and to send to the browser.
 */
function scrubErrorMessage(thrown: unknown): string {
  if (thrown instanceof ScanInvocationError) {
    // Already our own text — safe.
    return thrown.message.slice(0, 500)
  }
  if (thrown instanceof MissingRuntimeConfigError) {
    return "The runtime is not configured. Contact the operator."
  }
  // Generic — name only, no message (could contain credential fragments from SDK).
  if (thrown instanceof Error) {
    return `An unexpected error occurred (${thrown.name}).`
  }
  return "An unexpected error occurred."
}
