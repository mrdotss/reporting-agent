import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { AZURE_SECTIONS } from "@/lib/profiles/sections"
import {
  estimateEmit,
  matchedResourceCount,
  type AuthoredSectionForEstimate,
  type EstimatorCatalogueEntry,
  type TypeCounts,
} from "@/lib/profiles/emit"

/**
 * The emit-estimate mirror, web half (task 3.8).
 *
 * `estimateEmit` in `lib/profiles/emit.ts` and the real Python compiler
 * (`compile/sections.py#expand_sections` plus `compile/blocks/tables.py`'s figure
 * emission) cannot be compared by a static mirror — one is TypeScript, one is
 * Python — so both halves assert against **one committed corpus** instead of
 * against each other.
 * `agent/tests/fixtures/emit-estimate/cases.json` carries the inputs (a
 * catalogue entry key, an authored section, a synthetic scan) and the expected
 * counts; this file runs the TypeScript estimator over them and
 * `agent/tests/test_emit_estimate_mirror.py` compiles a synthetic snapshot built
 * from the same resource counts and asserts the real compiler agrees. A change
 * to the expansion arithmetic that moves the counts fails on both sides or
 * neither.
 *
 * Reading the corpus from `agent/` rather than duplicating it into `app/` is the
 * same decision `scope-union.mirror.test.ts` makes about its own corpus: a
 * second copy is a third thing to keep correct.
 */

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const repoRoot = path.resolve(appRoot, "..")

const CASES_PATH = path.join(
  repoRoot,
  "agent",
  "tests",
  "fixtures",
  "emit-estimate",
  "cases.json"
)

type Case = {
  readonly name: string
  readonly synthetic?: boolean
  readonly catalogue_entry: string
  readonly section: AuthoredSectionForEstimate
  readonly scan_type_counts: TypeCounts
  readonly expected: {
    readonly headings: number
    readonly charts: number
    readonly tables: number
    readonly figures: number
    readonly matches_zero_resources: boolean
  }
}

const corpus = JSON.parse(readFileSync(CASES_PATH, "utf8")) as {
  readonly cases: readonly Case[]
}

/**
 * The two hand-built entries the corpus's `synthetic: true` cases reference. No
 * shipped `resource_table`/`top_n_table` declares a metric-kind column today
 * (confirmed by inspection — see the corpus's own `note`), so these are the only
 * way either language can exercise the `matched × metricColumnCount` arithmetic
 * against something that actually has a metric column. Kept in exact sync with
 * `agent/tests/test_emit_estimate_mirror.py`'s own synthetic entries by both
 * reading the same corpus case names — a change to one without the other fails
 * a corpus-name-lookup case, not a silent divergence.
 */
const SYNTHETIC_ENTRIES: readonly EstimatorCatalogueEntry[] = [
  {
    key: "synthetic_metric_table",
    needs_resource_types: ["Microsoft.Compute/virtualMachines"],
    expands_to: [
      { block: "heading", per: "section" },
      {
        block: "resource_table",
        per: "section",
        config: { columns: [{ metric: "Percentage CPU", statistic: "avg" }] },
      },
    ],
  },
  {
    key: "synthetic_two_metric_table",
    needs_resource_types: ["Microsoft.Compute/virtualMachines"],
    expands_to: [
      { block: "heading", per: "section" },
      {
        block: "resource_table",
        per: "section",
        config: {
          columns: [
            { metric: "Percentage CPU", statistic: "avg" },
            { metric: "Percentage CPU", statistic: "max" },
          ],
        },
      },
    ],
  },
]

/**
 * The real shipped catalogue, narrowed to the estimator's `EstimatorCatalogueEntry`
 * shape, plus the synthetic entries the corpus's `synthetic: true` cases need.
 * Using `AZURE_SECTIONS` directly for the non-synthetic cases (rather than a
 * synthetic catalogue for everything) is deliberate — see the corpus's own
 * `note`: this test is also a live check that the estimator's arithmetic tracks
 * the shipped catalogue, not a frozen copy.
 */
const CATALOGUE: readonly EstimatorCatalogueEntry[] = [
  ...AZURE_SECTIONS,
  ...SYNTHETIC_ENTRIES,
]

