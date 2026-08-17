import { describe, expect, test } from "vitest"

import {
  collectDefinitionIssues,
  looksLikeAzureIdentifier,
  templateDefinitionForRunSchema,
  templateDefinitionSchema,
  validateMetricSelectionAgainstCatalog,
  type MetricCatalogSnapshot,
  type TemplateDefinition,
} from "@/lib/templates/definition"

/**
 * `lib/templates/definition.ts` — the `Template_Validator` (Requirements
 * cited in the module docstring).
 *
 * These are focused, example-based checks confirming this module's own
 * implementation behaves as designed — the exhaustive property test over
 * randomly injected multi-defect definitions is task 3.3
 * (`fast-check`), not this file.
 */

// --- A minimal, valid definition fixture ------------------------------------

function validDefinition(): TemplateDefinition {
  return {
    schema_version: 1,
    identity: { name: "Monthly utilization", description: "", report_title: "Monthly report" },
    scope: {
      resource_types: ["Microsoft.Compute/virtualMachines"],
      tag_filters: [],
      resource_groups: [],
      top_n: null,
      sort: null,
    },
    period: { kind: "last_full_month" },
    metrics: {
      "Microsoft.Compute/virtualMachines": [{ metric: "Percentage CPU", statistic: "avg" }],
    },
    blocks: [
      { id: "heading-1", type: "heading", config: { level: 1, text: "Report" } },
      { id: "rich-1", type: "rich_text", config: { text: "Static prose." } },
    ],
    design: {
      preset: "editorial",
      accent_color: "#1f6f78",
      density: "normal",
      table_style: "hairline",
      number_format: { decimal_places: 2, group_thousands: true },
      cover_page: true,
      logo: null,
      page_size: "A4",
    },
  }
}

function pathsOf(issues: readonly { readonly path: readonly (string | number)[] }[]): string[] {
  return issues.map((issue) => issue.path.join("."))
}

// --- A valid definition parses -----------------------------------------

describe("a well-formed definition", () => {
  test("passes with zero issues", () => {
    expect(collectDefinitionIssues(validDefinition())).toEqual([])
  })

  test("parses through the zod schema", () => {
    const result = templateDefinitionSchema.safeParse(validDefinition())
    expect(result.success).toBe(true)
  })
})

// --- Requirement 2.1 — seven required top-level keys ------------------------

describe("Requirement 2.1 — the seven required top-level keys", () => {
  test("a missing key is named", () => {
    const definition = validDefinition() as unknown as Record<string, unknown>
    delete definition.design

    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain("design")
  })

  test("every missing key is reported in one pass", () => {
    const issues = collectDefinitionIssues({})
    const paths = pathsOf(issues)
    for (const key of ["schema_version", "identity", "scope", "period", "metrics", "blocks", "design"]) {
      expect(paths).toContain(key)
    }
  })

  test("an undeclared top-level key is rejected by name, not stripped", () => {
    const definition = { ...validDefinition(), unexpected_field: true }
    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain("unexpected_field")
  })
})

// --- Requirement 2.2 — type mismatch rejected, never coerced ----------------

describe("Requirement 2.2 — a type mismatch is rejected rather than coerced", () => {
  test("schema_version as a string is rejected", () => {
    const definition = { ...validDefinition(), schema_version: "1" }
    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain("schema_version")
  })

  test("cover_page as a string is rejected", () => {
    const definition = validDefinition()
    const design = { ...definition.design, cover_page: "true" }
    const issues = collectDefinitionIssues({ ...definition, design })
    expect(pathsOf(issues)).toContain("design.cover_page")
  })
})

// --- Requirement 2.9 — schema_version bounds, no default --------------------

describe("Requirement 2.9 — schema_version bounds", () => {
  test.each([0, -1, 99, 1.5])("%s is rejected", (value) => {
    const definition = { ...validDefinition(), schema_version: value }
    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain("schema_version")
  })

  test("1 is accepted", () => {
    expect(collectDefinitionIssues(validDefinition())).toEqual([])
  })

  test("an absent schema_version applies no default", () => {
    const definition = validDefinition() as unknown as Record<string, unknown>
    delete definition.schema_version
    const issues = collectDefinitionIssues(definition)
    expect(pathsOf(issues)).toContain("schema_version")
  })
})

// --- Requirement 2.10 — bounds ------------------------------------------

