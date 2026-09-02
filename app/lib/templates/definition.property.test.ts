import { describe, expect, test } from "vitest"
import fc from "fast-check"

import { BLOCK_CONFIG, type BlockType } from "@/lib/templates/blocks"
import {
  canonicalJsonByteLength,
  canonicalJsonString,
  type CanonicalizableValue,
} from "@/lib/templates/canonical-json"
import {
  DENSITY_VALUES,
  DESIGN_PRESETS,
  MAX_BLOCKS_TOTAL,
  MAX_DEFINITION_CANONICAL_BYTES,
  MAX_RESOURCE_GROUPS,
  MAX_RESOURCE_TYPES,
  MAX_TAG_FILTERS,
  NAME_MAX_LENGTH,
  NON_ROW_BLOCK_TYPES,
  PAGE_SIZE_VALUES,
  PERIOD_KINDS,
  SORT_DIRECTIONS,
  TABLE_STYLE_VALUES,
  collectDefinitionIssues,
  templateDefinitionSchema,
  validateMetricSelectionAgainstCatalog,
  type FieldIssue,
  type MetricCatalogEntry,
  type MetricCatalogResourceType,
  type MetricCatalogSnapshot,
  type TemplateDefinition,
} from "@/lib/templates/definition"

/**
 * **Property 8: definition validation is total and reports every violation.**
 *
 * **Validates: Requirements 2.1, 2.3, 2.7, 2.9, 2.10, 3.1, 3.2, 3.10, 5.1,
 * 5.2, 5.3, 5.5, 5.8, 5.9, 6.3, 6.4, 6.6, 6.7, 6.9, 6.11, 7.1, 7.2, 7.8, 1.3,
 * 45.1, 45.3, 45.4**
 *
 * *For any* generated valid definition carrying any combination of 1–6 injected
 * defects, the `Template_Validator` rejects it and names **every** injected
 * defect by field path in one response.
 *
 * `definition.test.ts` already exemplifies each rule one at a time. What a
 * property adds here is the **combination**, and combination is the whole point:
 * every implementation this property exists to kill passes a one-defect-at-a-time
 * suite.
 *
 * - **A zod schema left at its default strip-unknown-keys behaviour.** An
 *   undeclared top-level key or an undeclared block config field is *accepted*
 *   and silently dropped, so the wizard saves a definition the compiler cannot
 *   compile and the error surfaces minutes later as a failed run (Req 2.3, 6.9).
 * - **A validator that returns the first error.** Six injected defects report as
 *   one, and the consultant fixes them one round-trip at a time (Req 2.7, 6.11).
 *   This is not a hypothetical: zod v4's own structural checks are `abort: true`,
 *   so an `.superRefine()` on an ancestor of an aborted node **does not run at
 *   all** — the module docstring records the empirical finding, and this property
 *   is what keeps it true. The combination that exercises it directly is an
 *   undeclared block type (an abort-shaped defect) beside a duplicate block id
 *   (a defect only a whole-tree walk can see); both are in the draw.
 * - **A nesting check that looks one level down.** `row` nesting is injected at
 *   depth 1, 2 **or** 3, and the expectation names the *innermost* row — the one
 *   a single-level check never reaches (Req 6.4).
 * - **A duplicate-id check that scans only top-level ids.** The duplicate is
 *   planted three ways: two top-level blocks, a row child colliding with a
 *   top-level block, and two children in two *different* row columns with
 *   nothing at top level (Req 6.7).
 * - **A resource-id check that scans only `resource_types`.** The Azure
 *   identifier goes into a **randomly chosen** dimension — `resource_types`,
 *   `resource_groups`, a tag filter key or a tag filter value — of either the
 *   template default `scope` or a randomly chosen block's `scope_override`
 *   (Req 1.3, 3.2).
 *
 * ## How "every defect is named" is asserted
 *
 * Two assertions, because the weaker one alone is passable by accident:
 *
 * 1. every defect has **at least one** matching issue; and
 * 2. a **system of distinct representatives** exists — each defect is assigned
 *    its own issue, no two defects sharing one. Without (2), a validator that
 *    emitted a single catch-all issue matching several predicates would pass (1)
 *    for every defect while having reported one violation.
 *
 * ## "No version row is written; the previously stored definition is
 * byte-identical afterwards"
 *
 * This module is **pure** — no database, no clock, no I/O — so there is no
 * version row for it to write and nothing for it to overwrite. The two
 * checkable stand-ins for that half of the assertion are asserted instead, and
 * they are the two facts a route handler's "no write happened" depends on:
 *
 * - **The gate closes.** `templateDefinitionSchema.safeParse` fails, which is
 *   what stops the caller reaching its write at all.
 * - **The candidate is not mutated.** Validation is compared against a
 *   `structuredClone` taken immediately before the call, both by deep equality
 *   and by **RFC 8785 canonical byte equality** — the literal "byte-identical"
 *   form, and the form `version.ts` will digest (task 3.4).
 *
 * The transactional half — that a rejected save leaves `report_template_versions`
 * untouched — belongs to the route/action tests that own a database.
 *
 * ## Two composition choices, stated rather than assumed
 *
 * **The catalog layer runs unconditionally here, not only on a clean shape.**
 * The module docstring's worked example composes
 * `validateMetricSelectionAgainstCatalog` *after* the shape check has already
 * succeeded. That is right for a caller that only needs a yes/no. It is wrong
 * for Req 2.7's "every failing field path in one response": a definition
 * carrying a shape defect *and* a metric absent from the `Metric_Catalog` would
 * report the shape defect and hide the catalog one. This property therefore runs
 * both layers and concatenates, guarded only on `metrics` being walkable at all
 * (an object of arrays) — because the catalog function documents that it assumes
 * a well-formed shape, and a defect that *removes* `metrics` must not turn a
 * validation failure into a thrown `TypeError`.
 *
 * **Defect kinds are drawn without repetition.** Two duplicate-id defects in one
 * definition are indistinguishable in the response, so "each defect gets its own
 * issue" would be asserting something false about a correct validator. Variation
 * *within* a kind (which nesting depth, which duplicate placement, which scope
 * dimension, which of `0` / `"1"` / `99`) is drawn separately, so the input space
 * is not narrowed by the distinctness rule — only made unambiguous.
 *
 * **Interacting defects are separated by construction, not by tolerance.** Two
 * kinds that fought over one field would mask each other: changing a block's
 * `type` to an undeclared one makes the validator skip that block's config
 * checks by design, so a `rich_text` metric binding injected into the *same*
 * block would correctly go unreported. Rather than weaken the expectation, every
 * block-targeting defect is allocated its **own** block from a reserved pool
 * before any injection runs, and the one kind that deletes a top-level key is
 * applied **last**, over the set of keys no other drawn defect claimed. Each
 * injector records what it claims; `period` and `design` are never claimed by
 * anything, so that last draw always has somewhere to go.
 *
 * ## No declared examples
 *
 * design.md's Property 8 declares none — unlike Properties 5, 6, 7 and 9, whose
 * tables carry a "Declared examples" row. The named cases the kills list calls
 * for are written as ordinary `test()` cases at the bottom of this file instead,
 * where a fixed, readable fixture states the case far better than a generated
 * tuple would. `test/property-hygiene.static.test.ts` records the count as `0`
 * so the ratchet still covers this module.
 */

// --- The Metric_Catalog fixture --------------------------------------------

/**
 * A small, fixed `Metric_Catalog` snapshot.
 *
 * Fixed rather than generated, and small rather than realistic, for one reason:
 * "a metric absent from the catalog" has to be a **real, checkable condition**.
 * The valid generator draws every metric selection out of this fixture, so a
 * name that is not in it is genuinely absent — which a generated catalog could
 * not guarantee without a second uniqueness argument.
 *
 * Shaped after `agent/src/reporting_agent/catalog/metrics.v1.json`: one
 * percentile carrying its estimator label and fidelity tier (Req 5.7, 5.8), and
 * one derived statistic declaring both a source metric and a SKU capability
 * (Req 5.5).
 */
const VM_RESOURCE_TYPE = "Microsoft.Compute/virtualMachines"
const STORAGE_RESOURCE_TYPE = "Microsoft.Storage/storageAccounts"

const CATALOG: MetricCatalogSnapshot = [
  {
    resourceType: VM_RESOURCE_TYPE,
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
      },
      {
        kind: "metric",
        name: "Available Memory Bytes",
        statistics: ["avg", "min", "max"],
        percentiles: {},
      },
      {
        kind: "metric",
        name: "Network In Total",
        statistics: ["avg", "max"],
        percentiles: {},
      },
      {
        kind: "derived",
        name: "memory_used_pct",
        statistics: ["avg", "max"],
        percentiles: {},
        requiredSourceMetrics: ["Available Memory Bytes"],
        requiredSkuCapabilities: ["MemoryGB"],
      },
    ],
  },
  {
    resourceType: STORAGE_RESOURCE_TYPE,
    declaredSkuCapabilities: [],
    entries: [
      {
        kind: "metric",
        name: "UsedCapacity",
        statistics: ["avg", "max"],
        percentiles: {},
      },
      {
        kind: "metric",
        name: "Transactions",
        statistics: ["avg", "max"],
        percentiles: {},
      },
    ],
  },
]

const VM_CATALOG = CATALOG[0]
const STORAGE_CATALOG = CATALOG[1]

/** A name no catalog entry declares, for the "absent from the catalog" defect. */
const UNCATALOGUED_METRIC = "Definitely Not A Catalog Metric"

// --- Mutable working shapes ------------------------------------------------

