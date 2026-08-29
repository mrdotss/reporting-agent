/**
 * The emit estimator (Requirement 11) — a pre-run figure/heading/table/chart count
 * for one authored section, computed from the scan's `type_counts` rather than a
 * snapshot.
 *
 * **Pure.** No fetch, no db. It walks the same `expands_to` sequence
 * `compile/sections.py#expand_sections` walks, but over a scan's resource-type
 * counts instead of a resolved snapshot — the estimate exists precisely because a
 * snapshot does not exist yet at the point a consultant is authoring a section.
 *
 * ## Why this cannot be exact, and does not try to be
 *
 * The compiler's real figure count depends on which resources actually emit a
 * given metric — a deallocated VM, a metric not available for a SKU, a permission
 * gap all subtract from the true count in ways a resource-type count cannot know.
 * This estimator computes the **common-case** arithmetic — every matched resource
 * carries every selected metric — which is the honest upper bound a consultant can
 * see before collection runs, not a claim of exactness. It is capped at the same
 * `MAX_TABLE_ROWS` (500) the compiler applies, since that cap is a fact about the
 * document regardless of how many resources exist.
 *
 * ## What is estimated, and what is deliberately not
 *
 * Headings always contribute 0 figures — `compile_heading` mints no `Figure`
 * (confirmed against `compile/blocks/structure.py`). A `per: "resource"`
 * expansion emits one block **per matched resource**, uncapped by
 * `MAX_TABLE_ROWS` (that cap bounds rows *within* one `per: "section"` table,
 * not how many per-resource blocks a section expands to — confirmed against
 * `compile/sections.py#_expand_one_section`'s `per == "resource"` branch,
 * which iterates the full resolved set with no truncation). A `per: "section"`
 * `resource_table`/`top_n_table` contributes
 * `min(matched, 500) × metricColumnCount` figures, **plus 1** when `matched`
 * exceeds 500 — the compiler's `omitted_row` mints exactly one `Figure` for the
 * truncated count itself (confirmed against `compile/blocks/base.py`).
 * `metricColumnCount` is the number of `{"metric": ..., "statistic": ...}`
 * entries in the expansion's own **static** `config.columns` — declared once
 * per catalogue entry, the same array `read_column_entries` reads on the
 * Python side.
 *
 * **This is deliberately NOT the section's own `metrics` selection.**
 * `compile/sections.py#expand_sections` never reads `section["metrics"]` at
 * all — confirmed by reading the module: nothing in it references the key. A
 * section's authored metric choice is collected by the wizard for a future
 * wiring task (see task 3.5's deferred `subscription_facts`/metric-selection
 * note on tasks.md) but has **zero effect on today's compiled output**. An
 * estimator that scaled with `section.metrics.length` would therefore describe
 * arithmetic the compiler cannot currently perform — a wrong number is worse
 * than an honest one, so this counts what the catalogue's own static config
 * declares, which is what actually compiles today. Every shipped
 * `resource_table`/`top_n_table` entry currently declares zero metric-kind
 * columns (only `attribute`/`fact`), so the real-catalogue estimate is
 * currently always 0 — that is a fact about the shipped catalogue, not a bug in
 * this estimator, and the shared fixture asserts it directly rather than
 * hiding it behind a plausible-looking non-zero number.
 *
 * Declared fact columns contribute 0 regardless, because a fact column mints a
 * `TextFact`, not a `Figure` (`figure_count` counts only
 * `FigureLedger._entries`, confirmed against `compile/blocks/__init__.py` and
 * `compile/figures.py`).
 *
 * Chart figure counts (`timeseries_chart`, `distribution_chart`,
 * `historical_trend`) are **not estimated here** — their real counts depend on
 * day-bucket series length and per-series caps that a resource-type count alone
 * cannot approximate honestly, and a wrong estimate is worse than an omitted one
 * for a number a consultant is meant to trust before anything has run. `charts` in
 * the returned summary counts chart-*blocks* (how many chart panels will appear),
 * not chart *figures* — see the field's own doc comment.
 *
 * ## Case folding, and why it matters here specifically
 *
 * A scan's `type_counts` keys are Resource Graph's own casing — lower-case
 * (`"microsoft.compute/virtualmachines"`) — while the section catalogue declares
 * Azure's canonical casing (`"Microsoft.Compute/virtualMachines"`). Matching by
 * exact string equality would silently estimate zero for every real subscription,
 * which is a worse failure than a stale count: it would read as "this section
 * matches nothing" rather than "the estimator has a bug". Every comparison here
 * case-folds, mirroring `azure/inventory.py#read_counts`'s own `.casefold()`.
 */

