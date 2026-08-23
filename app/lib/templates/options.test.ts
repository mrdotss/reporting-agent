import { describe, expect, test } from "vitest"

import { BLOCK_CONFIG, BLOCK_TYPES } from "@/lib/templates/blocks"
import {
  IMPLICIT_TABLE_COLUMNS,
  type MetricCatalogSnapshot,
  type MetricSelectionItem,
  type ScopeSpec,
} from "@/lib/templates/definition"
import {
  COLUMN_ATTRIBUTES,
  IMPLICIT_COLUMN_ATTRIBUTES,
  fieldKind,
  metricOptionKey,
  optionsFor,
  resolvedResourceTypes,
  undeclaredReferences,
  type FactDeclarationSnapshot,
} from "@/lib/templates/options"

/**
 * `lib/templates/options.ts` — the block-config option resolver (Requirements 11.9, 12.2,
 * 12.4, 12.9, 12.10).
 *
 * Focused, example-based checks over the presentation facts and the exact messages. The
 * exhaustive claims — every offered option is selected, the three groups partition, the
 * function writes nothing — are `test/property/config-options.property.test.ts` (breadth
 * Property 8); this file pins what a fixed case states better than a generator can.
 */

const VM = "Microsoft.Compute/virtualMachines"
const STORAGE = "Microsoft.Storage/storageAccounts"

function scope(resourceTypes: readonly string[]): ScopeSpec {
  return {
    resource_types: [...resourceTypes],
    tag_filters: [],
    resource_groups: [],
    top_n: null,
    sort: null,
  }
}

/** A catalog declaring `Percentage CPU` with a p95 estimate, and `Used capacity` without. */
function catalog(): MetricCatalogSnapshot {
  return [
    {
      resourceType: VM,
      declaredSkuCapabilities: ["vCPUsAvailable", "MemoryGB"],
      entries: [
        {
          kind: "metric",
          name: "Percentage CPU",
          statistics: ["avg", "min", "max", "p95"],
          percentiles: {
            p95: {
              estimator: "histogram_sketch_pt1h_interval_average",
              fidelityTier: "baseline",
            },
          },
          unit: "percent",
          scale: 2,
        },
        {
          kind: "derived",
          name: "memory_used_pct",
          statistics: ["avg"],
          percentiles: {},
          unit: "percent",
          scale: 2,
        },
      ],
    },
    {
      resourceType: STORAGE,
      declaredSkuCapabilities: [],
      entries: [
        {
          kind: "metric",
          name: "Used capacity",
          statistics: ["avg", "max"],
          percentiles: {},
          unit: "bytes",
          scale: 0,
        },
      ],
    },
  ]
}

function declaration(): FactDeclarationSnapshot {
  return [
    {
      resourceType: VM,
      key: "os_type",
      valueKind: "text",
      source: "resource_graph",
    },
    {
      resourceType: STORAGE,
      key: "replication_enabled",
      valueKind: "text",
      source: "storage",
    },
  ]
}

const CPU: MetricSelectionItem = { metric: "Percentage CPU", statistic: "avg" }
const CPU_P95: MetricSelectionItem = {
  metric: "Percentage CPU",
  statistic: "p95",
  estimator: "histogram_sketch_pt1h_interval_average",
  fidelity_tier: "baseline",
}
const CAPACITY: MetricSelectionItem = {
  metric: "Used capacity",
  statistic: "max",
}

function definition(
  metrics: Record<string, readonly MetricSelectionItem[]>,
  blocks: readonly unknown[] = []
) {
  return {
    scope: scope(Object.keys(metrics)),
    metrics,
    blocks: blocks as never,
  }
}

// --- fieldKind --------------------------------------------------------------

