import type { TemplateView } from "@/lib/db/views"
import { messageText } from "@/lib/messages/catalog"

/**
 * A preset's state as one pill, shared by the cards and the list.
 *
 * One label rather than a version badge beside an "unsaved draft" note: the note was on
 * nearly every row, because a publish never clears the draft, so it read like an error
 * and said nothing. "Edits pending" now comes from comparing the draft with the live
 * version (`hasUnpublishedEdits`), and an empty preset says it is empty.
 */

export type PresetTone = "draft" | "pending" | "empty" | "live" | "archived"

export function presetStatus(template: TemplateView): { label: string; tone: PresetTone } {
  if (template.archivedAt !== null) {
    return { label: messageText("ui.presets.filter_archived", "en") ?? "", tone: "archived" }
  }
  const version = template.currentVersion
  if (version === null) {
    return { label: messageText("ui.presets.status_draft", "en") ?? "", tone: "draft" }
  }
  if (template.hasUnpublishedEdits) {
    return { label: messageText("ui.presets.status_pending", "en", { version }) ?? "", tone: "pending" }
  }
  if (template.sectionTypes.length === 0) {
    return { label: messageText("ui.presets.status_empty", "en", { version }) ?? "", tone: "empty" }
  }
  return { label: messageText("ui.presets.status_live", "en", { version }) ?? "", tone: "live" }
}

/** Shape and hue both, so the pill still reads in greyscale: drafts and pending edits are dashed. */
export const TONE_CLASS: Readonly<Record<PresetTone, string>> = {
  live: "bg-(--status-verified-soft) text-(--status-verified)",
  pending: "bg-(--status-attention-soft) text-(--status-attention) border border-dashed border-current",
  draft: "bg-(--status-inflight-soft) text-(--status-inflight) border border-dashed border-current",
  empty: "bg-muted text-muted-foreground",
  archived: "bg-muted text-muted-foreground border border-current/30",
}

/** Work not yet live: a preset never published, or one whose draft differs from the live version. */
export function hasPendingWork(template: TemplateView): boolean {
  return template.currentVersion === null || template.hasUnpublishedEdits
}

export function isEmptyPreset(template: TemplateView): boolean {
  return template.sectionTypes.length === 0
}

export function sectionCount(count: number): string {
  return count === 1
    ? (messageText("ui.presets.section_count_one", "en") ?? "")
    : (messageText("ui.presets.section_count", "en", { count }) ?? "")
}

export function formatEdited(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

/** The same date without the year when it is this year's, for a card's footer. */
export function formatEditedShort(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  })
}

/** A source as a coloured dot beside its short name, where the full mark would not fit. */
export const SOURCE_DOT_CLASS = {
  aws: "bg-[#ff9900]",
  azure: "bg-[#0a5cb8]",
  onprem: "bg-muted-foreground",
} as const
