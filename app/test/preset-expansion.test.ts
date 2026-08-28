import { describe, expect, test } from "vitest"

import {
  DEFAULT_PRESET_NAME,
  expandPreset,
  expandPresets,
  matchPresetName,
} from "@/lib/profiles/presets"
import { AZURE_SECTIONS, sectionByKey } from "@/lib/profiles/sections"
import { METRIC_CATALOG } from "@/lib/templates/catalog"
import {
  MAX_METRIC_ITEMS_PER_ENTRY,
  collectDefinitionIssues,
  validateMetricSelectionAgainstCatalog,
} from "@/lib/templates/definition"

/**
 * Preset expansion (Requirement 10.3, 10.7).
 *
 * Presets were declared in the section catalogue, validated by the agent's
 * catalogue loader, and consumed by **nothing** — while both the wizard's
 * `addSection` and all three shipped starters wrote `metrics: []`. Every v3 profile
 * therefore requested zero metrics, the collector asked Azure for nothing, and the
 * run died `NO_STATISTICS` with an empty `collection_log`, so nothing explained the
 * absence.
 *
 * These tests run against the REAL catalogues, not fixtures: the whole point is
 * that a preset the agent's loader accepts expands to metrics this app's own
 * validator also accepts.
 */

const VM_UTILIZATION = "vm_utilization"

