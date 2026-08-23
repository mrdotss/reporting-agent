"use client"

import { Fragment, useMemo } from "react"
import { Warning } from "@phosphor-icons/react"

import { Checkbox } from "@/components/ui/checkbox"
import type {
  MetricCatalogEntry,
  MetricCatalogResourceType,
  MetricCatalogSnapshot,
  MetricSelectionItem,
  TemplateDefinition,
} from "@/lib/templates/definition"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A stored metric selection entry that the current catalog no longer declares
 * for its resource type (Requirement 11.9). Presented as selected and as "no
 * longer declared", retained until the consultant removes it, and blocking
 * step completion.
 */
export type UndeclaredEntry = {
  readonly resourceType: string
  readonly item: MetricSelectionItem
}

// ---------------------------------------------------------------------------
// Helpers — key computation
// ---------------------------------------------------------------------------

function itemKey(item: MetricSelectionItem): string {
  return `${item.metric ?? item.derived ?? ""}::${item.statistic}`
}

function entryKey(entry: MetricCatalogEntry, statistic: string): string {
  return `${entry.name}::${statistic}`
}

// ---------------------------------------------------------------------------
// Partition logic (Requirements 11.5, 11.6)
// ---------------------------------------------------------------------------

/**
 * A partition of resource-type groups. Either the groups for the scope's
 * declared types, or the groups for every other type, or one partition of
 * everything when the scope declares nothing.
 */
type Partition = {
  readonly label: string | null
  readonly groups: readonly MetricCatalogResourceType[]
}

/**
 * Code-point order comparator on resource type name strings.
 * Two renders of one catalog and one definition present one identical order.
 */
