import { beforeEach, describe, expect, test, vi } from "vitest"

import type { ScanView } from "@/lib/db/views"
import { scanGate, mayContinue } from "@/lib/scans/view"

/**
 * `lib/scans/execute.ts` — the scan completion invocation (task 1.8).
 *
 * ## Claims tested
 *
 * 1. **Happy path** — a successful invocation writes every outcome column onto
 *    the scan row with `status = 'complete'` and `completed_at` set.
 * 2. **Failure path** — an invocation that errors writes `status = 'failed'`
 *    with an `error_code` and a scrubbed `error_message`, never leaving the row
 *    stuck in `running`.
 * 3. **Scan gate** — a completed scan with `resourceCount > 0` flips `scanGate`
 *    to `ready` so `mayContinue` returns true (the Continue button appears).
 */

// --- Mocks ------------------------------------------------------------------

const { db, agentcore } = vi.hoisted(() => ({
  db: {
    updates: [] as Array<{ id: string; set: Record<string, unknown> }>,
    // A record, not `unknown`: the tests below build a failure row with
    // `{ ...db.lastReturning, status: "failed" }`, and spreading an `unknown` is a
    // type error (TS2698). This was latent when the file landed.
    lastReturning: {} as Record<string, unknown>,
  },
  agentcore: {
    shouldThrow: undefined as unknown,
    frames: [] as string[],
  },
}))

// Mock drizzle
vi.mock("@/lib/db", () => {
  // Return a chainable query builder mock
  const mockReturning = () => {
    const row = db.lastReturning
    return [row]
  }
  const mockWhere = (condition: unknown) => ({
    returning: mockReturning,
  })
  const mockSet = (set: Record<string, unknown>) => {
    // Record all updates for assertion
    db.updates.push({ id: "scan-test-id", set })
    return { where: mockWhere }
  }
  const mockUpdate = (table: unknown) => ({ set: mockSet })

  return {
    getDb: () => ({ update: mockUpdate }),
  }
})

vi.mock("@/lib/db/schema", () => ({
  subscriptionScans: { id: "id_column" },
}))

vi.mock("@/lib/db/views", () => ({
  toScanView: (row: unknown) => row as ScanView,
}))

vi.mock("@/lib/session-id", () => ({
  newSessionId: () => "session-test-123",
}))

vi.mock("@/lib/aws/agentcore", () => ({
  COMMAND_LIST_INVENTORY: "list_inventory",
  DEFAULT_TIMEZONE: "Asia/Jakarta",
  MissingRuntimeConfigError: class extends Error {
    variableName = "RPT_RUNTIME_ARN"
    constructor() {
      super("not configured")
      this.name = "MissingRuntimeConfigError"
    }
  },
  invokeAgentRuntime: async () => {
    if (agentcore.shouldThrow !== undefined) throw agentcore.shouldThrow
    // Return an async iterable from `agentcore.frames`
    const encoder = new TextEncoder()
    const chunks = agentcore.frames.map((f) => encoder.encode(f))
    let i = 0
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (i < chunks.length) return { done: false, value: chunks[i++] }
            return { done: true, value: undefined }
          },
          return: async () => ({ done: true, value: undefined }),
        }
      },
    }
  },
}))

// The module uses agent-stream helpers. Let those work with real implementations.
// We just need them to not throw. They are pure utility functions so we import them
// from the real module.

import { executeScan, type ExecuteScanRequest } from "@/lib/scans/execute"

// --- Fixtures ---------------------------------------------------------------

const CREDENTIALS = {
  subscriptionId: "sub-guid-001",
  tenantId: "tenant-001",
  clientId: "client-001",
  clientSecret: "secret-001",
  fidelityTier: "baseline" as const,
  logAnalyticsWorkspaceId: null,
}

const REQUEST: ExecuteScanRequest = {
  scanId: "scan-test-id",
  actorId: "user-01",
  displayName: "Test Subscription",
  credentials: CREDENTIALS,
}