describe("Requirement 2.10 — name, description and canonical byte-size bounds", () => {
  test("name of 0 characters is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      identity: { ...definition.identity, name: "" },
    })
    expect(pathsOf(issues)).toContain("identity.name")
  })

  test("name of 121 characters is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      identity: { ...definition.identity, name: "a".repeat(121) },
    })
    expect(pathsOf(issues)).toContain("identity.name")
  })

  test("name of 120 characters is accepted", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      identity: { ...definition.identity, name: "a".repeat(120) },
    })
    expect(issues).toEqual([])
  })

  test("description of 1001 characters is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      identity: { ...definition.identity, description: "a".repeat(1001) },
    })
    expect(pathsOf(issues)).toContain("identity.description")
  })

  test("a definition over the canonical byte bound is rejected", () => {
    const definition = validDefinition()
    const oversized = {
      ...definition,
      identity: { ...definition.identity, description: "x".repeat(300_000) },
    }
    const issues = collectDefinitionIssues(oversized)
    expect(issues.some((issue) => issue.message.includes("canonical form"))).toBe(true)
  })
})

// --- Requirement 3.1 — scope bounds --------------------------------------

describe("Requirement 3.1 — scope bounds", () => {
  test("21 resource types is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      scope: {
        ...definition.scope,
        resource_types: Array.from({ length: 21 }, (_, i) => `Microsoft.Compute/type${i}`),
      },
    })
    expect(pathsOf(issues)).toContain("scope.resource_types")
  })

  test("11 tag filters is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      scope: {
        ...definition.scope,
        tag_filters: Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, value: "v" })),
      },
    })
    expect(pathsOf(issues)).toContain("scope.tag_filters")
  })

  test("51 resource groups is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      scope: {
        ...definition.scope,
        resource_groups: Array.from({ length: 51 }, (_, i) => `rg-${i}`),
      },
    })
    expect(pathsOf(issues)).toContain("scope.resource_groups")
  })

  test("top_n count of 0 is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      scope: {
        ...definition.scope,
        top_n: { count: 0, metric: "Percentage CPU", statistic: "avg" },
      },
    })
    expect(pathsOf(issues)).toContain("scope.top_n.count")
  })

  test("top_n count of 501 is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      scope: {
        ...definition.scope,
        top_n: { count: 501, metric: "Percentage CPU", statistic: "avg" },
      },
    })
    expect(pathsOf(issues)).toContain("scope.top_n.count")
  })

  test("top_n without a metric is rejected (Requirement 3.10)", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      scope: { ...definition.scope, top_n: { count: 10, statistic: "avg" } },
    })
    expect(pathsOf(issues)).toContain("scope.top_n.metric")
  })

  test("top_n without a statistic is rejected (Requirement 3.10)", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      scope: { ...definition.scope, top_n: { count: 10, metric: "Percentage CPU" } },
    })
    expect(pathsOf(issues)).toContain("scope.top_n.statistic")
  })

  test("a sort direction outside the two values is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      scope: { ...definition.scope, sort: "up" },
    })
    expect(pathsOf(issues)).toContain("scope.sort")
  })
})

// --- Requirement 3.2 — scope_override on any block ---------------------

describe("Requirement 3.2 — scope_override", () => {
  test("a valid scope_override on a leaf block is accepted", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [
        {
          id: "top-1",
          type: "top_n_table",
          config: { columns: ["id"], order_by: "cpu" },
          scope_override: {
            resource_types: ["Microsoft.Compute/virtualMachines"],
            tag_filters: [],
            resource_groups: [],
            top_n: { count: 10, metric: "Percentage CPU", statistic: "avg" },
            sort: "descending",
          },
        },
      ],
    })
    expect(issues).toEqual([])
  })

  test("an invalid field inside scope_override is named at its nested path", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [
        {
          id: "top-1",
          type: "top_n_table",
          config: { columns: ["id"], order_by: "cpu" },
          scope_override: {
            resource_types: [],
            tag_filters: [],
            resource_groups: [],
            top_n: null,
            sort: "sideways",
          },
        },
      ],
    })
    expect(pathsOf(issues)).toContain("blocks.0.scope_override.sort")
  })
})

// --- Requirement 1.3 — Azure identifiers rejected in scope fields -----------