describe("Requirement 12.6 — which fields are references", () => {
  test.each([
    ["kpi_row", "metrics", "metric_ref_list"],
    ["timeseries_chart", "metrics", "metric_ref_list"],
    ["distribution_chart", "metrics", "metric_ref_list"],
    ["resource_table", "columns", "column_list"],
    ["top_n_table", "columns", "column_list"],
    ["top_n_table", "order_by", "metric_ref"],
    ["capacity_vs_usage", "usage_metric", "metric_ref"],
  ] as const)("%s.%s is %s", (blockType, field, expected) => {
    expect(fieldKind(blockType, field)).toBe(expected)
  })

  test("capacity_metric is not a metric ref", () => {
    // It is a SKU-capability ref (`{sku_capability: "MemoryGB"}`) read by a different reader,
    // so offering it the selection's metrics would offer values that reader refuses. Its own
    // options come from the catalog's `declaredSkuCapabilities`, which is task 12.6's control.
    expect(fieldKind("capacity_vs_usage", "capacity_metric")).toBe("other")
  })

  test("an enum-declared field is an enum whatever else it looks like", () => {
    // `BLOCK_CONFIG.enums` is the source, so a value added there needs no edit in this module.
    for (const blockType of BLOCK_TYPES) {
      for (const field of Object.keys(BLOCK_CONFIG[blockType].enums)) {
        expect(fieldKind(blockType, field)).toBe("enum")
      }
    }
  })

  test("a field the schema does not declare is other, not an error", () => {
    // A presentation question has one answer; refusing an undeclared field is the validator's
    // job, and two answers for one wrong field would be two places to keep in step.
    expect(fieldKind("heading", "columns")).toBe("other")
    expect(fieldKind("resource_table", "not_a_field")).toBe("other")
  })

  test("columns on a chart is not a column list", () => {
    // The table above is keyed by block type because the same field name means different
    // things on different blocks — a flat field-name table would offer a chart a column list.
    expect(fieldKind("timeseries_chart", "columns")).toBe("other")
    expect(fieldKind("resource_table", "metrics")).toBe("other")
  })
})

// --- Scope resolution -------------------------------------------------------

describe("Requirement 12.2 — the resolved scope", () => {
  test("an override narrows; an empty override does not", () => {
    const subject = definition({ [VM]: [CPU], [STORAGE]: [CAPACITY] })

    expect(
      resolvedResourceTypes(subject, { scope_override: scope([VM]) })
    ).toEqual([VM])
    expect(
      resolvedResourceTypes(subject, { scope_override: scope([]) })
    ).toEqual([VM, STORAGE])
    expect(resolvedResourceTypes(subject, {})).toEqual([VM, STORAGE])
  })

  test("a scope and a selection differing only in case are one type", () => {
    // Resource Graph lower-cases type strings and the catalog lookups fold too, so a scope
    // naming the documented casing must still match a lower-cased selection key.
    const subject = definition({ [VM.toLowerCase()]: [CPU] })

    expect(
      resolvedResourceTypes(subject, { scope_override: scope([VM]) })
    ).toEqual([VM.toLowerCase()])
  })

  test("an override naming an unselected type resolves to nothing", () => {
    const subject = definition({ [VM]: [CPU] })

    expect(
      resolvedResourceTypes(subject, { scope_override: scope([STORAGE]) })
    ).toEqual([])
  })
})

// --- The metric options -----------------------------------------------------

