import type {
  MetricCatalogEntry,
  MetricCatalogSnapshot,
  MetricSelectionItem,
} from "@/lib/templates/definition"

/**
 * The choices a section's Custom metric selection is made from, and the rules for
 * toggling one — pure, so the grid that renders them can be tested without a DOM.
 *
 * ## Why this exists beside `metric-picker.tsx`
 *
 * That picker predates `sections` and reads `definition.metrics[resourceType]` — the
 * **v2** top-level selection, which a v3 profile does not have. Its presentation is
 * right and its rules are right; where it writes is not. Rather than teach one component
 * two definition shapes, the selection logic moved here and the v3 surface renders it
 * against a section. `step-metrics.tsx` is what the wizard used to render for v2 and
 * renders for nothing now.
 *
 * ## Percentiles carry the catalogue's own metadata
 *
 * Requirements 5.7, 5.8 and 10.7 — a percentile item is unstorable without an estimator
 * label and a fidelity tier, and both are **copied from the catalogue**, never composed
 * here. That is why {@link toggleMetric} takes the catalogue entry rather than a name: a
 * bare `p95` is a rejected save, and the only way to be sure no surface can produce one
 * is to make the surface unable to name a statistic without its entry.
 */

/** Identity of a selection item, for comparing a stored list against the catalogue. */
export function itemKey(item: MetricSelectionItem): string {
  return `${item.metric ?? item.derived ?? ""}::${item.statistic}`
}

/** Identity of one catalogue entry at one statistic — the same key, from the other side. */
export function entryKey(entry: MetricCatalogEntry, statistic: string): string {
  return `${entry.name}::${statistic}`
}

export type MetricChoice = {
  readonly resourceType: string
  readonly entry: MetricCatalogEntry
  readonly statistic: string
  /** Selected in the section's current metric list. */
  readonly selected: boolean
  /**
   * Rolled up from a bounded sketch rather than computed exactly (Requirement 5.6).
   *
   * Shown at the point of selection, not only in the finished document: a p95 estimated
   * from hourly buckets runs well below the true p95 of the minute samples, which is the
   * error that makes an over-provisioned machine look right-sized.
   */
  readonly estimated: boolean
}

export type MetricChoiceGroup = {
  readonly resourceType: string
  readonly choices: readonly MetricChoice[]
}

/**
 * Every metric and statistic this section could select, grouped by resource type.
 *
 * Narrowed to the section's **own** resource types. The v2 picker offered every type the
 * catalogue declares and partitioned them; a section already declares what it is about,
 * so offering the rest would be offering metrics the collector will never request for it.
 *
 * Catalogue order throughout — the stored definition is hashed for the unchanged-digest
 * comparison, so a set-order-dependent list would make two identical choices produce two
 * versions.
 */
export function metricChoicesFor(
  resourceTypes: readonly string[],
  catalog: MetricCatalogSnapshot,
  selection: readonly MetricSelectionItem[]
): readonly MetricChoiceGroup[] {
  const wanted = new Set(resourceTypes.map((type) => type.toLowerCase()))
  const selected = new Set(selection.map(itemKey))
  const groups: MetricChoiceGroup[] = []

  for (const type of catalog) {
    if (!wanted.has(type.resourceType.toLowerCase())) continue

    const choices: MetricChoice[] = []
    for (const entry of type.entries) {
      for (const statistic of entry.statistics) {
        choices.push({
          resourceType: type.resourceType,
          entry,
          statistic,
          selected: selected.has(entryKey(entry, statistic)),
          estimated: entry.percentiles[statistic] !== undefined,
        })
      }
    }
    if (choices.length > 0) {
      groups.push({ resourceType: type.resourceType, choices })
    }
  }

  return groups
}

/**
 * `selection` with one metric+statistic added or removed.
 *
 * Appended rather than inserted in catalogue order, and that is deliberate: a consultant
 * who ticks three boxes and unticks one should not watch the list reorder itself. The
 * expansion a preset produces is catalogue-ordered because nobody chose its order; this
 * one is chosen.
 */
export function toggleMetric(
  selection: readonly MetricSelectionItem[],
  entry: MetricCatalogEntry,
  statistic: string,
  checked: boolean
): readonly MetricSelectionItem[] {
  const key = entryKey(entry, statistic)
  if (!checked) {
    return selection.filter((item) => itemKey(item) !== key)
  }
  if (selection.some((item) => itemKey(item) === key)) return selection

  const percentile = entry.percentiles[statistic]
  const item: MetricSelectionItem = {
    ...(entry.kind === "derived" ? { derived: entry.name } : { metric: entry.name }),
    statistic,
    // Copied, never composed — see the module note.
    ...(percentile === undefined
      ? {}
      : { estimator: percentile.estimator, fidelity_tier: percentile.fidelityTier }),
  }
  return [...selection, item]
}

/**
 * Items in `selection` the current catalogue no longer declares (Requirement 11.9).
 *
 * Retained rather than dropped: a stored selection is the author's, and silently removing
 * one would change what a saved profile collects without anyone deciding to. They are
 * surfaced so a consultant can remove them.
 */
export function undeclaredItems(
  resourceTypes: readonly string[],
  catalog: MetricCatalogSnapshot,
  selection: readonly MetricSelectionItem[]
): readonly MetricSelectionItem[] {
  const declared = new Set<string>()
  const wanted = new Set(resourceTypes.map((type) => type.toLowerCase()))
  for (const type of catalog) {
    if (!wanted.has(type.resourceType.toLowerCase())) continue
    for (const entry of type.entries) {
      for (const statistic of entry.statistics) {
        declared.add(entryKey(entry, statistic))
      }
    }
  }
  return selection.filter((item) => !declared.has(itemKey(item)))
}