describe("Requirement 1.3 — resource id / subscription id / tenant id rejected in scope fields", () => {
  test("looksLikeAzureIdentifier detects a fully qualified resource id", () => {
    expect(
      looksLikeAzureIdentifier(
        "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg1/providers/" +
          "Microsoft.Compute/virtualMachines/vm1"
      )
    ).toBe(true)
  })

  test("looksLikeAzureIdentifier detects a bare GUID (subscription or tenant id)", () => {
    expect(looksLikeAzureIdentifier("11111111-1111-1111-1111-111111111111")).toBe(true)
  })

  test("looksLikeAzureIdentifier accepts an ordinary resource type name", () => {
    expect(looksLikeAzureIdentifier("Microsoft.Compute/virtualMachines")).toBe(false)
  })

  test("a resource id in scope.resource_types is named by its exact path", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      scope: {
        ...definition.scope,
        resource_types: [
          "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg1/providers/" +
            "Microsoft.Compute/virtualMachines/vm1",
        ],
      },
    })
    expect(pathsOf(issues)).toContain("scope.resource_types.0")
  })

  test("a subscription id in scope.resource_groups is named by its exact path", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      scope: {
        ...definition.scope,
        resource_groups: ["11111111-1111-1111-1111-111111111111"],
      },
    })
    expect(pathsOf(issues)).toContain("scope.resource_groups.0")
  })

  test("a tenant id in a tag filter value is named by its exact path", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      scope: {
        ...definition.scope,
        tag_filters: [{ key: "env", value: "22222222-2222-2222-2222-222222222222" }],
      },
    })
    expect(pathsOf(issues)).toContain("scope.tag_filters.0.value")
  })

  test("a resource id inside a block's scope_override is named at its nested path", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [
        {
          id: "top-1",
          type: "top_n_table",
          config: { columns: ["id"], order_by: "cpu" },
          scope_override: {
            resource_types: [],
            tag_filters: [],
            resource_groups: ["33333333-3333-3333-3333-333333333333"],
            top_n: null,
            sort: null,
          },
        },
      ],
    })
    expect(pathsOf(issues)).toContain("blocks.0.scope_override.resource_groups.0")
  })

  test("the rejection states that a scope is expressed as types/filters/groups, not resources", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      scope: { ...definition.scope, resource_groups: ["11111111-1111-1111-1111-111111111111"] },
    })
    expect(issues[0]?.message).toMatch(/resource types, tag filters and resource groups/)
  })
})

// --- Requirement 4.1, 4.2 — period ---------------------------------------

describe("Requirement 4.1 — the six case-sensitive period values", () => {
  test.each([
    "last_24h",
    "last_7d",
    "last_30d",
    "last_full_month",
    "mtd",
  ])("%s is accepted with no start/end", (kind) => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({ ...definition, period: { kind } })
    expect(issues).toEqual([])
  })

  test("an unrecognized value is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({ ...definition, period: { kind: "last_month" } })
    expect(pathsOf(issues)).toContain("period.kind")
  })

  test("case sensitivity: LAST_24H is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({ ...definition, period: { kind: "LAST_24H" } })
    expect(pathsOf(issues)).toContain("period.kind")
  })

  test("a non-custom kind carrying start/end is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      period: { kind: "last_24h", start: "2024-01-01", end: "2024-01-02" },
    })
    expect(pathsOf(issues)).toContain("period.start")
    expect(pathsOf(issues)).toContain("period.end")
  })
})

describe("Requirement 4.2 — custom period validity", () => {
  test("a valid custom range is accepted", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      period: { kind: "custom", start: "2024-07-01", end: "2024-07-31" },
    })
    expect(issues).toEqual([])
  })

  test("an invalid calendar date is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      period: { kind: "custom", start: "2024-02-31", end: "2024-03-01" },
    })
    expect(pathsOf(issues)).toContain("period.start")
  })

  test("start after end is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      period: { kind: "custom", start: "2024-07-31", end: "2024-07-01" },
    })
    expect(pathsOf(issues)).toContain("period")
  })

  test("a span of 32 local days is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      period: { kind: "custom", start: "2024-01-01", end: "2024-02-01" },
    })
    expect(pathsOf(issues)).toContain("period")
  })

  test("a span of exactly 31 local days is accepted", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      period: { kind: "custom", start: "2024-01-01", end: "2024-01-31" },
    })
    expect(issues).toEqual([])
  })

  test("a span of exactly 1 local day is accepted", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      period: { kind: "custom", start: "2024-01-01", end: "2024-01-01" },
    })
    expect(issues).toEqual([])
  })
})

// --- Requirement 5.1, 5.7, 5.8 — metric selection ---------------------------

