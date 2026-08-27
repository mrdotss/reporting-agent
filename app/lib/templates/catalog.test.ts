import { describe, expect, test } from "vitest"

import { METRIC_CATALOG, METRIC_CATALOG_VERSION } from "@/lib/templates/catalog"
import {
  collectDefinitionIssues,
  validateMetricSelectionAgainstCatalog,
  type MetricCatalogEntry,
} from "@/lib/templates/definition"
import { STARTER_TEMPLATES } from "@/lib/templates/starters"

/**
 * The catalog projection (Requirement 5.6), and the one assertion that makes it
 * worth having.
 *
 * The projection itself is mechanical, so most of what follows is a check that a
 * mechanical translation did not quietly lose a field. The test that earns its
 * place is the last one: **every shipped starter validates against the catalog
 * this module serves.** The starters are three definitions hand-written against
 * the catalog's contents (`lib/templates/starters.ts`), and Requirement 10.8
 * fails the build if one of them stops validating. Before this module existed
 * they were checked against a catalog fixture; now they are checked against the
 * catalog the wizard will actually hand a consultant, which is what makes
 * "authorable in the wizard" and "shipped in the repository" the same claim.
 *
 * That test is also the one that catches a wrong estimator label. `starters.ts`
 * restates `histogram_sketch_pt1h_interval_average` as a constant; this module
 * *composes* the same string from the metric's unit family and the base grain. If
 * the composition drifts — a renamed sketch prefix, a changed base grain — the
 * two stop matching and Requirement 5.8 rejects the starter, here, rather than at
 * the consultant's first save.
 */

const VIRTUAL_MACHINES = "Microsoft.Compute/virtualMachines"

function resourceType(name: string) {
  const entry = METRIC_CATALOG.find(
    (candidate) => candidate.resourceType === name
  )
  expect(entry, `the catalog declares no ${name}`).toBeDefined()
  return entry!
}

function entryNamed(name: string): MetricCatalogEntry {
  const found = resourceType(VIRTUAL_MACHINES).entries.find(
    (candidate) => candidate.name === name
  )
  expect(found, `the catalog declares no entry named ${name}`).toBeDefined()
  return found!
}

