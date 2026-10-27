import { MAX_AGENT_BLOCKS } from "@/lib/templates/definition"

import { sectionEntry } from "./catalogue"
import { agentCount, avgAndPeakMetric, type AddedKind, type DefinitionV4, type SectionV4 } from "./model"

/**
 * Whether a block can go into a section, and why not when it cannot.
 *
 * One answer for every place a block is offered: the Add panel's gallery, the + between
 * blocks and the / menu. A block that does not fit stays on offer, greyed, with this reason
 * beside it, so an author learns what the block needs instead of wondering where it went.
 */

export type BlockFit = { readonly ok: true } | { readonly ok: false; readonly reason: string }

const READS_METRICS: ReadonlySet<AddedKind> = new Set([
  "key_figures",
  "top_list",
  "month_vs_month",
  "heatmap",
  "sparklines",
  "avg_vs_peak",
])

export function readsMetrics(kind: AddedKind): boolean {
  return READS_METRICS.has(kind)
}

export function blockFit(
  definition: DefinitionV4,
  section: SectionV4 | undefined,
  kind: AddedKind
): BlockFit {
  if (section === undefined) return { ok: false, reason: "Choose a section to add it to." }
  if (kind === "agent" && agentCount(definition) >= MAX_AGENT_BLOCKS) {
    return { ok: false, reason: `A preset holds at most ${MAX_AGENT_BLOCKS} agent paragraphs.` }
  }
  if (readsMetrics(kind) && !sectionEntry(definition.provider, section.type)?.metricBearing) {
    return { ok: false, reason: "Reads metrics. This section reports none." }
  }
  // Average and peak draws one metric's two figures, so the section must collect both.
  if (kind === "avg_vs_peak" && avgAndPeakMetric(section) === null) {
    return { ok: false, reason: "Needs a metric this section collects as both an average and a maximum." }
  }
  return { ok: true }
}

/**
 * The blocks by what an author wants the page to do, the gallery's groups.
 *
 * Every added kind is in exactly one group (`fit.test.ts` holds that), so a new kind that
 * is not placed here fails a test rather than disappearing from the gallery.
 */
export const BLOCK_INTENTS: readonly { readonly label: string; readonly kinds: readonly AddedKind[] }[] = [
  { label: "Show a number", kinds: ["key_figures", "avg_vs_peak"] },
  { label: "Rank", kinds: ["top_list"] },
  { label: "Over time", kinds: ["heatmap", "sparklines"] },
  { label: "Compare", kinds: ["month_vs_month"] },
  { label: "Status", kinds: ["coverage", "callout"] },
  { label: "Words", kinds: ["text", "agent"] },
  { label: "Layout", kinds: ["page_break"] },
]
