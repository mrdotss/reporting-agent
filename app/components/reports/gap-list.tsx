"use client"

import { CaretDown, CaretRight, Info } from "@phosphor-icons/react"
import Link from "next/link"
import { useState } from "react"

import type { Language } from "@/lib/messages/language"
import { messageText, type MessageId } from "@/lib/messages/catalog"
import type { RunGap } from "@/lib/runs/gaps"
import {
  groupGaps,
  type GapInnerGroup,
  type GapTypeGroup,
  type GroupGapsOptions,
} from "@/lib/runs/gap-groups"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum entries shown in an expanded group (Requirement 20.14).
 * When a group has more, an explicit statement names both counts.
 */
export const MAX_EXPANDED_ENTRIES = 200

/**
 * Explanatory copy for eight of the declared gap types (line 29 in the original).
 * A type with NO entry here presents its `gapType` value, its entry count and its
 * representative message — it is presented rather than omitted (Requirement 20.13).
 */
/**
 * Every gap type, with the short label that heads its group and the sentence that
 * explains it.
 *
 * ## Two ids, not one
 *
 * This map used to point `labelId` and `noteId` at the **same** catalog id, so a
 * group's heading and its body rendered the identical sentence — "This resource's
 * type was in scope but no metric was requested for it." printed twice, once as a
 * title and once as its own explanation.
 *
 * ## Twenty-five, not eight
 *
 * It also covered only eight of the twenty-five `doc.gap.*` explanations the catalogue
 * carries. The other seventeen fell through `resolveLabel`'s fallback and rendered
 * their raw `snake_case` gap type as a user-facing heading — `fact_unavailable` is the
 * one that shows on almost every run — and lost their explanatory note entirely,
 * because `resolveNote` keyed off the same absent entry.
 *
 * A humanised token was the cheaper fix and is the wrong one here: this product ships
 * in English and Indonesian, and `"Fact unavailable"` derived from a machine token is
 * English in both. Every label is therefore a real catalogue string, and
 * `message-catalog.static.test.ts` holds the two halves together.
 */
const GAP_TYPE_COPY_IDS: Readonly<
  Record<string, { readonly labelId: MessageId; readonly noteId: MessageId }>