describe("Requirement 12.2 — a metric option describes what the catalog declares", () => {
  test("an exact statistic is not marked estimated; a percentile is", () => {
    const groups = optionsFor("metrics", {
      definition: definition({ [VM]: [CPU, CPU_P95] }),
      block: { type: "kpi_row" },
      catalog: catalog(),
      factDeclaration: declaration(),
    })

    expect(groups.metrics.map((option) => option.key)).toEqual([
      "Percentage CPU:avg",
      "Percentage CPU:p95",
    ])
    expect(groups.metrics[0]).toMatchObject({
      estimated: false,
      unit: "percent",
      scale: 2,
      label: "Percentage CPU (avg)",
      resourceType: VM,
    })
    // Estimated is membership in the catalog's `percentiles`, and the label comes from the
    // catalog rather than being composed here — the same rule the renderer follows.
    expect(groups.metrics[1]).toMatchObject({
      estimated: true,
      estimatorLabel: "histogram_sketch_pt1h_interval_average",
      fidelityTier: "baseline",
    })
    expect(groups.metrics[0]).not.toHaveProperty("estimatorLabel")
  })

  test("a derived statistic is offered under its own key", () => {
    const groups = optionsFor("metrics", {
      definition: definition({
        [VM]: [{ derived: "memory_used_pct", statistic: "avg" }],
      }),
      block: { type: "kpi_row" },
      catalog: catalog(),
      factDeclaration: declaration(),
    })

    expect(groups.metrics[0]).toMatchObject({
      derived: "memory_used_pct",
      key: "memory_used_pct:avg",
      unit: "percent",
    })
    expect(groups.metrics[0]).not.toHaveProperty("metric")
  })

  test("a selected item the catalog does not describe is still offered", () => {
    // Membership comes from the selection and the catalog only *describes* an item, so a
    // catalog missing an entry costs the presentation facts and not the option itself.
    const groups = optionsFor("metrics", {
      definition: definition({
        [VM]: [{ metric: "Nowhere In Catalog", statistic: "avg" }],
      }),
      block: { type: "kpi_row" },
      catalog: catalog(),
      factDeclaration: declaration(),
    })

    expect(groups.metrics.map((option) => option.key)).toEqual([
      "Nowhere In Catalog:avg",
    ])
    expect(groups.metrics[0]).not.toHaveProperty("unit")
  })

  test("metricOptionKey is the agent's own <name>:<statistic>", () => {
    expect(metricOptionKey(CPU)).toBe("Percentage CPU:avg")
    expect(
      metricOptionKey({ derived: "memory_used_pct", statistic: "avg" })
    ).toBe("memory_used_pct:avg")
  })
})

// --- The three groups -------------------------------------------------------

describe("Requirement 12.4 — the three column groups", () => {
  function columnGroups(
    blockType: "resource_table" | "top_n_table" | "kpi_row"
  ) {
    return optionsFor("columns", {
      definition: definition({ [VM]: [CPU] }),
      block: { type: blockType },
      catalog: catalog(),
      factDeclaration: declaration(),
    })
  }

  test("a column list offers the metrics, every attribute and the in-scope facts", () => {
    const groups = columnGroups("resource_table")

    expect(groups.metrics.map((option) => option.key)).toEqual([
      "Percentage CPU:avg",
    ])
    expect(groups.attributes.map((option) => option.key)).toEqual([
      ...COLUMN_ATTRIBUTES,
    ])
    // `replication_enabled` is declared for Storage, which this block's scope cannot contain.
    expect(groups.facts.map((option) => option.factKey)).toEqual(["os_type"])
  })

  test("the implicit pair is presented as implicit rather than hidden", () => {
    // Presented so a consultant sees *why* it cannot be selected instead of wondering where it
    // went — and selecting it anyway is the validation error Requirement 12.3 names.
    const implicit = columnGroups("resource_table")
      .attributes.filter((option) => option.implicit)
      .map((option) => option.attribute)

    expect(implicit).toEqual([...IMPLICIT_COLUMN_ATTRIBUTES])
    expect([...IMPLICIT_COLUMN_ATTRIBUTES]).toEqual([...IMPLICIT_TABLE_COLUMNS])
  })

  test("a metric-valued field offers the metrics alone", () => {
    const groups = optionsFor("order_by", {
      definition: definition({ [VM]: [CPU] }),
      block: { type: "top_n_table" },
      catalog: catalog(),
      factDeclaration: declaration(),
    })

    expect(groups.metrics.length).toBe(1)
    expect(groups.attributes).toEqual([])
    expect(groups.facts).toEqual([])
  })

  test("an enum or plain field offers nothing", () => {
    for (const field of ["caption", "order_by_direction", "show_fidelity"]) {
      expect(
        optionsFor(field, {
          definition: definition({ [VM]: [CPU] }),
          block: { type: "top_n_table" },
          catalog: catalog(),
          factDeclaration: declaration(),
        })
      ).toEqual({ metrics: [], attributes: [], facts: [] })
    }
  })
})

// --- Undeclared references --------------------------------------------------