describe("Requirement 5.1 — metric selection bounds", () => {
  test("26 resource-type entries is rejected", () => {
    const definition = validDefinition()
    const metrics: Record<string, { metric: string; statistic: string }[]> = {}
    for (let i = 0; i < 26; i += 1) {
      metrics[`Microsoft.Compute/type${i}`] = [{ metric: "Percentage CPU", statistic: "avg" }]
    }
    const issues = collectDefinitionIssues({ ...definition, metrics })
    expect(pathsOf(issues)).toContain("metrics")
  })

  test("an entry with 0 items is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      metrics: { "Microsoft.Compute/virtualMachines": [] },
    })
    expect(pathsOf(issues)).toContain("metrics.Microsoft.Compute/virtualMachines")
  })

  test("an entry with 41 items is rejected", () => {
    const definition = validDefinition()
    const items = Array.from({ length: 41 }, () => ({ metric: "Percentage CPU", statistic: "avg" }))
    const issues = collectDefinitionIssues({
      ...definition,
      metrics: { "Microsoft.Compute/virtualMachines": items },
    })
    expect(pathsOf(issues)).toContain("metrics.Microsoft.Compute/virtualMachines")
  })

  test("a bare string entry is rejected — entries must be objects", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      metrics: { "Microsoft.Compute/virtualMachines": ["Percentage CPU"] },
    })
    expect(pathsOf(issues)).toContain("metrics.Microsoft.Compute/virtualMachines.0")
  })

  test("an entry naming both metric and derived is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      metrics: {
        "Microsoft.Compute/virtualMachines": [
          { metric: "Percentage CPU", derived: "memory_used_pct", statistic: "avg" },
        ],
      },
    })
    expect(pathsOf(issues)).toContain("metrics.Microsoft.Compute/virtualMachines.0")
  })

  test("an entry naming neither metric nor derived is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      metrics: { "Microsoft.Compute/virtualMachines": [{ statistic: "avg" }] },
    })
    expect(pathsOf(issues)).toContain("metrics.Microsoft.Compute/virtualMachines.0")
  })
})

describe("Requirements 5.7, 5.8 — a percentile entry requires an estimator and a fidelity tier", () => {
  test("p95 with both fields present is accepted", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      metrics: {
        "Microsoft.Compute/virtualMachines": [
          {
            metric: "Percentage CPU",
            statistic: "p95",
            estimator: "histogram_sketch_pt1h_interval_average",
            fidelity_tier: "baseline",
          },
        ],
      },
    })
    expect(issues).toEqual([])
  })

  test("p95 without an estimator is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      metrics: {
        "Microsoft.Compute/virtualMachines": [
          { metric: "Percentage CPU", statistic: "p95", fidelity_tier: "baseline" },
        ],
      },
    })
    expect(pathsOf(issues)).toContain("metrics.Microsoft.Compute/virtualMachines.0.estimator")
  })

  test("p95 without a fidelity_tier is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      metrics: {
        "Microsoft.Compute/virtualMachines": [
          {
            metric: "Percentage CPU",
            statistic: "p95",
            estimator: "histogram_sketch_pt1h_interval_average",
          },
        ],
      },
    })
    expect(pathsOf(issues)).toContain("metrics.Microsoft.Compute/virtualMachines.0.fidelity_tier")
  })

  test("p95 without either field reports both as separate issues", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      metrics: {
        "Microsoft.Compute/virtualMachines": [{ metric: "Percentage CPU", statistic: "p95" }],
      },
    })
    const paths = pathsOf(issues)
    expect(paths).toContain("metrics.Microsoft.Compute/virtualMachines.0.estimator")
    expect(paths).toContain("metrics.Microsoft.Compute/virtualMachines.0.fidelity_tier")
  })

  test("a non-percentile statistic (avg) needs neither field", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      metrics: {
        "Microsoft.Compute/virtualMachines": [{ metric: "Percentage CPU", statistic: "avg" }],
      },
    })
    expect(issues).toEqual([])
  })
})

// --- Requirement 6.2, 6.3 — block shape and bounds --------------------------

describe("Requirement 6.2 — block shape", () => {
  test("a block id of 65 characters is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [{ id: "a".repeat(65), type: "heading", config: { level: 1, text: "x" } }],
    })
    expect(pathsOf(issues)).toContain("blocks.0.id")
  })

  test("a block id of 64 characters is accepted", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [{ id: "a".repeat(64), type: "heading", config: { level: 1, text: "x" } }],
    })
    expect(issues).toEqual([])
  })

  test("a row with 1 column is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [{ id: "row-1", type: "row", columns: [[]] }],
    })
    expect(pathsOf(issues)).toContain("blocks.0.columns")
  })

  test("a row with 4 columns is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [{ id: "row-1", type: "row", columns: [[], [], [], []] }],
    })
    expect(pathsOf(issues)).toContain("blocks.0.columns")
  })

  test("a row with 2 or 3 columns is accepted", () => {
    const definition = validDefinition()
    const issues2 = collectDefinitionIssues({
      ...definition,
      blocks: [{ id: "row-1", type: "row", columns: [[], []] }],
    })
    expect(issues2).toEqual([])

    const issues3 = collectDefinitionIssues({
      ...definition,
      blocks: [{ id: "row-1", type: "row", columns: [[], [], []] }],
    })
    expect(issues3).toEqual([])
  })

  test("a column with 9 children is rejected", () => {
    const definition = validDefinition()
    const children = Array.from({ length: 9 }, (_, i) => ({
      id: `h-${i}`,
      type: "heading",
      config: { level: 1, text: "x" },
    }))
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [{ id: "row-1", type: "row", columns: [children, []] }],
    })
    expect(pathsOf(issues)).toContain("blocks.0.columns.0")
  })
})

