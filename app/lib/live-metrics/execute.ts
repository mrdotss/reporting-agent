import "server-only"

import { randomUUID } from "node:crypto"
import { and, desc, eq, inArray } from "drizzle-orm"

import {
  TIMED_OUT,
  parseSseFrame,
  releaseIterator,
  settle,
  splitSseFrames,
  withDeadline,
} from "@/lib/aws/agent-stream"
import {
  COMMAND_GENERATE_REPORT,
  MissingRuntimeConfigError,
  invokeAgentRuntime,
} from "@/lib/aws/agentcore"
import { getDb } from "@/lib/db"
import {
  connectedSubscriptions,
  liveMetricPulls,
  type LiveMetricPull,
} from "@/lib/db/schema"
import { LIVE_TIMEZONE, type LiveWindow } from "@/lib/live-metrics/window"
import { newSessionId } from "@/lib/session-id"
import type { ResolvedAzureCredentials } from "@/lib/subscriptions/store"
import { accessWhere } from "@/lib/workspaces/access"

/**
 * Live metrics pulls: create one, run it, read the workspace's (ask-chat Req 8).
 *
 * A pull is a **collection-only** `generate_report`: the payload names a period and a scope
 * and no definition, which the runtime's contract defines as a snapshot-only run. It
 * collects the picked machines over whole local days, writes a snapshot under
 * `<user_id>/snapshots/<pull id>/`, and renders, verifies and delivers nothing. The context
 * carries the pull's id as `run_id` and empty progress fields, so no run row is touched —
 * the pull's own row records the outcome.
 *
 * Run synchronously in the request, like a scan: collection over a few machines and a
 * handful of days takes tens of seconds, and the attach dialog waits for it.
 */

export const LIVE_PULL_TIMEOUT_MS = 150_000
export const VIRTUAL_MACHINE_TYPE = "Microsoft.Compute/virtualMachines"

export class LivePullConnectorNotFoundError extends Error {
  constructor() {
    super("That connector does not exist or you do not have access to it.")
    this.name = "LivePullConnectorNotFoundError"
  }
}

