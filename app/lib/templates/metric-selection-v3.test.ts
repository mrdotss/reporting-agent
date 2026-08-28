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

describe("a v3 section spanning types with different metric names", () => {
  // `database_utilization` really spans Sql/servers/databases,
  // Sql/managedInstances and DBforPostgreSQL/flexibleServers, and the first and
  // third declare `cpu_percent` while managedInstances calls the same thing
  // `avg_cpu_percent`. The section holds ONE flat metrics[] applied to all of
  // them, so requiring every type to declare every item would make that section —
  // and the preset the agent's own catalogue loader accepts — impossible to
  // publish.
  //
  // At-least-one is the rule both other halves already use: the loader breaks out
  // of its type loop on the first declaring type, and
  // `_requested_metric_union_v3` fans the names across all types at collection
  // time so a type that does not emit one records a `metric_not_emitted` gap
  // rather than failing the run.
  const DATABASES = "Microsoft.Sql/servers/databases"
  const MANAGED_INSTANCES = "Microsoft.Sql/managedInstances"

  function sectionWith(resourceTypes: readonly string[]) {
    return {
      schema_version: 3,
      sections: [
        {
          id: "s1",
          type: "database_utilization",
          selection: {
            resource_types: [...resourceTypes],
            resource_groups: [],
            tag_filters: [],
            top_n: null,
            sort: null,
          },
          // `max`, not `avg`: none of these SQL metrics declares an aggregation
          // that yields an average (they are `['Minimum','Maximum']`), so `avg`
          // would fail for a reason unrelated to the union rule under test.
          metrics: [{ metric: "cpu_percent", statistic: "max" }],
        },
      ],
    } as unknown as TemplateDefinition
  }

  test("a metric declared by only ONE of the section's types is accepted", () => {
    // managedInstances does NOT declare cpu_percent; databases does. Per-type
    // strictness reports an issue here, and that is the regression this pins.
    expect(
      validateMetricSelectionAgainstCatalog(
        sectionWith([MANAGED_INSTANCES, DATABASES]),
        METRIC_CATALOG
      )
    ).toStrictEqual([])
  })

  test("order does not decide it -- the declaring type may come first or last", () => {
    expect(
      validateMetricSelectionAgainstCatalog(
        sectionWith([DATABASES, MANAGED_INSTANCES]),
        METRIC_CATALOG
      )
    ).toStrictEqual([])
  })

  test("a metric NO type declares is still reported, naming every type", () => {
    // The union must not become "accept anything": at-least-one still means one.
    const issues = validateMetricSelectionAgainstCatalog(
      {
        schema_version: 3,
        sections: [
          {
            id: "s1",
            type: "database_utilization",
            selection: {
              resource_types: [MANAGED_INSTANCES, DATABASES],
              resource_groups: [],
              tag_filters: [],
              top_n: null,
              sort: null,
            },
            metrics: [{ metric: "Not A Real Metric", statistic: "avg" }],
          },
        ],
      } as unknown as TemplateDefinition,
      METRIC_CATALOG
    )

    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]!.message).toContain(MANAGED_INSTANCES)
    expect(issues[0]!.message).toContain(DATABASES)
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
