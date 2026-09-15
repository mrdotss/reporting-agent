import "server-only"

import {
  TIMED_OUT,
  parseSseFrame,
  releaseIterator,
  settle,
  splitSseFrames,
  withDeadline,
} from "@/lib/aws/agent-stream"
import {
  COMMAND_LIST_RESOURCES,
  DEFAULT_TIMEZONE,
  MissingRuntimeConfigError,
  invokeAgentRuntime,
} from "@/lib/aws/agentcore"
import { newSessionId } from "@/lib/session-id"
import type { ResolvedAzureCredentials } from "@/lib/subscriptions/store"

/**
 * The machines a connector can see, for the Ask page's live metrics picker (ask-chat
 * Req 8.1).
 *
 * The runtime answers `list_resources` on `done` with each machine's id, name, region, size
 * and power state. Resolved server-side with the connector's credentials, exactly as a scan
 * is; the browser receives this listing and never a credential.
 *
 * Cached per connector for a few minutes, in memory: a picker is opened, closed and opened
 * again while someone decides, and the estate does not change between those clicks.
 */

export const RESOURCES_TIMEOUT_MS = 45_000
const CACHE_TTL_MS = 5 * 60_000

export type ConnectorResource = {
  readonly resourceId: string
  readonly name: string
  readonly resourceType: string
  readonly location: string
  readonly resourceGroup: string
  readonly skuName: string
  readonly powerState: string
}

export type ResourceListing =
  | { readonly available: true; readonly resources: readonly ConnectorResource[]; readonly truncated: boolean }
  | { readonly available: false; readonly message: string }

const cache = globalThis as typeof globalThis & {
  __rptResourceListings?: Map<string, { expires: number; listing: ResourceListing }>
}

function listingCache() {
  cache.__rptResourceListings ??= new Map()
  return cache.__rptResourceListings
}

export async function listConnectorResources(request: {
  readonly connectorId: string
  readonly actorId: string
  readonly displayName: string
  readonly credentials: ResolvedAzureCredentials
  readonly now?: number
}): Promise<ResourceListing> {
  const now = request.now ?? Date.now()
  const cached = listingCache().get(request.connectorId)
  if (cached !== undefined && cached.expires > now) return cached.listing

  const listing = await invoke(request)
  if (listing.available) {
    listingCache().set(request.connectorId, { expires: now + CACHE_TTL_MS, listing })
  }
  return listing
}

async function invoke(request: {
  readonly actorId: string
  readonly displayName: string
  readonly credentials: ResolvedAzureCredentials
}): Promise<ResourceListing> {
  const deadline = Date.now() + RESOURCES_TIMEOUT_MS
  const { credentials } = request

  const opened = await withDeadline(
    settle(
      invokeAgentRuntime({
        sessionId: newSessionId(),
        context: {
          actor_id: request.actorId,
          subscription_id: credentials.subscriptionId,
          tenant_id: credentials.tenantId,
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          timezone: DEFAULT_TIMEZONE,
          display_name: request.displayName,
          fidelity_tier: credentials.fidelityTier,
          log_analytics_workspace_id: credentials.logAnalyticsWorkspaceId,
          // No run: a listing writes no row and posts no progress.
          run_id: "",
          progress_url: "",
          progress_token: "",
        },
        command: { command: COMMAND_LIST_RESOURCES },
      })
    ),
    deadline - Date.now()
  )

  if (opened === TIMED_OUT) return unavailable("The machine list took too long to load.")
  if (!opened.ok) {
    if (opened.error instanceof MissingRuntimeConfigError) throw opened.error
    return unavailable("The machine list couldn’t be loaded. Try again in a moment.")
  }

  const iterator = opened.value[Symbol.asyncIterator]()
  const decoder = new TextDecoder()
  let buffer = ""
  let failed = false

  try {
    for (;;) {
      const step = await withDeadline(settle(iterator.next()), deadline - Date.now())
      if (step === TIMED_OUT) return unavailable("The machine list took too long to load.")
      if (!step.ok || step.value.done === true) {
        return unavailable("The machine list couldn’t be loaded. Try again in a moment.")
      }

      buffer += decoder.decode(step.value.value, { stream: true })
      const { frames, rest } = splitSseFrames(buffer)
      buffer = rest

      for (const frame of frames) {
        const event = parseSseFrame(frame)
        if (event === null || typeof event !== "object") continue
        const record = event as Record<string, unknown>
        if (record.type === "error") failed = true
        if (record.type === "done") {
          const resources = parseResources(record.resources)
          if (failed || resources === undefined) {
            return unavailable(
              "This connector’s machines couldn’t be listed. Check that its secret is valid, then try again."
            )
          }
          return {
            available: true,
            resources,
            truncated: record.resources_truncated === true,
          }
        }
      }
    }
  } finally {
    await releaseIterator(iterator)
  }
}

export function parseResources(value: unknown): ConnectorResource[] | undefined {
  if (!Array.isArray(value)) return undefined
  const resources: ConnectorResource[] = []
  for (const item of value) {
    if (item === null || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : "")
    if (!text("resource_id") || !text("name")) continue
    resources.push({
      resourceId: text("resource_id"),
      name: text("name"),
      resourceType: text("resource_type"),
      location: text("location"),
      resourceGroup: text("resource_group"),
      skuName: text("sku_name"),
      powerState: text("power_state"),
    })
  }
  return resources
}

function unavailable(message: string): ResourceListing {
  return { available: false, message }
}