describe("Requirements 12.9, 12.10 — a stored reference outside the options", () => {
  function issuesFor(blocks: readonly unknown[]) {
    return undeclaredReferences(
      definition({ [VM]: [CPU] }, blocks),
      catalog(),
      declaration()
    )
  }

  test("a selected metric produces no issue", () => {
    expect(
      issuesFor([
        {
          id: "t",
          type: "resource_table",
          config: { columns: [{ metric: "Percentage CPU", statistic: "avg" }] },
        },
      ])
    ).toEqual([])
  })

  test("an unselected metric is named with its reason and its path", () => {
    const issues = issuesFor([
      {
        id: "t",
        type: "resource_table",
        config: { columns: [{ metric: "Percentage CPU", statistic: "p95" }] },
      },
    ])

    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      reason: "metric_not_selected",
      reference: "Percentage CPU:p95",
      blockId: "t",
      field: "columns",
      path: ["blocks", 0, "config", "columns", 0],
    })
    expect(issues[0]!.message).toContain("Percentage CPU:p95")
  })

  test("a metric_ref field is pathed without an index", () => {
    // `order_by` holds one reference rather than a list, so an index in its path would point
    // at a position that does not exist in the stored definition.
    const issues = issuesFor([
      {
        id: "t",
        type: "top_n_table",
        config: { order_by: { metric: "Used capacity", statistic: "max" } },
      },
    ])

    expect(issues).toHaveLength(1)
    expect(issues[0]!.path).toEqual(["blocks", 0, "config", "order_by"])
  })

  test("a declared attribute and an in-scope fact key both resolve", () => {
    expect(
      issuesFor([
        {
          id: "t",
          type: "resource_table",
          config: { columns: ["resource_group", "os_type"] },
        },
      ])
    ).toEqual([])
  })

  test("a fact key declared only for an out-of-scope type is reported", () => {
    // Not "undeclared" in the abstract: declared, for a resource type this block cannot
    // contain, which makes the column empty for every row it would emit.
    const issues = issuesFor([
      {
        id: "t",
        type: "resource_table",
        config: { columns: ["replication_enabled"] },
      },
    ])

    expect(issues.map((issue) => issue.reason)).toEqual(["fact_key_undeclared"])
  })

  test("an unknown attribute and an undeclared fact key report different reasons", () => {
    const issues = issuesFor([
      {
        id: "t",
        type: "resource_table",
        config: { columns: ["Not An Attribute", "some_unknown_key"] },
      },
    ])

    expect(issues.map((issue) => issue.reason)).toEqual([
      "attribute_unknown",
      "fact_key_undeclared",
    ])
  })

  test("a version-1 flat metric string reports rather than being accepted", () => {
    // The wire shape task 12.6 replaces with a typed object. A bare string names neither a
    // declared attribute nor a declared fact key, so it is reported rather than guessed at.
    const issues = issuesFor([
      {
        id: "t",
        type: "resource_table",
        config: { columns: ["Percentage CPU:avg"] },
      },
    ])

    expect(issues.map((issue) => issue.reason)).toEqual(["attribute_unknown"])
  })

  test("an enum or plain field is not scanned", () => {
    // `caption` is prose a consultant wrote. Reading it as a reference would report an issue
    // on every table with a caption.
    expect(
      issuesFor([
        {
          id: "t",
          type: "resource_table",
          config: { caption: "Not An Attribute", columns: ["resource_group"] },
        },
      ])
    ).toEqual([])
  })

  test("a reference in a row's column is reached and pathed through the column", () => {
    const issues = issuesFor([
      {
        id: "r",
        type: "row",
        columns: [
          [],
          [
            {
              id: "nested",
              type: "resource_table",
              config: { columns: ["Not An Attribute"] },
            },
          ],
        ],
      },
    ])

    expect(issues).toHaveLength(1)
    expect(issues[0]!.blockId).toBe("nested")
    expect(issues[0]!.path).toEqual([
      "blocks",
      0,
      "columns",
      1,
      0,
      "config",
      "columns",
      0,
    ])
  })

  test("every offending entry in one field is reported, not just the first", () => {
    const issues = issuesFor([
      {
        id: "t",
        type: "resource_table",
        config: { columns: ["Nope", "resource_group", "Also Nope"] },
      },
    ])

    expect(issues.map((issue) => issue.path.at(-1))).toEqual([0, 2])
  })
})