/**
 * `TemplateDefinition` and friends are deeply `readonly`, which is right for the
 * module's own callers and useless for an injector whose whole job is to
 * introduce a defect. These are the same shapes, mutable, and loose in exactly
 * the places a defect lands: an index signature at the top level and on a block
 * (so an undeclared key or a positioning field is expressible), and `unknown`
 * where a defect substitutes a wrong type.
 */
type MutableTagFilter = { key: unknown; value: unknown }
type MutableTopN = { count?: unknown; metric?: unknown; statistic?: unknown }

type MutableScope = {
  resource_types: unknown[]
  tag_filters: MutableTagFilter[]
  resource_groups: unknown[]
  top_n: MutableTopN | null
  sort: string | null
}

type MutableMetricItem = {
  metric?: string
  derived?: string
  statistic: string
  estimator?: string
  fidelity_tier?: string
}

type MutableBlock = {
  id: string
  type: string
  config?: Record<string, unknown>
  columns?: MutableBlock[][]
  scope_override?: MutableScope
  [injected: string]: unknown
}

type MutableIdentity = {
  name: unknown
  description?: string
  report_title?: string
}

type MutablePeriod = { kind: string; start?: string; end?: string }

type MutableDesign = {
  preset: string
  accent_color: string
  density: string
  table_style: string
  number_format: { decimal_places: number; group_thousands: boolean }
  cover_page: boolean
  logo: string | null
  page_size: string
}

type MutableDefinition = {
  schema_version?: unknown
  identity?: MutableIdentity
  scope?: MutableScope
  period?: MutablePeriod
  metrics?: Record<string, MutableMetricItem[]>
  blocks?: MutableBlock[]
  design?: MutableDesign
  [injected: string]: unknown
}

/** The seven, restated locally — a test that imports its expectations agrees by construction. */
const TOP_LEVEL_KEYS = [
  "schema_version",
  "identity",
  "scope",
  "period",
  "metrics",
  "blocks",
  "design",
] as const

function emptyScope(): MutableScope {
  return {
    resource_types: [],
    tag_filters: [],
    resource_groups: [],
    top_n: null,
    sort: null,
  }
}

function asCanonicalizable(
  definition: MutableDefinition
): CanonicalizableValue {
  return definition as unknown as CanonicalizableValue
}

// --- Path helpers -----------------------------------------------------------

type Path = readonly (string | number)[]

function samePath(a: Path, b: Path): boolean {
  return (
    a.length === b.length && a.every((segment, index) => segment === b[index])
  )
}

function pathText(path: Path): string {
  return path.join(".")
}

/** The block carrying `id`, and the field path the validator would report it at. */
function locateBlock(
  definition: MutableDefinition,
  id: string
): { readonly block: MutableBlock; readonly path: Path } {
  const search = (
    blocks: readonly MutableBlock[],
    prefix: Path
  ): { block: MutableBlock; path: Path } | null => {
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      const path = [...prefix, index]
      if (block.id === id) return { block, path }

      if (Array.isArray(block.columns)) {
        for (let column = 0; column < block.columns.length; column += 1) {
          const found = search(block.columns[column], [
            ...path,
            "columns",
            column,
          ])
          if (found !== null) return found
        }
      }
    }
    return null
  }

  const found = search(definition.blocks ?? [], ["blocks"])
  if (found === null) {
    throw new Error(
      `No block with id "${id}" — the injector and the generator disagree`
    )
  }
  return found
}

/** Every block in the tree, rows and their children included (Requirement 6.3). */
function countBlocks(blocks: readonly MutableBlock[]): number {
  return blocks.reduce((total, block) => {
    const children = (block.columns ?? []).reduce(
      (sum, column) => sum + countBlocks(column),
      0
    )
    return total + 1 + children
  }, 0)
}

// --- Block config generation ------------------------------------------------

/**
 * A value for each config field name `blocks.ts` declares.
 *
 * The validator checks config field **names** and enumerated **values**, not the
 * type of a free-form field (`blocks.ts`'s own docstring says so: the schema is
 * "deliberately shallow — field *names*, not field *types*"). These values are
 * therefore plausible rather than load-bearing; what matters is that every
 * declared field has one, which the coverage test below asserts so a new field
 * in `BLOCK_CONFIG` cannot silently fall through to the generic fallback.
 */
const CONFIG_FIELD_VALUES: Readonly<Record<string, (seed: number) => unknown>> =
  {
    subtitle: (seed) => `Prepared for the July review (${seed})`,
    caption: (seed) => `Figure caption ${seed}`,
    show_fidelity: (seed) => seed % 2 === 0,
    metrics: (seed) =>
      seed % 2 === 0
        ? ["Percentage CPU|avg"]
        : ["Percentage CPU|avg", "Available Memory Bytes|avg"],
    // `resource_name` is deliberately **absent**: Requirement 12.3 rejects an explicit column
    // naming what the table already emits, and this generator's contract is that every
    // definition it produces is valid. It used to emit `resource_name` and the new rule caught
    // it immediately, which is the generator working as intended — a defect the generator
    // itself introduces would make every other property in this file assert against an invalid
    // definition.
    columns: (seed) =>
      seed % 3 === 0
        ? ["resource_group"]
        : ["resource_group", "Percentage CPU|avg"],
    order_by: () => "Percentage CPU|avg",
    capacity_metric: () => "vCPUsAvailable",
    usage_metric: () => "Percentage CPU|avg",
    run_a: () => "run-earlier",
    run_b: () => "run-later",
    level: (seed) => 1 + (seed % 4),
    text: (seed) => `Static prose, paragraph ${seed}.`,
    // historical_trend — `metric` and `statistic` are placeholders here; the
    // `leaf()` builder overrides them with values drawn from the definition's
    // own metric selection (the schema rejects a metric absent from it).
    metric: () => "Percentage CPU",
    statistic: () => "avg",
    lookback: (seed) => 2 + (seed % 23),
    // blank_rows_table — the count of ruled EMPTY rows section 13 prints for an author
    // to complete by hand. Bounded well inside the schema's range so the generator
    // cannot emit a definition its own validator would reject.
    rows: (seed) => 1 + (seed % 8),
    // blank_rows_table — author-supplied incident rows. Always `[]` here rather
    // than a generated row of text: each entry must have exactly `columns.length`
    // strings, and `columns` above is generated independently (and shared across
    // several block types with different shapes), so there is no seed-derived
    // value this provider could produce that is guaranteed to match without
    // reaching into another field's own generator. An empty list is valid at
    // every seed and exercises the field's presence — the actual multi-row,
    // length-matching path is covered directly in `test_blocks.py` and this
    // file's own compile-path tests instead, not by the generator.
    supplied_rows: () => [],
    // inventory_summary — which grouping the block reports the estate at. Cycled
    // rather than pinned, so the generator exercises the pairs shape
    // (`subscription`) and the rollup shape (the other three) alike.
    group_by: (seed) =>
      ["subscription", "resource_group", "region", "resource_type"][seed % 4],
    // resource_table — `rows` stacks a resource's columns down the page for a
    // section that expands per machine; `pairs` is the other declared value.
    layout: (seed) => (seed % 2 === 0 ? "rows" : "pairs"),
    // metric_summary — `resource_major` is the fleet table (a row per machine);
    // `statistic_major` is one machine's own page, a table per metric with a row per
    // statistic. The second exists because the fleet shape does not fit A4 once a
    // byte-valued metric and an estimated percentile share a table.
    orientation: (seed) =>
      seed % 2 === 0 ? "resource_major" : "statistic_major",
  }

type BlockConfigSchemaShape = {
  readonly required: readonly string[]
  readonly optional: readonly string[]
  readonly enums: Readonly<Record<string, readonly string[]>>
}

function configSchemaFor(blockType: BlockType): BlockConfigSchemaShape {
  // A cast rather than a union index: `BLOCK_CONFIG[blockType]` over a union of
  // fifteen keys is a union of fifteen literal shapes, and `.forEach` over a
  // union of readonly tuples has no callable signature TypeScript will accept.
  return BLOCK_CONFIG[blockType] as BlockConfigSchemaShape
}

function configValueFor(field: string, seed: number): unknown {
  const provider = CONFIG_FIELD_VALUES[field]
  return provider === undefined ? `value-${seed}` : provider(seed)
}

function configFor(
  blockType: Exclude<BlockType, "row">,
  seed: number,
  optionalMask: readonly boolean[]
): Record<string, unknown> {
  const schema = configSchemaFor(blockType)
  const config: Record<string, unknown> = {}

  schema.required.forEach((field, index) => {
    config[field] = configValueFor(field, seed + index)
  })

  schema.optional.forEach((field, index) => {
    if (optionalMask[index % optionalMask.length]) {
      config[field] = configValueFor(field, seed + index)
    }
  })

  Object.entries(schema.enums).forEach(([field, permitted], index) => {
    if (optionalMask[(index + 1) % optionalMask.length]) {
      config[field] = permitted[seed % permitted.length]
    }
  })

  return config
}

// --- Metric selection generation -------------------------------------------

function metricItemFor(
  entry: MetricCatalogEntry,
  seed: number
): MutableMetricItem {
  const statistic = entry.statistics[seed % entry.statistics.length]
  const item: MutableMetricItem =
    entry.kind === "metric"
      ? { metric: entry.name, statistic }
      : { derived: entry.name, statistic }

  // Requirements 5.7, 5.8 — a percentile carries the catalog's own estimator
  // label and fidelity tier, drawn from the catalog rather than composed here,
  // so the catalog layer agrees with the shape layer on a valid definition.
  const percentile = entry.percentiles[statistic]
  if (percentile !== undefined) {
    item.estimator = percentile.estimator
    item.fidelity_tier = percentile.fidelityTier
  }

  return item
}

type EntryDraw = readonly [include: boolean, statisticSeed: number]

