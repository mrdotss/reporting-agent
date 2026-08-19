"use client"

import { Fragment } from "react"

import { Checkbox } from "@/components/ui/checkbox"
import type {
  MetricCatalogEntry,
  MetricCatalogResourceType,
  MetricCatalogSnapshot,
  MetricSelectionItem,
  TemplateDefinition,
} from "@/lib/templates/definition"

/**
 * Step 4 — metric selection, per resource type (Requirements 5.1, 5.6, 5.7, 5.8).
 *
 * ## Every item comes from the catalog
 *
 * Requirement 5.6 requires the selectable items to come "from the Metric_Catalog
 * entry for that resource type rather than from a list held in the Web_App, so
 * that one catalog governs both halves". The `catalog` prop is that catalog —
 * `lib/templates/catalog.ts` imports the agent's own `metrics.v1.json`, so this
 * list and the list the collector validates against are one file. Nothing here
 * hardcodes a metric name.
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
 * ## Which resource types appear
 *
 * The scope's types when it names any; every catalog type when it does not —
 * because an empty scope dimension is unconstrained (Requirement 3.12), so a
 * template with no declared type can collect any of them. Requirement 5.9 then
 * requires a selection for each scoped type, which is why this step shows exactly
 * the types that rule will be checked against.
 */

function itemKey(item: MetricSelectionItem): string {
  return `${item.metric ?? item.derived ?? ""}::${item.statistic}`
}

function entryKey(entry: MetricCatalogEntry, statistic: string): string {
  return `${entry.name}::${statistic}`
}

/** The catalog types this template's scope can contain. */
function visibleTypes(
  definition: TemplateDefinition,
  catalog: MetricCatalogSnapshot
): readonly MetricCatalogResourceType[] {
  const declared = definition.scope.resource_types

  if (declared.length === 0) return catalog

  const folded = new Set(declared.map((name) => name.toLowerCase()))

  return catalog.filter((entry) => folded.has(entry.resourceType.toLowerCase()))
}

export function StepMetrics({
  definition,
  onChange,
  catalog,
}: Readonly<{
  definition: TemplateDefinition
  onChange: (next: TemplateDefinition) => void
  catalog: MetricCatalogSnapshot
}>) {
  const types = visibleTypes(definition, catalog)

  const toggle = (
    resourceType: string,
    entry: MetricCatalogEntry,
    statistic: string,
    checked: boolean
  ) => {
    const current = definition.metrics[resourceType] ?? []
    const key = entryKey(entry, statistic)

    if (!checked) {
      const remaining = current.filter((item) => itemKey(item) !== key)
      const metrics = { ...definition.metrics }

      // An empty entry is dropped rather than kept as `[]`. Requirement 5.1
      // bounds an entry at 1 to 40 items, so an empty array is a validation
      // error — and "no selection for this type" is expressed by the key being
      // absent.
      if (remaining.length === 0) delete metrics[resourceType]
      else metrics[resourceType] = remaining

      onChange({ ...definition, metrics })
      return
    }

    const declared = entry.percentiles[statistic]

    const item: MetricSelectionItem = {
      ...(entry.kind === "metric"
        ? { metric: entry.name }
        : { derived: entry.name }),
      statistic,
      // Requirements 5.7, 5.8 — both fields, from the catalog, for a percentile
      // and for nothing else.
      ...(declared === undefined
        ? {}
        : {
            estimator: declared.estimator,
            fidelity_tier: declared.fidelityTier,
          }),
    }

    onChange({
      ...definition,
      metrics: { ...definition.metrics, [resourceType]: [...current, item] },
    })
  }

  if (types.length === 0) {
    return (
      <p className="max-w-prose text-sm text-muted-foreground">
        The Metric_Catalog declares nothing for the resource types this
        template&rsquo;s scope names. Widen the scope on step 2, or leave its
        resource types empty to see every type the catalog covers.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {types.map((resourceType) => {
        const selected = new Set(
          (definition.metrics[resourceType.resourceType] ?? []).map(itemKey)
        )

        return (
          <section
            key={resourceType.resourceType}
            data-slot="metric-resource-type"
            className="flex flex-col gap-3"
          >
            <h3 className="font-mono text-xs text-muted-foreground">
              {resourceType.resourceType}
            </h3>

            <div className="flex flex-col gap-3">
              {resourceType.entries.map((entry) => (
                <div
                  key={entry.name}
                  className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2"
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm">{entry.name}</span>

                    {entry.label === undefined ? null : (
                      <span className="text-xs text-muted-foreground">
                        {entry.label}
                      </span>
                    )}

                    {entry.fidelityTier === "enhanced" ? (
                      // Offered, marked, and disabled below — not hidden. "Not
                      // offered" and "needs an agent on the customer's VMs" are
                      // answers a consultant acts on very differently.
                      <span className="text-xs text-muted-foreground">
                        · needs Azure Monitor Agent and a Data Collection Rule
                      </span>
                    ) : null}

                    {entry.scale === undefined ? null : (
                      <span className="text-xs text-muted-foreground">
                        · {entry.scale} dp
                      </span>
                    )}
                  </div>

                  {entry.note === undefined ? null : (
                    <p className="max-w-prose text-xs text-muted-foreground">
                      {entry.note}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-3">
                    {entry.statistics.map((statistic) => {
                      const estimated =
                        entry.percentiles[statistic] !== undefined
                      const key = entryKey(entry, statistic)
                      const disabled = entry.fidelityTier === "enhanced"

                      return (
                        <Fragment key={statistic}>
                          <label className="flex items-center gap-1.5 text-xs">
                            <Checkbox
                              checked={selected.has(key)}
                              disabled={disabled}
                              onCheckedChange={(checked) =>
                                toggle(
                                  resourceType.resourceType,
                                  entry,
                                  statistic,
                                  checked === true
                                )
                              }
                            />
                            <span className="font-mono">{statistic}</span>
                            <span className="text-muted-foreground">
                              {estimated ? "estimated" : "exact"}
                            </span>
                          </label>
                        </Fragment>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