describe("the emit-estimate corpus", () => {
  test("is present and non-empty", () => {
    expect(corpus.cases.length).toBeGreaterThan(0)
  })

  test("every non-synthetic catalogue_entry exists in the real shipped catalogue", () => {
    // If this fails, the corpus itself has drifted from the catalogue it claims
    // to test against — a case naming a key the catalogue no longer declares
    // would otherwise silently estimate the zeroed "unknown type" fallback and
    // pass by accident.
    for (const entry of corpus.cases) {
      if (entry.synthetic) continue
      expect(
        AZURE_SECTIONS.some((candidate) => candidate.key === entry.catalogue_entry)
      ).toBe(true)
    }
  })

  test.each(corpus.cases.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      const estimate = estimateEmit(
        entry.section,
        entry.scan_type_counts,
        CATALOGUE
      )

      expect(estimate.headings).toBe(entry.expected.headings)
      expect(estimate.charts).toBe(entry.expected.charts)
      expect(estimate.tables).toBe(entry.expected.tables)
      expect(estimate.figures).toBe(entry.expected.figures)
      expect(estimate.matchesZeroResources).toBe(
        entry.expected.matches_zero_resources
      )
    }
  )

  test("the corpus covers both a matched and a zero-resource case", () => {
    // A corpus of only-matched cases would pass against an implementation that
    // never reports zero, and one of only-zero cases would pass against an
    // implementation that always reports zero.
    const expectations = corpus.cases.map((entry) => entry.expected)

    expect(expectations.some((e) => e.matches_zero_resources)).toBe(true)
    expect(expectations.some((e) => !e.matches_zero_resources)).toBe(true)
  })

  test("the corpus covers both a zero-figure and a positive-figure case", () => {
    const expectations = corpus.cases.map((entry) => entry.expected)

    expect(expectations.some((e) => e.figures === 0)).toBe(true)
    expect(expectations.some((e) => e.figures > 0)).toBe(true)
  })

  test("the corpus exercises the 500-row table cap", () => {
    // Without this, a mutant that dropped the cap entirely would pass every
    // other case if none of them individually exceeded it.
    expect(
      corpus.cases.some(
        (entry) =>
          Object.values(entry.scan_type_counts).reduce((a, b) => a + b, 0) >
          500
      )
    ).toBe(true)
  })
})

describe("matchedResourceCount", () => {
  test("an empty resource_types list is unconstrained — sums every scanned type", () => {
    expect(
      matchedResourceCount([], {
        "microsoft.compute/virtualmachines": 3,
        "microsoft.storage/storageaccounts": 2,
      })
    ).toBe(5)
  })

  test("matching is case-insensitive against the scan's Resource-Graph casing", () => {
    expect(
      matchedResourceCount(
        ["Microsoft.Network/publicIPAddresses"],
        { "microsoft.network/publicipaddresses": 7 }
      )
    ).toBe(7)
  })

  test("a type absent from the scan contributes zero, not an error", () => {
    expect(
      matchedResourceCount(
        ["Microsoft.Network/publicIPAddresses"],
        { "microsoft.compute/virtualmachines": 3 }
      )
    ).toBe(0)
  })
})

describe("estimateEmit — behaviour not covered by the shared corpus", () => {
  test("an unknown section type estimates zero rather than throwing", () => {
    const estimate = estimateEmit(
      { type: "not_a_real_section_type" },
      {},
      CATALOGUE
    )

    expect(estimate).toEqual({
      headings: 0,
      charts: 0,
      tables: 0,
      figures: 0,
      matchesZeroResources: false,
    })
  })

  test("a presentation that excludes a when_presentation-gated block omits it", () => {
    // vm_utilization's timeseries_chart is gated on chart_and_table/chart_only,
    // so table_only excludes it. resource_table is `per: "resource"` and gated
    // on chart_and_table/table_only, so table_only includes it — and since it
    // is per-resource, it contributes ONE table per matched resource (4 here),
    // not one for the whole section. top_n_table carries NO when_presentation
    // gate and is `per: "section"`, so it always emits exactly one, regardless
    // of presentation. table_only therefore counts 4 + 1 = 5 table-family
    // blocks, not one.
    const vmUtilization = CATALOGUE.find((e) => e.key === "vm_utilization")
    expect(vmUtilization).toBeDefined()

    const estimate = estimateEmit(
      {
        type: "vm_utilization",
        selection: { resource_types: ["Microsoft.Compute/virtualMachines"] },
        metrics: [{ metric: "Percentage CPU", statistic: "avg" }],
        presentation: "table_only",
      },
      { "microsoft.compute/virtualmachines": 4 },
      CATALOGUE
    )

    expect(estimate.charts).toBe(0)
    expect(estimate.tables).toBe(5)
  })
})