function metricItemsFor(
  resourceType: MetricCatalogResourceType,
  draws: readonly EntryDraw[]
): MutableMetricItem[] {
  const chosen = new Set<number>()
  resourceType.entries.forEach((_, index) => {
    if (draws[index][0]) chosen.add(index)
  })
  // Requirement 5.1 — an entry names at least one item.
  if (chosen.size === 0) chosen.add(0)

  // Requirement 5.5 — a derived statistic's source metrics must also be
  // selected, so the generator closes over them rather than emitting a
  // definition the catalog layer would (correctly) reject.
  for (const index of [...chosen]) {
    for (const source of resourceType.entries[index].requiredSourceMetrics ??
      []) {
      const sourceIndex = resourceType.entries.findIndex(
        (entry) => entry.kind === "metric" && entry.name === source
      )
      if (sourceIndex >= 0) chosen.add(sourceIndex)
    }
  }

  return [...chosen]
    .sort((a, b) => a - b)
    .map((index) => metricItemFor(resourceType.entries[index], draws[index][1]))
}

function entryDrawsArb(
  resourceType: MetricCatalogResourceType
): fc.Arbitrary<EntryDraw[]> {
  return fc.array(fc.tuple(fc.boolean(), fc.nat({ max: 64 })), {
    minLength: resourceType.entries.length,
    maxLength: resourceType.entries.length,
  })
}

/**
 * The virtual-machine entry is always present, so the percentile defect always
 * has a resource type to attach `p95` to. Storage is optional, so the selection
 * varies in width as well as in depth.
 */
const metricsArb: fc.Arbitrary<Record<string, MutableMetricItem[]>> = fc
  .record({
    vm: entryDrawsArb(VM_CATALOG),
    storage: entryDrawsArb(STORAGE_CATALOG),
    includeStorage: fc.boolean(),
  })
  .map(({ vm, storage, includeStorage }) => {
    const metrics: Record<string, MutableMetricItem[]> = {
      [VM_RESOURCE_TYPE]: metricItemsFor(VM_CATALOG, vm),
    }
    if (includeStorage) {
      metrics[STORAGE_RESOURCE_TYPE] = metricItemsFor(STORAGE_CATALOG, storage)
    }
    return metrics
  })

// --- Scope generation -------------------------------------------------------

/**
 * Resource types, tag keys, tag values and resource group names are drawn from
 * prefixed, fixed vocabularies rather than from `fc.string`, because
 * Requirement 1.3's check is a **shape** check: a freely generated string could
 * land on a bare GUID and make a valid definition invalid. The Azure-shaped
 * values are injected deliberately by their own defect, never by accident.
 */
const RESOURCE_TYPE_NAMES = [
  "Microsoft.Compute/virtualMachines",
  "Microsoft.Storage/storageAccounts",
  "Microsoft.Network/networkInterfaces",
  "Microsoft.Sql/servers/databases",
] as const
const TAG_KEYS = ["env", "owner", "tier", "cost-center"] as const
const TAG_VALUES = ["prod", "staging", "dev", "platform-team"] as const
const RESOURCE_GROUP_WORDS = ["core", "data", "web", "shared"] as const

const scopeArb: fc.Arbitrary<MutableScope> = fc.record({
  resource_types: fc.uniqueArray(fc.constantFrom(...RESOURCE_TYPE_NAMES), {
    maxLength: RESOURCE_TYPE_NAMES.length,
  }),
  tag_filters: fc.array(
    fc.record({
      key: fc.constantFrom(...TAG_KEYS),
      value: fc.constantFrom(...TAG_VALUES),
    }),
    // One below the bound, so the over-bound defect and the Azure-identifier
    // defect can each append to `tag_filters` without either one accidentally
    // creating the other's violation.
    { maxLength: MAX_TAG_FILTERS - 2 }
  ),
  resource_groups: fc.uniqueArray(
    fc
      .tuple(fc.constantFrom(...RESOURCE_GROUP_WORDS), fc.nat({ max: 40 }))
      .map(([word, index]) => `rg-${word}-${index}`),
    { maxLength: 6 }
  ),
  top_n: fc.option(
    fc.record({
      count: fc.integer({ min: 1, max: 500 }),
      metric: fc.constantFrom("Percentage CPU", "UsedCapacity"),
      statistic: fc.constantFrom("avg", "max"),
    }),
    { nil: null }
  ),
  sort: fc.option(fc.constantFrom(...SORT_DIRECTIONS), { nil: null }),
})

// --- Period generation ------------------------------------------------------

const MS_PER_DAY = 86_400_000

function addLocalDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number)
  const at = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY)
  return [
    String(at.getUTCFullYear()).padStart(4, "0"),
    String(at.getUTCMonth() + 1).padStart(2, "0"),
    String(at.getUTCDate()).padStart(2, "0"),
  ].join("-")
}

const periodArb: fc.Arbitrary<MutablePeriod> = fc.oneof(
  fc
    .constantFrom(...PERIOD_KINDS.filter((kind) => kind !== "custom"))
    .map((kind) => ({ kind })),
  // Requirement 4.2 — an inclusive span of 1 to 31 local days, so `span` runs
  // 0 to 30 added days.
  fc
    .tuple(fc.integer({ min: 0, max: 400 }), fc.integer({ min: 0, max: 30 }))
    .map(([offset, span]) => {
      const start = addLocalDays("2026-01-01", offset)
      return { kind: "custom", start, end: addLocalDays(start, span) }
    })
)

// --- Design generation ------------------------------------------------------

const designArb: fc.Arbitrary<MutableDesign> = fc.record({
  preset: fc.constantFrom(...DESIGN_PRESETS),
  accent_color: fc.constantFrom("#1f6f78", "#0f766e", "oklch(0.52 0.105 223)"),
  density: fc.constantFrom(...DENSITY_VALUES),
  table_style: fc.constantFrom(...TABLE_STYLE_VALUES),
  number_format: fc.record({
    decimal_places: fc.integer({ min: 0, max: 3 }),
    group_thousands: fc.boolean(),
  }),
  cover_page: fc.boolean(),
  logo: fc.option(fc.constantFrom("logo.png", "brand/logo.svg"), { nil: null }),
  page_size: fc.constantFrom(...PAGE_SIZE_VALUES),
})

// --- Block generation -------------------------------------------------------

type LeafDraw = {
  readonly type: Exclude<BlockType, "row">
  readonly seed: number
  readonly optionalMask: readonly boolean[]
  readonly scopeOverride: MutableScope | null
}

type RowDraw = {
  readonly columns: readonly (readonly LeafDraw[])[]
}

const leafDrawArb: fc.Arbitrary<LeafDraw> = fc.record({
  type: fc.constantFrom(...NON_ROW_BLOCK_TYPES),
  seed: fc.nat({ max: 512 }),
  optionalMask: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  // Requirement 3.2 — a per-block override on some blocks and not others, so
  // "inheriting" and "narrowed" are both in the generated space.
  scopeOverride: fc.option(scopeArb, { nil: null }),
})

/**
 * The row the injectors reserve. Columns 0 and 1 always hold at least one child,
 * because two of the three duplicate-id placements need a child in a row column
 * and one of them needs a child in **two different** row columns. Every other
 * generated row is free-shaped, so the 0-children and 8-children column edges
 * are still reached (Requirement 6.4's `MAX_CHILDREN_PER_COLUMN`).
 */
const reservedRowArb: fc.Arbitrary<RowDraw> = fc
  .record({
    columnCount: fc.constantFrom(2, 3),
    first: fc.array(leafDrawArb, { minLength: 1, maxLength: 3 }),
    second: fc.array(leafDrawArb, { minLength: 1, maxLength: 3 }),
    third: fc.array(leafDrawArb, { maxLength: 3 }),
  })
  .map(({ columnCount, first, second, third }) => ({
    columns: columnCount === 2 ? [first, second] : [first, second, third],
  }))

const freeRowArb: fc.Arbitrary<RowDraw> = fc
  .record({
    columnCount: fc.constantFrom(2, 3),
    columns: fc.array(fc.array(leafDrawArb, { maxLength: 8 }), {
      minLength: 3,
      maxLength: 3,
    }),
  })
  .map(({ columnCount, columns }) => ({
    columns: columns.slice(0, columnCount),
  }))

/** How many top-level leaf blocks the injectors may claim exclusively. */
const POOL_SIZE = 6

type DefinitionDraw = {
  readonly name: string
  readonly description: string | null
  readonly reportTitle: string | null
  readonly scope: MutableScope
  readonly period: MutablePeriod
  readonly metrics: Record<string, MutableMetricItem[]>
  readonly design: MutableDesign
  readonly poolLeaves: readonly LeafDraw[]
  readonly richTextSeed: number
  readonly reservedRow: RowDraw
  readonly extraLeaves: readonly LeafDraw[]
  readonly extraRows: readonly RowDraw[]
  readonly rotation: number
}

type ValidCase = {
  readonly definition: MutableDefinition
  readonly reserved: {
    /** A `rich_text` block, for the "rich_text binds a metric" defect. */
    readonly richTextBlockId: string
    /** A top-level `row`, for the nesting and duplicate-in-a-column defects. */
    readonly rowBlockId: string
    readonly rowColumnChildIds: readonly (readonly string[])[]
    /** Top-level leaf blocks, allocated one per block-targeting defect. */
    readonly poolBlockIds: readonly string[]
    readonly metricResourceTypes: readonly string[]
  }
}