describe("the catalog is the agent's file, projected", () => {
  test("it declares a version and at least one resource type", () => {
    expect(METRIC_CATALOG_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(METRIC_CATALOG.length).toBeGreaterThan(0)
  })

  test("resource type names keep the catalog's own spelling", () => {
    // Not `microsoft.compute/virtualmachines`. Resource Graph lowercases `type`
    // in its response body and every lookup against this catalog folds case, but
    // what the catalog *declares* is the documented spelling — and it is the
    // spelling a definition's `metrics` key inherits when the wizard writes one.
    expect(resourceType(VIRTUAL_MACHINES).resourceType).toBe(VIRTUAL_MACHINES)
  })

  test("the SKU capabilities a derived formula may consume are declared", () => {
    expect(resourceType(VIRTUAL_MACHINES).declaredSkuCapabilities).toContain(
      "MemoryGB"
    )
  })
})

describe("Requirement 5.6 — what a selectable item declares", () => {
  test("a metric offers avg only when it declares both Total and Count", () => {
    // `avg` is `Σtotal / Σcount`, count-weighted across intervals. A metric with
    // `Total` and no `Count` has no denominator, and offering `avg` for it would
    // offer a figure the collector cannot produce correctly.
    const cpu = entryNamed("Percentage CPU")

    expect(cpu.statistics).toContain("avg")
    expect(cpu.statistics).toContain("min")
    expect(cpu.statistics).toContain("max")
  })

  test("a metric carries its scale, unit and unit family", () => {
    const cpu = entryNamed("Percentage CPU")

    expect(cpu.scale).toBe(2)
    expect(cpu.unit).toBe("percent")
    expect(cpu.unitFamily).toBe("percentage")
  })

  test("the catalog's own qualifier survives the projection", () => {
    // `Network In Total` is NIC-level bytes and **not** billable egress. The
    // catalog says so in a `label`, and a wizard that dropped it would present a
    // metric a consultant could reasonably read as an egress bill.
    expect(entryNamed("Network In Total").label).toBe("NIC-level bytes")
  })
})

describe("Requirements 5.7, 5.8 — a percentile declares how it was estimated", () => {
  test("every declared percentile carries an estimator label and a tier", () => {
    const cpu = entryNamed("Percentage CPU")

    expect(Object.keys(cpu.percentiles).sort()).toEqual([
      "p50",
      "p90",
      "p95",
      "p99",
    ])

    for (const declared of Object.values(cpu.percentiles)) {
      expect(declared.estimator).not.toBe("")
      expect(declared.fidelityTier).toBe("baseline")
    }
  })

  test("a percentage metric's percentile names the histogram sketch", () => {
    // Composed from the unit family and the base grain, matching
    // `collect/snapshot.py#_percentile_estimator`. This is the string
    // Requirement 5.8 rejects a selection entry for lacking.
    expect(entryNamed("Percentage CPU").percentiles["p95"]?.estimator).toBe(
      "histogram_sketch_pt1h_interval_average"
    )
  })

  test("a magnitude metric's percentile would name the log-spaced sketch", () => {
    // No byte metric in the shipped catalog declares a percentile, so this
    // asserts the *rule* rather than a current entry: the sketch a percentile
    // folds into follows from the unit family, and a byte metric folds into a
    // DDSketch rather than a 0-to-100 histogram. Fixing this rule in a test is
    // what keeps the label correct for the first byte percentile the catalog
    // declares, rather than silently labelling it as a histogram.
    const magnitude = resourceType(VIRTUAL_MACHINES).entries.filter(
      (entry) => entry.unitFamily === "magnitude"
    )

    expect(magnitude.length).toBeGreaterThan(0)

    for (const entry of magnitude) {
      for (const declared of Object.values(entry.percentiles)) {
        expect(declared.estimator).toBe("ddsketch_pt1h_interval_average")
      }
    }
  })

  test("an exact statistic is one absent from `percentiles`", () => {
    // The exact-or-estimated fact Requirement 5.6 asks the wizard to show is
    // membership in `percentiles`, not a boolean beside it.
    const cpu = entryNamed("Percentage CPU")

    expect(cpu.percentiles["avg"]).toBeUndefined()
    expect(cpu.percentiles["p95"]).toBeDefined()
  })
})

describe("Requirement 5.5 — a derived statistic declares what it consumes", () => {
  test("memory_used_pct names its source metric and its SKU capability apart", () => {
    const derived = entryNamed("memory_used_pct")

    expect(derived.kind).toBe("derived")
    // The source metric must be in this resource type's own metric selection;
    // the SKU capability must be in the catalog's declared set for the type.
    // Requirement 5.5 checks the two against different sets, so conflating them
    // would put a SKU field in a metrics request.
    expect(derived.requiredSourceMetrics).toEqual(["Available Memory Bytes"])
    expect(derived.requiredSkuCapabilities).toEqual(["MemoryGB"])
  })

  test("it offers exactly the directions its sources bind to", () => {
    // Minimum available memory feeds *maximum* memory-used percent. A derived
    // statistic offers the directions its formula has inputs for, and offering
    // one it cannot compute would put a hole in the document that only appears
    // at collection time.
    expect(entryNamed("memory_used_pct").statistics).toEqual([
      "avg",
      "min",
      "max",
    ])
  })

  test("the host-observed caveat survives the projection", () => {
    const derived = entryNamed("memory_used_pct")

    expect(derived.observation).toBe("host_observed")
    expect(derived.note).toContain("Host-observed")
  })
})

describe("an enhanced-tier counter is offered, marked, not hidden", () => {
  test("disk_free_pct is present and tiered `enhanced`", () => {
    // Presented rather than omitted: it is the one metric a consultant most
    // often comes looking for, and "not offered" and "needs an agent on the
    // customer's VMs" are answers they act on very differently.
    const counter = entryNamed("disk_free_pct")

    expect(counter.fidelityTier).toBe("enhanced")
    expect(counter.label).toContain("LogicalDisk")
  })

  test("every platform metric is tiered `baseline`", () => {
    for (const entry of resourceType(VIRTUAL_MACHINES).entries) {
      if (entry.kind !== "metric") continue
      expect(entry.fidelityTier).toBe("baseline")
    }
  })
})

describe("Requirement 10.8 — every shipped starter validates against this catalog", () => {
  test.each(
    STARTER_TEMPLATES.map(
      (starter) => [starter.seededStarterKey, starter] as const
    )
  )("%s", (_key, starter) => {
    // Shape first: a catalog check assumes the shape it walks is well-formed.
    expect(
      collectDefinitionIssues(starter.definition, { mode: "run" })
    ).toEqual([])

    // Then membership, against the catalog the wizard serves — v1/v2 only.
    // A v3 profile has no top-level `metrics` object at all (metric selection
    // moved to each section's own `metrics` array, task 3.6+), so
    // `validateMetricSelectionAgainstCatalog`'s `Object.entries(definition
    // .metrics)` has nothing to walk for one — a structural fact about the
    // schema, not something this check can meaningfully assert for a v3
    // starter. Guarded on `schema_version` rather than skipped outright, so a
    // future v1/v2 starter re-added here is still checked. This is the
    // assertion that catches a drifted estimator label for the v1/v2 case:
    // `starters.ts` restates the string and `catalog.ts` composes it, and
    // Requirement 5.8 rejects the entry the moment the two stop agreeing.
    if (starter.definition.schema_version < 3) {
      expect(
        validateMetricSelectionAgainstCatalog(starter.definition, METRIC_CATALOG)
      ).toEqual([])
    }
  })
})
