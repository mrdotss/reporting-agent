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
const GAP_TYPE_COPY_IDS: Readonly<
  Record<string, { readonly labelId: MessageId; readonly noteId: MessageId }>
> = Object.freeze({
  deallocated: {
    labelId: "doc.gap.deallocated",
    noteId: "doc.gap.deallocated",
  },
  metric_not_emitted: {
    labelId: "doc.gap.metric_not_emitted",
    noteId: "doc.gap.metric_not_emitted",
  },
  permission_denied: {
    labelId: "doc.gap.permission_denied",
    noteId: "doc.gap.permission_denied",
  },
  metric_error: {
    labelId: "doc.gap.metric_error",
    noteId: "doc.gap.metric_error",
  },
  power_state_unknown: {
    labelId: "doc.gap.power_state_unknown",
    noteId: "doc.gap.power_state_unknown",
  },
  response_too_large: {
    labelId: "doc.gap.response_too_large",
    noteId: "doc.gap.response_too_large",
  },
  region_unreachable: {
    labelId: "doc.gap.region_unreachable",
    noteId: "doc.gap.region_unreachable",
  },
  metric_not_selected: {
    labelId: "doc.gap.metric_not_selected",
    noteId: "doc.gap.metric_not_selected",
  },
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
  if (entry === undefined) return gapType
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
      href={`/templates/${templateId}/edit`}
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
              <span className="text-muted-foreground/70">
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
                <span className="text-muted-foreground/70">
                  {" "}
                  ×{group.count}
                </span>
              ) : null}
              {group.range !== null ? (
                <span className="text-muted-foreground/70">
                  {" "}
                  ({group.range.from} – {group.range.to})
                </span>
              ) : null}
            </span>
            <span className="text-muted-foreground">
              {group.representative.message}
            </span>
          </li>
        ))}
      </ul>
      {overflow ? (
        <p
          data-slot="gap-overflow"
          className="text-xs text-muted-foreground/70 italic"
        >
          Showing {capped.length} of {innerGroups.length} groups ({shownEntryCount} of {totalCount} entries).
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