> = Object.freeze({
  advisor_not_available: { labelId: "ui.gap_label.advisor_not_available", noteId: "doc.gap.advisor_not_available" },
  archive_write_failed: { labelId: "ui.gap_label.archive_write_failed", noteId: "doc.gap.archive_write_failed" },
  backup_not_configured: { labelId: "ui.gap_label.backup_not_configured", noteId: "doc.gap.backup_not_configured" },
  catalog_entry_invalid: { labelId: "ui.gap_label.catalog_entry_invalid", noteId: "doc.gap.catalog_entry_invalid" },
  deallocated: { labelId: "ui.gap_label.deallocated", noteId: "doc.gap.deallocated" },
  definitions_unavailable: { labelId: "ui.gap_label.definitions_unavailable", noteId: "doc.gap.definitions_unavailable" },
  duplicate_inventory_row: { labelId: "ui.gap_label.duplicate_inventory_row", noteId: "doc.gap.duplicate_inventory_row" },
  fact_unavailable: { labelId: "ui.gap_label.fact_unavailable", noteId: "doc.gap.fact_unavailable" },
  instance_name_collapsed: { labelId: "ui.gap_label.instance_name_collapsed", noteId: "doc.gap.instance_name_collapsed" },
  interval_counts_missing: { labelId: "ui.gap_label.interval_counts_missing", noteId: "doc.gap.interval_counts_missing" },
  interval_malformed: { labelId: "ui.gap_label.interval_malformed", noteId: "doc.gap.interval_malformed" },
  metric_error: { labelId: "ui.gap_label.metric_error", noteId: "doc.gap.metric_error" },
  metric_not_emitted: { labelId: "ui.gap_label.metric_not_emitted", noteId: "doc.gap.metric_not_emitted" },
  metric_not_selected: { labelId: "ui.gap_label.metric_not_selected", noteId: "doc.gap.metric_not_selected" },
  no_reservations: { labelId: "ui.gap_label.no_reservations", noteId: "doc.gap.no_reservations" },
  no_samples: { labelId: "ui.gap_label.no_samples", noteId: "doc.gap.no_samples" },
  percentile_unsupported_unit: { labelId: "ui.gap_label.percentile_unsupported_unit", noteId: "doc.gap.percentile_unsupported_unit" },
  permission_denied: { labelId: "ui.gap_label.permission_denied", noteId: "doc.gap.permission_denied" },
  power_state_unknown: { labelId: "ui.gap_label.power_state_unknown", noteId: "doc.gap.power_state_unknown" },
  region_unreachable: { labelId: "ui.gap_label.region_unreachable", noteId: "doc.gap.region_unreachable" },
  replication_not_enabled: { labelId: "ui.gap_label.replication_not_enabled", noteId: "doc.gap.replication_not_enabled" },
  resource_absent_from_response: { labelId: "ui.gap_label.resource_absent_from_response", noteId: "doc.gap.resource_absent_from_response" },
  response_too_large: { labelId: "ui.gap_label.response_too_large", noteId: "doc.gap.response_too_large" },
  sku_capability_missing: { labelId: "ui.gap_label.sku_capability_missing", noteId: "doc.gap.sku_capability_missing" },
  sku_unknown: { labelId: "ui.gap_label.sku_unknown", noteId: "doc.gap.sku_unknown" },
})

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
export type GapListProps = Readonly<{
  gaps: readonly RunGap[]
  /** The grain + utcOffset needed by the grouper. */
  groupOptions?: GroupGapsOptions
  /** The pinned template's language for resolving copy (Requirement 15.9). */
  language?: Language
  /** The pinned template id, for the metric_not_selected link. */
  templateId?: string
}>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resolveLabel(
  gapType: string,
  language: Language
): string {
  const entry = GAP_TYPE_COPY_IDS[gapType]

  // A gap type with no catalogue entry is a type this build does not know about —
  // a newer agent writing into an older app. Printing the raw `snake_case` token at a
  // consultant is worse than saying plainly that it is unrecognised, and the entries
  // themselves are still listed underneath either way, so nothing is hidden.
  if (entry === undefined) {
    return messageText("ui.gap_list.unrecognized", language) ?? gapType
  }

  return messageText(entry.labelId, language) ?? gapType
}

function resolveNote(
  gapType: string,
  language: Language
): string | undefined {
  const entry = GAP_TYPE_COPY_IDS[gapType]
  if (entry === undefined) return undefined
  return messageText(entry.noteId, language)
}

/**
 * For `metric_not_selected`: extract distinct resource types and their resource
 * counts from the inner groups.
 */
function metricNotSelectedSummary(
  innerGroups: readonly GapInnerGroup[]
): {
  hasResourceTypes: boolean
  typeCounts: readonly { type: string; count: number }[]
  distinctResources: number
} {
  // Inner groups are keyed by (resourceId, metricKey). For metric_not_selected
  // entries we look at the representative message to extract the resource type,
  // since the message pattern from the agent is:
  //   "no metric was requested for resource type 'Microsoft.X/y'"
  // But more reliably, we extract from resourceId patterns.
  // Actually, we use the representative's message for the resource type extraction.
  const resourcesByType = new Map<string, Set<string>>()
  let hasAnyType = false
  const distinctResourceIds = new Set<string>()

  for (const group of innerGroups) {
    distinctResourceIds.add(group.resourceId)
    // Try to extract resource type from the resource id path
    const typeMatch = extractResourceType(group.resourceId)
    if (typeMatch !== null) {
      hasAnyType = true
      const existing = resourcesByType.get(typeMatch)
      if (existing !== undefined) {
        existing.add(group.resourceId)
      } else {
        resourcesByType.set(typeMatch, new Set([group.resourceId]))
      }
    }
  }

  if (!hasAnyType) {
    return {
      hasResourceTypes: false,
      typeCounts: [],
      distinctResources: distinctResourceIds.size,
    }
  }

  // Sort ascending by resource type in code-point order
  const sorted = [...resourcesByType.entries()]
    .map(([type, resources]) => ({ type, count: resources.size }))
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))

  return {
    hasResourceTypes: true,
    typeCounts: sorted,
    distinctResources: distinctResourceIds.size,
  }
}