describe("expandPreset against the real catalogues", () => {
  test("the default preset is declared by every metric-bearing section", () => {
    // If a metric-bearing entry declared no preset at all, `addSection` would have
    // nothing to seed and the section would silently collect nothing again.
    const metricBearing = AZURE_SECTIONS.filter((e) => e.metric_bearing)
    expect(metricBearing.length).toBeGreaterThan(0)

    for (const entry of metricBearing) {
      expect(
        Object.keys(entry.presets).length,
        `${entry.key} declares no preset`
      ).toBeGreaterThan(0)
    }
  })

  test("standard_utilization on vm_utilization expands to concrete metrics", () => {
    const entry = sectionByKey(VM_UTILIZATION)
    expect(entry).toBeDefined()

    const metrics = expandPreset(entry!, DEFAULT_PRESET_NAME, METRIC_CATALOG)

    expect(metrics.length).toBeGreaterThan(0)
    expect(metrics).toContainEqual({
      metric: "Percentage CPU",
      statistic: "avg",
    })
    // No bare statistic strings, no free text: every item names a metric or a
    // derived statistic plus one statistic.
    for (const item of metrics) {
      expect(
        item.metric !== undefined || item.derived !== undefined,
        `item names neither metric nor derived: ${JSON.stringify(item)}`
      ).toBe(true)
      expect(typeof item.statistic).toBe("string")
    }
  })

  test("every expanded preset passes the app's own catalogue validation", () => {
    // The load-bearing assertion: expansion must produce a selection
    // `validateMetricSelectionAgainstCatalog` accepts, or publishing would refuse
    // what the wizard just wrote.
    for (const entry of AZURE_SECTIONS.filter((e) => e.metric_bearing)) {
      for (const preset of expandPresets(entry, METRIC_CATALOG)) {
        const issues = validateMetricSelectionAgainstCatalog(
          {
            schema_version: 3,
            sections: [
              {
                id: "s1",
                type: entry.key,
                selection: {
                  resource_types: [...entry.needs_resource_types],
                  resource_groups: [],
                  tag_filters: [],
                  top_n: null,
                  sort: null,
                },
                metrics: preset.metrics,
              },
            ],
          } as never,
          METRIC_CATALOG,
          (type) => sectionByKey(type)?.needs_resource_types ?? []
        )

        expect(
          issues,
          `${entry.key}/${preset.name} produced issues: ${JSON.stringify(issues)}`
        ).toStrictEqual([])
      }
    }
  })

  test("a percentile carries the catalogue's estimator and fidelity tier", () => {
    // Requirement 10.7 — `capacity_planning` declares a p95, so this is a live
    // path, and a bare `p95` must be unrepresentable.
    const entry = sectionByKey(VM_UTILIZATION)!
    const metrics = expandPreset(entry, "capacity_planning", METRIC_CATALOG)

    const percentiles = metrics.filter((m) => /^p\d+$/.test(m.statistic))
    expect(percentiles.length).toBeGreaterThan(0)

    for (const item of percentiles) {
      expect(item.estimator, JSON.stringify(item)).toBeTruthy()
      expect(item.fidelity_tier, JSON.stringify(item)).toBeTruthy()
    }
  })

  test("Everything expands to exact statistics only, never a percentile", () => {
    const entry = sectionByKey("historical_vm_utilization")!
    expect(entry.presets.everything).toBe("*")

    const metrics = expandPreset(entry, "everything", METRIC_CATALOG)

    expect(metrics.length).toBeGreaterThan(0)
    expect(metrics.filter((m) => /^p\d+$/.test(m.statistic))).toStrictEqual([])
  })

  test("Everything stays inside the per-entry item cap", () => {
    // Not decoration: exceeding it makes the definition invalid, so a growing
    // catalogue would silently remove the Everything choice (expandPresets omits
    // an over-cap preset) rather than shipping an unsaveable one.
    const entry = sectionByKey("historical_vm_utilization")!
    expect(
      expandPreset(entry, "everything", METRIC_CATALOG).length
    ).toBeLessThanOrEqual(MAX_METRIC_ITEMS_PER_ENTRY)
  })

  test("which default presets expand to NOTHING, exactly", () => {
    // A default preset expanding to zero recreates the very bug this change
    // fixes: the wizard seeds an empty selection, the collector requests nothing,
    // and the run dies NO_STATISTICS with an empty collection_log. So the set is
    // pinned rather than left to be discovered from a failed run.
    //
    // `app_service_and_storage` is currently in it, and the cause is a catalogue
    // inconsistency, not this expander: its preset asks for `avg` on five metrics,
    // and the Metric_Catalog models `avg` as count-weighted — `Total` AND `Count`
    // (`exactStatisticsFor`) — while `Microsoft.Web/sites`'s metrics declare
    // `Total` alone and Storage's declare `Total, Minimum, Maximum`. No `Count`
    // means no derivable average, so every item drops.
    //
    // Deliberately NOT "fixed" by rewriting the preset to `max`: that would turn a
    // section reporting averages into one reporting peaks, which is a different
    // claim about the estate and exactly the kind of quiet substitution a
    // right-sizing report must not make. The real fix is in the catalogues —
    // most likely declaring the `Count` aggregation Azure does provide for these
    // metrics — and `azure-integration.md`'s own rule is that an Azure
    // aggregation fact gets verified against the live API before it is written.
    // Recorded here so it is a known, named defect with a failing consequence
    // (that section collects nothing) rather than an invisible one.
    const empty: string[] = []

    for (const entry of AZURE_SECTIONS.filter(
      (e) => e.metric_bearing && e.presets[DEFAULT_PRESET_NAME] !== undefined
    )) {
      if (
        expandPreset(entry, DEFAULT_PRESET_NAME, METRIC_CATALOG).length === 0
      ) {
        empty.push(entry.key)
      }
    }

    expect(empty).toStrictEqual(["app_service_and_storage"])
  })

  test("every OTHER metric-bearing default preset expands to something", () => {
    for (const entry of AZURE_SECTIONS.filter(
      (e) =>
        e.metric_bearing &&
        e.presets[DEFAULT_PRESET_NAME] !== undefined &&
        e.key !== "app_service_and_storage"
    )) {
      expect(
        expandPreset(entry, DEFAULT_PRESET_NAME, METRIC_CATALOG).length,
        `${entry.key}/${DEFAULT_PRESET_NAME} expands to nothing`
      ).toBeGreaterThan(0)
    }
  })

  test("which declared preset items the catalogues currently DROP, exactly", () => {
    // `expandPreset` skips a declared item whose statistic the Metric_Catalog does
    // not offer for any of the section's types, because keeping it would store a
    // selection the publish-time validator then refuses. That skip is silent, so
    // this pins the current set: the Section_Catalogue asks for `avg` on SQL
    // metrics the Metric_Catalog declares as `['Minimum','Maximum']` only, so no
    // count-weighted average is derivable and the item cannot be honoured.
    //
    // This is a REAL catalogue inconsistency, recorded rather than hidden — the
    // agent's own loader validates that a preset's metric NAME is declared but
    // never that its STATISTIC is. Fixing it belongs in the catalogues (either
    // declare the aggregations or change the preset), and this test fails the
    // moment either side moves, in either direction.
    const dropped: string[] = []

    for (const entry of AZURE_SECTIONS.filter((e) => e.metric_bearing)) {
      for (const [name, declared] of Object.entries(entry.presets)) {
        if (declared === "*") continue
        const expandedCount = expandPreset(entry, name, METRIC_CATALOG).length
        const declaredCount = new Set(
          declared.map((item) => `${item.metric}\u0000${item.statistic}`)
        ).size
        if (expandedCount < declaredCount) {
          dropped.push(
            `${entry.key}/${name}: ${declaredCount} -> ${expandedCount}`
          )
        }
      }
    }

    expect(dropped.sort()).toStrictEqual([
      "app_service_and_storage/standard_utilization: 5 -> 0",
      "database_utilization/standard_utilization: 3 -> 1",
    ])
  })

  test("an undeclared preset name expands to nothing", () => {
    const entry = sectionByKey(VM_UTILIZATION)!
    expect(expandPreset(entry, "no_such_preset", METRIC_CATALOG)).toStrictEqual(
      []
    )
  })

  test("a section needing no resource types expands to nothing", () => {
    // `azure_subscription` is subscription-level and metric-bearing false; nothing
    // to key metrics against, so it must not expand to the whole catalogue.
    const entry = sectionByKey("azure_subscription")!
    expect(expandPresets(entry, METRIC_CATALOG)).toStrictEqual([])
  })
})

