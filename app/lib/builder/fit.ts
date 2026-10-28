import { MAX_AGENT_BLOCKS } from "@/lib/templates/definition"

import { sectionEntry } from "./catalogue"
import { agentCount, avgAndPeakMetric, type AddedKind, type DefinitionV4, type SectionV4 } from "./model"

/**
 * Whether a block can go into a section, and why not when it cannot.
 *
 * One answer for every place a block is offered: the Add panel's gallery, the + between
 * blocks and the / menu. A block that does not fit stays on offer, greyed, with this reason
 * beside it, so an author learns what the block needs instead of wondering where it went.
 * `short` fits under a gallery card's name; `reason` is the full sentence, shown on hover.
 */

export type BlockFit =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly short: string }

const READS_METRICS: ReadonlySet<AddedKind> = new Set([
  "key_figures",
  "top_list",
  "month_vs_month",
  "heatmap",
  "sparklines",
  "avg_vs_peak",
  "kpi_tiles",
  "bar_list",
  "utilization_bullet",
  "small_multiples",
  "annotated_line",
  "week_heatmap",
])

/**
 * The types a fleet mix counts (`compile/snapshot_view.py::FLEET_MIX_TYPES`): the machines and
 * databases whose sizes name a family.
 */
const FLEET_MIX_TYPES: ReadonlySet<string> = new Set([
  "aws::ec2::instance",
  "aws::rds::dbinstance",
  "microsoft.compute/virtualmachines",
])

function holdsFleetMixTypes(definition: DefinitionV4, section: SectionV4): boolean {
  const types = section.selection?.resource_types?.length
    ? section.selection.resource_types
    : (sectionEntry(definition.provider, section.type)?.needsResourceTypes ?? [])
  return types.some((type) => FLEET_MIX_TYPES.has(type.toLowerCase()))
}

/** The fact sources a backup tracker reads: AWS Backup's recovery points, or Recovery Services. */
const BACKUP_FACT_SOURCES: ReadonlySet<string> = new Set(["aws_backup", "recovery_services"])

function readsBackups(definition: DefinitionV4, section: SectionV4): boolean {
  return (sectionEntry(definition.provider, section.type)?.needsFactSources ?? []).some((source) =>
    BACKUP_FACT_SOURCES.has(source)
  )
}

export function readsMetrics(kind: AddedKind): boolean {
  return READS_METRICS.has(kind)
}

export function blockFit(
  definition: DefinitionV4,
  section: SectionV4 | undefined,
  kind: AddedKind
): BlockFit {
  if (section === undefined) return { ok: false, reason: "Choose a section to add it to.", short: "Choose a section" }
  if (kind === "agent" && agentCount(definition) >= MAX_AGENT_BLOCKS) {
    return {
      ok: false,
      reason: `A preset holds at most ${MAX_AGENT_BLOCKS} agent paragraphs.`,
      short: `At most ${MAX_AGENT_BLOCKS} per preset`,
    }
  }
  if (readsMetrics(kind) && !sectionEntry(definition.provider, section.type)?.metricBearing) {
    return { ok: false, reason: "Reads metrics. This section reports none.", short: "Needs a metrics section" }
  }
  // Average and peak draws one metric's two figures, so the section must collect both.
  if ((kind === "avg_vs_peak" || kind === "utilization_bullet") && avgAndPeakMetric(section) === null) {
    return {
      ok: false,
      reason: "Needs a metric this section collects as both an average and a maximum.",
      short: "Needs average and maximum",
    }
  }
  if (kind === "fleet_mix" && !holdsFleetMixTypes(definition, section)) {
    return {
      ok: false,
      reason: "Counts machines and databases. This section holds neither.",
      short: "Needs machines or databases",
    }
  }
  if (kind === "backup_tracker" && !readsBackups(definition, section)) {
    return { ok: false, reason: "Reads backups. Add it to the backups section.", short: "Needs Backups section" }
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
  { label: "Show a number", kinds: ["key_figures", "kpi_tiles", "avg_vs_peak", "utilization_bullet"] },
  { label: "Rank", kinds: ["top_list", "bar_list"] },
  { label: "Over time", kinds: ["heatmap", "sparklines", "small_multiples", "annotated_line", "week_heatmap"] },
  { label: "Compare", kinds: ["month_vs_month", "fleet_mix"] },
  { label: "Status", kinds: ["coverage", "callout", "backup_tracker"] },
  { label: "Words", kinds: ["text", "agent"] },
  { label: "Layout", kinds: ["page_break"] },
]
