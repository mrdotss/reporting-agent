/**
 * The three starter template definitions, versioned in the repository and
 * reviewed as code (Requirements 10.1, 10.3, 10.5, 10.8).
 *
 * **Pure, and deliberately not `server-only`.** These are plain values: no
 * clock, no connection, no secret. `lib/templates/seed.ts` writes them at
 * account creation, `app/test/starters.static.test.ts` validates them at build
 * time, and the wizard may render one as a preview without pulling a server
 * module into a client bundle.
 *
 * ## Why they are code rather than seed SQL
 *
 * Requirement 10.8 is the reason: a starter definition that fails the
 * `Template_Validator` must fail the **build**, naming that starter and each
 * failing field path, rather than being discovered by the first user whose
 * account was created with it. A definition living in a migration or a JSON
 * fixture is data nobody validates until it is written; a definition living
 * here is validated by `starters.static.test.ts` on every run of `pnpm test`,
 * through the same `collectDefinitionIssues` the wizard and every route handler
 * use — in **`mode: "run"`**, not `"draft"`, because a starter that saves but
 * cannot be run is not a working example.
 *
 * ## What every starter carries, and why
 *
 * Requirement 10.3 — the period is one of the five **relative** specifications
 * and never `custom`, so a starter that shipped in July still resolves to a
 * meaningful window in November with no edit. A `custom` starter would be a
 * placeholder pretending to be an example, and it would start failing the
 * enqueue's 1–31-local-day bound the moment its dates aged out.
 *
 * Requirement 10.5 — each is composed from at least one block of
 * {@link STARTER_DATA_BLOCK_TYPES}, at least one of
 * {@link STARTER_NARRATIVE_BLOCK_TYPES}, and exactly one `verification_record`.
 * That combination is not decoration: it is the provenance chain end to end in
 * one document. A data block emits figures the compiler traced to snapshot
 * paths, a narrative block emits model prose the verifier will refuse to let
 * carry an unmatched numeral, and the `verification_record` states the snapshot
 * those figures came from. A starter missing any of the three would demonstrate
 * a report rather than a *provable* report.
 *
 * ## They are three genuinely different reports
 *
 * Not one definition renamed three times, because the point of shipping three
 * is that a first-time user sees what the palette can express:
 *
 * | starter | period | shape |
 * |---|---|---|
 * | **Monthly utilization** | `last_full_month` | broad and periodic — KPIs, a chart row, the full resource table, a top-10 ranking, gaps |
 * | **Capacity planning** | `last_30d` | decision-oriented — `capacity_vs_usage` twice, a busiest-ten and a quietest-ten ranking, the p95 distribution |
 * | **Executive summary** | `last_full_month` | one page, prose-forward — cover, prose, three KPIs, the record |
 *
 * ## The metric selections are consistent with the blocks that read them
 *
 * Every `metric` and `derived` name below is one the Metric_Catalog
 * (`agent/src/reporting_agent/catalog/metrics.v1.json`) declares for
 * `Microsoft.Compute/virtualMachines`, and every statistic is one that catalog
 * entry supports. Three consequences that are easy to get wrong and would each
 * turn a starter into a failed run:
 *
 *   * **A percentile entry carries its estimator label and fidelity tier**
 *     (Requirements 5.7, 5.8). `p95` from platform metrics is computed from a
 *     fixed 0–100 histogram fed with hourly interval averages, so the estimator
 *     is `histogram_sketch_pt1h_interval_average` and the tier is `baseline`.
 *     The spelling is the collector's own, from
 *     `collect/snapshot.py`'s `_percentile_estimator`; a starter that invented
 *     a label would produce a figure the formatter has no entry for.
 *   * **`memory_used_pct` is derived, so its source metric travels with it.**
 *     The catalog declares `Available Memory Bytes` and the `MemoryGB` SKU
 *     capability as its sources, and
 *     `validateMetricSelectionAgainstCatalog` requires that source metric to be
 *     selected for the same resource type — so every starter naming
 *     `memory_used_pct` also names `Available Memory Bytes`.
 *   * **A block references only what its definition collects** (Requirement
 *     5.3). Each `kpi_row`, `resource_table`, `top_n_table`, chart and
 *     `capacity_vs_usage` config below names `(metric | derived, statistic)`
 *     pairs drawn from that same definition's `metrics`, and
 *     `starters.static.test.ts` asserts that containment directly rather than
 *     leaving it to a reader to check by eye.
 *
 * ## `seededStarterKey` is a persisted identifier
 *
 * The three keys are the `report_templates.seeded_starter_key` values, and they
 * are the idempotency key of `UNIQUE (user_id, seeded_starter_key)`. They are
 * **stable forever**: renaming one would make an existing user's seeded row
 * invisible to the seeder and re-insert a duplicate under the new spelling.
 * They are deliberately not derived from the display name, which is a label a
 * consultant may edit (Requirement 10.7) while the key must not move.
 */

