import { describe, expect, it } from "vitest"

import {
  entryKey,
  itemKey,
  metricChoicesFor,
  toggleMetric,
  undeclaredItems,
} from "@/lib/profiles/section-metrics"
import type {
  MetricCatalogEntry,
  MetricCatalogSnapshot,
  MetricSelectionItem,
} from "@/lib/templates/definition"

/**
 * The Custom tier's selection rules.
 *
 * The defect they exist for: `Custom` cleared the section's metrics and said "per-metric
 * choice is not built yet, so a section left on Custom collects nothing" — a third option
 * that produced a section collecting nothing, which is the same defect the preset row was
 * added to fix, one tier down.
 */

const CPU: MetricCatalogEntry = {
  kind: "metric",
  name: "Percentage CPU",
  statistics: ["avg", "max", "p95"],
  percentiles: {
    p95: {
      estimator: "histogram_sketch_pt1h_interval_average",
      fidelityTier: "baseline",
    },
  },
}

const MEMORY: MetricCatalogEntry = {
  kind: "metric",
  name: "Available Memory Bytes",
  statistics: ["avg"],
  percentiles: {},
}

const HEADROOM: MetricCatalogEntry = {
  kind: "derived",
  name: "cpu_headroom",
  statistics: ["avg"],
  percentiles: {},
  requiredSourceMetrics: ["Percentage CPU"],
}

const DISK: MetricCatalogEntry = {
  kind: "metric",
  name: "Composite Disk Read Bytes/sec",
  statistics: ["avg"],
  percentiles: {},
}

const CATALOG: MetricCatalogSnapshot = [
  {
    resourceType: "Microsoft.Compute/virtualMachines",
    entries: [CPU, MEMORY, HEADROOM],
  },
  { resourceType: "Microsoft.Compute/disks", entries: [DISK] },
] as unknown as MetricCatalogSnapshot

const VM = ["Microsoft.Compute/virtualMachines"]

describe("what a section may choose from", () => {
  it("offers only the section's own resource types", () => {
    // A section already declares what it is about. Offering the rest of the catalogue
    // would offer metrics the collector never requests for it.
    const groups = metricChoicesFor(VM, CATALOG, [])
    expect(groups.map((group) => group.resourceType)).toEqual([
      "Microsoft.Compute/virtualMachines",
    ])
  })

  it("offers every statistic each entry declares, including percentiles", () => {
    const [group] = metricChoicesFor(VM, CATALOG, [])
    expect(
      group.choices.map((choice) => `${choice.entry.name}/${choice.statistic}`)
    ).toEqual([
      "Percentage CPU/avg",
      "Percentage CPU/max",
      "Percentage CPU/p95",
      "Available Memory Bytes/avg",
      "cpu_headroom/avg",
    ])
  })

  it("marks a percentile as estimated and nothing else", () => {
    const [group] = metricChoicesFor(VM, CATALOG, [])
    const estimated = group.choices.filter((choice) => choice.estimated)
    expect(estimated.map((choice) => choice.statistic)).toEqual(["p95"])
  })

  it("reflects the section's stored selection", () => {
    const selection = [{ metric: "Percentage CPU", statistic: "max" }]
    const [group] = metricChoicesFor(VM, CATALOG, selection)
    const selected = group.choices.filter((choice) => choice.selected)
    expect(selected.map((choice) => choice.statistic)).toEqual(["max"])
  })

  it("matches a resource type whatever its casing", () => {
    // ARM types are case-insensitive, and a section's declared type and the catalogue's
    // are two strings a human typed at different times.
    const groups = metricChoicesFor(
      ["microsoft.compute/VIRTUALMACHINES"],
      CATALOG,
      []
    )
    expect(groups).toHaveLength(1)
  })

  it("is empty for a section whose types the catalogue does not declare", () => {
    expect(metricChoicesFor(["Microsoft.Web/sites"], CATALOG, [])).toEqual([])
  })
})

describe("toggling one metric", () => {
  it("adds it, and removes it again", () => {
    const added = toggleMetric([], CPU, "avg", true)
    expect(added).toEqual([{ metric: "Percentage CPU", statistic: "avg" }])
    expect(toggleMetric(added, CPU, "avg", false)).toEqual([])
  })

  it("copies the catalogue's estimator and tier onto a percentile", () => {
    // Requirements 5.7, 5.8, 10.7 — a bare `p95` is a rejected save, and the only way to
    // be sure no surface can produce one is to make the surface unable to name a
    // statistic without its catalogue entry.
    expect(toggleMetric([], CPU, "p95", true)).toEqual([
      {
        metric: "Percentage CPU",
        statistic: "p95",
        estimator: "histogram_sketch_pt1h_interval_average",
        fidelity_tier: "baseline",
      },
    ])
  })

  it("puts no estimator on an exactly-rolled-up statistic", () => {
    const [item] = toggleMetric([], CPU, "avg", true)
    expect(item).not.toHaveProperty("estimator")
    expect(item).not.toHaveProperty("fidelity_tier")
  })

  it("writes a derived entry under `derived`, not `metric`", () => {
    expect(toggleMetric([], HEADROOM, "avg", true)).toEqual([
      { derived: "cpu_headroom", statistic: "avg" },
    ])
  })

  it("is idempotent — ticking a checked box changes nothing", () => {
    const once = toggleMetric([], CPU, "avg", true)
    expect(toggleMetric(once, CPU, "avg", true)).toBe(once)
  })

  it("keeps the order things were chosen in", () => {
    // Appended rather than re-sorted: a consultant who ticks three boxes and unticks one
    // should not watch the list reorder itself.
    let selection: readonly MetricSelectionItem[] = []
    selection = toggleMetric(selection, MEMORY, "avg", true)
    selection = toggleMetric(selection, CPU, "avg", true)
    expect(selection.map(itemKey)).toEqual([
      "Available Memory Bytes::avg",
      "Percentage CPU::avg",
    ])
  })

  it("leaves its neighbours alone when one is removed", () => {
    let selection: readonly MetricSelectionItem[] = []
    for (const statistic of ["avg", "max", "p95"]) {
      selection = toggleMetric(selection, CPU, statistic, true)
    }
    expect(toggleMetric(selection, CPU, "max", false).map(itemKey)).toEqual([
      "Percentage CPU::avg",
      "Percentage CPU::p95",
    ])
  })
})

describe("a stored metric the catalogue no longer declares", () => {
  it("is named rather than dropped", () => {
    // Requirement 11.9. Silently removing it would change what a saved profile collects
    // with nobody deciding to.
    const selection = [
      { metric: "Percentage CPU", statistic: "avg" },
      { metric: "Retired Counter", statistic: "avg" },
    ]
    expect(undeclaredItems(VM, CATALOG, selection).map(itemKey)).toEqual([
      "Retired Counter::avg",
    ])
  })

  it("counts a statistic the entry has stopped declaring", () => {
    const selection = [{ metric: "Available Memory Bytes", statistic: "max" }]
    expect(undeclaredItems(VM, CATALOG, selection)).toHaveLength(1)
  })

  it("is none when every item is declared", () => {
    const selection = [
      { metric: "Percentage CPU", statistic: "avg" },
      { derived: "cpu_headroom", statistic: "avg" },
    ]
    expect(undeclaredItems(VM, CATALOG, selection)).toEqual([])
  })
})

describe("the two identity functions agree", () => {
  it("an item built from an entry keys back to that entry", () => {
    for (const statistic of CPU.statistics) {
      const [item] = toggleMetric([], CPU, statistic, true)
      expect(itemKey(item)).toBe(entryKey(CPU, statistic))
    }
  })
})