describe("Requirement 6.3 — at most 200 blocks, counting rows and children", () => {
  test("exactly 200 blocks is accepted", () => {
    // 100 top-level heading blocks + one row of 2 columns * 50 children = 200
    const topLevel = Array.from({ length: 100 }, (_, i) => ({
      id: `h-${i}`,
      type: "heading",
      config: { level: 1, text: "x" },
    }))
    const rowChildren = Array.from({ length: 50 }, (_, i) => ({
      id: `rc-a-${i}`,
      type: "heading",
      config: { level: 1, text: "x" },
    }))
    const rowChildrenB = Array.from({ length: 49 }, (_, i) => ({
      id: `rc-b-${i}`,
      type: "heading",
      config: { level: 1, text: "x" },
    }))
    const blocks = [
      ...topLevel,
      { id: "row-1", type: "row", columns: [rowChildren, rowChildrenB] },
    ]
    // total = 100 + 1(row) + 50 + 49 = 200
    const definition = validDefinition()
    const issues = collectDefinitionIssues({ ...definition, blocks })
    expect(issues.some((issue) => issue.message.includes("at most 200 blocks"))).toBe(false)
  })

  test("201 blocks is rejected", () => {
    const topLevel = Array.from({ length: 201 }, (_, i) => ({
      id: `h-${i}`,
      type: "heading",
      config: { level: 1, text: "x" },
    }))
    const definition = validDefinition()
    const issues = collectDefinitionIssues({ ...definition, blocks: topLevel })
    expect(issues.some((issue) => issue.message.includes("at most 200 blocks"))).toBe(true)
  })
})

// --- Requirement 6.4 — row nesting rejected at any depth ---------------------

describe("Requirement 6.4 — a row inside a row is rejected at any depth", () => {
  test("depth 1: a row directly inside a row's column", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [
        {
          id: "outer-row",
          type: "row",
          columns: [
            [{ id: "inner-row", type: "row", columns: [[], []] }],
            [],
          ],
        },
      ],
    })
    expect(pathsOf(issues)).toContain("blocks.0.columns.0.0.type")
  })

  test("depth 2: a row nested two levels deep is still caught", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [
        {
          id: "outer-row",
          type: "row",
          columns: [
            [
              {
                id: "mid-row",
                type: "row",
                columns: [[{ id: "deep-row", type: "row", columns: [[], []] }], []],
              },
            ],
            [],
          ],
        },
      ],
    })
    const paths = pathsOf(issues)
    // mid-row is itself a row-in-a-row (depth 1 relative to outer-row)
    expect(paths).toContain("blocks.0.columns.0.0.type")
    // deep-row is a row inside mid-row's column (also flagged)
    expect(paths).toContain("blocks.0.columns.0.0.columns.0.0.type")
  })

  test("the offending child's id is named in the message", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [
        {
          id: "outer-row",
          type: "row",
          columns: [[{ id: "bad-inner-row", type: "row", columns: [[], []] }], []],
        },
      ],
    })
    expect(issues.some((issue) => issue.message.includes("bad-inner-row"))).toBe(true)
  })

  test("a row nested with everything else valid still reports only the nesting issue", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [
        {
          id: "outer-row",
          type: "row",
          columns: [
            [{ id: "inner-row", type: "row", columns: [[], []] }],
            [{ id: "ok-heading", type: "heading", config: { level: 1, text: "x" } }],
          ],
        },
      ],
    })
    expect(pathsOf(issues)).toEqual(["blocks.0.columns.0.0.type"])
  })
})

// --- Requirement 6.6 — rich_text binds nothing --------------------------

describe("Requirement 6.6 — rich_text carries static prose and no figure", () => {
  test("a rich_text config binding a metric is rejected, naming the bound field", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [{ id: "rt-1", type: "rich_text", config: { text: "hi", metric: "Percentage CPU" } }],
    })
    expect(pathsOf(issues)).toContain("blocks.0.config.metric")
    expect(issues.some((issue) => issue.message.includes('bind "metric"'))).toBe(true)
  })

  test.each(["statistic", "resource_id", "scope", "snapshot_path"])(
    "a rich_text config binding %s is rejected",
    (field) => {
      const definition = validDefinition()
      const issues = collectDefinitionIssues({
        ...definition,
        blocks: [{ id: "rt-1", type: "rich_text", config: { text: "hi", [field]: "x" } }],
      })
      expect(pathsOf(issues)).toContain(`blocks.0.config.${field}`)
    }
  )

  test("a plain rich_text config is accepted", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [{ id: "rt-1", type: "rich_text", config: { text: "hi" } }],
    })
    expect(issues).toEqual([])
  })
})