import type { BlockType } from "@/lib/templates/blocks"
import type { TemplateDefinition } from "@/lib/templates/definition"

// --- The composition rule (Requirement 10.5) --------------------------------

/**
 * The six block types that emit figures from the snapshot. Requirement 10.5
 * requires at least one of them in every starter.
 *
 * Declared as a value rather than restated in the guard, so the rule and the
 * assertion share one source.
 */
export const STARTER_DATA_BLOCK_TYPES = [
  "kpi_row",
  "resource_table",
  "top_n_table",
  "timeseries_chart",
  "distribution_chart",
  "capacity_vs_usage",
] as const satisfies readonly BlockType[]

/** The two block types that carry prose. At least one per starter. */
export const STARTER_NARRATIVE_BLOCK_TYPES = [
  "executive_summary",
  "rich_text",
] as const satisfies readonly BlockType[]

/** Exactly one per starter — the block that names the snapshot behind the figures. */
export const STARTER_RECORD_BLOCK_TYPE =
  "verification_record" satisfies BlockType

// --- The one resource type these starters scope to --------------------------

/**
 * The MVP's only collected resource type. Fully qualified, because Requirement
 * 3.1 bounds `resource_types` to fully qualified names and Requirement 1.3
 * rejects anything shaped like a *named resource* in a scope field.
 */
const VIRTUAL_MACHINES = "Microsoft.Compute/virtualMachines"

// --- Metric selection fragments ---------------------------------------------

/**
 * The catalog's estimator label for a platform-metric percentile at the base
 * `PT1H` grain (Requirement 5.7).
 *
 * Composed by the collector as `<sketch kind>_<grain>_<interval statistic>`:
 * a fixed 0–100 histogram, fed from `PT1H` intervals, each folded as that
 * interval's own average. Restated here as a constant rather than spelled at
 * each use site, so the three starters cannot disagree about it.
 */
export const BASELINE_PERCENTILE_ESTIMATOR =
  "histogram_sketch_pt1h_interval_average"

/** Platform metrics only — no Azure Monitor Agent, no Data Collection Rule. */
export const BASELINE_FIDELITY_TIER = "baseline"

const CPU_AVG = { metric: "Percentage CPU", statistic: "avg" } as const
const CPU_MIN = { metric: "Percentage CPU", statistic: "min" } as const
const CPU_MAX = { metric: "Percentage CPU", statistic: "max" } as const

/**
 * The p95 entry, carrying both fields Requirement 5.8 makes mandatory. Written
 * once and shared, because an entry that named `p95` without them is a
 * rejection and a second hand-typed copy is where that happens.
 */
const CPU_P95 = {
  metric: "Percentage CPU",
  statistic: "p95",
  estimator: BASELINE_PERCENTILE_ESTIMATOR,
  fidelity_tier: BASELINE_FIDELITY_TIER,
} as const

const MEMORY_BYTES_AVG = {
  metric: "Available Memory Bytes",
  statistic: "avg",
} as const
const MEMORY_BYTES_MIN = {
  metric: "Available Memory Bytes",
  statistic: "min",
} as const

/** Host-observed, and the catalog says so — see `memory_used_pct`'s `observation`. */
const MEMORY_USED_PCT_AVG = {
  derived: "memory_used_pct",
  statistic: "avg",
} as const
const MEMORY_USED_PCT_MAX = {
  derived: "memory_used_pct",
  statistic: "max",
} as const

/** NIC-level byte counters. **Not** billable egress — see `azure-integration.md`. */
const NETWORK_IN_AVG = { metric: "Network In Total", statistic: "avg" } as const
const NETWORK_OUT_AVG = {
  metric: "Network Out Total",
  statistic: "avg",
} as const

