import {
  expansionFor,
  resourceNoun,
  type CatalogueSection,
} from "@/lib/builder/catalogue"
import type { AddedEntry, AddedKind, CalloutCondition } from "@/lib/builder/model"
import type { ChartStyle } from "@/lib/templates/definition"

/**
 * What the builder calls a block — in the outline, the selection tag and the inspector.
 *
 * Named for what a reader sees on the page (a "Details table", a "Chart"), not for the
 * block type the runtime compiles. Interface copy is English throughout, as the rest of the
 * app is; the document's language governs only what prints.
 */

const BY_BLOCK: Readonly<Record<string, string>> = {
  timeseries_chart: "Chart",
  metric_summary: "Metric summary",
  resource_narrative: "Narrative",
  trend_narrative: "Narrative",
  historical_trend: "Trend chart",
  top_n_table: "Top list",
  inventory_summary: "Summary table",
  blank_rows_table: "Typed rows",
  gaps_and_coverage: "Coverage",
  verification_record: "Verification record",
  at_a_glance: "At a glance",
}

function words(slot: string): string {
  const spaced = slot.replaceAll("_", " ")
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function blockLabel(entry: CatalogueSection, slot: string): string {
  const expansion = expansionFor(entry, slot)
  if (!expansion) return words(slot)
  if (expansion.block === "heading") {
    if (slot === "title") return "Section title"
    if (slot === "name") return `${words(resourceNoun(entry))} heading`
    return words(slot)
  }
  if (expansion.block === "resource_table") {
    if (slot === "details") return "Details table"
    if (slot === "table") return "Table"
    return words(slot.endsWith("_table") ? slot : `${slot} table`)
  }
  return BY_BLOCK[expansion.block] ?? words(slot)
}

/** One line on what the block shows, for the Add panel and the inspector. */
export function blockHint(entry: CatalogueSection, slot: string): string {
  const expansion = expansionFor(entry, slot)
  switch (expansion?.block) {
    case "heading":
      return slot === "title" ? "The section's name, in the contents too." : "A subheading."
    case "resource_table":
      return expansion.per === "resource" ? "One row per field, for each resource." : "One row per resource."
    case "timeseries_chart":
      return "Each selected metric over the period."
    case "metric_summary":
      return "Average, estimated P95, peak and when it peaked."
    case "resource_narrative":
    case "trend_narrative":
      return "A short paragraph written from the verified figures."
    case "historical_trend":
      return "Month by month, from earlier verified reports."
    case "top_n_table":
      return "The resources ranked by the section's ranking metric."
    default:
      return ""
  }
}

/** What the builder calls a block the author added, and one line on what it shows. */
export { AGENT_REASONS } from "@/lib/builder/agent-reasons"

export const ADDED_BLOCKS: Readonly<
  Record<
    AddedKind,
    { readonly label: string; readonly hint: string; readonly blurb: string; readonly needsMetrics: boolean }
  >
> = {
  text: { label: "Text", hint: "Your words, EN and ID", blurb: "Words only, in English and Indonesian.", needsMetrics: false },
  key_figures: {
    label: "Key figures", hint: "Highest value per metric",
    blurb: "Each metric's highest value, and which resource reached it.",
    needsMetrics: true,
  },
  top_list: {
    label: "Top list", hint: "Today's ranked table",
    blurb: "The resources ranked by the section's ranking metric.",
    needsMetrics: true,
  },
  month_vs_month: {
    label: "Month vs month", hint: "Against the last report",
    blurb: "Each resource against the previous verified report.",
    needsMetrics: true,
  },
  coverage: { label: "Coverage", hint: "What couldn't be measured", blurb: "What could not be measured, and for which resources.", needsMetrics: false },
  page_break: { label: "Page break", hint: "Next block on a new page", blurb: "Starts the next block on a new page.", needsMetrics: false },
  callout: {
    label: "Callout", hint: "Words when a condition holds",
    blurb: "Your words, printed only when a condition holds.",
    needsMetrics: false,
  },
  heatmap: {
    label: "Heatmap", hint: "Resource by day, shaded",
    blurb: "One row per resource, one cell per day, shaded by the ranking metric.",
    needsMetrics: true,
  },
  sparklines: {
    label: "Sparkline table", hint: "Shapes with their numbers",
    blurb: "Each resource's shape over the period, with its numbers beside it.",
    needsMetrics: true,
  },
  avg_vs_peak: {
    label: "Average and peak", hint: "From average to peak",
    blurb: "One row per resource, from its average to its peak. Busiest first.",
    needsMetrics: true,
  },
  kpi_tiles: {
    label: "KPI tiles", hint: "Figure, change, sparkline",
    blurb: "Up to four metrics as large figures, each beside the previous report's.",
    needsMetrics: true,
  },
  bar_list: {
    label: "Bar list", hint: "Busiest first, value at end",
    blurb: "The ranked resources as labelled bars, each with its figure.",
    needsMetrics: true,
  },
  utilization_bullet: {
    label: "Utilisation bullet", hint: "Avg, P95, peak vs line",
    blurb: "Average, estimated P95 and peak on one bar per resource, against your threshold.",
    needsMetrics: true,
  },
  fleet_mix: {
    label: "Fleet mix", hint: "Size families, stopped",
    blurb: "How the machines or databases split by size family, and how many are stopped.",
    needsMetrics: false,
  },
  backup_tracker: {
    label: "Backup tracker", hint: "A mark per day backed up",
    blurb: "Which days each resource was backed up on (AWS), or its last backup status (Azure).",
    needsMetrics: false,
  },
  small_multiples: {
    label: "Small multiples", hint: "One mini chart each",
    blurb: "One small chart per resource on one shared scale, to compare their shapes.",
    needsMetrics: true,
  },
  annotated_line: {
    label: "Annotated line", hint: "Threshold and incidents",
    blurb: "The busiest resources over the period, with your threshold and the incidents you type on the run form.",
    needsMetrics: true,
  },
  week_heatmap: {
    label: "Hour by weekday", hint: "Busy hours of the week",
    blurb: "The fleet's busy hours: one row per weekday, one cell per hour. Shows when it could be switched off.",
    needsMetrics: true,
  },
  agent: {
    label: "Agent paragraph", hint: "Written for you, checked",
    blurb: "Written by the agent from this section's figures, on your instruction. Every number checked.",
    needsMetrics: false,
  },
}


/** What each callout condition tests, per provider — the providers name the same idea differently. */
export function calloutConditionLabel(when: CalloutCondition, provider: "aws" | "azure"): string {
  switch (when) {
    case "peak_at_or_above":
      return "A resource reaches a threshold"
    case "without_backup":
      return provider === "aws" ? "Resources with no AWS Backup plan" : "Resources with no Azure Backup"
    case "housekeeping":
      return "Resources to tidy up"
    case "stopped":
      return provider === "aws" ? "Stopped instances" : "Deallocated machines"
    case "coverage_gaps":
      return "Figures that could not be measured"
  }
}

export const CALLOUT_TOKENS: Readonly<Record<CalloutCondition, readonly string[]>> = {
  peak_at_or_above: ["resource", "value"],
  without_backup: ["count"],
  housekeeping: ["count"],
  stopped: ["count"],
  coverage_gaps: ["count"],
}

export const ADDED_KINDS = Object.keys(ADDED_BLOCKS) as AddedKind[]

export function addedLabel(entry: AddedEntry, language: "en" | "id"): string {
  if (entry.kind !== "text") return ADDED_BLOCKS[entry.kind].label
  const text = entry.text?.[language]
  return text ? `“${text.slice(0, 28)}${text.length > 28 ? "…" : ""}”` : "Text (empty)"
}

/** A chart look's name, in the theme panel, the inspector and Ask. */
export const CHART_STYLE_NAMES: Readonly<Record<ChartStyle, string>> = {
  stacked: "Stacked",
  soft_area: "Soft area",
  flat_area: "Flat area",
  range_band: "Range band",
  columns: "Columns",
  sparkline: "Sparkline",
  small_multiples: "Small multiples",
}