// --- Requirement 6.7 — duplicate ids -------------------------------------

describe("Requirement 6.7 — duplicate block id, counting row children", () => {
  test("a duplicate at the top level is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [
        { id: "dup", type: "heading", config: { level: 1, text: "a" } },
        { id: "dup", type: "heading", config: { level: 1, text: "b" } },
      ],
    })
    expect(issues.some((issue) => issue.message.includes('Duplicate block id "dup"'))).toBe(true)
  })

  test("a duplicate between a top-level block and a row child is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [
        { id: "dup", type: "heading", config: { level: 1, text: "a" } },
        {
          id: "row-1",
          type: "row",
          columns: [[{ id: "dup", type: "heading", config: { level: 1, text: "b" } }], []],
        },
      ],
    })
    expect(issues.some((issue) => issue.message.includes('Duplicate block id "dup"'))).toBe(true)
  })

  test("a duplicate between two different row columns is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [
        {
          id: "row-1",
          type: "row",
          columns: [
            [{ id: "dup", type: "heading", config: { level: 1, text: "a" } }],
            [{ id: "dup", type: "heading", config: { level: 1, text: "b" } }],
          ],
        },
      ],
    })
    expect(issues.some((issue) => issue.message.includes('Duplicate block id "dup"'))).toBe(true)
  })

  test("distinct ids report no duplicate issue", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [
        { id: "a", type: "heading", config: { level: 1, text: "a" } },
        { id: "b", type: "heading", config: { level: 1, text: "b" } },
      ],
    })
    expect(issues).toEqual([])
  })
})

// --- Requirement 6.5 — no absolute positioning fields -----------------------

describe("Requirement 6.5 — absolute position, coordinate, offset, size or page fields are rejected", () => {
  test.each([
    "position",
    "x_position",
    "coordinate_x",
    "offset_top",
    "absolute_width",
    "absolute_height",
    "page_assignment",
    "page_number",
  ])("a block-level field named %s is rejected, naming the field", (field) => {
    const definition = validDefinition()
    const block = { id: "h1", type: "heading", config: { level: 1, text: "x" }, [field]: 5 }
    const issues = collectDefinitionIssues({ ...definition, blocks: [block] })
    expect(pathsOf(issues)).toContain(`blocks.0.${field}`)
  })

  test("a config-level positioning field is rejected", () => {
    const definition = validDefinition()
    const block = { id: "h1", type: "heading", config: { level: 1, text: "x", offset_left: 10 } }
    const issues = collectDefinitionIssues({ ...definition, blocks: [block] })
    expect(pathsOf(issues)).toContain("blocks.0.config.offset_left")
  })
})

// --- Requirement 6.9 — undeclared block type / config field ----------------

describe("Requirement 6.9 — an undeclared block type or config field is rejected, never dropped", () => {
  test("an undeclared block type is named, and the block is not silently ignored", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [{ id: "x1", type: "bogus_block_type", config: {} }],
    })
    expect(pathsOf(issues)).toContain("blocks.0.type")
  })

  test("an undeclared config field is named", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [{ id: "h1", type: "heading", config: { level: 1, text: "x", bogus_field: 1 } }],
    })
    expect(pathsOf(issues)).toContain("blocks.0.config.bogus_field")
  })

  test("a required config field missing is named", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [{ id: "h1", type: "heading", config: {} }],
    })
    const paths = pathsOf(issues)
    expect(paths).toContain("blocks.0.config.level")
    expect(paths).toContain("blocks.0.config.text")
  })

  test("an enumerated config field outside its permitted values is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      blocks: [
        {
          id: "top-1",
          type: "top_n_table",
          config: { columns: ["id"], order_by: "cpu", order_by_direction: "sideways" },
        },
      ],
    })
    expect(pathsOf(issues)).toContain("blocks.0.config.order_by_direction")
  })
})

// --- Requirement 6.8 — zero blocks: valid draft, invalid run ----------------