const DISK_READ_AVG = { metric: "Disk Read Bytes", statistic: "avg" } as const
const DISK_WRITE_AVG = { metric: "Disk Write Bytes", statistic: "avg" } as const

/** A `(metric | derived, statistic)` reference, as a block config carries one. */
function ref(
  item: Readonly<{ metric?: string; derived?: string; statistic: string }>
): Readonly<{ metric?: string; derived?: string; statistic: string }> {
  return item.metric === undefined
    ? { derived: item.derived, statistic: item.statistic }
    : { metric: item.metric, statistic: item.statistic }
}

// --- Shared design ----------------------------------------------------------

/**
 * Every field `designSchema` declares, present. The presets differ per starter
 * below; everything else is the same restrained default — two decimal places,
 * grouped thousands, hairline tables, A4.
 *
 * `accent_color` is the preset's teal, written as one opaque value: the schema
 * treats it as a string it does not interpret, and the renderer is the only
 * thing entitled to give it meaning.
 */
function design(
  preset: TemplateDefinition["design"]["preset"],
  overrides: Partial<TemplateDefinition["design"]> = {}
): TemplateDefinition["design"] {
  return {
    preset,
    accent_color: "#1f6f78",
    density: "normal",
    table_style: "hairline",
    number_format: { decimal_places: 2, group_thousands: true },
    cover_page: true,
    logo: null,
    page_size: "A4",
    ...overrides,
  }
}

/**
 * The template default scope: every virtual machine the connected subscription
 * exposes, unnarrowed.
 *
 * All five dimensions are **present** — an empty array or `null`, never an
 * absent key — because that is the shape `scopeSpecSchema` requires and the
 * shape the mirrored Python validator reads. A key this module omitted would be
 * a key one side defaults and the other rejects.
 */
function allVirtualMachines(): TemplateDefinition["scope"] {
  return {
    resource_types: [VIRTUAL_MACHINES],
    tag_filters: [],
    resource_groups: [],
    top_n: null,
    sort: null,
  }
}

/**
 * A per-block narrowing to the top `count` virtual machines by one
 * `(metric, statistic)` pair (Requirement 3.2).
 *
 * `direction` is the scope's own `sort`, which is what actually orders the
 * ranking — `top_n_table`'s `order_by_direction` config field names the column
 * the table highlights as the reason for that order and does not re-derive it.
 */
function topVirtualMachines(
  count: number,
  metric: string,
  statistic: string,
  direction: "descending" | "ascending"
): TemplateDefinition["scope"] {
  return {
    resource_types: [VIRTUAL_MACHINES],
    tag_filters: [],
    resource_groups: [],
    top_n: { count, metric, statistic },
    sort: direction,
  }
}

// --- Starter 1 — Monthly utilization ----------------------------------------

/**
 * The broad periodic report: what every machine did last month, with the
 * ranking a consultant looks at first and the gaps that qualify it.
 */
