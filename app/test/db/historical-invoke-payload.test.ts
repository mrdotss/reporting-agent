import { describe, expect, test } from "vitest"

import {
  buildInvokePayload,
  COMMAND_GENERATE_REPORT,
  type AgentInvokeContext,
  type HistoricalCandidatePayload,
  type InvokeCommand,
} from "@/lib/aws/agentcore"

/**
 * `buildInvokePayload` with historical candidates (Requirement 18.4).
 *
 * Proves:
 *   1. `historical_candidates` reaches the serialized payload alongside the
 *      definition and period — the agent receives them.
 *   2. `context` carries exactly twelve fields — the closure guard is intact.
 *   3. `historical_candidates` is NOT inside `context`.
 */

const CONTEXT: AgentInvokeContext = {
  actor_id: "user-01",
  subscription_id: "sub-01",
  tenant_id: "tenant-01",
  client_id: "client-01",
  client_secret: "secret-01",
  timezone: "Asia/Jakarta",
  display_name: "Test subscription",
  fidelity_tier: "baseline",
  log_analytics_workspace_id: null,
  run_id: "run-01",
  progress_url: "https://example.com/api/internal/runs/run-01/progress",
  progress_token: "token-01",
}

const CANDIDATES: HistoricalCandidatePayload[] = [
  {
    id: "prior-run-1",
    period_start: "2026-06-01",
    period_end: "2026-06-30",
    timezone: "Asia/Jakarta",
    status: "completed",
    verification_id: "ver-1",
    verification_status: "pass",
    verification_created_at: "2026-07-01T00:00:00Z",
    verification_snapshot_sha256: "a".repeat(64),
  },
  {
    id: "prior-run-2",
    period_start: "2026-05-01",
    period_end: "2026-05-31",
    timezone: "Asia/Jakarta",
    status: "completed",
    verification_id: null,
    verification_status: null,
    verification_created_at: null,
    verification_snapshot_sha256: null,
  },
]

describe("buildInvokePayload — historical candidates", () => {
  test("historical_candidates reaches the wire payload", () => {
    const command: InvokeCommand = {
      command: COMMAND_GENERATE_REPORT,
      template_version_id: "tv-01",
      definition: { blocks: [] },
      period: { start: "2026-07-01", end: "2026-07-31" },
      scope: {
        resource_types: ["Microsoft.Compute/virtualMachines"],
        resource_groups: [],
        tag_filters: {},
      },
      historical_candidates: CANDIDATES,
    }

    const bytes = buildInvokePayload(command, CONTEXT)
    const payload = JSON.parse(new TextDecoder().decode(bytes))

    // Candidates are at the top level of the payload (spread from command)
    expect(payload.historical_candidates).toEqual(CANDIDATES)
    expect(payload.historical_candidates).toHaveLength(2)
    expect(payload.historical_candidates[0].id).toBe("prior-run-1")
    expect(payload.historical_candidates[1].verification_id).toBeNull()
  })

  test("context stays closed at exactly twelve fields", () => {
    const command: InvokeCommand = {
      command: COMMAND_GENERATE_REPORT,
      template_version_id: "tv-01",
      definition: {},
      period: { start: "2026-07-01", end: "2026-07-31" },
      scope: {
        resource_types: [],
        resource_groups: [],
        tag_filters: {},
      },
      historical_candidates: CANDIDATES,
    }

    const bytes = buildInvokePayload(command, CONTEXT)
    const payload = JSON.parse(new TextDecoder().decode(bytes))

    const contextKeys = Object.keys(payload.context)
    expect(contextKeys).toHaveLength(12)
    expect(contextKeys.sort()).toEqual([
      "actor_id",
      "client_id",
      "client_secret",
      "display_name",
      "fidelity_tier",
      "log_analytics_workspace_id",
      "progress_token",
      "progress_url",
      "run_id",
      "subscription_id",
      "tenant_id",
      "timezone",
    ])

    // historical_candidates is NOT in context
    expect(payload.context.historical_candidates).toBeUndefined()
  })

  test("historical_candidates is absent from the payload when undefined", () => {
    const command: InvokeCommand = {
      command: COMMAND_GENERATE_REPORT,
      template_version_id: "tv-01",
      definition: {},
      period: { start: "2026-07-01", end: "2026-07-31" },
      scope: {
        resource_types: [],
        resource_groups: [],
        tag_filters: {},
      },
      // No historical_candidates field
    }

    const bytes = buildInvokePayload(command, CONTEXT)
    const payload = JSON.parse(new TextDecoder().decode(bytes))

    // When undefined, JSON.stringify omits the key entirely
    expect("historical_candidates" in payload).toBe(false)
  })

  test("snapshot-only command has no historical_candidates field", () => {
    const command: InvokeCommand = {
      command: COMMAND_GENERATE_REPORT,
      period: { start: "2026-07-01", end: "2026-07-31" },
      scope: {
        resource_types: [],
        resource_groups: [],
        tag_filters: {},
      },
    }

    const bytes = buildInvokePayload(command, CONTEXT)
    const payload = JSON.parse(new TextDecoder().decode(bytes))

    expect("historical_candidates" in payload).toBe(false)
    expect("template_version_id" in payload).toBe(false)
  })
})