function buildValidCase(draw: DefinitionDraw): ValidCase {
  // Ids are counter-based rather than generated: uniqueness across the whole
  // tree is a hard rule (Requirement 6.7), and a generator that hoped random
  // strings would not collide would produce invalid base definitions at a low
  // rate — which is exactly the failure that makes every later assertion
  // meaningless.
  let counter = 0
  const nextId = (): string => {
    counter += 1
    return `blk-${String(counter).padStart(4, "0")}`
  }

  // Requirement 5.9 — a resource type a scope names needs an entry in `metrics`.
  // `scopeArb` and `metricsArb` are drawn independently, so the coupling is applied
  // here: every scope's `resource_types` is narrowed to the types this draw's metric
  // selection actually covers.
  //
  // Narrowing rather than widening, and folded case, for two separate reasons. A
  // widened `metrics` would have to name a resource type the CATALOG snapshot above
  // does not declare, which the catalog layer then rejects — and the generator-validity
  // test asserts that layer returns nothing. Folding matches the validator (Requirement
  // 3.12); comparing exactly here would silently drop every drawn type and leave the
  // scope dimension unexercised, which is a generator that passes by generating less.
  const selectedTypes = new Set(
    Object.keys(draw.metrics).map((resourceType) => resourceType.toLowerCase())
  )
  const selectable = (scope: MutableScope): MutableScope => ({
    ...scope,
    resource_types: scope.resource_types.filter(
      (entry) =>
        typeof entry === "string" && selectedTypes.has(entry.toLowerCase())
    ),
  })

  const leaf = (leafDraw: LeafDraw): MutableBlock => {
    const block: MutableBlock = {
      id: nextId(),
      type: leafDraw.type,
      config: configFor(leafDraw.type, leafDraw.seed, leafDraw.optionalMask),
    }
    // Requirement 18.1 — `historical_trend` config names a metric and statistic
    // that must already appear in the definition's own metric selection.  Draw
    // from it deterministically so the generated definition stays valid.
    if (leafDraw.type === "historical_trend" && block.config !== undefined) {
      const entries = Object.values(draw.metrics).flat()
      const picked = entries[leafDraw.seed % entries.length]
      block.config.metric = picked.metric ?? picked.derived ?? entries[0].metric
      block.config.statistic = picked.statistic
    }
    if (leafDraw.scopeOverride !== null)
      block.scope_override = selectable(leafDraw.scopeOverride)
    return block
  }

  const row = (rowDraw: RowDraw): MutableBlock => ({
    id: nextId(),
    type: "row",
    columns: rowDraw.columns.map((column) => column.map(leaf)),
  })

  const poolBlocks = draw.poolLeaves.map(leaf)
  const richTextBlock: MutableBlock = {
    id: nextId(),
    type: "rich_text",
    config: { text: `Static prose ${draw.richTextSeed}.` },
  }
  const reservedRow = row(draw.reservedRow)
  const otherBlocks = [
    ...draw.extraLeaves.map(leaf),
    ...draw.extraRows.map(row),
  ]

  const ordered = [...poolBlocks, richTextBlock, reservedRow, ...otherBlocks]
  // Rotated rather than shuffled. The only thing block order changes is *which*
  // of two colliding ids the walk reports (the second one it reaches), and every
  // duplicate-id expectation below is written to accept either — a rotation is
  // enough to put the reserved row before and after the pool.
  const offset = draw.rotation % ordered.length
  const blocks = [...ordered.slice(offset), ...ordered.slice(0, offset)]

  const identity: MutableIdentity = { name: draw.name }
  // Absent, not present-and-`undefined`: RFC 8785 cannot represent `undefined`,
  // so `canonicalJsonByteLength` would throw on the key rather than measure it.
  if (draw.description !== null) identity.description = draw.description
  if (draw.reportTitle !== null) identity.report_title = draw.reportTitle

  const definition: MutableDefinition = {
    schema_version: 1,
    identity,
    scope: selectable(draw.scope),
    period: draw.period,
    metrics: draw.metrics,
    blocks,
    design: draw.design,
  }

  return {
    definition,
    reserved: {
      richTextBlockId: richTextBlock.id,
      rowBlockId: reservedRow.id,
      rowColumnChildIds: (reservedRow.columns ?? []).map((column) =>
        column.map((child) => child.id)
      ),
      poolBlockIds: poolBlocks.map((block) => block.id),
      metricResourceTypes: Object.keys(draw.metrics),
    },
  }
}

const validCaseArb: fc.Arbitrary<ValidCase> = fc
  .record({
    // Requirement 2.10 — 1 to 120 characters. `unit: "binary"` reaches astral
    // planes, combining marks and control characters, where a length check
    // counting the wrong unit or a canonicalizer escaping the wrong thing would
    // break. 40 code points is at most 80 UTF-16 units, comfortably inside 120.
    name: fc.string({ unit: "binary", minLength: 1, maxLength: 40 }),
    description: fc.option(fc.string({ maxLength: 120 }), { nil: null }),
    reportTitle: fc.option(fc.string({ maxLength: 60 }), { nil: null }),
    scope: scopeArb,
    period: periodArb,
    metrics: metricsArb,
    design: designArb,
    poolLeaves: fc.array(leafDrawArb, {
      minLength: POOL_SIZE,
      maxLength: POOL_SIZE,
    }),
    richTextSeed: fc.nat({ max: 512 }),
    reservedRow: reservedRowArb,
    extraLeaves: fc.array(leafDrawArb, { maxLength: 6 }),
    extraRows: fc.array(freeRowArb, { maxLength: 2 }),
    rotation: fc.nat({ max: 128 }),
  })
  .map(buildValidCase)

// --- Composing both validation layers ---------------------------------------

function metricsAreWalkable(candidate: unknown): boolean {
  if (typeof candidate !== "object" || candidate === null) return false
  const { metrics } = candidate as { metrics?: unknown }
  if (
    typeof metrics !== "object" ||
    metrics === null ||
    Array.isArray(metrics)
  ) {
    return false
  }
  return Object.values(metrics as Record<string, unknown>).every((items) =>
    Array.isArray(items)
  )
}

/**
 * The shape layer and the `Metric_Catalog` layer, concatenated — the "one
 * response" Requirement 2.7 names. See the module docstring for why this
 * composes unconditionally rather than gating the catalog layer behind a clean
 * shape.
 */
function collectAllIssues(candidate: MutableDefinition): FieldIssue[] {
  const shapeIssues = collectDefinitionIssues(candidate)
  const catalogIssues = metricsAreWalkable(candidate)
    ? validateMetricSelectionAgainstCatalog(
        candidate as unknown as TemplateDefinition,
        CATALOG
      )
    : []
  return [...shapeIssues, ...catalogIssues]
}

// --- Defects ----------------------------------------------------------------

/**
 * How to recognize one injected defect in the response.
 *
 * A predicate rather than a `{ pathPrefix, messagePattern }` pair, because the
 * defects differ in what identifies them: a duplicate id is identified by the
 * **block id in the message** (whichever of the two colliding occurrences the
 * walk reaches second), a positioning field by its **exact path**, an
 * over-bound dimension by both.
 */
type Expectation = {
  readonly label: string
  readonly describe: string
  readonly matches: (issue: FieldIssue) => boolean
}

type Injection = {
  readonly expectations: readonly Expectation[]
  /**
   * The top-level keys this defect needs to survive. `missing_required_key`
   * runs last and drops a key nothing claimed, so no two drawn defects can
   * cancel each other out.
   */
  readonly claims: readonly string[]
}

const DEFECT_KINDS = [
  "undeclared_top_level_key",
  "schema_version_invalid",
  "name_length_invalid",
  "scope_dimension_over_bound",
  "top_n_without_metric",
  "metric_absent_from_catalog",
  "percentile_without_estimator",
  "undeclared_block_type",
  "rich_text_binds_metric",
  "absolute_position_field",
  "duplicate_block_id",
  "row_nested_in_row",
  "azure_identifier_in_scope",
  "too_many_blocks",
  "oversize_canonical_body",
  // Last, deliberately: it reads the claims every other drawn defect recorded.
  "missing_required_key",
] as const

type DefectKind = (typeof DEFECT_KINDS)[number]

/**
 * Defects only the `Metric_Catalog` layer can see, so
 * `templateDefinitionSchema.safeParse` accepts them on its own (Requirement 5.2,
 * and the module docstring's "Layering" section). Named as a set rather than
 * inlined, because "which defects the shape schema alone does not catch" is a
 * fact about the module's layering that a reader of this property needs.
 */
const CATALOG_ONLY_DEFECT_KINDS: ReadonlySet<DefectKind> = new Set<DefectKind>([
  "metric_absent_from_catalog",
])

type Variants = {
  readonly undeclaredTopLevelKey: string
  readonly missingKeyPick: number
  readonly undeclaredBlockType: string
  readonly nestingDepth: number
  readonly duplicateVariant:
    "top_level_pair" | "row_child_and_top_level" | "two_row_columns"
  readonly positioningPlacement: "block" | "config"
  readonly positioningField: string
  readonly schemaVersionValue: number | string
  readonly nameLength: number
  readonly scopeDimension: "resource_types" | "tag_filters" | "resource_groups"
  readonly azureLocation: "template" | "block"
  readonly azureDimension:
    "resource_types" | "resource_groups" | "tag_key" | "tag_value"
  readonly azureShape: "resource_id" | "subscription_id" | "tenant_id"
  readonly metricResourceTypePick: number
  readonly poolOffset: number
}