const MONTHLY_UTILIZATION: TemplateDefinition = {
  schema_version: 1,
  identity: {
    name: "Monthly utilization",
    description:
      "CPU, memory, disk and network for every virtual machine in scope over " +
      "the last full calendar month, with a top-ten ranking by average CPU " +
      "and every recorded collection gap.",
    report_title: "Infrastructure utilization — monthly review",
  },
  scope: allVirtualMachines(),
  // Requirement 10.3 — relative, so this starter runs unedited in any month.
  period: { kind: "last_full_month" },
  metrics: {
    [VIRTUAL_MACHINES]: [
      CPU_AVG,
      CPU_MIN,
      CPU_MAX,
      CPU_P95,
      MEMORY_BYTES_AVG,
      MEMORY_BYTES_MIN,
      MEMORY_USED_PCT_AVG,
      NETWORK_IN_AVG,
      NETWORK_OUT_AVG,
      DISK_READ_AVG,
      DISK_WRITE_AVG,
    ],
  },
  blocks: [
    {
      id: "cover",
      type: "cover",
      config: { subtitle: "Monthly utilization review" },
    },
    {
      id: "summary-heading",
      type: "heading",
      config: { level: 1, text: "Summary" },
    },
    // Model prose. It may characterize the month; it may not state a figure the
    // compiler did not place, and the verifier deletes the report if it does.
    { id: "summary-prose", type: "executive_summary", config: {} },
    {
      id: "kpis",
      type: "kpi_row",
      config: {
        caption: "Fleet averages for the period",
        show_fidelity: true,
        metrics: [
          ref(CPU_AVG),
          ref(CPU_P95),
          ref(MEMORY_USED_PCT_AVG),
          ref(NETWORK_OUT_AVG),
        ],
      },
    },
    {
      id: "trend-heading",
      type: "heading",
      config: { level: 1, text: "How utilization moved" },
    },
    // One level of nesting: a row of two charts, each a block in its own column.
    {
      id: "trend-row",
      type: "row",
      columns: [
        [
          {
            id: "cpu-over-time",
            type: "timeseries_chart",
            config: {
              caption: "Average CPU per local day",
              metrics: [ref(CPU_AVG), ref(MEMORY_USED_PCT_AVG)],
            },
          },
        ],
        [
          {
            id: "cpu-distribution",
            type: "distribution_chart",
            config: {
              caption: "Distribution of CPU across the fleet",
              metrics: [ref(CPU_AVG)],
            },
          },
        ],
      ],
    },
    {
      id: "fleet-heading",
      type: "heading",
      config: { level: 1, text: "Every machine in scope" },
    },
    {
      id: "fleet-table",
      type: "resource_table",
      config: {
        caption: "Per-machine utilization",
        show_fidelity: true,
        columns: [
          ref(CPU_AVG),
          ref(CPU_MAX),
          ref(CPU_P95),
          ref(MEMORY_USED_PCT_AVG),
          ref(DISK_READ_AVG),
          ref(DISK_WRITE_AVG),
        ],
      },
    },
    {
      id: "busiest-ten",
      type: "top_n_table",
      config: {
        caption: "Top ten by average CPU",
        show_fidelity: true,
        order_by: ref(CPU_AVG),
        order_by_direction: "descending",
        columns: [ref(CPU_AVG), ref(CPU_P95), ref(MEMORY_USED_PCT_AVG)],
      },
      scope_override: topVirtualMachines(
        10,
        "Percentage CPU",
        "avg",
        "descending"
      ),
    },
    {
      id: "gaps",
      type: "gaps_and_coverage",
      config: { caption: "What could not be collected" },
    },
    { id: "record-break", type: "page_break", config: {} },
    {
      id: "record",
      type: STARTER_RECORD_BLOCK_TYPE,
      config: { caption: "Collection record" },
    },
    { id: "methodology", type: "appendix_methodology", config: {} },
  ],
  design: design("editorial"),
}

// --- Starter 2 — Capacity planning ------------------------------------------

/**
 * The right-sizing report. Leans on `capacity_vs_usage` and two rankings —
 * busiest and quietest — because those are the two ends a resize decision is
 * made from, and on p95 rather than the average, since a mean hides the spikes
 * that decide whether a machine can be shrunk.
 *
 * The p95 figures are `baseline`-tier estimates and say so wherever they
 * appear: the estimator label travels inside the figure, so the document is
 * structurally incapable of printing a bare "p95".
 */
