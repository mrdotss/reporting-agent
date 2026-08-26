import { describe, expect, test } from "vitest"

import type { SubscriptionScan } from "@/lib/db/schema"
import { toScanView } from "@/lib/db/views"

/**
 * Projection guard for `ScanView` (Requirement 22.7).
 *
 * Asserts that no secret and no presigned URL can survive the projection —
 * the repo's convention is that this guard lands with the table, not after.
 */

const FAKE_SCAN: SubscriptionScan = {
  id: "scan-001",
  userId: "user-secret-id",
  connectedSubscriptionId: "sub-001",
  status: "complete",
  catalogVersion: "1.0.0",
  sectionsCatalogueVersion: "1.0.0",
  resourceCount: 42,
  typeCounts: { "Microsoft.Compute/virtualMachines": 10 },
  childTypeCounts: { "Microsoft.Network/virtualNetworks/subnets": 5 },
  resourceGroups: ["rg-prod", "rg-dev"],
  regions: ["eastus", "westus2"],
  regionCounts: { eastus: 30, westus2: 12 },
  regionProbes: [
    { region: "eastus", status_code: 200, verdict: "ok", probed_at: "2026-08-01T00:00:00Z" },
  ],
  truncated: false,
  errorCode: null,
  errorMessage: null,
  completedAt: new Date("2026-08-01T01:00:00Z"),
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T01:00:00Z"),
}

describe("ScanView projection guard", () => {
  test("the exact key set — user_id is dropped", () => {
    const view = toScanView(FAKE_SCAN)

    expect(Object.keys(view).sort()).toEqual([
      "catalogVersion",
      "childTypeCounts",
      "completedAt",
      "connectedSubscriptionId",
      "createdAt",
      "errorCode",
      "errorMessage",
      "id",
      "regionCounts",
      "regionProbes",
      "regions",
      "resourceCount",
      "resourceGroups",
      "sectionsCatalogueVersion",
      "status",
      "truncated",
      "typeCounts",
      "updatedAt",
    ])
  })

  test("no secret survives the projection", () => {
    const view = toScanView(FAKE_SCAN)
    const serialized = JSON.stringify(view)

    // user_id must not appear anywhere in the serialized output
    expect(serialized).not.toContain(FAKE_SCAN.userId)
    // No presigned URL pattern
    expect(serialized).not.toMatch(/X-Amz-Signature/)
    expect(serialized).not.toMatch(/X-Amz-Credential/)
  })

  test("user_id is not a key of the returned object", () => {
    const view = toScanView(FAKE_SCAN)
    expect("userId" in view).toBe(false)
    expect("user_id" in view).toBe(false)
  })

  test("timestamps are ISO 8601 strings", () => {
    const view = toScanView(FAKE_SCAN)
    expect(view.createdAt).toBe("2026-08-01T00:00:00.000Z")
    expect(view.updatedAt).toBe("2026-08-01T01:00:00.000Z")
    expect(view.completedAt).toBe("2026-08-01T01:00:00.000Z")
  })

  test("null completedAt stays null", () => {
    const view = toScanView({ ...FAKE_SCAN, completedAt: null })
    expect(view.completedAt).toBeNull()
  })
})
