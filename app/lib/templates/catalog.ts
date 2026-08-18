import "server-only"

import rawCatalog from "../../../agent/src/reporting_agent/catalog/metrics.v1.json"

import type {
  MetricCatalogEntry,
  MetricCatalogResourceType,
  MetricCatalogSnapshot,
} from "@/lib/templates/definition"

/**
 * The Metric_Catalog, projected into the shape the wizard's step 4 and
 * `validateMetricSelectionAgainstCatalog` both read (Requirement 5.6).
 *
 * ## One catalog, imported rather than copied
 *
 * `agent/src/reporting_agent/catalog/metrics.v1.json` is the catalog, and this
 * module imports **that file**. Not a copy of it, not a TypeScript restatement of
 * it, not a generated artifact that a build step keeps in step — the same bytes
 * the collector validates at run start, resolved across the monorepo at build
 * time and inlined into the server bundle.
 *
 * Requirement 5.6 asks for this in as many words: the wizard presents "the
 * selectable items from the Metric_Catalog entry for that resource type rather
 * than from a list held in the Web_App, so that one catalog governs both halves."
 * A second declaration here would be a second thing to keep correct, and the
 * failure it produces is quiet — a wizard offering a metric the collector cannot
 * request, or withholding one it can.
 *
 * This is deliberately **not** the mirrored-declaration pattern
 * `lib/templates/blocks.ts` uses for block types. That pattern exists where each
 * half needs the vocabulary as *code* in its own language; here both halves need
 * the same *data*, so there is one file and no guard to write.
 *
 * ## `import "server-only"`
 *
 * The catalog is ~20 KB of JSON that the browser has no reason to carry in a
 * bundle. Step 4 fetches it from `GET /api/templates/catalog`, which is the same
 * boundary the validator's catalog parameter already assumed. Marking the module
 * server-only makes "the browser gets this over the wire" a build error to
 * violate rather than a convention to remember.
 *
 * ## Which statistics a metric offers
 *
 * The catalog declares Azure *aggregations* (`Total`, `Count`, `Minimum`,
 * `Maximum`) and the selection speaks in *statistics* (`avg`, `min`, `max`,
 * `p95`). The mapping is not cosmetic:
 *
 * - **`avg` requires both `Total` and `Count`**, because the average this product
 *   emits is `Σtotal / Σcount` — count-weighted across intervals, never the mean
 *   of interval averages. A metric declaring `Total` without `Count` has no
 *   denominator, so offering `avg` for it would offer a figure the collector
 *   cannot produce correctly.
 * - **`min` and `max` roll up exactly**, so each is offered on its own
 *   aggregation alone.
 * - **Percentiles come from the sketch**, never from an aggregation, so they are
 *   read from the entry's own `percentiles` list.
 */

// --- The catalog file's own shape -------------------------------------------
//
// Typed structurally rather than with a schema parse. The file is a build-time
// import from this repository, reviewed as code and validated on every agent run
// by `catalog/loader.py`; a zod parse here would be a second validator whose
// disagreement with the loader is the only thing it could ever report.

type RawMetric = {
  readonly name: string
  readonly unit: string
  readonly unit_family: string
  readonly aggregations: readonly string[]
  readonly scale: number
  readonly percentiles?: readonly string[]
  readonly label?: string
  readonly interval_scoped?: boolean
}

type RawSource = {
  readonly kind: string
  readonly name: string
  readonly binds?: string
  readonly statistic?: string
  readonly for_statistic?: string
}

type RawDerived = {
  readonly statistic_id: string
  readonly unit: string
  readonly unit_family: string
  readonly scale: number
  readonly formula: string
  readonly sources: readonly RawSource[]
  readonly observation?: string
  readonly note?: string
}

type RawEnhancedCounter = {
  readonly statistic_id: string
  readonly object: string
  readonly counter: string
  readonly unit: string
  readonly unit_family: string
  readonly scale: number
  readonly per_instance?: boolean
}

type RawResourceType = {
  readonly metric_namespace: string
  readonly sku_capabilities?: readonly string[]
  readonly metrics?: readonly RawMetric[]
  readonly derived?: readonly RawDerived[]
  readonly enhanced_counters?: readonly RawEnhancedCounter[]
}

type RawCatalog = {
  readonly catalog_version: string
  readonly resource_types: Readonly<Record<string, RawResourceType>>
}