const CAPACITY_PLANNING: TemplateDefinition = {
  schema_version: 1,
  identity: {
    name: "Capacity planning",
    description:
      "SKU capacity against observed usage over the last 30 local days, with " +
      "the busiest and quietest ten machines by estimated p95 CPU, for " +
      "right-sizing decisions.",
    report_title: "Capacity and right-sizing review",
  },
  scope: allVirtualMachines(),
  period: { kind: "last_30d" },
  metrics: {
    [VIRTUAL_MACHINES]: [
      CPU_AVG,
      CPU_MAX,
      CPU_P95,
      MEMORY_BYTES_AVG,
      MEMORY_BYTES_MIN,
      MEMORY_USED_PCT_AVG,
      MEMORY_USED_PCT_MAX,
    ],
  },
  blocks: [
    {
      id: "cover",
      type: "cover",
      config: { subtitle: "Capacity and right-sizing" },
    },
    {
      id: "method-heading",
      type: "heading",
      config: { level: 1, text: "How to read this report" },
    },
    // Static prose, authored here and carrying no figure — Requirement 6.6.
    // Deliberately a `rich_text` rather than an `executive_summary`: this
    // paragraph is a fixed methodological caveat, not a per-run narration, so
    // it should be identical in every render.
    {
      id: "method-note",
      type: "rich_text",
      config: {
        text:
          "Percentile figures in this report are estimated from hourly " +
          "platform metrics and are labelled as such wherever they appear. " +
          "Memory utilization is host-observed and typically reads a little " +
          "below what the guest operating system reports. Both are exact " +
          "enough to size a machine and are stated with their derivation so a " +
          "reader can judge them.",
      },
    },
    {
      id: "headroom-heading",
      type: "heading",
      config: { level: 1, text: "Capacity against usage" },
    },
    {
      id: "cpu-headroom",
      type: "capacity_vs_usage",
      config: {
        caption: "vCPU capacity against observed CPU",
        show_fidelity: true,
        capacity_metric: { sku_capability: "vCPUsAvailable" },
        usage_metric: ref(CPU_P95),
      },
    },
    {
      id: "memory-headroom",
      type: "capacity_vs_usage",
      config: {
        caption: "Memory capacity against observed usage",
        show_fidelity: true,
        capacity_metric: { sku_capability: "MemoryGB" },
        usage_metric: ref(MEMORY_USED_PCT_MAX),
      },
    },
    {
      id: "ranking-heading",
      type: "heading",
      config: { level: 1, text: "The two ends of the fleet" },
    },
    {
      id: "busiest-ten",
      type: "top_n_table",
      config: {
        caption: "Busiest ten by estimated p95 CPU",
        show_fidelity: true,
        order_by: ref(CPU_P95),
        order_by_direction: "descending",
        columns: [ref(CPU_P95), ref(CPU_MAX), ref(MEMORY_USED_PCT_MAX)],
      },
      scope_override: topVirtualMachines(
        10,
        "Percentage CPU",
        "p95",
        "descending"
      ),
    },
    {
      id: "quietest-ten",
      type: "top_n_table",
      config: {
        caption: "Quietest ten by estimated p95 CPU — the resize candidates",
        show_fidelity: true,
        order_by: ref(CPU_P95),
        order_by_direction: "ascending",
        columns: [ref(CPU_P95), ref(CPU_AVG), ref(MEMORY_USED_PCT_AVG)],
      },
      scope_override: topVirtualMachines(
        10,
        "Percentage CPU",
        "p95",
        "ascending"
      ),
    },
    {
      id: "p95-distribution",
      type: "distribution_chart",
      config: {
        caption: "Where the fleet sits on estimated p95 CPU",
        metrics: [ref(CPU_P95)],
      },
    },
    {
      id: "gaps",
      type: "gaps_and_coverage",
      config: { caption: "Machines this analysis could not cover" },
    },
    {
      id: "record",
      type: STARTER_RECORD_BLOCK_TYPE,
      config: { caption: "Collection record" },
    },
    { id: "methodology", type: "appendix_methodology", config: {} },
  ],
  design: design("technical", { table_style: "banded", density: "compact" }),
}

// --- Starter 3 — Executive summary ------------------------------------------

/**
 * One page for someone who will not read the other two. Prose first, three
 * figures, and the record that makes those three figures checkable.
 *
 * No resource table and no ranking on purpose: this starter exists to show that
 * a short, prose-forward report is a legitimate shape, and a per-machine table
 * would make it the monthly report with fewer columns.
 */
const EXECUTIVE_SUMMARY: TemplateDefinition = {
  schema_version: 1,
  identity: {
    name: "Executive summary",
    description:
      "A single page for the last full calendar month: narrative first, three " +
      "headline figures, and the snapshot record those figures trace to.",
    report_title: "Infrastructure utilization — executive summary",
  },
  scope: allVirtualMachines(),
  period: { kind: "last_full_month" },
  metrics: {
    [VIRTUAL_MACHINES]: [
      CPU_AVG,
      CPU_P95,
      MEMORY_BYTES_AVG,
      MEMORY_USED_PCT_AVG,
    ],
  },
  blocks: [
    { id: "cover", type: "cover", config: { subtitle: "Executive summary" } },
    {
      id: "summary-heading",
      type: "heading",
      config: { level: 1, text: "The month in one paragraph" },
    },
    { id: "summary-prose", type: "executive_summary", config: {} },
    {
      id: "kpis",
      type: "kpi_row",
      config: {
        caption: "Headline figures",
        show_fidelity: true,
        metrics: [ref(CPU_AVG), ref(CPU_P95), ref(MEMORY_USED_PCT_AVG)],
      },
    },
    {
      id: "record",
      type: STARTER_RECORD_BLOCK_TYPE,
      config: { caption: "Where these figures came from" },
    },
  ],
  design: design("minimal", { table_style: "hairline", density: "relaxed" }),
}