describe("matchPresetName", () => {
  const entry = sectionByKey(VM_UTILIZATION)!
  const presets = expandPresets(entry, METRIC_CATALOG)

  test("recognizes an exact preset selection", () => {
    const standard = presets.find((p) => p.name === DEFAULT_PRESET_NAME)!
    expect(matchPresetName(standard.metrics, presets)).toBe(DEFAULT_PRESET_NAME)
  })

  test("order does not matter", () => {
    const standard = presets.find((p) => p.name === DEFAULT_PRESET_NAME)!
    const reversed = [...standard.metrics].reverse()
    expect(matchPresetName(reversed, presets)).toBe(DEFAULT_PRESET_NAME)
  })

  test("a changed selection reads as Custom", () => {
    const standard = presets.find((p) => p.name === DEFAULT_PRESET_NAME)!
    expect(matchPresetName(standard.metrics.slice(1), presets)).toBeNull()
  })

  test("an empty selection reads as Custom, not as a preset", () => {
    expect(matchPresetName([], presets)).toBeNull()
  })
})

describe("a section seeded from the default preset publishes", () => {
  test("the full v3 definition validates in run mode", () => {
    // End to end on the real thing: what `addSection` will now write must survive
    // the publish-time validator, which is where `metrics: []` used to sail through
    // and then collect nothing.
    const entry = sectionByKey(VM_UTILIZATION)!
    const metrics = expandPreset(entry, DEFAULT_PRESET_NAME, METRIC_CATALOG)

    const issues = collectDefinitionIssues(
      {
        schema_version: 3,
        provider: "azure",
        identity: {
          name: "Enesis",
          language: "en",
          description: "",
          report_title: "Enesis",
          customer_name: "Enesis Group",
        },
        sections: [
          {
            id: "sec_1",
            type: VM_UTILIZATION,
            selection: {
              resource_types: [...entry.needs_resource_types],
              resource_groups: [],
              tag_filters: [],
              top_n: null,
              sort: null,
            },
            metrics,
            presentation: "chart_and_table",
          },
        ],
        period: { kind: "last_full_month" },
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
        front_matter: { cover: {}, document_control: {}, toc: {} },
      },
      { mode: "run" }
    )

    expect(issues).toStrictEqual([])
  })
})