function codePointCompare(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Sort entries within a group by option name in ascending code-point order.
 */
function sortedEntries(
  entries: readonly MetricCatalogEntry[]
): readonly MetricCatalogEntry[] {
  return [...entries].sort((a, b) => codePointCompare(a.name, b.name))
}

/**
 * Build partitions per Requirement 11.6.
 *
 * WHERE the scope declares resource types → two partitions:
 *   1. groups for the scope's declared types (code-point order)
 *   2. groups for every other catalog type (code-point order)
 *
 * WHERE the scope declares NO resource type → one partition carrying every group.
 */
function buildPartitions(
  definition: TemplateDefinition,
  catalog: MetricCatalogSnapshot
): readonly Partition[] {
  const scopeTypes = definition.scope.resource_types

  // Sort all catalog groups by resource type name in code-point order
  const sorted = [...catalog].sort((a, b) =>
    codePointCompare(a.resourceType, b.resourceType)
  )

  if (scopeTypes.length === 0) {
    // One partition with every group
    return [{ label: null, groups: sorted }]
  }

  // Case-folded set of the scope's declared resource types
  const scopeFolded = new Set(scopeTypes.map((t) => t.toLowerCase()))

  const inScope: MetricCatalogResourceType[] = []
  const other: MetricCatalogResourceType[] = []

  for (const group of sorted) {
    if (scopeFolded.has(group.resourceType.toLowerCase())) {
      inScope.push(group)
    } else {
      other.push(group)
    }
  }

  return [
    { label: "In scope", groups: inScope },
    { label: "Other resource types", groups: other },
  ]
}

// ---------------------------------------------------------------------------
// Undeclared-entry detection (Requirement 11.9)
// ---------------------------------------------------------------------------

/**
 * Find stored metric selection entries that the current catalog no longer
 * declares for their resource type. These block step completion and are
 * presented with a "no longer declared" badge.
 */
export function findUndeclaredEntries(
  definition: TemplateDefinition,
  catalog: MetricCatalogSnapshot
): readonly UndeclaredEntry[] {
  const undeclared: UndeclaredEntry[] = []

  for (const [resourceType, items] of Object.entries(definition.metrics)) {
    // Find this resource type in the catalog (case-insensitive)
    const folded = resourceType.toLowerCase()
    const catalogType = catalog.find(
      (ct) => ct.resourceType.toLowerCase() === folded
    )

    for (const item of items) {
      if (catalogType === undefined) {
        // The entire resource type is gone from the catalog
        undeclared.push({ resourceType, item })
        continue
      }

      // Find the entry in the catalog
      const entry = catalogType.entries.find((e) =>
        item.metric !== undefined
          ? e.kind === "metric" && e.name === item.metric
          : e.kind === "derived" && e.name === item.derived
      )

      if (entry === undefined) {
        // The metric/derived itself is gone
        undeclared.push({ resourceType, item })
        continue
      }

      // The entry exists but maybe the specific statistic is gone
      if (!entry.statistics.includes(item.statistic)) {
        undeclared.push({ resourceType, item })
      }
    }
  }

  return undeclared
}

/**
 * Whether the metric step can complete (no refusal states active).
 *
 * Returns `true` if the step may advance, `false` if blocked.
 */
export function metricStepCanComplete(
  catalog: MetricCatalogSnapshot | null,
  definition: TemplateDefinition
): boolean {
  // Refusal state 1: catalog unavailable
  if (catalog === null) return false

  // Refusal state 2: undeclared entries exist
  if (findUndeclaredEntries(definition, catalog).length > 0) return false

  return true
}

// ---------------------------------------------------------------------------
// MetricPicker component
// ---------------------------------------------------------------------------

export type MetricPickerProps = {
  readonly definition: TemplateDefinition
  readonly onChange: (next: TemplateDefinition) => void
  /**
   * The catalog fetched from `GET /api/templates/catalog`, or `null` when the
   * catalog could not be retrieved (Requirement 11.8). When `null`, the picker
   * presents a statement, shows no options, retains the stored selection, and
   * refuses step completion.
   */
  readonly catalog: MetricCatalogSnapshot | null
}

/**
 * The Metric_Picker — the selection grid grouped by resource type
 * (Requirements 11.1–11.9).
 *
 * ## Every item comes from the catalog
 *
 * Requirement 11.2: sourced through `GET /api/templates/catalog` and never
 * from a list held in the app.
 *
 * ## Two partitions in a fixed order (Requirement 11.6)
 *
 * First the groups for the scope's declared types, then the groups for every
 * other type the catalog declares — present rather than hidden — because a
 * block `scope_override` may narrow to a type the template default does not
 * name. One partition when the scope declares no resource type.
 *
 * ## Two refusal states (Requirements 11.8, 11.9)
 *
 * Both retain the stored selection and refuse step completion rather than
 * saving something the validator would reject minutes later.
 */
export function MetricPicker({
  definition,
  onChange,
  catalog,
}: MetricPickerProps) {
  // ----- Refusal state 1: catalog unavailable (Requirement 11.8) -----
  if (catalog === null) {
    return (
      <div
        className="flex items-start gap-3 rounded-lg border border-border bg-muted/50 px-4 py-3"
        role="status"
        aria-live="polite"
      >
        <Warning
          size={20}
          weight="regular"
          className="mt-0.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="flex flex-col gap-1">
          <p className="text-sm text-foreground">
            The metric catalog could not be loaded.
          </p>
          <p className="text-xs text-muted-foreground">
            Your stored metric selection is retained. Resolve the catalog
            availability issue to continue editing this step.
          </p>
        </div>
      </div>
    )
  }

  // ----- Detect undeclared entries (Requirement 11.9) -----
  // eslint-disable-next-line react-hooks/rules-of-hooks -- catalog null is an early return
  const undeclaredEntries = useMemo(
    () => findUndeclaredEntries(definition, catalog),
    [definition, catalog]
  )

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const undeclaredKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const entry of undeclaredEntries) {
      keys.add(`${entry.resourceType}::${itemKey(entry.item)}`)
    }
    return keys
  }, [undeclaredEntries])

  // ----- Build partitions (Requirements 11.5, 11.6) -----
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const partitions = useMemo(
    () => buildPartitions(definition, catalog),
    [definition, catalog]
  )

  // ----- Toggle handler -----
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
      // Requirements 5.7, 5.8 — estimator and fidelity tier for percentiles
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

  /** Remove an undeclared entry (Requirement 11.9 — consultant removes it). */
  const removeUndeclared = (resourceType: string, item: MetricSelectionItem) => {
    const current = definition.metrics[resourceType] ?? []
    const key = itemKey(item)
    const remaining = current.filter((i) => itemKey(i) !== key)
    const metrics = { ...definition.metrics }

    if (remaining.length === 0) delete metrics[resourceType]
    else metrics[resourceType] = remaining

    onChange({ ...definition, metrics })
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Refusal state 2: banner for undeclared entries (Requirement 11.9) */}
      {undeclaredEntries.length > 0 && (
        <div
          className="flex items-start gap-3 rounded-lg border border-border bg-muted/50 px-4 py-3"
          role="status"
          aria-live="polite"
        >
          <Warning
            size={20}
            weight="regular"
            className="mt-0.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-1">
            <p className="text-sm text-foreground">
              {undeclaredEntries.length === 1
                ? "1 stored selection is no longer declared by the current catalog."
                : `${undeclaredEntries.length} stored selections are no longer declared by the current catalog.`}
            </p>
            <p className="text-xs text-muted-foreground">
              Remove the undeclared entries below to continue. A catalog version
              change can produce this without any edit.
            </p>
          </div>
        </div>
      )}

      {/* Partitions of resource-type groups */}
      {partitions.map((partition, partIdx) => (
        <div key={partIdx} className="flex flex-col gap-5">
          {partition.label !== null && (
            <h2 className="font-sans text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {partition.label}
            </h2>
          )}

          {partition.groups.map((resourceType) => {
            const selected = new Set(
              (definition.metrics[resourceType.resourceType] ?? []).map(itemKey)
            )

            // Entries sorted by name in code-point order (Requirement 11.5)
            const entries = sortedEntries(resourceType.entries)

            return (
              <section
                key={resourceType.resourceType}
                data-slot="metric-resource-type"
                className="flex flex-col gap-3"
                aria-label={`Metrics for ${resourceType.resourceType}`}
              >
                <h3 className="font-mono text-xs text-muted-foreground">
                  {resourceType.resourceType}
                </h3>

                <div className="flex flex-col gap-3">
                  {entries.map((entry) => (
                    <MetricEntryCard
                      key={entry.name}
                      entry={entry}
                      resourceType={resourceType.resourceType}
                      selected={selected}
                      undeclaredKeys={undeclaredKeys}
                      onToggle={toggle}
                      onRemoveUndeclared={removeUndeclared}
                      definition={definition}
                    />
                  ))}
                </div>

                {/* Undeclared entries for this resource type not in any current entry */}
                <UndeclaredEntriesForType
                  resourceType={resourceType.resourceType}
                  entries={entries}
                  undeclaredEntries={undeclaredEntries}
                  onRemove={removeUndeclared}
                />
              </section>
            )
          })}

          {/* Resource types entirely gone from catalog (all their entries undeclared) */}
          <UndeclaredResourceTypes
            catalog={catalog}
            undeclaredEntries={undeclaredEntries}
            onRemove={removeUndeclared}
          />
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MetricEntryCard({
  entry,
  resourceType,
  selected,
  undeclaredKeys,
  onToggle,
  onRemoveUndeclared,
  definition,
}: Readonly<{
  entry: MetricCatalogEntry
  resourceType: string
  selected: Set<string>
  undeclaredKeys: Set<string>
  onToggle: (
    resourceType: string,
    entry: MetricCatalogEntry,
    statistic: string,
    checked: boolean
  ) => void
  onRemoveUndeclared: (resourceType: string, item: MetricSelectionItem) => void
  definition: TemplateDefinition
}>) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm">{entry.name}</span>

        {entry.label !== undefined && (
          <span className="text-xs text-muted-foreground">{entry.label}</span>
        )}

        {entry.fidelityTier === "enhanced" && (
          <span className="text-xs text-muted-foreground">
            · needs Azure Monitor Agent and a Data Collection Rule
          </span>
        )}

        {entry.scale !== undefined && (
          <span className="text-xs text-muted-foreground">
            · {entry.scale} dp
          </span>
        )}
      </div>

      {entry.note !== undefined && (
        <p className="max-w-prose text-xs text-muted-foreground">{entry.note}</p>
      )}

      <div className="flex flex-wrap gap-3">
        {entry.statistics.map((statistic) => {
          const percentileInfo = entry.percentiles[statistic]
          const estimated = percentileInfo !== undefined
          const key = entryKey(entry, statistic)
          const fullKey = `${resourceType}::${key}`
          const isUndeclared = undeclaredKeys.has(fullKey)
          const disabled = entry.fidelityTier === "enhanced"

          // Find stored item for undeclared removal
          const storedItem =
            isUndeclared
              ? (definition.metrics[resourceType] ?? []).find(
                  (i) => itemKey(i) === key
                )
              : undefined

          return (
            <Fragment key={statistic}>
              <label
                className={`flex items-center gap-1.5 text-xs ${
                  isUndeclared
                    ? "rounded-md border border-border bg-muted/50 px-2 py-1"
                    : ""
                }`}
              >
                <Checkbox
                  checked={selected.has(key)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    onToggle(resourceType, entry, statistic, checked === true)
                  }
                />
                <span className="font-mono">{statistic}</span>
                <span className="text-muted-foreground">
                  {estimated ? "estimated" : "exact"}
                </span>
                {/* Estimator label for percentiles (Requirement 11.3) */}
                {percentileInfo !== undefined && (
                  <span className="text-muted-foreground">
                    · {percentileInfo.estimator}
                  </span>
                )}
                {isUndeclared && storedItem !== undefined && (
                  <>
                    <span className="text-muted-foreground italic">
                      · no longer declared
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault()
                        onRemoveUndeclared(resourceType, storedItem)
                      }}
                      className="ml-1 rounded-4xl border border-border px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Remove undeclared ${statistic} for ${entry.name}`}
                    >
                      Remove
                    </button>
                  </>
                )}
              </label>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Render undeclared entries for a resource type whose metric/derived is no
 * longer in the catalog at all (not matched by any current entry card).
 */
function UndeclaredEntriesForType({
  resourceType,
  entries,
  undeclaredEntries,
  onRemove,
}: Readonly<{
  resourceType: string
  entries: readonly MetricCatalogEntry[]
  undeclaredEntries: readonly UndeclaredEntry[]
  onRemove: (resourceType: string, item: MetricSelectionItem) => void
}>) {
  // Find undeclared entries for this resource type that don't match any current catalog entry
  const orphaned = undeclaredEntries.filter((ue) => {
    if (ue.resourceType !== resourceType) return false
    // Check if the metric/derived is in the current entries
    return !entries.some((e) =>
      ue.item.metric !== undefined
        ? e.kind === "metric" && e.name === ue.item.metric
        : e.kind === "derived" && e.name === ue.item.derived
    )
  })

  if (orphaned.length === 0) return null

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
      {orphaned.map((ue) => {
        const name = ue.item.metric ?? ue.item.derived ?? ""
        const key = `${name}::${ue.item.statistic}`
        return (
          <div
            key={key}
            className="flex items-center gap-2 text-xs"
          >
            <Checkbox checked={true} disabled={true} />
            <span className="font-mono">{name}</span>
            <span className="text-muted-foreground">· {ue.item.statistic}</span>
            <span className="text-muted-foreground italic">
              · no longer declared
            </span>
            <button
              type="button"
              onClick={() => onRemove(ue.resourceType, ue.item)}
              className="ml-1 rounded-4xl border border-border px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Remove undeclared ${ue.item.statistic} for ${name}`}
            >
              Remove
            </button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Resource types that are entirely gone from the catalog but have stored
 * selections. These appear only when a catalog version removes a whole type.
 */
function UndeclaredResourceTypes({
  catalog,
  undeclaredEntries,
  onRemove,
}: Readonly<{
  catalog: MetricCatalogSnapshot
  undeclaredEntries: readonly UndeclaredEntry[]
  onRemove: (resourceType: string, item: MetricSelectionItem) => void
}>) {
  // Resource types in undeclared entries that are not in the catalog at all
  const catalogTypes = new Set(
    catalog.map((ct) => ct.resourceType.toLowerCase())
  )

  const goneTypes = new Map<string, UndeclaredEntry[]>()
  for (const ue of undeclaredEntries) {
    if (!catalogTypes.has(ue.resourceType.toLowerCase())) {
      const list = goneTypes.get(ue.resourceType) ?? []
      list.push(ue)
      goneTypes.set(ue.resourceType, list)
    }
  }

  if (goneTypes.size === 0) return null

  // Sort by resource type name in code-point order
  const sortedTypes = [...goneTypes.entries()].sort(([a], [b]) =>
    codePointCompare(a, b)
  )

  return (
    <>
      {sortedTypes.map(([resourceType, entries]) => (
        <section
          key={resourceType}
          data-slot="metric-resource-type"
          className="flex flex-col gap-3"
          aria-label={`Undeclared metrics for ${resourceType}`}
        >
          <h3 className="font-mono text-xs text-muted-foreground">
            {resourceType}
            <span className="ml-2 italic">(no longer in catalog)</span>
          </h3>

          <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
            {entries.map((ue) => {
              const name = ue.item.metric ?? ue.item.derived ?? ""
              const key = `${name}::${ue.item.statistic}`
              return (
                <div
                  key={key}
                  className="flex items-center gap-2 text-xs"
                >
                  <Checkbox checked={true} disabled={true} />
                  <span className="font-mono">{name}</span>
                  <span className="text-muted-foreground">
                    · {ue.item.statistic}
                  </span>
                  <span className="text-muted-foreground italic">
                    · no longer declared
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemove(ue.resourceType, ue.item)}
                    className="ml-1 rounded-4xl border border-border px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Remove undeclared ${ue.item.statistic} for ${name}`}
                  >
                    Remove
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </>
  )
}
