"use client"

import type {
  MetricCatalogSnapshot,
  TemplateDefinition,
} from "@/lib/templates/definition"
import { MetricPicker } from "@/components/templates/metric-picker"

/**
 * Step 4 — metric selection, per resource type (Requirements 5.1, 5.6, 5.7, 5.8,
 * 11.1–11.9).
 *
 * ## Every item comes from the catalog
 *
 * Requirement 5.6 / 11.2 requires the selectable items to come "from the
 * Metric_Catalog entry for that resource type rather than from a list held in the
 * Web_App, so that one catalog governs both halves". The `catalog` prop is that
 * catalog — `lib/templates/catalog.ts` imports the agent's own `metrics.v1.json`,
 * so this list and the list the collector validates against are one file. Nothing
 * here hardcodes a metric name.
 *
 * ## Exact or estimated, shown per statistic
 *
 * A statistic keyed in the entry's `percentiles` came from a bounded sketch and
 * is an **estimate**; every other statistic rolls up exactly. That is the fact
 * Requirement 5.6 asks to be shown, and it is not cosmetic: a p95 computed from
 * hourly buckets runs 20 to 40 points below the true p95 of the minute samples,
 * which is precisely the error that makes an over-provisioned VM look
 * right-sized. So a percentile is labelled as an estimate at the point of
 * selection, not only in the finished document.
 *
 * ## Selecting a percentile writes two fields the consultant never sees
 *
 * Requirements 5.7 and 5.8 make a percentile entry unstorable without the
 * catalog's estimator label and its fidelity tier. Both are copied from the
 * catalog entry at selection time. Asking a consultant to type
 * `histogram_sketch_pt1h_interval_average` would be asking them to restate a fact
 * the catalog already declares, and getting it wrong is a rejected save.
 *
 * ## Two partitions (Requirement 11.6)
 *
 * WHERE the scope declares resource types → first the groups for the scope's
 * types, then groups for every other catalog type (present, not hidden). WHERE
 * the scope declares no resource type → one partition with every group.
 *
 * ## Two refusal states (Requirements 11.8, 11.9)
 *
 * An unavailable catalog shows a statement and no options, retaining the stored
 * selection and refusing step completion. A stored entry the current catalog no
 * longer declares shows as selected and "no longer declared", retained until the
 * consultant removes it, refusing step completion until removed.
 */
export function StepMetrics({
  definition,
  onChange,
  catalog,
}: Readonly<{
  definition: TemplateDefinition
  onChange: (next: TemplateDefinition) => void
  catalog: MetricCatalogSnapshot | null
}>) {
  return (
    <MetricPicker
      definition={definition}
      onChange={onChange}
      catalog={catalog}
    />
  )
}
