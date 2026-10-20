import {
  expansionFor,
  resourceNoun,
  type CatalogueSection,
} from "@/lib/builder/catalogue"
import type { AddedEntry, AddedKind, CalloutCondition } from "@/lib/builder/model"

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
export const ADDED_BLOCKS: Readonly<
  Record<AddedKind, { readonly label: string; readonly blurb: string; readonly needsMetrics: boolean }>
> = {
  text: { label: "Text", blurb: "Words only, in English and Indonesian.", needsMetrics: false },
  key_figures: {
    label: "Key figures",
    blurb: "Each metric's highest value, and which resource reached it.",
    needsMetrics: true,
  },
  top_list: {
    label: "Top list",
    blurb: "The resources ranked by the section's ranking metric.",
    needsMetrics: true,
  },
  month_vs_month: {
    label: "Month vs month",
    blurb: "Each resource against the previous verified report.",
    needsMetrics: true,
  },
  coverage: { label: "Coverage", blurb: "What could not be measured, and for which resources.", needsMetrics: false },
  page_break: { label: "Page break", blurb: "Starts the next block on a new page.", needsMetrics: false },
  callout: {
    label: "Callout",
    blurb: "Your words, printed only when a condition holds.",
    needsMetrics: false,
  },
  heatmap: {
    label: "Heatmap",
    blurb: "One row per resource, one cell per day, shaded by the ranking metric.",
    needsMetrics: true,
  },
  sparklines: {
    label: "Sparkline table",
    blurb: "Each resource's shape over the period, with its numbers beside it.",
    needsMetrics: true,
  },
  avg_vs_peak: {
    label: "Average and peak",
    blurb: "One row per resource, from its average to its peak. Busiest first.",
    needsMetrics: true,
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