/** The scan's per-resource-type counts, as `readTypeCounts` in `lib/scans/view.ts`
 * already types them. Declared locally rather than imported so this module has no
 * dependency on the scan schema's own zod machinery — a pure arithmetic function
 * needs only the shape, not the parser. */
export type TypeCounts = Readonly<Record<string, number>>

/** The catalogue entry shape this estimator needs — a subset of `SectionEntry`
 * from `lib/profiles/sections.ts`, declared locally so this module stays
 * independent of that file's `server-only` boundary (see its own docstring). */
export type EstimatorCatalogueEntry = {
  readonly key: string
  readonly needs_resource_types: readonly string[]
  readonly expands_to: readonly {
    readonly block: string
    readonly per: "section" | "resource"
    readonly config?: Readonly<Record<string, unknown>>
    readonly when_presentation?: readonly string[]
  }[]
}

/** One authored section instance — the shape a v3 definition's `sections` array
 * carries, narrowed to what this estimator reads. */
export type AuthoredSectionForEstimate = {
  readonly type: string
  readonly selection?: {
    readonly resource_types?: readonly string[]
  }
  readonly metrics?: readonly unknown[]
  readonly presentation?: string
}

export type EmitEstimate = {
  /** Count of `heading` expansion blocks this section will emit. Always exact —
   * a heading's count depends only on the catalogue entry, never on the scan. */
  readonly headings: number
  /** Count of chart-family expansion **blocks** (`timeseries_chart`,
   * `distribution_chart`, `historical_trend`) this section will emit, filtered by
   * `presentation`. This is a block count, not a figure count — see the module
   * docstring for why chart figures are not estimated. */
  readonly charts: number
  /** Count of table-family expansion **blocks** (`resource_table`, `top_n_table`,
   * `metric_summary`,
   * `blank_rows_table`) this section will emit, filtered by `presentation`. */
  readonly tables: number
  /** The estimated total `Figure` count from every table-family block —
   * `min(matchedResources, 500) × metricCount`, summed over each table-family
   * block this section emits. 0 for a section that matches zero resources,
   * reported as a fact rather than an error (Requirement 11.4). */
  readonly figures: number
  /** Whether the section's own `needs_resource_types` matched zero resources in
   * the scan — the state the inspector renders in mist neutrals, never as an
   * error (Requirement 11.4). A section with no `needs_resource_types` at all
   * (e.g. `azure_subscription`, which counts the whole subscription) is never
   * zero-matched by definition. */
  readonly matchesZeroResources: boolean
}

/** The count of `{"metric": ..., "statistic": ...}` entries in an expansion's
 * static `config.columns` array. Everything else in `columns` (`attribute` and
 * `fact` kind entries) contributes 0, matching `read_column_entries`'s own
 * three-way split on the Python side. A missing or malformed `columns` config
 * is read as zero columns rather than thrown on — an estimate must not fail a
 * draft the wizard has not yet finished validating. */
function metricColumnCount(
  config: Readonly<Record<string, unknown>> | undefined
): number {
  const columns = config?.columns
  if (!Array.isArray(columns)) return 0

  let count = 0
  for (const column of columns) {
    if (typeof column !== "object" || column === null) continue
    const kind = (column as Record<string, unknown>).kind
    const hasMetricField = "metric" in (column as Record<string, unknown>)
    // A v1-compatible bare metric-ref object has no `kind` at all — the same
    // "absent kind defaults to metric" rule `read_column_entries` applies.
    if (kind === "metric" || (kind === undefined && hasMetricField)) count += 1
  }
  return count
}

const TABLE_FAMILY = new Set([
  "resource_table",
  "top_n_table",
  "blank_rows_table",
  "metric_summary",
])
const CHART_FAMILY = new Set([
  "timeseries_chart",
  "distribution_chart",
  "historical_trend",
])

/** The same cap `compile/blocks/base.py#MAX_TABLE_ROWS` applies. Duplicated as a
 * literal rather than imported, because the two are independent languages and
 * this value is exercised by the shared fixture — a drift between the two shows
 * up as a fixture-comparison failure, which is the whole point of task 3.8's
 * cross-language corpus. */
const MAX_TABLE_ROWS = 500

/**
 * The count of resources in `scan` matching any of `resourceTypes`, case-folded.
 *
 * An empty `resourceTypes` array means "every resource in the subscription" —
 * the same "empty dimension is unconstrained" rule `azure-integration.md` and
 * `scope.py` apply everywhere else in this product — so it sums every count in
 * the scan rather than returning 0.
 */