describe("Requirement 6.8 — zero blocks is a valid draft and an invalid run", () => {
  test("draft mode (default) accepts zero blocks", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({ ...definition, blocks: [] })
    expect(issues).toEqual([])
  })

  test("run mode rejects zero blocks", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({ ...definition, blocks: [] }, { mode: "run" })
    expect(pathsOf(issues)).toContain("blocks")
  })

  test("templateDefinitionForRunSchema rejects zero blocks", () => {
    const definition = validDefinition()
    const result = templateDefinitionForRunSchema.safeParse({ ...definition, blocks: [] })
    expect(result.success).toBe(false)
  })

  test("templateDefinitionSchema (draft) accepts zero blocks", () => {
    const definition = validDefinition()
    const result = templateDefinitionSchema.safeParse({ ...definition, blocks: [] })
    expect(result.success).toBe(true)
  })
})

// --- Requirement 7.1, 7.2 — design schema -----------------------------------

describe("Requirement 7.1 — design preset, exactly four case-sensitive values", () => {
  test.each(["editorial", "corporate", "technical", "minimal"])("%s is accepted", (preset) => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      design: { ...definition.design, preset },
    })
    expect(issues).toEqual([])
  })

  test("a fifth value is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      design: { ...definition.design, preset: "modern" },
    })
    expect(pathsOf(issues)).toContain("design.preset")
  })

  test("case sensitivity: Editorial is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      design: { ...definition.design, preset: "Editorial" },
    })
    expect(pathsOf(issues)).toContain("design.preset")
  })
})

describe("Requirement 7.2 — design bounds and enums", () => {
  test("decimal_places of 4 is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      design: {
        ...definition.design,
        number_format: { decimal_places: 4, group_thousands: true },
      },
    })
    expect(pathsOf(issues)).toContain("design.number_format.decimal_places")
  })

  test("density outside the three values is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      design: { ...definition.design, density: "loose" },
    })
    expect(pathsOf(issues)).toContain("design.density")
  })

  test("table_style outside the three values is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      design: { ...definition.design, table_style: "plain" },
    })
    expect(pathsOf(issues)).toContain("design.table_style")
  })

  test("page_size outside A4/Letter is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      design: { ...definition.design, page_size: "Legal" },
    })
    expect(pathsOf(issues)).toContain("design.page_size")
  })

  test("a logo of 513 characters is rejected", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      design: { ...definition.design, logo: "a".repeat(513) },
    })
    expect(pathsOf(issues)).toContain("design.logo")
  })

  test("a null logo is accepted", () => {
    const definition = validDefinition()
    const issues = collectDefinitionIssues({
      ...definition,
      design: { ...definition.design, logo: null },
    })
    expect(issues).toEqual([])
  })
})

// --- "One pass reports every violation" -------------------------------------