// --- The statistic vocabulary ------------------------------------------------

/** The three exact directions, in the order `collect/accumulate.py` visits them. */
const EXACT_STATISTICS = ["avg", "min", "max"] as const

const AGGREGATION_TOTAL = "Total"
const AGGREGATION_COUNT = "Count"
const AGGREGATION_MINIMUM = "Minimum"
const AGGREGATION_MAXIMUM = "Maximum"

/**
 * The base collection grain, and the grain every percentile offered at authoring
 * time is labelled against (`azure-integration.md`).
 *
 * A run in a zone whose offset is not a whole number of hours drops to `PT15M`,
 * and its snapshot then records `histogram_sketch_pt15m_interval_average` for the
 * same statistic this module labelled `…_pt1h_…` at selection time. That is not a
 * divergence to reconcile: the definition's label is what the catalog *declares*
 * for the statistic (Requirements 5.7, 5.8), and the snapshot's is what the run
 * *did*. The document renders the ledger's label verbatim, so the reader is told
 * how the number in front of them was produced, not how it was chosen from a menu.
 */
const BASE_GRAIN = "PT1H"

/** `collect/snapshot.py#_percentile_estimator`'s two sketch prefixes. */
const HISTOGRAM_SKETCH_PREFIX = "histogram_sketch"
const DDSKETCH_PREFIX = "ddsketch"

/** What `MetricAccumulator.fold_interval` folds into a sketch: the interval's own average. */
const INTERVAL_STATISTIC_FOLDED = "interval_average"

/** Platform metrics only — no Azure Monitor Agent, no Data Collection Rule. */
const BASELINE_FIDELITY_TIER = "baseline"

/** Requires AMA, a Data Collection Rule and Log Analytics. */
const ENHANCED_FIDELITY_TIER = "enhanced"

/**
 * The estimator label for a sketch-derived percentile, composed exactly as
 * `collect/snapshot.py#_percentile_estimator` composes it: the sketch kind, the
 * source grain folded to lower case, and the interval statistic folded.
 *
 * The sketch kind follows from the unit family, because that is what decides
 * which sketch the collector folds into — a fixed 0-to-100 histogram for a
 * percentage, a log-spaced DDSketch for a magnitude. Reading it from the unit
 * family rather than restating a literal is what keeps a metric added to the
 * catalog tomorrow labelled correctly without an edit here.
 */
function percentileEstimator(unitFamily: string): string {
  const prefix =
    unitFamily === "percentage" ? HISTOGRAM_SKETCH_PREFIX : DDSKETCH_PREFIX

  return `${prefix}_${BASE_GRAIN.toLowerCase()}_${INTERVAL_STATISTIC_FOLDED}`
}

/**
 * The exact statistics a metric's declared aggregations support.
 *
 * `avg` needs `Total` **and** `Count`; see the module docstring for why the
 * conjunction is load-bearing rather than defensive.
 */
function exactStatisticsFor(metric: RawMetric): readonly string[] {
  const declared = new Set(metric.aggregations)

  return EXACT_STATISTICS.filter((statistic) =>
    statistic === "avg"
      ? declared.has(AGGREGATION_TOTAL) && declared.has(AGGREGATION_COUNT)
      : statistic === "min"
        ? declared.has(AGGREGATION_MINIMUM)
        : declared.has(AGGREGATION_MAXIMUM)
  )
}

/** Every percentile the metric declares, with its estimator label and tier. */
function percentilesFor(
  metric: RawMetric
): Readonly<Record<string, { readonly estimator: string; readonly fidelityTier: string }>> {
  const estimator = percentileEstimator(metric.unit_family)
  const entries: Record<
    string,
    { readonly estimator: string; readonly fidelityTier: string }
  > = {}

  for (const percentile of metric.percentiles ?? []) {
    entries[percentile] = { estimator, fidelityTier: BASELINE_FIDELITY_TIER }
  }

  return entries
}

function metricEntry(metric: RawMetric): MetricCatalogEntry {
  const percentiles = percentilesFor(metric)

  return {
    kind: "metric",
    name: metric.name,
    statistics: [...exactStatisticsFor(metric), ...Object.keys(percentiles)],
    percentiles,
    scale: metric.scale,
    unit: metric.unit,
    unitFamily: metric.unit_family,
    fidelityTier: BASELINE_FIDELITY_TIER,
    ...(metric.label === undefined ? {} : { label: metric.label }),
  }
}