const variantsArb: fc.Arbitrary<Variants> = fc.record({
  undeclaredTopLevelKey: fc.constantFrom(
    "layout",
    "notes",
    "version",
    "blocks_v2"
  ),
  missingKeyPick: fc.nat({ max: 32 }),
  undeclaredBlockType: fc.constantFrom(
    "kpi_grid",
    "table",
    "ROW",
    "cover_page",
    ""
  ),
  nestingDepth: fc.integer({ min: 1, max: 3 }),
  duplicateVariant: fc.constantFrom(
    "top_level_pair" as const,
    "row_child_and_top_level" as const,
    "two_row_columns" as const
  ),
  positioningPlacement: fc.constantFrom("block" as const, "config" as const),
  positioningField: fc.constantFrom(
    "position",
    "coordinate_x",
    "offset_top",
    "x",
    "absolute_width",
    "page_number"
  ),
  schemaVersionValue: fc.constantFrom<number | string>(0, "1", 99),
  nameLength: fc.constantFrom(0, NAME_MAX_LENGTH + 1),
  scopeDimension: fc.constantFrom(
    "resource_types" as const,
    "tag_filters" as const,
    "resource_groups" as const
  ),
  azureLocation: fc.constantFrom("template" as const, "block" as const),
  azureDimension: fc.constantFrom(
    "resource_types" as const,
    "resource_groups" as const,
    "tag_key" as const,
    "tag_value" as const
  ),
  azureShape: fc.constantFrom(
    "resource_id" as const,
    "subscription_id" as const,
    "tenant_id" as const
  ),
  metricResourceTypePick: fc.nat({ max: 32 }),
  poolOffset: fc.nat({ max: 32 }),
})

/** A fully qualified resource id, a subscription id and a tenant id (Requirement 1.3). */
const AZURE_RESOURCE_ID =
  "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-core" +
  "/providers/Microsoft.Compute/virtualMachines/prod-sql-01"
const AZURE_SUBSCRIPTION_ID = "22222222-2222-2222-2222-222222222222"
const AZURE_TENANT_ID = "33333333-3333-3333-3333-333333333333"

type InjectorContext = {
  readonly definition: MutableDefinition
  readonly reserved: ValidCase["reserved"]
  readonly variants: Variants
  /** Block ids reserved for this defect alone, one per `POOL_BLOCKS_NEEDED`. */
  readonly poolIds: readonly string[]
  /** Every key claimed by the defects applied before this one. */
  readonly claimed: ReadonlySet<string>
}

type Injector = (context: InjectorContext) => Injection

/** How many exclusive top-level leaf blocks each kind needs. */
const POOL_BLOCKS_NEEDED: Readonly<
  Record<DefectKind, (variants: Variants) => number>
> = {
  undeclared_top_level_key: () => 0,
  schema_version_invalid: () => 0,
  name_length_invalid: () => 0,
  scope_dimension_over_bound: () => 0,
  top_n_without_metric: () => 0,
  metric_absent_from_catalog: () => 0,
  percentile_without_estimator: () => 0,
  undeclared_block_type: () => 1,
  rich_text_binds_metric: () => 0,
  absolute_position_field: () => 1,
  duplicate_block_id: (variants) =>
    variants.duplicateVariant === "top_level_pair"
      ? 2
      : variants.duplicateVariant === "row_child_and_top_level"
        ? 1
        : 0,
  row_nested_in_row: () => 0,
  azure_identifier_in_scope: (variants) =>
    variants.azureLocation === "block" ? 1 : 0,
  too_many_blocks: () => 0,
  oversize_canonical_body: () => 0,
  missing_required_key: () => 0,
}

