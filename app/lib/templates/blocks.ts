/**
 * The block-type set and the per-type config schema — one contract, expressed in
 * two languages.
 *
 * The declaration below is mirrored in
 * `agent/src/reporting_agent/compile/definition.py` (Requirement 2.5), and
 * `app/test/mirror.static.test.ts` extracts the sentinel-delimited regions from
 * both files and compares the block-type sets, every type's config field names,
 * every field's required status and every enumerated field's permitted values
 * (Requirement 2.6). That is why the declarations sit on their own, between
 * sentinels, in a plain literal shape rather than inside a zod schema or a
 * mapped type: the guard needs neither a TypeScript parser nor a Python parser,
 * so the guard itself cannot drift from what it guards — the same reasoning
 * `lib/events.ts` already applies to the SSE event vocabulary.
 *
 * **Why this matters more than the event vocabulary does.** A definition the
 * wizard can save and the compiler cannot compile turns a save-time validation
 * error into a failed run minutes later, after inventory and metrics have
 * already been spent (Requirement 2.6). The block-type set is the one place
 * that failure mode is structurally possible, because it is declared twice.
 *
 * **This file exports only `BLOCK_TYPES`, `BlockType` and `BLOCK_CONFIG`.** The
 * zod schema that actually validates a definition against this shape
 * (`lib/templates/definition.ts`, the `Template_Validator`) is a later task —
 * this file is the shared vocabulary the validator, the compiler and the guard
 * all read, not the validator itself.
 */

// --- BEGIN BLOCK TYPES (mirrored in agent/src/reporting_agent/compile/definition.py) ---
export const BLOCK_TYPES = [
  "cover",
  "executive_summary",
  "kpi_row",
  "resource_table",
  "top_n_table",
  "timeseries_chart",
  "distribution_chart",
  "capacity_vs_usage",
  "gaps_and_coverage",
  "comparison_delta",
  "verification_record",
  "appendix_methodology",
  "row",
  "page_break",
  "heading",
  "rich_text",
  "historical_trend",
  "blank_rows_table",
  "metric_summary",
  "inventory_summary",
] as const
// --- END BLOCK TYPES ---

/** One of the nineteen declared block types (Requirement 6.1). */
export type BlockType = (typeof BLOCK_TYPES)[number]

/**
 * The config schema for one block type: which fields it accepts, which of
 * those are required, and the permitted values of any field the schema
 * enumerates.
 *
 * Deliberately shallow — field *names*, not field *types*. A field's actual
 * type (string length, numeric bound, nested object shape) is the
 * `Template_Validator`'s job in `lib/templates/definition.ts` (a later task);
 * what the Mirror_Guard needs from this declaration is only what a save-time
 * schema and a compile-time schema could silently disagree about: a field one
 * side accepts and the other rejects, a field one side requires and the other
 * treats as optional, or an enumerated value one side permits and the other
 * does not.
 */
type BlockConfigSchema = {
  readonly required: readonly string[]
  readonly optional: readonly string[]
  readonly enums: Readonly<Record<string, readonly string[]>>
  /**
   * The required **string** fields whose compilers demand content, so a blank one is
   * a save-time rejection rather than a run-time failure. See the note above
   * `BLOCK_CONFIG` for why this lives here and not in the emptiness rule.
   *
   * Optional, and absent on most types: a type with no such field reads identically
   * whether it omits the key or spells out `[]`, on both sides of the mirror.
   */
  readonly non_empty?: readonly string[]
}

// --- BEGIN COLUMN KINDS (mirrored in agent/src/reporting_agent/compile/definition.py) ---
export const COLUMN_KINDS = ["metric", "attribute", "fact"] as const
// --- END COLUMN KINDS ---

export type ColumnKind = (typeof COLUMN_KINDS)[number]