function makeDoneFrame(outcome: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ type: "done", status: "success", ...outcome })}\n\n`
}

function makeErrorFrame(code: string, message: string): string {
  return `data: ${JSON.stringify({ type: "error", code, message })}\n\n`
}

// --- Tests ------------------------------------------------------------------

beforeEach(() => {
  db.updates = []
  db.lastReturning = {
    id: "scan-test-id",
    connectedSubscriptionId: "sub-guid-001",
    status: "complete",
    resourceCount: 42,
    typeCounts: { "Microsoft.Compute/virtualMachines": 10 },
    childTypeCounts: {},
    regionCounts: { eastus: 30, westus2: 12 },
    resourceGroups: { values: ["rg-prod"], truncated: false },
    regions: { values: ["eastus", "westus2"], truncated: false },
    regionProbes: [{ region: "eastus", status_code: 200, verdict: "reachable", probed_at: "2026-08-01T00:00:00Z" }],
    truncated: false,
    catalogVersion: null,
    sectionsCatalogueVersion: null,
    errorCode: null,
    errorMessage: null,
    completedAt: new Date("2026-08-01T01:00:00Z"),
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T01:00:00Z"),
  }
  agentcore.shouldThrow = undefined
  agentcore.frames = [
    makeDoneFrame({
      resource_count: 42,
      type_counts: { "Microsoft.Compute/virtualMachines": 10 },
      child_type_counts: {},
      region_counts: { eastus: 30, westus2: 12 },
      resource_groups: { values: ["rg-prod"], truncated: false },
      regions: { values: ["eastus", "westus2"], truncated: false },
      resource_types: { values: ["Microsoft.Compute/virtualMachines"], truncated: false },
      tag_keys: { values: ["env"], truncated: false },
      tag_values: { values: ["prod"], truncated: false },
      region_probes: [
        { region: "eastus", status_code: 200, verdict: "reachable", probed_at: "2026-08-01T00:00:00Z" },
      ],
    }),
  ]
})

describe("executeScan — happy path", () => {
  test("writes every outcome column with status='complete' and completed_at set", async () => {
    await executeScan(REQUEST)

    // First update: queued -> running
    expect(db.updates[0].set).toMatchObject({ status: "running" })

    // Second update: the outcome write
    const outcome = db.updates[1].set
    expect(outcome.status).toBe("complete")
    expect(outcome.resourceCount).toBe(42)
    expect(outcome.typeCounts).toEqual({ "Microsoft.Compute/virtualMachines": 10 })
    expect(outcome.childTypeCounts).toEqual({})
    expect(outcome.regionCounts).toEqual({ eastus: 30, westus2: 12 })
    expect(outcome.resourceGroups).toEqual({ values: ["rg-prod"], truncated: false })
    expect(outcome.regions).toEqual({ values: ["eastus", "westus2"], truncated: false })
    expect(outcome.regionProbes).toEqual([
      { region: "eastus", status_code: 200, verdict: "reachable", probed_at: "2026-08-01T00:00:00Z" },
    ])
    expect(outcome.truncated).toBe(false)
    expect(outcome.completedAt).toBeInstanceOf(Date)
    expect(outcome.errorCode).toBeNull()
    expect(outcome.errorMessage).toBeNull()
  })
})

describe("executeScan — failure path", () => {
  test("a terminal error writes status='failed' with error_code and never leaves running", async () => {
    agentcore.frames = [
      makeErrorFrame("AUTH_FAILED", "The credential was rejected"),
      makeDoneFrame({}),
    ]
    db.lastReturning = {
      ...db.lastReturning,
      status: "failed",
      errorCode: "AUTH_FAILED",
      errorMessage: "The credential was rejected",
    }

    await executeScan(REQUEST)

    // First update: queued -> running
    expect(db.updates[0].set).toMatchObject({ status: "running" })
    // Second: the failure write
    const failed = db.updates[1].set
    expect(failed.status).toBe("failed")
    expect(failed.errorCode).toBe("AUTH_FAILED")
    expect(typeof failed.errorMessage).toBe("string")
    expect((failed.errorMessage as string).length).toBeGreaterThan(0)
    // Never left running
    expect(failed.status).not.toBe("running")
  })

  test("an invocation throw writes status='failed' (never stuck in running)", async () => {
    agentcore.shouldThrow = new Error("network unreachable")
    db.lastReturning = {
      ...db.lastReturning,
      status: "failed",
      errorCode: "INTERNAL_ERROR",
    }

    await executeScan(REQUEST)

    expect(db.updates[0].set).toMatchObject({ status: "running" })
    const failed = db.updates[1].set
    expect(failed.status).toBe("failed")
    expect(failed.errorCode).toBe("INTERNAL_ERROR")
    expect(typeof failed.errorMessage).toBe("string")
  })

  test("a thrown SDK error cannot leak a credential into the stored message", async () => {
    // The assertion the test above cannot make. `typeof errorMessage === "string"` passes
    // whether or not the string contains a client secret, so it would stay green if
    // `scrubErrorMessage` were "improved" to include `thrown.message`.
    //
    // An Azure SDK error legitimately embeds request context, and this row is stored AND
    // returned to the browser. So the scrubber deliberately keeps only `thrown.name` for an
    // error it did not construct itself, and this is what holds it to that.
    agentcore.shouldThrow = new Error(
      `AADSTS7000215: Invalid client secret provided. secret=${CREDENTIALS.clientSecret} ` +
        `client_id=${CREDENTIALS.clientId} tenant=${CREDENTIALS.tenantId}`
    )
    db.lastReturning = { ...db.lastReturning, status: "failed", errorCode: "INTERNAL_ERROR" }

    await executeScan(REQUEST)

    const stored = String(db.updates[1].set.errorMessage)
    for (const secret of [
      CREDENTIALS.clientSecret,
      CREDENTIALS.clientId,
      CREDENTIALS.tenantId,
    ]) {
      expect(stored).not.toContain(secret)
    }
    expect(stored).not.toContain("AADSTS7000215")
    expect(stored).toContain("Error")
  })
})

describe("scanGate — the whole point of task 1.8", () => {
  test("a completed scan with resourceCount > 0 flips to ready, Continue appears", () => {
    const gate = scanGate({
      status: "complete",
      resourceCount: 42,
      errorCode: null,
    })
    expect(gate).toEqual({ kind: "ready" })
    expect(mayContinue(gate)).toBe(true)
  })

  test("a scan stuck in running does NOT flip to ready", () => {
    const gate = scanGate({
      status: "running",
      resourceCount: null,
      errorCode: null,
    })
    expect(gate).toEqual({ kind: "running" })
    expect(mayContinue(gate)).toBe(false)
  })

  test("a failed scan does NOT flip to ready", () => {
    const gate = scanGate({
      status: "failed",
      resourceCount: null,
      errorCode: "AUTH_FAILED",
    })
    expect(gate).toEqual({ kind: "failed", code: "AUTH_FAILED" })
    expect(mayContinue(gate)).toBe(false)
  })

  test("a completed scan with zero resources returns empty (no Continue)", () => {
    const gate = scanGate({
      status: "complete",
      resourceCount: 0,
      errorCode: null,
    })
    expect(gate).toEqual({ kind: "empty" })
    expect(mayContinue(gate)).toBe(false)
  })
})
