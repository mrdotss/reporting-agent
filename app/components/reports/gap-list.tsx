import { InfoIcon } from "@phosphor-icons/react/ssr"

import type { RunGap } from "@/lib/runs/gaps"

/**
 * The `collection_log`, grouped by `gap_type` (Requirement 36.7).
 *
 * ## A gap is neutral information, not an error state
 *
 * Every token here is a **mist neutral**, and that is a requirement rather than taste.
 * `--destructive` in this product means *this document could not be proven*; a gap means
 * *this is what we could not read, recorded rather than silently zero-filled*, which is
 * the honest half of a report that completed. A report with recorded, visible gaps is
 * useful; a report with hidden gaps is the thing the whole design exists to prevent — so
 * styling them as failures would push a consultant to treat the useful case as the
 * broken one.
 *
 * The grouping is by `gap_type` because the types are not interchangeable. A deallocated
 * VM emitting nothing is *expected*; a metric a SKU does not emit is a genuine gap; a 403
 * on a resource is a permission failure. Collapsing them into one list of two hundred
 * rows would put the one that needs action next to the one that does not.
 *
 * Presentational and free of parsing: the gap list arrives as props, from the row's
 * snapshot through `lib/runs/gaps.ts`. A resource id is rendered in mono because it is a
 * figure-like value a reader copies.
 */

/** The `gap_type` values worth a sentence, in the order they matter. */
const GAP_TYPE_COPY: Readonly<
  Record<string, { readonly label: string; readonly note: string }>
> = Object.freeze({
  deallocated: {
    label: "Deallocated",
    note:
      "Stopped for part or all of the period. A stopped machine emits no " +
      "metrics, so these are excluded from averages rather than counted as " +
      "idle — reporting 0% CPU for a deallocated VM would be a factual error " +
      "in a document somebody may resize infrastructure from.",
  },
  metric_not_emitted: {
    label: "Metric not emitted",
    note:
      "The resource's SKU does not publish this metric, so there is nothing " +
      "to collect rather than a value of zero.",
  },
  permission_denied: {
    label: "Permission denied",
    note:
      "The service principal could not read this resource. Its figures are " +
      "absent from the report rather than defaulted.",
  },
  metric_error: {
    label: "Metric error",
    note: "Azure returned an error for this metric, recorded as read.",
  },
  power_state_unknown: {
    label: "Power state unknown",
    note:
      "The inventory query did not return a power state, so whether this " +
      "resource was running cannot be established.",
  },
  response_too_large: {
    label: "Response too large",
    note:
      "A metrics response exceeded what one request may carry, and the " +
      "adaptive retry did not recover it.",
  },
  region_unreachable: {
    label: "Region unreachable",
    note:
      "No metrics endpoint answered for this region and the per-resource " +
      "fallback did not succeed either.",
  },
})

/** Group gaps by type, preserving the snapshot's order within each group. */
function groupByType(
  gaps: readonly RunGap[]
): readonly { readonly gapType: string; readonly gaps: readonly RunGap[] }[] {
  const grouped = new Map<string, RunGap[]>()

  for (const gap of gaps) {
    const existing = grouped.get(gap.gapType)
    if (existing === undefined) grouped.set(gap.gapType, [gap])
    else existing.push(gap)
  }

  // Insertion order, which is the snapshot's order — the agent already sorted by
  // `gap_type` then `resource_id` then `metric`. Re-sorting here would be a second
  // opinion about an ordering the immutable document fixed.
  return [...grouped.entries()].map(([gapType, groupGaps]) => ({
    gapType,
    gaps: groupGaps,
  }))
}

export function GapList({ gaps }: Readonly<{ gaps: readonly RunGap[] }>) {
  if (gaps.length === 0) {
    return (
      <p data-slot="gap-list-empty" className="text-sm text-muted-foreground">
        No gaps were recorded. Every resource in scope was readable and every
        requested metric was available.
      </p>
    )
  }

  const groups = groupByType(gaps)

  return (
    <div data-slot="gap-list" className="flex flex-col gap-4">
      {groups.map(({ gapType, gaps: groupGaps }) => {
        const copy = GAP_TYPE_COPY[gapType]

        return (
          <section
            key={gapType}
            data-slot="gap-group"
            data-gap-type={gapType}
            // Mist neutrals throughout — `--border`, `--muted`,
            // `--muted-foreground`. No `--destructive` anywhere in this component.
            className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <InfoIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />

              <h3 className="font-heading text-sm font-medium tracking-tight">
                {copy?.label ?? gapType}
              </h3>

              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {groupGaps.length}
              </span>
            </div>

            {copy === undefined ? null : (
              <p className="max-w-prose text-sm text-muted-foreground">
                {copy.note}
              </p>
            )}

            <ul className="flex flex-col gap-1">
              {groupGaps.map((gap, index) => (
                <li
                  // The snapshot can legitimately carry two gaps for one resource —
                  // one per metric — so the index participates in the key. Gaps are
                  // never reordered or removed on the client, so an index key is
                  // stable here in a way it would not be in an editable list.
                  key={`${gap.resourceId}|${gap.metric ?? ""}|${index}`}
                  className="flex flex-col gap-0.5 text-sm"
                >
                  <span className="font-mono text-xs break-all text-muted-foreground tabular-nums">
                    {gap.resourceId}
                    {gap.metric === null ? null : (
                      <>
                        {" · "}
                        {gap.metric}
                      </>
                    )}
                  </span>

                  <span className="text-muted-foreground">{gap.message}</span>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