// --- BEGIN BLOCK CONFIG (mirrored in agent/src/reporting_agent/compile/definition.py) ---
// `non_empty` names the required string fields whose compilers demand content, and it
// exists because `isEmptyContainer` deliberately cannot decide that. An empty string's
// meaning is a fact about the individual field: `heading.text: ""` is a legitimately
// blank heading, while `rich_text.text: ""` saved cleanly and then failed the run
// minutes later in the agent's `compile_rich_text`. Telling those apart needs per-field
// knowledge, and this table is already the authority on block configuration — putting
// it in the emptiness rule would make that rule a third authority to drift from.
//
// Declared only on the types that have such a field; both validators default to empty,
// so an absent `non_empty` and an explicit `[]` mean the same thing. A list of field
// names rather than a nested per-field flag so the Mirror_Guard reads it with the same
// `extractArrayField` it already uses for `required` and `optional`.
export const BLOCK_CONFIG = {
  // Req 16.13 — the compiler derives the report title, the subscription's
  // display name and the run's resolved local dates on its own, and emits no
  // metric value. `subtitle` is the only thing left for the wizard to set.
  cover: {
    required: [],
    optional: ["subtitle"],
    enums: {},
  },

  // Req 19.1 — the model's only context is the ledger, the aggregate table and
  // the collection_log gap counts, all supplied by the Agent_Runtime rather
  // than by the definition. There is no knob here that could add a number: a
  // config field that let the wizard hand the model anything else would be
  // exactly the hole Requirement 19 closes.
  executive_summary: {
    required: [],
    optional: [],
    enums: {},
  },

  // Req 16.1 — `metrics` names the metric/statistic pairs this row's cards
  // show; every entry must already be present in the definition's own metric
  // selection (Req 5.3), so a block can reference only what the run actually
  // collects.
  kpi_row: {
    required: ["metrics"],
    optional: ["caption", "show_fidelity"],
    enums: {},
  },

  // Req 16.2 — one row per resource in the block's resolved scope, ordered as
  // criterion 3.6 declares (the scope's own top-N/sort, not a field here).
  // `columns` is the set of metric/statistic pairs and resource attributes the
  // table shows per resource.
  resource_table: {
    required: ["columns"],
    optional: ["caption", "show_fidelity", "layout"],
    enums: { layout: ["rows", "pairs"] },
  },

  // The one entry design.md's cross-language-mirror example gives verbatim
  // (Requirement 2.5's worked example): `order_by` is the column the wizard
  // presents the ranking against, distinct from the ranking metric a scope's
  // `top_n` dimension already carries (Req 3.1) — the two can name the same
  // metric, but this field is about which column the table highlights as the
  // reason for the order, not about re-deriving the order itself.
  top_n_table: {
    required: ["columns", "order_by"],
    optional: ["caption", "show_fidelity"],
    enums: { order_by_direction: ["descending", "ascending"] },
    non_empty: ["order_by"],
  },

  // Req 16.14 — the compiler decides `encoding` (`categorical` vs
  // `sequential`) from whether the series are peers or one ordered quantity;
  // that is not a field a consultant sets, so it is absent here on purpose.
  timeseries_chart: {
    required: ["metrics"],
    optional: ["caption", "show_fidelity"],
    enums: {},
  },

  // One table per selected metric: a row per resource carrying that metric's
  // average, its estimated P95 where the catalogue declares one, its peak, and
  // the day the peak fell on. The statistics are the block's own rather than a
  // config field — see `SUMMARY_STATISTICS` on the agent side — so the only
  // thing to select is which metrics get a summary.
  metric_summary: {
    required: ["metrics"],
    optional: ["caption", "orientation"],
    enums: { orientation: ["resource_major", "metric_major"] },
  },
  inventory_summary: {
    required: ["group_by"],
    optional: ["caption"],
    enums: {
      group_by: ["subscription", "resource_group", "region", "resource_type"],
    },
  },

  // Same reasoning as `timeseries_chart` — Req 16.14 governs both chart block
  // types with one criterion, so both config schemas stay parallel.
  distribution_chart: {
    required: ["metrics"],
    optional: ["caption", "show_fidelity"],
    enums: {},
  },

  // A capacity figure (from `azure-mgmt-compute` SKU capacity) paired against a
  // usage metric — the derived-metric pairing `azure-integration.md` describes
  // for memory_used_pct and its siblings.
  capacity_vs_usage: {
    required: ["capacity_metric", "usage_metric"],
    optional: ["caption", "show_fidelity"],
    enums: {},
  },

  // Req 16.3 — the compiler groups the snapshot's own `collection_log` by
  // `gap_type`; there is nothing for a consultant to configure beyond a
  // caption, and the explicit no-gaps row is emitted automatically when the
  // log is empty.
  gaps_and_coverage: {
    required: [],
    optional: ["caption"],
    enums: {},
  },

  // Req 16.7 — compiled from the snapshots pinned by the two completed runs
  // this block names; `run_a` and `run_b` are the only inputs, and the delta's
  // sign (later minus earlier) is fixed by the requirement rather than
  // configurable.
  comparison_delta: {
    required: ["run_a", "run_b"],
    optional: ["caption"],
    enums: {},
    non_empty: ["run_a", "run_b"],
  },

  // Req 16.4, 16.5 — snapshot provenance and the collection record only. No
  // config field could carry a verification status, a verified-figure count or
  // a finding count, because that outcome does not exist until the document
  // this block sits inside has already been rendered.
  verification_record: {
    required: [],
    optional: ["caption"],
    enums: {},
  },

  // Req 16.6 — period, grain, aggregation method and estimator labels are all
  // read from the pinned template version and the Figure_Ledger; the
  // requirement is explicit that the compiler composes no estimator label of
  // its own, so there is nothing here for a consultant to set.
  appendix_methodology: {
    required: [],
    optional: ["caption"],
    enums: {},
  },

  // Req 6.2 — a `row`'s own shape (`id`, `type: "row"`, a column count of 2 or
  // 3, and each column's child blocks) is carried on the block object itself,
  // not inside `config` — the same reason `lib/templates/definition.ts` models
  // `columns` as a list of lists rather than a count plus a flat child list.
  // This entry stays empty rather than absent, so the Mirror_Guard has
  // something to compare for every declared type.
  row: {
    required: [],
    optional: [],
    enums: {},
  },

  // Req 16.9 — a page break node carrying no figure and needing no
  // configuration at all.
  page_break: {
    required: [],
    optional: [],
    enums: {},
  },

  heading: {
    required: ["level", "text"],
    optional: [],
    enums: {},
  },

  // Req 6.6 — `rich_text` carries static prose and no figure. `text` is
  // therefore the *only* field this schema will ever declare: no `metric`, no
  // `statistic`, no `resource_id`, no `scope` and no `snapshot_path` may be
  // added here without reopening the hole that requirement exists to close.
  rich_text: {
    required: ["text"],
    optional: [],
    enums: {},
    non_empty: ["text"],
  },

  // Req 18.1 — one chart over prior verified runs' values for a single
  // metric+statistic pair. `lookback` is 2–24 inclusive. The block's config
  // metric and statistic must already be in the definition's metric selection.
  historical_trend: {
    required: ["metric", "statistic", "lookback"],
    optional: ["caption"],
    enums: {},
  },
  blank_rows_table: {
    required: ["columns", "rows"],
    optional: ["caption", "supplied_rows"],
    enums: {},
  },
} as const satisfies Record<BlockType, BlockConfigSchema>
// --- END BLOCK CONFIG ---