// --- The declared set -------------------------------------------------------

/**
 * One starter: its persisted `seeded_starter_key` and its definition.
 *
 * `name` and `description` are read off the definition's own `identity` rather
 * than being declared a second time, so the `report_templates` row and the
 * definition it pins cannot disagree about what the template is called.
 */
export type StarterTemplate = {
  /**
   * The `report_templates.seeded_starter_key` value — the idempotency key of
   * `UNIQUE (user_id, seeded_starter_key)`. **Stable forever**: renaming one
   * hides an existing user's seeded row from the seeder.
   */
  readonly seededStarterKey: string
  readonly definition: TemplateDefinition
}

/**
 * Exactly three (Requirement 10.1), in the order they are seeded and listed.
 *
 * One array read by the seeder **and** by `starters.static.test.ts`, so a fourth
 * starter added here is seeded and validated in the same change — a second list
 * is how a starter comes to be written and never checked.
 */
export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  { seededStarterKey: "monthly_utilization", definition: MONTHLY_UTILIZATION },
  { seededStarterKey: "capacity_planning", definition: CAPACITY_PLANNING },
  { seededStarterKey: "executive_summary", definition: EXECUTIVE_SUMMARY },
] as const

/** The three keys, for a caller comparing against what a user actually holds. */
export const STARTER_KEYS: readonly string[] = STARTER_TEMPLATES.map(
  (starter) => starter.seededStarterKey
)

/** Requirement 10.1 — three, asserted as a value the guard can read. */
export const STARTER_TEMPLATE_COUNT = 3

/**
 * Every block in a starter, flattened through row columns in document order.
 *
 * Exported because both the composition rule (Requirement 10.5) and the
 * unique-id assertion need the same traversal, and because a row's children are
 * exactly the blocks a naive `definition.blocks.map(…)` misses.
 */
export function flattenStarterBlocks(
  definition: TemplateDefinition
): readonly { readonly id: string; readonly type: BlockType }[] {
  const flattened: { id: string; type: BlockType }[] = []

  for (const block of definition.blocks) {
    flattened.push({ id: block.id, type: block.type })
    if (block.type !== "row") continue
    for (const column of block.columns) {
      for (const child of column) {
        flattened.push({ id: child.id, type: child.type })
      }
    }
  }

  return flattened
}

/**
 * Every `(metric | derived, statistic)` pair a starter's blocks reference,
 * as `"<metric|derived>|<statistic>"` keys.
 *
 * Requirement 5.3's containment check, in the one place that can perform it
 * cheaply: a block config's references are opaque to `definition.ts` (which
 * validates field *names*, not the shapes inside them), so the guard reads them
 * through this function and compares against the definition's own `metrics`.
 */
export function referencedMetricKeys(
  definition: TemplateDefinition
): ReadonlySet<string> {
  const keys = new Set<string>()

  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item)
      return
    }
    if (typeof value !== "object" || value === null) return

    const record = value as Record<string, unknown>
    const name =
      typeof record.metric === "string"
        ? record.metric
        : typeof record.derived === "string"
          ? record.derived
          : undefined

    if (name !== undefined && typeof record.statistic === "string") {
      keys.add(`${name}|${record.statistic}`)
      return
    }

    for (const nested of Object.values(record)) collect(nested)
  }

  for (const block of definition.blocks) {
    if (block.type === "row") {
      for (const column of block.columns) {
        for (const child of column) collect(child.config)
      }
      continue
    }
    collect(block.config)
  }

  return keys
}

/** The `(metric | derived, statistic)` pairs a starter's `metrics` selects. */
export function selectedMetricKeys(
  definition: TemplateDefinition
): ReadonlySet<string> {
  const keys = new Set<string>()

  for (const items of Object.values(definition.metrics)) {
    for (const item of items) {
      const name = item.metric ?? item.derived
      if (name === undefined) continue
      keys.add(`${name}|${item.statistic}`)
    }
  }

  return keys
}