const INJECTORS: Readonly<Record<DefectKind, Injector>> = {
  // Requirement 2.3 — an undeclared key is *named*, never stripped.
  undeclared_top_level_key: ({ definition, variants }) => {
    const key = variants.undeclaredTopLevelKey
    definition[key] = "not a declared field"
    return {
      claims: [],
      expectations: [
        {
          label: `undeclared top-level key "${key}"`,
          describe: `an issue at "${key}" naming it as unrecognized`,
          matches: (issue) =>
            samePath(issue.path, [key]) &&
            /Unrecognized top-level key/.test(issue.message),
        },
      ],
    }
  },

  // Requirement 2.9 — 0 and 99 are outside the supported range; "1" is a type
  // mismatch that must be rejected rather than coerced (Requirement 2.2).
  schema_version_invalid: ({ definition, variants }) => {
    definition.schema_version = variants.schemaVersionValue
    return {
      claims: ["schema_version"],
      expectations: [
        {
          label: `schema_version ${JSON.stringify(variants.schemaVersionValue)}`,
          describe: 'an issue at "schema_version"',
          matches: (issue) =>
            samePath(issue.path, ["schema_version"]) &&
            /schema_version must be/.test(issue.message),
        },
      ],
    }
  },

  // Requirement 2.10 — 0 and 121 characters, the two sides of the bound.
  name_length_invalid: ({ definition, variants }) => {
    const identity = definition.identity
    if (identity === undefined)
      throw new Error("identity is absent before injection")
    identity.name = "n".repeat(variants.nameLength)
    return {
      claims: ["identity"],
      expectations: [
        {
          label: `identity.name of ${variants.nameLength} characters`,
          describe: 'an issue at "identity.name"',
          matches: (issue) =>
            samePath(issue.path, ["identity", "name"]) &&
            /identity\.name must be a string/.test(issue.message),
        },
      ],
    }
  },

  // Requirement 3.1 — one dimension pushed one past its bound. Entries are
  // *appended*, never replaced, so a defect that already put a value in this
  // dimension keeps the index its expectation recorded.
  scope_dimension_over_bound: ({ definition, variants }) => {
    const scope = definition.scope
    if (scope === undefined) throw new Error("scope is absent before injection")
    const dimension = variants.scopeDimension

    if (dimension === "resource_types") {
      while (scope.resource_types.length <= MAX_RESOURCE_TYPES) {
        scope.resource_types.push(
          `Microsoft.Test/kind${scope.resource_types.length}`
        )
      }
    } else if (dimension === "tag_filters") {
      while (scope.tag_filters.length <= MAX_TAG_FILTERS) {
        scope.tag_filters.push({
          key: `tag-${scope.tag_filters.length}`,
          value: "prod",
        })
      }
    } else {
      while (scope.resource_groups.length <= MAX_RESOURCE_GROUPS) {
        scope.resource_groups.push(`rg-extra-${scope.resource_groups.length}`)
      }
    }

    return {
      claims: ["scope"],
      expectations: [
        {
          label: `scope.${dimension} over its bound`,
          describe: `an issue at "scope.${dimension}" naming the bound`,
          matches: (issue) =>
            samePath(issue.path, ["scope", dimension]) &&
            /accepts at most/.test(issue.message),
        },
      ],
    }
  },

  // Requirement 3.10 — a top-N with no metric to rank by.
  top_n_without_metric: ({ definition }) => {
    const scope = definition.scope
    if (scope === undefined) throw new Error("scope is absent before injection")
    scope.top_n = { count: 10, statistic: "avg" }
    return {
      claims: ["scope"],
      expectations: [
        {
          label: "top_n without a metric",
          describe: 'an issue at "scope.top_n.metric"',
          matches: (issue) =>
            samePath(issue.path, ["scope", "top_n", "metric"]) &&
            /requires a metric name/.test(issue.message),
        },
      ],
    }
  },

  // Requirement 5.2 — a metric the Metric_Catalog does not declare for that
  // resource type. Caught by the catalog layer, not by the shape layer.
  metric_absent_from_catalog: ({ definition, reserved, variants }) => {
    const metrics = definition.metrics
    if (metrics === undefined)
      throw new Error("metrics is absent before injection")
    const resourceType =
      reserved.metricResourceTypes[
        variants.metricResourceTypePick % reserved.metricResourceTypes.length
      ]
    const items = metrics[resourceType]
    items.push({ metric: UNCATALOGUED_METRIC, statistic: "avg" })
    const index = items.length - 1

    return {
      claims: ["metrics"],
      expectations: [
        {
          label: `a metric absent from the catalog at metrics.${resourceType}.${index}`,
          describe: `a catalog issue at "${pathText(["metrics", resourceType, index])}"`,
          matches: (issue) =>
            samePath(issue.path, ["metrics", resourceType, index]) &&
            /Metric_Catalog declares no/.test(issue.message),
        },
      ],
    }
  },

  // Requirements 5.7, 5.8 — a percentile with no estimator label and no
  // fidelity tier. The document must be structurally incapable of printing a
  // bare "p95".
  percentile_without_estimator: ({ definition }) => {
    const metrics = definition.metrics
    if (metrics === undefined)
      throw new Error("metrics is absent before injection")
    const items = metrics[VM_RESOURCE_TYPE]
    items.push({ metric: "Percentage CPU", statistic: "p95" })
    const index = items.length - 1

    return {
      claims: ["metrics"],
      expectations: [
        {
          label: "a p95 statistic carrying no estimator label",
          describe: `an issue at "${pathText([
            "metrics",
            VM_RESOURCE_TYPE,
            index,
            "estimator",
          ])}"`,
          matches: (issue) =>
            samePath(issue.path, [
              "metrics",
              VM_RESOURCE_TYPE,
              index,
              "estimator",
            ]) && /requires the catalog's estimator label/.test(issue.message),
        },
      ],
    }
  },

  // Requirement 6.9 — an undeclared block type is named, and the block is not
  // silently ignored.
  undeclared_block_type: ({ definition, variants, poolIds }) => {
    const { block, path } = locateBlock(definition, poolIds[0])
    const blockId = block.id
    block.type = variants.undeclaredBlockType
    return {
      claims: ["blocks"],
      expectations: [
        {
          label: `undeclared block type ${JSON.stringify(variants.undeclaredBlockType)} on ${blockId}`,
          describe: `an issue at "${pathText([...path, "type"])}"`,
          matches: (issue) =>
            samePath(issue.path, [...path, "type"]) &&
            /is not a declared block type/.test(issue.message),
        },
      ],
    }
  },

  // Requirement 6.6 — rich_text carries static prose and binds no figure.
  rich_text_binds_metric: ({ definition, reserved }) => {
    const { block, path } = locateBlock(definition, reserved.richTextBlockId)
    const config = block.config
    if (config === undefined)
      throw new Error("the reserved rich_text block has no config")
    config.metric = "Percentage CPU"
    return {
      claims: ["blocks"],
      expectations: [
        {
          label: `rich_text block ${block.id} binding a metric`,
          describe: `an issue at "${pathText([...path, "config", "metric"])}"`,
          matches: (issue) =>
            samePath(issue.path, [...path, "config", "metric"]) &&
            /may not bind/.test(issue.message),
        },
      ],
    }
  },

  // Requirement 6.5 — an absolute position, a coordinate, an offset, an
  // absolute size or an explicit page assignment, on the block itself or inside
  // its config.
  absolute_position_field: ({ definition, variants, poolIds }) => {
    const { block, path } = locateBlock(definition, poolIds[0])
    const field = variants.positioningField
    const expected =
      variants.positioningPlacement === "block"
        ? [...path, field]
        : [...path, "config", field]

    if (variants.positioningPlacement === "block") {
      block[field] = 12
    } else {
      const config = block.config
      if (config === undefined)
        throw new Error("the target block has no config")
      config[field] = 12
    }

    return {
      claims: ["blocks"],
      expectations: [
        {
          label: `positioning field "${field}" on ${
            variants.positioningPlacement === "block"
              ? "a block"
              : "a block config"
          }`,
          describe: `an issue at "${pathText(expected)}"`,
          matches: (issue) =>
            samePath(issue.path, expected) &&
            /No block may carry/.test(issue.message),
        },
      ],
    }
  },

  // Requirement 6.7 — a duplicate id, counting every row's children. Three
  // placements, and the third (two children in two different row columns, with
  // nothing at top level) is the one a top-level-only scan cannot see.
  duplicate_block_id: ({ definition, reserved, variants, poolIds }) => {
    let duplicated: string
    let describe: string
    let extraMatch: (issue: FieldIssue) => boolean

    if (variants.duplicateVariant === "top_level_pair") {
      const [keeperId, collidingId] = poolIds
      const { block } = locateBlock(definition, collidingId)
      block.id = keeperId
      duplicated = keeperId
      describe = "two top-level blocks sharing one id"
      // ["blocks", index, "id"] — a top-level block's own id path.
      extraMatch = (issue) =>
        issue.path.length === 3 && issue.path[0] === "blocks"
    } else if (variants.duplicateVariant === "row_child_and_top_level") {
      const keeperId = poolIds[0]
      const childId = reserved.rowColumnChildIds[0][0]
      const { block } = locateBlock(definition, childId)
      block.id = keeperId
      duplicated = keeperId
      describe = "a row child colliding with a top-level block"
      extraMatch = () => true
    } else {
      const keeperId = reserved.rowColumnChildIds[0][0]
      const collidingId = reserved.rowColumnChildIds[1][0]
      const { block } = locateBlock(definition, collidingId)
      block.id = keeperId
      duplicated = keeperId
      describe =
        "two children in two different row columns, neither at top level"
      // The flagged occurrence sits inside a column, which is precisely what a
      // top-level-only duplicate scan would miss.
      extraMatch = (issue) => issue.path.includes("columns")
    }

    return {
      claims: ["blocks"],
      expectations: [
        {
          label: `duplicate block id "${duplicated}" — ${describe}`,
          describe: `an issue whose path ends at an "id" and whose message names "${duplicated}"`,
          matches: (issue) =>
            issue.path[0] === "blocks" &&
            issue.path[issue.path.length - 1] === "id" &&
            issue.message.includes(`Duplicate block id "${duplicated}"`) &&
            extraMatch(issue),
        },
      ],
    }
  },

  // Requirement 6.4 — one level of nesting only, and the expectation names the
  // *innermost* row so a check that looks one level down fails at depth 2 and 3.
  row_nested_in_row: ({ definition, reserved, variants }) => {
    const { block, path } = locateBlock(definition, reserved.rowBlockId)
    const columns = block.columns
    if (columns === undefined)
      throw new Error("the reserved row has no columns")

    let container = columns[0]
    let containerPath: Path = [...path, "columns", 0]
    let innermostPath: Path = []

    for (let depth = 1; depth <= variants.nestingDepth; depth += 1) {
      const nested: MutableBlock = {
        id: `nested-row-${depth}`,
        type: "row",
        columns: [[], []],
      }
      innermostPath = [...containerPath, container.length]
      container.push(nested)
      const nestedColumns = nested.columns
      if (nestedColumns === undefined) throw new Error("unreachable")
      container = nestedColumns[0]
      containerPath = [...innermostPath, "columns", 0]
    }

    return {
      claims: ["blocks"],
      expectations: [
        {
          label: `a row nested at depth ${variants.nestingDepth}`,
          describe: `an issue at "${pathText([...innermostPath, "type"])}"`,
          matches: (issue) =>
            samePath(issue.path, [...innermostPath, "type"]) &&
            /row nested inside a row/.test(issue.message),
        },
      ],
    }
  },

  // Requirements 1.3, 3.2 — an Azure identifier in a randomly chosen scope
  // dimension of either the template default or a block override. The
  // randomization is the point: a check that scans only `resource_types` passes
  // a quarter of these draws and fails the rest.
  azure_identifier_in_scope: ({ definition, variants, poolIds }) => {
    let scope: MutableScope
    let scopePath: Path

    if (variants.azureLocation === "template") {
      const templateScope = definition.scope
      if (templateScope === undefined)
        throw new Error("scope is absent before injection")
      scope = templateScope
      scopePath = ["scope"]
    } else {
      const { block, path } = locateBlock(definition, poolIds[0])
      if (block.scope_override === undefined)
        block.scope_override = emptyScope()
      scope = block.scope_override
      scopePath = [...path, "scope_override"]
    }

    // A resource group name is bounded at 90 characters and a fully qualified
    // resource id is ~120, so in that one dimension the length rule fires first
    // and the identifier check is skipped by design. The GUID shapes are the
    // ones that reach it there, so the shape is narrowed rather than the
    // dimension — the value is still rejected either way, but this expectation
    // is about the identifier message specifically.
    const shape =
      variants.azureDimension === "resource_groups" &&
      variants.azureShape === "resource_id"
        ? "subscription_id"
        : variants.azureShape
    const value =
      shape === "resource_id"
        ? AZURE_RESOURCE_ID
        : shape === "subscription_id"
          ? AZURE_SUBSCRIPTION_ID
          : AZURE_TENANT_ID

    let expected: Path
    if (variants.azureDimension === "resource_types") {
      scope.resource_types.push(value)
      expected = [
        ...scopePath,
        "resource_types",
        scope.resource_types.length - 1,
      ]
    } else if (variants.azureDimension === "resource_groups") {
      scope.resource_groups.push(value)
      expected = [
        ...scopePath,
        "resource_groups",
        scope.resource_groups.length - 1,
      ]
    } else if (variants.azureDimension === "tag_key") {
      scope.tag_filters.push({ key: value, value: "prod" })
      expected = [
        ...scopePath,
        "tag_filters",
        scope.tag_filters.length - 1,
        "key",
      ]
    } else {
      scope.tag_filters.push({ key: "env", value })
      expected = [
        ...scopePath,
        "tag_filters",
        scope.tag_filters.length - 1,
        "value",
      ]
    }

    return {
      // Claims both, because the override variant lives on a block and the
      // default variant lives on `scope`.
      claims: ["scope", "blocks"],
      expectations: [
        {
          label: `an Azure ${shape} in ${variants.azureLocation} ${variants.azureDimension}`,
          describe: `an issue at "${pathText(expected)}"`,
          matches: (issue) =>
            samePath(issue.path, expected) &&
            /looks like a fully qualified Azure resource/.test(issue.message),
        },
      ],
    }
  },

  // Requirement 6.3 — 201 blocks, counting rows and their children.
  too_many_blocks: ({ definition }) => {
    const blocks = definition.blocks
    if (blocks === undefined)
      throw new Error("blocks is absent before injection")
    const shortfall = Math.max(1, MAX_BLOCKS_TOTAL + 1 - countBlocks(blocks))
    for (let index = 0; index < shortfall; index += 1) {
      blocks.push({
        id: `overflow-${index}`,
        type: "heading",
        config: { level: 2, text: `Overflow ${index}` },
      })
    }

    return {
      claims: ["blocks"],
      expectations: [
        {
          label: `more than ${MAX_BLOCKS_TOTAL} blocks`,
          describe: 'an issue at "blocks" naming the block bound',
          matches: (issue) =>
            samePath(issue.path, ["blocks"]) &&
            new RegExp(`accepts at most ${MAX_BLOCKS_TOTAL} blocks`).test(
              issue.message
            ),
        },
      ],
    }
  },

  // Requirement 2.10 — a body above 262,144 bytes in RFC 8785 canonical form.
  // Padded into a `rich_text` block's `text`, which carries no length bound of
  // its own, so this defect produces the byte-bound violation and nothing else.
  oversize_canonical_body: ({ definition }) => {
    const blocks = definition.blocks
    if (blocks === undefined)
      throw new Error("blocks is absent before injection")
    blocks.push({
      id: "oversize-prose",
      type: "rich_text",
      config: { text: "a".repeat(MAX_DEFINITION_CANONICAL_BYTES + 1_024) },
    })

    return {
      claims: ["blocks"],
      expectations: [
        {
          label: "a canonical body above the byte bound",
          describe:
            "an issue at the definition root naming the canonical byte bound",
          matches: (issue) =>
            issue.path.length === 0 &&
            /canonical form is \d+ bytes/.test(issue.message),
        },
      ],
    }
  },

  // Requirement 2.1 — one of the seven required keys, dropped. Applied last, so
  // it can pick a key no other drawn defect needs; `period` and `design` are
  // claimed by nothing, so there is always a choice.
  missing_required_key: ({ definition, variants, claimed }) => {
    const available = TOP_LEVEL_KEYS.filter((key) => !claimed.has(key))
    if (available.length === 0) {
      throw new Error(
        "every top-level key was claimed — the claim table is wrong"
      )
    }
    const key = available[variants.missingKeyPick % available.length]
    delete definition[key]

    return {
      claims: [key],
      expectations: [
        {
          label: `missing required top-level key "${key}"`,
          describe: `an issue at "${key}" naming it as missing`,
          matches: (issue) =>
            samePath(issue.path, [key]) &&
            /Missing required top-level key/.test(issue.message),
        },
      ],
    }
  },
}

