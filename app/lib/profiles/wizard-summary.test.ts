import { describe, expect, test } from "vitest"

import {
  designPreset,
  metricItemCount,
  scopedResourceTypeCount,
} from "./wizard"

/**
 * The three summary helpers behind step 5's stats grid.
 *
 * They exist because `StepPreview` read `definition.scope.resource_types`,
 * `definition.metrics` and `definition.design.preset` directly — all three absent
 * on a v3 definition — and threw `Cannot read properties of undefined (reading
 * 'resource_types')` during SSR, taking the whole wizard page down at step 5.
 */

const VM = "Microsoft.Compute/virtualMachines"
const SA = "Microsoft.Storage/storageAccounts"

describe("scopedResourceTypeCount", () => {
  test("reads a v1/v2 definition's single top-level scope", () => {
    expect(
      scopedResourceTypeCount({ scope: { resource_types: [VM, SA] } })
    ).toBe(2)
  })

  test("reads a v3 definition's per-section selections", () => {
    expect(
      scopedResourceTypeCount({
        schema_version: 3,
        sections: [
          {
            id: "a",
            type: "vm_utilization",
            selection: { resource_types: [VM] },
          },
          {
            id: "b",
            type: "storage",
            selection: { resource_types: [SA] },
          },
        ],
      })
    ).toBe(2)
  })

  test("UNIONS across sections rather than summing them", () => {
    // Two sections scoped to the same type narrow the run to one type: the
    // collector fetches the union once. Summing would claim a breadth the run
    // does not have.
    expect(
      scopedResourceTypeCount({
        schema_version: 3,
        sections: [
          {
            id: "a",
            type: "vm_utilization",
            selection: { resource_types: [VM] },
          },
          {
            id: "b",
            type: "vm_inventory",
            selection: { resource_types: [VM] },
          },
        ],
      })
    ).toBe(1)
  })

  test("a v3 section with no selection contributes nothing", () => {
    expect(
      scopedResourceTypeCount({
        schema_version: 3,
        sections: [{ id: "a", type: "azure_subscription" }],
      })
    ).toBe(0)
  })

  test("does not throw on a v3 definition with no scope key at all", () => {
    // The actual crash, in reverse: this exact shape is what the wizard holds.
    expect(() =>
      scopedResourceTypeCount({ schema_version: 3, sections: [] })
    ).not.toThrow()
    expect(scopedResourceTypeCount({ schema_version: 3, sections: [] })).toBe(0)
  })

  test("does not throw on junk", () => {
    expect(scopedResourceTypeCount(undefined)).toBe(0)
    expect(scopedResourceTypeCount(null)).toBe(0)
    expect(scopedResourceTypeCount("nope")).toBe(0)
    expect(scopedResourceTypeCount({ scope: null })).toBe(0)
    expect(scopedResourceTypeCount({ sections: "nope" })).toBe(0)
    expect(
      scopedResourceTypeCount({
        sections: [{ selection: { resource_types: 7 } }],
      })
    ).toBe(0)
  })
})

describe("metricItemCount", () => {
  test("sums a v1/v2 definition's metrics object", () => {
    expect(
      metricItemCount({
        metrics: {
          [VM]: [{ metric: "Percentage CPU" }, { metric: "x" }],
          [SA]: [],
        },
      })
    ).toBe(2)
  })

  test("sums a v3 definition's per-section metric arrays", () => {
    expect(
      metricItemCount({
        schema_version: 3,
        sections: [
          {
            id: "a",
            type: "vm_utilization",
            metrics: [{ metric: "Percentage CPU" }],
          },
          {
            id: "b",
            type: "db_utilization",
            metrics: [{ metric: "cpu_percent" }, { metric: "dtu" }],
          },
        ],
      })
    ).toBe(3)
  })

  test("SUMS rather than de-duplicates -- one metric twice is two figures", () => {
    expect(
      metricItemCount({
        schema_version: 3,
        sections: [
          {
            id: "a",
            type: "vm_utilization",
            metrics: [{ metric: "Percentage CPU" }],
          },
          {
            id: "b",
            type: "vm_inventory",
            metrics: [{ metric: "Percentage CPU" }],
          },
        ],
      })
    ).toBe(2)
  })

  test("does not throw on a v3 definition with no metrics key at all", () => {
    expect(
      metricItemCount({ schema_version: 3, sections: [{ id: "a", type: "t" }] })
    ).toBe(0)
    expect(metricItemCount(undefined)).toBe(0)
    expect(metricItemCount({ metrics: null })).toBe(0)
  })
})

describe("designPreset", () => {
  test("reads the preset when present", () => {
    expect(designPreset({ design: { preset: "corporate" } })).toBe("corporate")
  })

  test("returns null rather than throwing when design is absent", () => {
    expect(designPreset({ schema_version: 3 })).toBeNull()
    expect(designPreset({ design: null })).toBeNull()
    expect(designPreset({ design: { preset: 7 } })).toBeNull()
    expect(designPreset(undefined)).toBeNull()
  })
})