describe("validation is one pass reporting every violation, not the first", () => {
  test("two unrelated simultaneous defects are both reported", () => {
    const definition = validDefinition()
    const broken = {
      ...definition,
      schema_version: "not-a-number",
      design: { ...definition.design, preset: "modern" },
    }
    const issues = collectDefinitionIssues(broken)
    const paths = pathsOf(issues)
    expect(paths).toContain("schema_version")
    expect(paths).toContain("design.preset")
  })

  test("five simultaneous defects across different sections are all reported", () => {
    const definition = validDefinition()
    const broken = {
      ...definition,
      schema_version: 99,
      identity: { ...definition.identity, name: "" },
      scope: { ...definition.scope, sort: "sideways" },
      period: { kind: "bogus" },
      design: { ...definition.design, page_size: "Legal" },
    }
    const issues = collectDefinitionIssues(broken)
    const paths = pathsOf(issues)
    expect(paths).toContain("schema_version")
    expect(paths).toContain("identity.name")
    expect(paths).toContain("scope.sort")
    expect(paths).toContain("period.kind")
    expect(paths).toContain("design.page_size")
  })

  test("through the zod schema, safeParse's error.issues carries every defect in one result", () => {
    const definition = validDefinition()
    const broken = {
      ...definition,
      schema_version: "1",
      design: { ...definition.design, preset: "modern" },
      blocks: [
        { id: "dup", type: "heading", config: { level: 1, text: "a" } },
        { id: "dup", type: "heading", config: { level: 1, text: "b" } },
      ],
    }
    const result = templateDefinitionSchema.safeParse(broken)
    expect(result.success).toBe(false)
    if (result.success) throw new Error("unreachable")

    const paths = result.error.issues.map((issue) => issue.path.join("."))
    expect(paths).toContain("schema_version")
    expect(paths).toContain("design.preset")
    expect(result.error.issues.some((issue) => issue.message.includes('Duplicate block id "dup"'))).toBe(
      true
    )
    // At least 3 distinct issues in one pass — not just the first one found.
    expect(result.error.issues.length).toBeGreaterThanOrEqual(3)
  })

  test("rejecting a definition writes no version row — a pure function has nothing to write, and returns issues instead", () => {
    // This module performs no I/O at all (Requirement 6.11's "writing no
    // version row and leaving every existing version byte-identical" is
    // upheld structurally: `collectDefinitionIssues` and the zod schemas
    // touch no database, no store and no file system).
    const result = templateDefinitionSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// --- Metric_Catalog-dependent validation (separately composed) -------------

describe("validateMetricSelectionAgainstCatalog — the catalog-aware layer", () => {
  const catalog: MetricCatalogSnapshot = [
    {
      resourceType: "Microsoft.Compute/virtualMachines",
      declaredSkuCapabilities: ["vCPUsAvailable", "MemoryGB"],
      entries: [
        {
          kind: "metric",
          name: "Percentage CPU",
          statistics: ["avg", "min", "max", "p95"],
          percentiles: {
            p95: { estimator: "histogram_sketch_pt1h_interval_average", fidelityTier: "baseline" },
          },
        },
        {
          kind: "metric",
          name: "Available Memory Bytes",
          statistics: ["avg", "min", "max"],
          percentiles: {},
        },
        {
          kind: "derived",
          name: "memory_used_pct",
          statistics: ["avg"],
          percentiles: {},
          requiredSourceMetrics: ["Available Memory Bytes"],
          requiredSkuCapabilities: ["MemoryGB"],
        },
      ],
    },
  ]

  test("a metric and statistic the catalog declares is accepted", () => {
    const definition: TemplateDefinition = {
      ...validDefinition(),
      metrics: {
        "Microsoft.Compute/virtualMachines": [{ metric: "Percentage CPU", statistic: "avg" }],
      },
    }
    expect(validateMetricSelectionAgainstCatalog(definition, catalog)).toEqual([])
  })

  test("a metric absent from the catalog for that resource type is rejected", () => {
    const definition: TemplateDefinition = {
      ...validDefinition(),
      metrics: {
        "Microsoft.Compute/virtualMachines": [{ metric: "Not A Real Metric", statistic: "avg" }],
      },
    }
    const issues = validateMetricSelectionAgainstCatalog(definition, catalog)
    expect(pathsOf(issues)).toContain("metrics.Microsoft.Compute/virtualMachines.0")
  })

  test("a resource type the catalog declares nothing for is rejected", () => {
    const definition: TemplateDefinition = {
      ...validDefinition(),
      metrics: {
        "Microsoft.Storage/storageAccounts": [{ metric: "Whatever", statistic: "avg" }],
      },
    }
    const issues = validateMetricSelectionAgainstCatalog(definition, catalog)
    expect(pathsOf(issues)).toContain("metrics.Microsoft.Storage/storageAccounts")
  })

  test("a statistic the catalog does not declare for that metric is rejected", () => {
    const definition: TemplateDefinition = {
      ...validDefinition(),
      metrics: {
        "Microsoft.Compute/virtualMachines": [{ metric: "Percentage CPU", statistic: "p50" }],
      },
    }
    const issues = validateMetricSelectionAgainstCatalog(definition, catalog)
    expect(pathsOf(issues)).toContain("metrics.Microsoft.Compute/virtualMachines.0.statistic")
  })

  test("a derived statistic whose source metric is not also selected is rejected", () => {
    const definition: TemplateDefinition = {
      ...validDefinition(),
      metrics: {
        "Microsoft.Compute/virtualMachines": [{ derived: "memory_used_pct", statistic: "avg" }],
      },
    }
    const issues = validateMetricSelectionAgainstCatalog(definition, catalog)
    expect(
      issues.some((issue) => issue.message.includes("Available Memory Bytes"))
    ).toBe(true)
  })

  test("a derived statistic with its source metric selected is accepted", () => {
    const definition: TemplateDefinition = {
      ...validDefinition(),
      metrics: {
        "Microsoft.Compute/virtualMachines": [
          { metric: "Available Memory Bytes", statistic: "avg" },
          { derived: "memory_used_pct", statistic: "avg" },
        ],
      },
    }
    const issues = validateMetricSelectionAgainstCatalog(definition, catalog)
    expect(issues).toEqual([])
  })

  test("this layer is not run by templateDefinitionSchema automatically", () => {
    // A metric absent from any catalog still parses at the shape level —
    // catalog membership is a separately composed check (see module
    // docstring's "Layering" section).
    const definition = validDefinition()
    const result = templateDefinitionSchema.safeParse({
      ...definition,
      metrics: {
        "Microsoft.Compute/virtualMachines": [{ metric: "Not A Real Metric At All", statistic: "avg" }],
      },
    })
    expect(result.success).toBe(true)
  })
})