/**
 * A derived statistic's entry.
 *
 * The statistics it offers are the **directions its sources bind to** — the
 * `for_statistic` values — rather than a fixed avg/min/max triple. That is the
 * catalog fact that lets *minimum* available memory feed *maximum* memory-used
 * percent: a derived statistic offers exactly the directions its formula has
 * inputs for, and offering one it cannot compute would put a hole in the document
 * that only appears at collection time.
 *
 * `requiredSourceMetrics` excludes `sku_capability` sources and
 * `requiredSkuCapabilities` collects them, because Requirement 5.5 checks the two
 * against different sets: a source metric must be in this resource type's own
 * metric *selection*, while a SKU capability must be in the catalog's own
 * declared set for the type. A capability is not a thing the metrics endpoint has
 * ever heard of, so conflating them would put a SKU field in a metrics request.
 */
function derivedEntry(derived: RawDerived): MetricCatalogEntry {
  const directions = new Set<string>()
  const sourceMetrics = new Set<string>()
  const skuCapabilities = new Set<string>()

  for (const source of derived.sources) {
    if (source.for_statistic !== undefined) directions.add(source.for_statistic)
    if (source.kind === "metric") sourceMetrics.add(source.name)
    if (source.kind === "sku_capability") skuCapabilities.add(source.name)
  }

  return {
    kind: "derived",
    name: derived.statistic_id,
    statistics: EXACT_STATISTICS.filter((statistic) => directions.has(statistic)),
    // A derived statistic is not a percentile, so it declares none — and
    // Requirement 5.8's estimator requirement is keyed on the percentile shape
    // of the statistic name, which none of `avg`/`min`/`max` has.
    percentiles: {},
    requiredSourceMetrics: [...sourceMetrics].sort(),
    requiredSkuCapabilities: [...skuCapabilities].sort(),
    scale: derived.scale,
    unit: derived.unit,
    unitFamily: derived.unit_family,
    fidelityTier: BASELINE_FIDELITY_TIER,
    ...(derived.observation === undefined
      ? {}
      : { observation: derived.observation }),
    ...(derived.note === undefined ? {} : { note: derived.note }),
  }
}

/**
 * An enhanced-tier counter's entry.
 *
 * Presented rather than hidden, and marked `enhanced`, so the wizard can offer it
 * disabled with a reason a consultant can act on — "this needs Azure Monitor
 * Agent and a Data Collection Rule on the customer's VMs" — instead of silently
 * omitting the one metric they came looking for. Requirement 5.6 asks the wizard
 * to present the catalog's items; it does not ask it to present only the easy ones.
 */
function enhancedEntry(counter: RawEnhancedCounter): MetricCatalogEntry {
  return {
    kind: "derived",
    name: counter.statistic_id,
    statistics: [...EXACT_STATISTICS],
    percentiles: {},
    requiredSourceMetrics: [],
    requiredSkuCapabilities: [],
    scale: counter.scale,
    unit: counter.unit,
    unitFamily: counter.unit_family,
    fidelityTier: ENHANCED_FIDELITY_TIER,
    label: `${counter.object} · ${counter.counter}`,
  }
}

function projectResourceType(
  resourceType: string,
  raw: RawResourceType
): MetricCatalogResourceType {
  return {
    resourceType,
    entries: [
      ...(raw.metrics ?? []).map(metricEntry),
      ...(raw.derived ?? []).map(derivedEntry),
      ...(raw.enhanced_counters ?? []).map(enhancedEntry),
    ],
    declaredSkuCapabilities: [...(raw.sku_capabilities ?? [])],
  }
}

/**
 * The catalog, projected once at module load.
 *
 * The projection is pure over a build-time constant, so computing it per request
 * would produce the identical object every time. Frozen at the top level so a
 * route handler cannot hand a caller something that mutates the shared value.
 */
export const METRIC_CATALOG: MetricCatalogSnapshot = Object.freeze(
  Object.entries((rawCatalog as RawCatalog).resource_types).map(
    ([resourceType, raw]) => projectResourceType(resourceType, raw)
  )
)

/** The catalog file's own declared version, served alongside the entries. */
export const METRIC_CATALOG_VERSION: string = (rawCatalog as RawCatalog)
  .catalog_version