/**
 * Extract resource type from an ARM resource id.
 * Pattern: /subscriptions/.../providers/Namespace/Type/name
 */
function extractResourceType(resourceId: string): string | null {
  // Match the providers/Namespace/Type pattern in the resource id
  const match =
    /\/providers\/(Microsoft\.[^/]+\/[^/]+)/i.exec(resourceId)
  if (match) return match[1]
  return null
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MetricNotSelectedSection({
  group,
  language,
  templateId,
}: Readonly<{
  group: GapTypeGroup
  language: Language
  templateId: string | undefined
}>) {
  const summary = metricNotSelectedSummary(group.innerGroups)

  const statement =
    language === "id"
      ? "Penyebabnya adalah templat tidak memilih metrik untuk tipe-tipe sumber daya tersebut. Perbaikan: edit templat pada langkah pemilihan metrik."
      : "The template selected no metric for those resource types. Fix: edit the template's metric selection step."

  const templateLink = templateId ? (
    <Link
      href={`/report-profiles/${templateId}/edit`}
      className="text-sm underline underline-offset-2 text-muted-foreground hover:text-foreground"
    >
      {language === "id"
        ? "Buka pemilihan metrik templat"
        : "Open template metric selection"}
    </Link>
  ) : null

  return (
    <div className="flex flex-col gap-2 text-sm text-muted-foreground">
      <p className="max-w-prose">{statement}</p>
      {templateLink}

      {summary.hasResourceTypes ? (
        <ul className="flex flex-col gap-0.5">
          {summary.typeCounts.map(({ type, count }) => (
            <li key={type} className="font-mono text-xs tabular-nums">
              {type}{" "}
              <span className="text-muted-foreground">
                ({count}{" "}
                {count === 1
                  ? language === "id"
                    ? "sumber daya"
                    : "resource"
                  : language === "id"
                    ? "sumber daya"
                    : "resources"}
                )
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs">
          {language === "id"
            ? `${summary.distinctResources} sumber daya berbeda terdampak. Tipe sumber daya tidak tercatat.`
            : `${summary.distinctResources} distinct resources affected. Resource types were not recorded.`}
        </p>
      )}
    </div>
  )
}

function InnerGroupList({
  innerGroups,
  totalCount,
}: Readonly<{
  innerGroups: readonly GapInnerGroup[]
  totalCount: number
}>) {
  const capped = innerGroups.slice(0, MAX_EXPANDED_ENTRIES)
  const overflow = innerGroups.length > MAX_EXPANDED_ENTRIES
  const shownEntryCount = capped.reduce((sum, g) => sum + g.count, 0)

  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-1">
        {capped.map((group, idx) => (
          <li
            key={`${group.resourceId}|${group.metricKey}|${idx}`}
            className="flex flex-col gap-0.5 text-sm"
          >
            <span className="font-mono text-xs break-all text-muted-foreground tabular-nums">
              {group.resourceId}
              {group.metricKey !== "\u0000no-metric" ? (
                <>
                  {" · "}
                  {group.metricKey}
                </>
              ) : null}
              {group.count > 1 ? (
                <span className="text-muted-foreground">
                  {" "}
                  ×{group.count}
                </span>
              ) : null}
              {group.range !== null ? (
                <span className="text-muted-foreground">
                  {" "}
                  ({group.range.from} – {group.range.to})
                </span>
              ) : null}
            </span>
            <span className="max-w-prose text-muted-foreground">
              {group.representative.message}
            </span>
          </li>
        ))}
      </ul>
      {overflow ? (
        <p
          data-slot="gap-overflow"
          className="text-xs text-muted-foreground italic"
        >
          {messageText("ui.gap_list.pagination", "en", { shownGroups: String(capped.length), totalGroups: String(innerGroups.length), shownEntries: String(shownEntryCount), totalEntries: String(totalCount) })}
        </p>
      ) : null}
    </div>
  )
}

function GapGroupSection({
  group,
  language,
  templateId,
}: Readonly<{
  group: GapTypeGroup
  language: Language
  templateId: string | undefined
}>) {
  const [expanded, setExpanded] = useState(false)

  const label = resolveLabel(group.gapType, language)
  const note = resolveNote(group.gapType, language)
  const isMetricNotSelected = group.gapType === "metric_not_selected"
  const hasCopy = GAP_TYPE_COPY_IDS[group.gapType] !== undefined

  const accessibleName = `${label}, ${group.count} ${language === "id" ? "entri" : group.count === 1 ? "entry" : "entries"}`

  return (
    <section
      data-slot="gap-group"
      data-gap-type={group.gapType}
      className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3"
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-label={accessibleName}
        className="flex flex-wrap items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
      >
        {expanded ? (
          <CaretDown
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
        ) : (
          <CaretRight
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}

        <Info
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />

        <h3 className="font-heading text-sm font-medium tracking-tight">
          {label}
        </h3>

        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {group.count}
        </span>
      </button>

      {/* Note for recognized types, or representative message for unrecognized */}
      {hasCopy && note !== undefined ? (
        <p className="max-w-prose text-sm text-muted-foreground">{note}</p>
      ) : !hasCopy ? (
        <p className="max-w-prose text-sm text-muted-foreground italic">
          {group.innerGroups[0]?.representative.message}
        </p>
      ) : null}

      {/* metric_not_selected special section (Requirement 20.8, 20.9) */}
      {isMetricNotSelected ? (
        <MetricNotSelectedSection
          group={group}
          language={language}
          templateId={templateId}
        />
      ) : null}

      {/* Expanded inner groups */}
      {expanded ? (
        <InnerGroupList
          innerGroups={group.innerGroups}
          totalCount={group.count}
        />
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * The `collection_log`, grouped losslessly by `gap_type` then by
 * `(resourceId, metric)` (Requirements 20.1–20.14, 15.9).
 *
 * ## A gap is neutral information, not an error state
 *
 * Every token here is a **mist neutral**, and that is a requirement rather than taste.
 * `--destructive` in this product means *this document could not be proven*; a gap means
 * *this is what we could not read, recorded rather than silently zero-filled*, which is
 * the honest half of a report that completed.
 *
 * ## The grouping replaces the one-per-entry list
 *
 * The original presentation emitted 512 paragraphs for a run whose entries largely
 * named the same resource. This component groups by type, then shows inner groups
 * with counts, expanding to at most MAX_EXPANDED_ENTRIES (200).
 */
export function GapList({
  gaps,
  groupOptions,
  language = "en",
  templateId,
}: GapListProps) {
  // Requirement 20.10: zero entries → explicit statement, never omit the section
  if (gaps.length === 0) {
    const emptyText =
      messageText("ui.gap_list.empty", language) ??
      "No gaps recorded for this run"

    return (
      <p data-slot="gap-list-empty" className="text-sm text-muted-foreground">
        {emptyText}
      </p>
    )
  }

  const options: GroupGapsOptions = groupOptions ?? {
    grain: "PT1H",
    utcOffset: "+07:00",
  }

  const groups = groupGaps(gaps, options)

  return (
    <div data-slot="gap-list" className="flex flex-col gap-4">
      {groups.map((group) => (
        <GapGroupSection
          key={group.gapType}
          group={group}
          language={language}
          templateId={templateId}
        />
      ))}
    </div>
  )
}