const injectionArb = fc.record({
  // Distinct kinds, 1 to 6. See the module docstring: repetition would make
  // "each defect gets its own issue" false about a correct validator.
  kinds: fc.uniqueArray(fc.constantFrom(...DEFECT_KINDS), {
    minLength: 1,
    maxLength: 6,
  }),
  variants: variantsArb,
})

type DrawnInjection = {
  readonly kinds: readonly DefectKind[]
  readonly variants: Variants
}

/**
 * Apply every drawn defect to a copy of `case_.definition`, in
 * {@link DEFECT_KINDS} order.
 *
 * Pool blocks are allocated **before** any injection runs. Allocating lazily
 * would break as soon as a defect rewrote the very id a later injector was going
 * to look up — which the duplicate-id defect does by construction.
 */
function injectDefects(
  case_: ValidCase,
  injection: DrawnInjection
): {
  readonly mutated: MutableDefinition
  readonly defects: readonly Expectation[]
} {
  const mutated = structuredClone(case_.definition)
  const ordered = DEFECT_KINDS.filter((kind) => injection.kinds.includes(kind))
  const pool = case_.reserved.poolBlockIds

  const allocations = new Map<DefectKind, string[]>()
  let cursor = 0
  for (const kind of ordered) {
    const needed = POOL_BLOCKS_NEEDED[kind](injection.variants)
    const ids: string[] = []
    for (let index = 0; index < needed; index += 1) {
      ids.push(pool[(injection.variants.poolOffset + cursor) % pool.length])
      cursor += 1
    }
    allocations.set(kind, ids)
  }
  if (cursor > pool.length) {
    throw new Error(
      `the drawn defects need ${cursor} exclusive blocks; the pool holds ${pool.length}`
    )
  }

  const claimed = new Set<string>()
  const defects: Expectation[] = []

  for (const kind of ordered) {
    const injected = INJECTORS[kind]({
      definition: mutated,
      reserved: case_.reserved,
      variants: injection.variants,
      poolIds: allocations.get(kind) ?? [],
      claimed,
    })
    for (const claim of injected.claims) claimed.add(claim)
    defects.push(...injected.expectations)
  }

  return { mutated, defects }
}

// --- Matching defects to issues ---------------------------------------------

function issueKey(issue: FieldIssue): string {
  return `${JSON.stringify(issue.path)} :: ${issue.message}`
}

/**
 * Assign each defect its **own** issue, or report the defects for which no such
 * assignment exists (a maximum-matching search over the bipartite graph of
 * defects and the issues their predicates accept).
 *
 * The weaker "every defect matched at least one issue" is asserted separately
 * and first, because it produces the readable failure. This is the assertion
 * that a validator emitting one catch-all issue cannot pass.
 */
function unmatchedDefects(
  defects: readonly Expectation[],
  issues: readonly FieldIssue[]
): readonly string[] {
  const candidates = defects.map((defect) =>
    issues.reduce<number[]>((accepted, issue, index) => {
      if (defect.matches(issue)) accepted.push(index)
      return accepted
    }, [])
  )

  const owner = new Array<number | null>(issues.length).fill(null)

  const assign = (defectIndex: number, visited: Set<number>): boolean => {
    for (const issueIndex of candidates[defectIndex]) {
      if (visited.has(issueIndex)) continue
      visited.add(issueIndex)
      const current = owner[issueIndex]
      if (current === null || assign(current, visited)) {
        owner[issueIndex] = defectIndex
        return true
      }
    }
    return false
  }

  return defects
    .map((defect, index) => (assign(index, new Set()) ? null : defect.label))
    .filter((label): label is string => label !== null)
}

function describeIssues(issues: readonly FieldIssue[]): string {
  return issues.map((issue) => `  - ${issueKey(issue)}`).join("\n")
}

// ---------------------------------------------------------------------------
// The generator's own validity — before anything else
// ---------------------------------------------------------------------------

describe("the generator emits only valid definitions", () => {
  test("every declared config field has a generated value", () => {
    // Not a property: it is a finite, exhaustive check over `BLOCK_CONFIG`. It
    // exists so a field added to `blocks.ts` cannot quietly fall through to the
    // `value-<n>` fallback and leave a required field unexercised.
    const missing: string[] = []

    for (const blockType of Object.keys(BLOCK_CONFIG) as BlockType[]) {
      const schema = configSchemaFor(blockType)
      for (const field of [...schema.required, ...schema.optional]) {
        if (!(field in CONFIG_FIELD_VALUES))
          missing.push(`${blockType}.${field}`)
      }
    }

    expect(missing).toEqual([])
  })

  test("a generated definition carries zero issues in either layer", () => {
    // Without this, every assertion in the property below is vacuous: a base
    // definition that is already invalid produces issues no injected defect
    // asked for, and the matching would succeed on issues that were never about
    // a defect at all.
    fc.assert(
      fc.property(validCaseArb, (case_) => {
        expect(collectDefinitionIssues(case_.definition)).toEqual([])
        // Requirement 6.8 — and it is runnable, not merely a valid draft.
        expect(
          collectDefinitionIssues(case_.definition, { mode: "run" })
        ).toEqual([])
        expect(
          validateMetricSelectionAgainstCatalog(
            case_.definition as unknown as TemplateDefinition,
            CATALOG
          )
        ).toEqual([])
        expect(
          templateDefinitionSchema.safeParse(case_.definition).success
        ).toBe(true)
      })
    )
  })

  test("a generated definition leaves headroom under every bound a defect breaches", () => {
    fc.assert(
      fc.property(validCaseArb, (case_) => {
        const blocks = case_.definition.blocks ?? []

        // So `too_many_blocks` and `oversize_canonical_body` are the *only*
        // reasons those two bounds are ever breached.
        expect(countBlocks(blocks)).toBeLessThan(MAX_BLOCKS_TOTAL / 2)
        expect(
          canonicalJsonByteLength(asCanonicalizable(case_.definition))
        ).toBeLessThan(MAX_DEFINITION_CANONICAL_BYTES / 2)
      })
    )
  })

  test("a generated definition carries the structure the injectors reserve", () => {
    fc.assert(
      fc.property(validCaseArb, (case_) => {
        const { reserved, definition } = case_

        expect(reserved.poolBlockIds).toHaveLength(POOL_SIZE)
        expect(new Set(reserved.poolBlockIds).size).toBe(POOL_SIZE)

        // Every reserved id resolves, so an injector never fails to locate its
        // own target.
        for (const id of reserved.poolBlockIds) {
          expect(locateBlock(definition, id).block.id).toBe(id)
        }

        const richText = locateBlock(definition, reserved.richTextBlockId).block
        expect(richText.type).toBe("rich_text")
        expect(richText.config).toBeDefined()

        const row = locateBlock(definition, reserved.rowBlockId).block
        expect(row.type).toBe("row")
        expect(row.columns?.length).toBeGreaterThanOrEqual(2)

        // Two of the three duplicate-id placements need a child in a row column,
        // and one needs a child in two *different* columns.
        expect(reserved.rowColumnChildIds[0].length).toBeGreaterThanOrEqual(1)
        expect(reserved.rowColumnChildIds[1].length).toBeGreaterThanOrEqual(1)

        // The percentile defect always has somewhere to go.
        expect(reserved.metricResourceTypes).toContain(VM_RESOURCE_TYPE)
      })
    )
  })
})

// ---------------------------------------------------------------------------
// Property 8
// ---------------------------------------------------------------------------