export function matchedResourceCount(
  resourceTypes: readonly string[],
  scan: TypeCounts
): number {
  if (resourceTypes.length === 0) {
    return Object.values(scan).reduce((sum, count) => sum + count, 0)
  }

  const wanted = new Set(resourceTypes.map((type) => type.toLowerCase()))
  let total = 0
  for (const [type, count] of Object.entries(scan)) {
    if (wanted.has(type.toLowerCase())) total += count
  }
  return total
}

function shouldEmit(
  expansion: EstimatorCatalogueEntry["expands_to"][number],
  presentation: string
): boolean {
  if (!expansion.when_presentation || expansion.when_presentation.length === 0) {
    return true
  }
  return expansion.when_presentation.includes(presentation)
}

/**
 * Estimate what `section` will emit, given `scan`'s resource-type counts and the
 * loaded `catalogue`.
 *
 * Returns a zeroed estimate (every field 0, `matchesZeroResources: false`) for a
 * section whose `type` is not in the catalogue — the caller's job to have
 * validated that already; this function does not raise on it, because an
 * estimate computed mid-authoring must not throw on a draft that has not yet
 * settled on a valid type.
 */
export function estimateEmit(
  section: AuthoredSectionForEstimate,
  scan: TypeCounts,
  catalogue: readonly EstimatorCatalogueEntry[]
): EmitEstimate {
  const entry = catalogue.find((candidate) => candidate.key === section.type)
  if (!entry) {
    return {
      headings: 0,
      charts: 0,
      tables: 0,
      figures: 0,
      matchesZeroResources: false,
    }
  }

  const presentation = section.presentation ?? "chart_and_table"
  const resourceTypes = section.selection?.resource_types ?? []

  const matched = matchedResourceCount(
    resourceTypes.length > 0 ? resourceTypes : entry.needs_resource_types,
    scan
  )
  const cappedMatched = Math.min(matched, MAX_TABLE_ROWS)

  let headings = 0
  let charts = 0
  let tables = 0
  let figures = 0

  for (const expansion of entry.expands_to) {
    if (!shouldEmit(expansion, presentation)) continue

    // A `per: "resource"` expansion emits one block PER matched resource,
    // uncapped by MAX_TABLE_ROWS — that cap is `resource_table`'s own row
    // limit within a single table, not a limit on how many per-resource
    // blocks a section expands to (confirmed against
    // `compile/sections.py#_expand_one_section`'s `per == "resource"` branch,
    // which iterates the FULL resolved set with no truncation).
    const blockMultiplier = expansion.per === "resource" ? matched : 1

    if (expansion.block === "heading") {
      headings += blockMultiplier
    } else if (CHART_FAMILY.has(expansion.block)) {
      charts += blockMultiplier
    } else if (TABLE_FAMILY.has(expansion.block)) {
      tables += blockMultiplier
      const columns = metricColumnCount(expansion.config)
      if (expansion.per === "resource") {
        // Each per-resource table has exactly one row (the resource itself),
        // so its own MAX_TABLE_ROWS cap never applies — one row is never
        // truncated. Figures are simply one row's worth of metric columns,
        // per matched resource.
        figures += matched * columns
      } else {
        figures += cappedMatched * columns
        // The compiler's `omitted_row` (compile/blocks/base.py) emits exactly
        // one additional Figure — the truncated count itself — when a
        // per:"section" table's matched set exceeds MAX_TABLE_ROWS.
        if (matched > MAX_TABLE_ROWS) figures += 1
      }
    }
  }

  // `entry.needs_resource_types.length > 0` is what distinguishes "this section
  // targets a resource type and matched none" from "this section has no resource
  // dimension at all" (azure_subscription, coverage_and_verification, …), which
  // is never a zero-match state by definition — there is nothing for it to match
  // against, so it is not the state the inspector reports as "zero resources".
  const matchesZeroResources = entry.needs_resource_types.length > 0 && matched === 0

  return { headings, charts, tables, figures, matchesZeroResources }
}

/**
 * The profile-level rollup Step 5 states (Requirement 11.6, 11.7): the total
 * estimated figure count across every authored section, and how many sections
 * are estimated to emit zero figures despite carrying a resource dimension.
 */
export function estimateProfileEmit(
  sections: readonly AuthoredSectionForEstimate[],
  scan: TypeCounts,
  catalogue: readonly EstimatorCatalogueEntry[]
): { readonly totalFigures: number; readonly zeroResourceSectionCount: number } {
  let totalFigures = 0
  let zeroResourceSectionCount = 0

  for (const section of sections) {
    const estimate = estimateEmit(section, scan, catalogue)
    totalFigures += estimate.figures
    if (estimate.matchesZeroResources) zeroResourceSectionCount += 1
  }

  return { totalFigures, zeroResourceSectionCount }
}