export async function createLivePull(a: {
  readonly userId: string
  readonly connectedSubscriptionId: string
  readonly resourceIds: readonly string[]
  readonly resourceNames: readonly string[]
  readonly window: LiveWindow
}): Promise<LiveMetricPull> {
  const db = getDb()
  const [source] = await db
    .select()
    .from(connectedSubscriptions)
    .where(
      and(
        eq(connectedSubscriptions.id, a.connectedSubscriptionId),
        accessWhere(connectedSubscriptions, a.userId, "edit")
      )
    )
    .limit(1)
  if (source === undefined) throw new LivePullConnectorNotFoundError()

  const now = new Date()
  const [row] = await db
    .insert(liveMetricPulls)
    .values({
      id: randomUUID(),
      workspaceId: source.workspaceId,
      projectId: source.projectId,
      userId: a.userId,
      connectedSubscriptionId: a.connectedSubscriptionId,
      resourceIds: [...a.resourceIds],
      resourceNames: [...a.resourceNames],
      periodStart: a.window.start,
      periodEnd: a.window.end,
      timezone: LIVE_TIMEZONE,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  return row as LiveMetricPull
}

type PullOutcome =
  | { readonly ok: true; readonly resourceCount: number | null; readonly gapCount: number | null }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Run a created pull to completion and write its outcome. Never leaves it `running`. */
export async function executeLivePull(a: {
  readonly pull: LiveMetricPull
  readonly displayName: string
  readonly credentials: ResolvedAzureCredentials
}): Promise<LiveMetricPull> {
  const db = getDb()
  await db
    .update(liveMetricPulls)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(liveMetricPulls.id, a.pull.id))

  let outcome: PullOutcome
  try {
    outcome = await invokePull(a)
  } catch (thrown) {
    if (thrown instanceof MissingRuntimeConfigError) {
      outcome = { ok: false, code: "RUNTIME_UNCONFIGURED", message: "The agent runtime is not configured." }
    } else {
      outcome = { ok: false, code: "INVOKE_FAILED", message: "The collection could not be started." }
    }
  }

  const [row] = await db
    .update(liveMetricPulls)
    .set(
      outcome.ok
        ? {
            status: "complete",
            resourceCount: outcome.resourceCount,
            gapCount: outcome.gapCount,
            errorCode: null,
            errorMessage: null,
            completedAt: new Date(),
            updatedAt: new Date(),
          }
        : {
            status: "failed",
            errorCode: outcome.code,
            errorMessage: outcome.message,
            completedAt: new Date(),
            updatedAt: new Date(),
          }
    )
    .where(eq(liveMetricPulls.id, a.pull.id))
    .returning()
  return row as LiveMetricPull
}

async function invokePull(a: {
  readonly pull: LiveMetricPull
  readonly displayName: string
  readonly credentials: ResolvedAzureCredentials
}): Promise<PullOutcome> {
  const { pull, credentials } = a
  const deadline = Date.now() + LIVE_PULL_TIMEOUT_MS

  const stream = await invokeAgentRuntime({
    sessionId: newSessionId(),
    context: {
      // The pulling user's id: the snapshot lands under their prefix, and the chat that
      // cites it names this id as the owner.
      actor_id: pull.userId,
      subscription_id: credentials.subscriptionId,
      tenant_id: credentials.tenantId,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      timezone: pull.timezone,
      display_name: a.displayName,
      fidelity_tier: credentials.fidelityTier,
      log_analytics_workspace_id: credentials.logAnalyticsWorkspaceId,
      run_id: pull.id,
      // No run row: the reporter is disabled without these, so nothing posts progress.
      progress_url: "",
      progress_token: "",
    },
    command: {
      command: COMMAND_GENERATE_REPORT,
      period: { start: pull.periodStart, end: pull.periodEnd },
      scope: {
        resource_types: [VIRTUAL_MACHINE_TYPE],
        resource_groups: [],
        tag_filters: {},
        resource_ids: [...pull.resourceIds],
      },
    },
  })

  const iterator = stream[Symbol.asyncIterator]()
  const decoder = new TextDecoder()
  let buffer = ""
  let snapshot: { resourceCount: number | null; gapCount: number | null } | undefined
  let terminalError: { code: string; message: string } | undefined

  try {
    for (;;) {
      const step = await withDeadline(settle(iterator.next()), deadline - Date.now())
      if (step === TIMED_OUT) {
        return { ok: false, code: "TIMEOUT", message: "The collection took too long." }
      }
      if (!step.ok || step.value.done === true) {
        return { ok: false, code: "TRUNCATED", message: "The collection ended before it finished." }
      }

      buffer += decoder.decode(step.value.value, { stream: true })
      const { frames, rest } = splitSseFrames(buffer)
      buffer = rest

      for (const frame of frames) {
        const event = parseSseFrame(frame)
        if (event === null || typeof event !== "object") continue
        const record = event as Record<string, unknown>

        if (record.type === "snapshot_ready") {
          snapshot = {
            resourceCount: typeof record.resource_count === "number" ? record.resource_count : null,
            gapCount: Array.isArray(record.gaps) ? record.gaps.length : null,
          }
        } else if (record.type === "error" && record.terminal !== false) {
          terminalError = {
            code: typeof record.code === "string" ? record.code : "COLLECTION_FAILED",
            message:
              "The metrics for these machines couldn’t be collected. Check the connector, then try again.",
          }
        } else if (record.type === "done") {
          // A pull that recorded gaps still wrote its snapshot: the non-terminal
          // `PARTIAL_COVERAGE` error does not fail it.
          if (snapshot !== undefined && terminalError === undefined) {
            return { ok: true, ...snapshot }
          }
          return terminalError !== undefined
            ? { ok: false, ...terminalError }
            : { ok: false, code: "NO_SNAPSHOT", message: "The collection wrote no snapshot." }
        }
      }
    }
  } finally {
    await releaseIterator(iterator)
  }
}

/** The workspace's completed pulls, newest first. */
export async function listLivePulls(
  userId: string,
  workspaceId: string,
  limit = 30
): Promise<LiveMetricPull[]> {
  return await getDb()
    .select()
    .from(liveMetricPulls)
    .where(
      and(
        accessWhere(liveMetricPulls, userId, "read", { workspaceId }),
        eq(liveMetricPulls.status, "complete")
      )
    )
    .orderBy(desc(liveMetricPulls.createdAt))
    .limit(limit)
}

export async function readLivePulls(
  userId: string,
  workspaceId: string,
  ids: readonly string[]
): Promise<LiveMetricPull[]> {
  if (ids.length === 0) return []
  return await getDb()
    .select()
    .from(liveMetricPulls)
    .where(
      and(
        accessWhere(liveMetricPulls, userId, "read", { workspaceId }),
        eq(liveMetricPulls.status, "complete"),
        inArray(liveMetricPulls.id, [...ids])
      )
    )
}
