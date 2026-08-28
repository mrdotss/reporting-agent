import { describe, expect, test } from "vitest"

import {
  validateMetricSelectionAgainstCatalog,
  type TemplateDefinition,
} from "@/lib/templates/definition"
import { METRIC_CATALOG } from "@/lib/templates/catalog"

/**
 * `validateMetricSelectionAgainstCatalog` at schema_version 3.
 *
 * It read `Object.entries(definition.metrics)` unconditionally. A v3 definition
 * has no top-level `metrics` key at all, so every v3 publish threw
 * `TypeError: Cannot convert undefined or null to object` — surfacing as a bare
 * 500 ("The request could not be completed.") and making a v3 report profile
 * impossible to save.
 *
 * The shape pass that runs immediately before it is what made the read look
 * safe: it validates a v3 definition successfully, and `metrics` is legitimately
 * absent from what it approves.
 */

const VM = "Microsoft.Compute/virtualMachines"

function v3(sections: readonly Record<string, unknown>[]): TemplateDefinition {
  return {
    schema_version: 3,
    provider: "azure",
    identity: { name: "Enesis", language: "en" },
    sections,
    period: { kind: "last_full_month" },
    design: { preset: "editorial" },
    front_matter: { cover: {}, document_control: {}, toc: {} },
  } as unknown as TemplateDefinition
}

/** The resolver `lib/actions/templates.ts` supplies from the section catalogue. */
const resolveVm = (sectionType: string) =>
  sectionType === "vm_utilization" ? [VM] : []

describe("v3 definitions no longer throw", () => {
  test("a v3 definition with no top-level metrics key validates without throwing", () => {
    // The regression, stated directly. This threw before the fix.
    expect(() =>
      validateMetricSelectionAgainstCatalog(
        v3([{ id: "s1", type: "azure_subscription" }]),
        METRIC_CATALOG,
        resolveVm
      )
    ).not.toThrow()
  })

  test("a v3 definition whose sections carry no metrics yields no issues", () => {
    // The user's own profile: 13 sections, 0 metric entries.
    expect(
      validateMetricSelectionAgainstCatalog(
        v3([
          { id: "s1", type: "azure_subscription" },
          { id: "s2", type: "resource_groups" },
        ]),
        METRIC_CATALOG,
        resolveVm
      )
    ).toStrictEqual([])
  })

  test("an empty sections array is fine", () => {
    expect(
      validateMetricSelectionAgainstCatalog(v3([]), METRIC_CATALOG, resolveVm)
    ).toStrictEqual([])
  })
})

describe("v3 section metrics are still really validated", () => {
  test("a bogus metric on a section IS reported, pathed to that section", () => {
    // The fix must not become "skip validation at v3" — that would trade a crash
    // for a definition the compiler later refuses.
    const issues = validateMetricSelectionAgainstCatalog(
      v3([
        {
          id: "s1",
          type: "vm_utilization",
          metrics: [{ metric: "Not A Real Metric", statistic: "avg" }],
        },
      ]),
      METRIC_CATALOG,
      resolveVm
    )

    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]!.path.slice(0, 3)).toStrictEqual([
      "sections",
      0,
      "metrics",
    ])
    expect(issues[0]!.message).toMatch(/Not A Real Metric/)
  })

  test("resource types come from the section's own selection when it narrows", () => {
    // A section narrowing to a type the catalogue has no entries for must be
    // reported against that type, not against the catalogue's default.
    const issues = validateMetricSelectionAgainstCatalog(
      v3([
        {
          id: "s1",
          type: "vm_utilization",
          selection: { resource_types: ["Microsoft.Nonexistent/things"] },
          metrics: [{ metric: "Percentage CPU", statistic: "avg" }],
        },
      ]),
      METRIC_CATALOG,
      resolveVm
    )

    expect(
      issues.some((i) => /Microsoft\.Nonexistent\/things/.test(i.message))
    ).toBe(true)
  })

  test("without a resolver, a non-narrowing section yields no site rather than a wrong one", () => {
    // Fabricating a resource-type key to check against would report a mismatch
    // that describes this function rather than the profile.
    expect(
      validateMetricSelectionAgainstCatalog(
        v3([
          {
            id: "s1",
            type: "vm_utilization",
            metrics: [{ metric: "Not A Real Metric", statistic: "avg" }],
          },
        ]),
        METRIC_CATALOG
        // no resolver
      )
    ).toStrictEqual([])
  })
})

describe("v1/v2 definitions are unaffected", () => {
  test("a top-level metrics object is still read and still validated", () => {
    const legacy = {
      schema_version: 2,
      identity: { name: "Legacy", language: "en" },
      scope: { resource_types: [VM] },
      metrics: { [VM]: [{ metric: "Not A Real Metric", statistic: "avg" }] },
      blocks: [],
      period: { kind: "last_full_month" },
      design: { preset: "editorial" },
    } as unknown as TemplateDefinition

    const issues = validateMetricSelectionAgainstCatalog(legacy, METRIC_CATALOG)

    expect(issues.length).toBeGreaterThan(0)
    // Still pathed under the top-level key, not under sections.
    expect(issues[0]!.path[0]).toBe("metrics")
  })

  test("a valid v1/v2 selection still passes", () => {
    const legacy = {
      schema_version: 2,
      identity: { name: "Legacy", language: "en" },
      scope: { resource_types: [VM] },
      metrics: { [VM]: [{ metric: "Percentage CPU", statistic: "avg" }] },
      blocks: [],
      period: { kind: "last_full_month" },
      design: { preset: "editorial" },
    } as unknown as TemplateDefinition

    expect(
      validateMetricSelectionAgainstCatalog(legacy, METRIC_CATALOG)
    ).toStrictEqual([])
  })
})