describe("Property 8 — validation is total and reports every violation", () => {
  test("every injected defect is named by field path in one response", () => {
    fc.assert(
      fc.property(validCaseArb, injectionArb, (case_, injection) => {
        const { mutated, defects } = injectDefects(case_, injection)

        // Requirements 2.7, 6.11 — one pass, and the candidate the caller handed
        // in must come back untouched. Cloned *after* injection and *before*
        // validation, so the comparison is about the validator and nothing else.
        const beforeValidation = structuredClone(mutated)
        const canonicalBefore = canonicalJsonString(asCanonicalizable(mutated))

        const issues = collectAllIssues(mutated)

        // The definition is rejected at all.
        expect(issues.length).toBeGreaterThan(0)

        // (1) Every defect appears. The readable failure.
        for (const defect of defects) {
          expect(
            issues.some((issue) => defect.matches(issue)),
            `no issue matched the injected defect [${defect.label}] — expected ` +
              `${defect.describe}. The response was:\n${describeIssues(issues)}`
          ).toBe(true)
        }

        // (2) And each has its own issue: nothing was silently collapsed into a
        // single catch-all, and nothing was accepted or stripped.
        expect(
          unmatchedDefects(defects, issues),
          `these defects could not be assigned an issue of their own, so at least ` +
            `two of them are sharing one report:\n${describeIssues(issues)}`
        ).toEqual([])

        expect(new Set(issues.map(issueKey)).size).toBeGreaterThanOrEqual(
          defects.length
        )

        // The gate closes — which is what stops a caller reaching its write.
        // See the module docstring on "no version row is written".
        //
        // Qualified by the layering, and the qualification is the point rather
        // than a concession: `templateDefinitionSchema` deliberately does not
        // consult the Metric_Catalog (module docstring, "Layering"), so a
        // definition whose *only* defect is a metric absent from the catalog
        // parses cleanly through the schema and is rejected by the composed
        // check above. A route that ran only `safeParse` would accept it — which
        // is exactly why the composed `collectAllIssues` result, not
        // `safeParse`, is what a save path has to gate on.
        if (
          injection.kinds.some((kind) => !CATALOG_ONLY_DEFECT_KINDS.has(kind))
        ) {
          expect(templateDefinitionSchema.safeParse(mutated).success).toBe(
            false
          )
        }

        // And the candidate is byte-identical afterwards.
        expect(mutated).toEqual(beforeValidation)
        expect(canonicalJsonString(asCanonicalizable(mutated))).toBe(
          canonicalBefore
        )
      })
    )
  })

  test("validation never mutates a valid definition either", () => {
    // The other half of "byte-identical afterwards": the accepting path. A
    // validator that normalized — trimmed a name, defaulted a `schema_version`,
    // dropped an unknown key — would fail here without failing anything above.
    fc.assert(
      fc.property(validCaseArb, (case_) => {
        const before = structuredClone(case_.definition)
        const canonicalBefore = canonicalJsonString(
          asCanonicalizable(case_.definition)
        )

        collectAllIssues(case_.definition)
        templateDefinitionSchema.safeParse(case_.definition)

        expect(case_.definition).toEqual(before)
        expect(canonicalJsonString(asCanonicalizable(case_.definition))).toBe(
          canonicalBefore
        )
      })
    )
  })
})

// ---------------------------------------------------------------------------
// The kills list, as named cases
// ---------------------------------------------------------------------------

/**
 * A small fixture for the named cases below.
 *
 * Hand-written rather than drawn from `validCaseArb`, because each case names
 * one concrete implementation the property exists to rule out, and a reader
 * should be able to see the whole input at once.
 */
function fixture(): MutableDefinition {
  return {
    schema_version: 1,
    identity: { name: "Monthly utilization" },
    scope: {
      resource_types: [VM_RESOURCE_TYPE],
      tag_filters: [],
      resource_groups: ["rg-core"],
      top_n: null,
      sort: null,
    },
    period: { kind: "last_full_month" },
    metrics: {
      [VM_RESOURCE_TYPE]: [{ metric: "Percentage CPU", statistic: "avg" }],
    },
    blocks: [
      {
        id: "heading-1",
        type: "heading",
        config: { level: 1, text: "Report" },
      },
      {
        id: "row-1",
        type: "row",
        columns: [
          [
            {
              id: "kpi-1",
              type: "kpi_row",
              config: { metrics: ["Percentage CPU|avg"] },
            },
          ],
          [
            {
              id: "kpi-2",
              type: "kpi_row",
              config: { metrics: ["Percentage CPU|avg"] },
            },
          ],
        ],
      },
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

describe("Property 8's kills, as named cases", () => {
  test("the fixture is valid, so each case below changes exactly one thing", () => {
    expect(collectAllIssues(fixture())).toEqual([])
  })

  test("an undeclared top-level key is rejected, not accepted and stripped", () => {
    // Kills: a zod schema left at its default strip-unknown-keys behaviour. That
    // schema *succeeds* here and hands back a value with `layout` removed, so
    // the wizard saves a definition the compiler cannot compile and the error
    // arrives minutes later as a failed run (Requirement 2.3).
    const candidate = fixture()
    candidate.layout = { direction: "vertical" }

    const issues = collectAllIssues(candidate)

    expect(issues.map((issue) => pathText(issue.path))).toContain("layout")
    expect(templateDefinitionSchema.safeParse(candidate).success).toBe(false)
    // And the key is still there: nothing stripped it on the way through.
    expect(candidate.layout).toEqual({ direction: "vertical" })
  })

  test("two simultaneous defects yield two issues, not one", () => {
    // Kills: a validator that returns the first error — and specifically the
    // zod shape the module docstring rejects. An undeclared block type is what
    // `z.enum` would report as an abort-true `invalid_value`, and a duplicate id
    // elsewhere in the tree is only reachable by a whole-tree walk. Under
    // `z.enum` + an ancestor `.superRefine()`, the second one is silently absent
    // from `error.issues` (Requirements 2.7, 6.11).
    const candidate = fixture()
    const blocks = candidate.blocks ?? []
    blocks[0].type = "not_a_block_type"
    blocks.push({
      id: "heading-1",
      type: "heading",
      config: { level: 2, text: "Again" },
    })

    const issues = collectAllIssues(candidate)

    expect(
      issues.some(
        (issue) =>
          pathText(issue.path) === "blocks.0.type" &&
          /is not a declared block type/.test(issue.message)
      )
    ).toBe(true)
    expect(
      issues.some((issue) =>
        issue.message.includes('Duplicate block id "heading-1"')
      )
    ).toBe(true)
    expect(issues.length).toBeGreaterThanOrEqual(2)
  })

  test("a row nested at depth 3 is caught", () => {
    // Kills: a nesting check that looks one level down. It finds the depth-1
    // row and stops, so the depth-3 row — the one that actually cannot be
    // rendered — passes (Requirement 6.4).
    const candidate = fixture()
    const row = locateBlock(candidate, "row-1").block
    const columns = row.columns ?? []

    const deepest: MutableBlock = {
      id: "row-depth-3",
      type: "row",
      columns: [[], []],
    }
    const middle: MutableBlock = {
      id: "row-depth-2",
      type: "row",
      columns: [[deepest], []],
    }
    const shallow: MutableBlock = {
      id: "row-depth-1",
      type: "row",
      columns: [[middle], []],
    }
    columns[0].push(shallow)

    const issues = collectAllIssues(candidate)
    const nestingIssues = issues.filter((issue) =>
      /row nested inside a row/.test(issue.message)
    )

    // All three, each at its own path — not just the outermost one.
    expect(nestingIssues.map((issue) => pathText(issue.path))).toEqual(
      expect.arrayContaining([
        "blocks.1.columns.0.1.type",
        "blocks.1.columns.0.1.columns.0.0.type",
        "blocks.1.columns.0.1.columns.0.0.columns.0.0.type",
      ])
    )
    expect(
      nestingIssues.some((issue) => issue.message.includes("row-depth-3"))
    ).toBe(true)
  })

  test("a duplicate id across two different row columns, neither at top level, is caught", () => {
    // Kills: a duplicate-id check that scans only top-level ids. Neither `kpi-1`
    // occurrence is at the top level, so a scan of `definition.blocks` alone
    // finds nothing (Requirement 6.7).
    const candidate = fixture()
    const row = locateBlock(candidate, "row-1").block
    const columns = row.columns ?? []
    columns[1][0].id = "kpi-1"

    const issues = collectAllIssues(candidate)
    const duplicate = issues.filter((issue) =>
      issue.message.includes('Duplicate block id "kpi-1"')
    )

    expect(duplicate).toHaveLength(1)
    expect(pathText(duplicate[0].path)).toBe("blocks.1.columns.1.0.id")
  })

  test("a resource-id-shaped string in resource_groups and in a tag value is caught", () => {
    // Kills: a resource-id check that scans only `resource_types`. Both of these
    // are scope dimensions that are not `resource_types` (Requirement 1.3).
    //
    // `resource_groups` gets the bare subscription GUID rather than the fully
    // qualified id: a resource group name is bounded at 90 characters and the
    // qualified form is ~120, so the length rule would fire there first and the
    // identifier message — the thing this case is about — would never be
    // reached. The qualified form goes in the tag value, which is bounded at 256.
    const candidate = fixture()
    const scope = candidate.scope
    if (scope === undefined) throw new Error("the fixture has no scope")
    scope.resource_groups.push(AZURE_SUBSCRIPTION_ID)
    scope.tag_filters.push({ key: "env", value: AZURE_RESOURCE_ID })

    const issues = collectAllIssues(candidate)
    const identifierIssues = issues.filter((issue) =>
      /looks like a fully qualified Azure resource/.test(issue.message)
    )

    expect(identifierIssues.map((issue) => pathText(issue.path))).toEqual(
      expect.arrayContaining([
        "scope.resource_groups.1",
        "scope.tag_filters.0.value",
      ])
    )
    // And the rejection says what a scope is, rather than only that this value
    // is wrong.
    for (const issue of identifierIssues) {
      expect(issue.message).toMatch(
        /never as\s+named resources|named resources/
      )
    }
  })

  test("a metric absent from the catalog is caught even beside a shape defect", () => {
    // Kills: composing the catalog layer only behind a clean shape. With both
    // defects present, gating the catalog check on `shapeIssues.length === 0`
    // reports the shape defect and hides the catalog one — half of Requirement
    // 2.7's "every failing field path in one response" (Requirements 5.2, 2.7).
    const candidate = fixture()
    candidate.schema_version = 99
    const metrics = candidate.metrics
    if (metrics === undefined) throw new Error("the fixture has no metrics")
    metrics[VM_RESOURCE_TYPE].push({
      metric: UNCATALOGUED_METRIC,
      statistic: "avg",
    })

    const issues = collectAllIssues(candidate)

    expect(issues.map((issue) => pathText(issue.path))).toEqual(
      expect.arrayContaining([
        "schema_version",
        `metrics.${VM_RESOURCE_TYPE}.1`,
      ])
    )
  })
})
