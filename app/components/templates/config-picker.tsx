"use client"

import { useMemo, useRef } from "react"
import { Check, Warning, X } from "@phosphor-icons/react"

import type { ColumnKind } from "@/lib/templates/blocks"
import type {
  ConfigOption,
  MetricOption,
  OptionGroups,
} from "@/lib/templates/options"
import { fieldKind, optionsFor, type OptionsInput } from "@/lib/templates/options"
import type { ConfigReferenceIssue } from "@/lib/templates/options"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A typed column entry as stored in a v2 definition's `columns` config field.
 *
 * A v1 definition's bare metric-ref objects (no `kind` field) parse as
 * `kind: "metric"` — see {@link parseColumnEntry}. That backward compatibility
 * is what lets stored rows keep their meaning.
 */
export type ColumnEntryValue = {
  readonly kind: ColumnKind
  // metric:
  readonly metric?: string
  readonly derived?: string
  readonly statistic?: string
  // attribute:
  readonly attribute?: string
  // fact:
  readonly fact_key?: string
}

// ---------------------------------------------------------------------------
// Parsing — v1 bare-string columns → v2 typed objects
// ---------------------------------------------------------------------------

/**
 * Parse one stored column entry into its typed form.
 *
 * - An object with `kind` → pass through.
 * - An object with `metric`/`derived` + `statistic` but no `kind` → v1 metric ref.
 * - A bare string (v1 attribute/fact that the validator now rejects on save) → omit.
 */
export function parseColumnEntry(raw: unknown): ColumnEntryValue | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === "string") {
    // v1 bare string — the validator rejects these on save, but they may exist
    // in stored definitions opened for editing. Treat as metric key for display.
    return null
  }
  if (typeof raw !== "object") return null

  const record = raw as Record<string, unknown>
  const kind = record.kind

  if (kind === "attribute" && typeof record.attribute === "string") {
    return { kind: "attribute", attribute: record.attribute }
  }
  if (kind === "fact" && typeof record.fact_key === "string") {
    return { kind: "fact", fact_key: record.fact_key }
  }

  // kind === "metric" explicitly, or absent (v1 compat)
  const metric = record.metric
  const derived = record.derived
  const statistic = record.statistic

  if (typeof statistic === "string" && statistic) {
    if (typeof metric === "string" && metric) {
      return { kind: "metric", metric, statistic }
    }
    if (typeof derived === "string" && derived) {
      return { kind: "metric", derived, statistic }
    }
  }

  return null
}

/**
 * Build the stored value for a column entry from a config option selection.
 */
function columnEntryFromOption(option: ConfigOption): ColumnEntryValue {
  switch (option.kind) {
    case "metric":
      return {
        kind: "metric",
        ...(option.metric !== undefined ? { metric: option.metric } : {}),
        ...(option.derived !== undefined ? { derived: option.derived } : {}),
        statistic: option.statistic,
      }
    case "attribute":
      return { kind: "attribute", attribute: option.attribute }
    case "fact":
      return { kind: "fact", fact_key: option.factKey }
  }
}

/**
 * The key that identifies one column entry for deduplication.
 */
function columnEntryKey(entry: ColumnEntryValue): string {
  if (entry.kind === "metric") {
    return `metric:${entry.metric ?? entry.derived ?? ""}:${entry.statistic ?? ""}`
  }
  if (entry.kind === "attribute") {
    return `attribute:${entry.attribute ?? ""}`
  }
  return `fact:${entry.fact_key ?? ""}`
}

/**
 * How many actual table columns one column entry produces at compile time.
 *
 * **One, for every kind.** A fact entry used to emit two — `<key>` and
 * `<key>.observed_at` — but the compiler now emits the instant column only when the
 * table's facts disagree about when they were collected, and states one agreed instant
 * under the table instead.
 *
 * That condition depends on the run's data, which this wizard does not have: an author
 * choosing columns has no snapshot to consult. So the count is the ordinary shape, and
 * the copy below says a fact may gain a second column rather than promising it will.
 * Over-counting here would tell an author their table is too wide when it is not.
 */
export function compiledColumnCount(_entry: ColumnEntryValue): number {
  return 1
}

/**
 * Total compiled column count for a list of entries.
 */
export function totalCompiledColumns(entries: readonly ColumnEntryValue[]): number {
  return entries.reduce((sum, e) => sum + compiledColumnCount(e), 0)
}

// ---------------------------------------------------------------------------
// ConfigPicker — the metric-valued field picker
// ---------------------------------------------------------------------------

export type ConfigPickerProps = {
  readonly blockId: string
  readonly blockType: string
  readonly field: string
  readonly value: unknown
  readonly input: OptionsInput
  readonly issues: readonly ConfigReferenceIssue[]
  readonly onChange: (field: string, value: unknown) => void
}

/**
 * The Block_Config_Picker — replaces the raw JSON text control for every
 * metric-valued config field (Requirements 12.1–12.10).
 *
 * For `metrics`, `capacity_metric`, `usage_metric` and `order_by` fields the
 * picker shows only metric options. For `columns` fields it shows three
 * distinctly presented groups: metrics, attributes, and fact keys.
 *
 * There is **no free-text control at all** for these fields — a mistyped
 * metric is not something the interface can express.
 */
export function ConfigPicker({
  blockId,
  blockType,
  field,
  value,
  input,
  issues,
  onChange,
}: ConfigPickerProps) {
  const kind = fieldKind(blockType as never, field)
  const groups = useMemo(
    () => optionsFor(field, input),
    [field, input]
  )

  const fieldIssues = useMemo(
    () => issues.filter((issue) => issue.field === field && issue.blockId === blockId),
    [issues, field, blockId]
  )

  // Determine if this is a single-value or multi-value field

  if (kind === "column_list") {
    return (
      <ColumnListPicker
        blockId={blockId}
        field={field}
        value={value}
        groups={groups}
        issues={fieldIssues}
        onChange={onChange}
      />
    )
  }

  if (kind === "metric_ref_list") {
    return (
      <MetricListPicker
        blockId={blockId}
        field={field}
        value={value}
        groups={groups}
        issues={fieldIssues}
        onChange={onChange}
      />
    )
  }

  // metric_ref — single value
  return (
    <SingleMetricPicker
      blockId={blockId}
      field={field}
      value={value}
      groups={groups}
      issues={fieldIssues}
      onChange={onChange}
    />
  )
}

// ---------------------------------------------------------------------------
// SingleMetricPicker — for `capacity_metric`, `usage_metric`, `order_by`
// ---------------------------------------------------------------------------

function SingleMetricPicker({
  field,
  value,
  groups,
  issues,
  onChange,
}: Readonly<{
  blockId: string
  field: string
  value: unknown
  groups: OptionGroups
  issues: readonly ConfigReferenceIssue[]
  onChange: (field: string, value: unknown) => void
}>) {
  const selectedKey = useMemo(() => {
    if (value === null || value === undefined) return ""
    if (typeof value === "object") {
      const record = value as Record<string, unknown>
      const name = record.metric ?? record.derived
      if (typeof name === "string" && typeof record.statistic === "string") {
        return `${name}:${record.statistic}`
      }
    }
    return ""
  }, [value])

  const handleSelect = (option: MetricOption) => {
    const stored = {
      ...(option.metric !== undefined ? { metric: option.metric } : {}),
      ...(option.derived !== undefined ? { derived: option.derived } : {}),
      statistic: option.statistic,
    }
    onChange(field, stored)
  }

  return (
    <div className="flex flex-col gap-2">
      {issues.length > 0 && (
        <InvalidBanner issues={issues} />
      )}
      <div
        className="flex flex-col gap-1"
        role="listbox"
        aria-label={`${field} options`}
      >
        {groups.metrics.map((option) => (
          <OptionButton
            key={option.key}
            selected={selectedKey === option.key}
            label={option.label}
            estimated={option.estimated}
            unit={option.unit}
            onClick={() => handleSelect(option)}
          />
        ))}
        {groups.metrics.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No metrics selected for this block&apos;s scope. Add metrics on
            step 4.
          </p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MetricListPicker — for `metrics` (charts, kpi_row)
// ---------------------------------------------------------------------------

function MetricListPicker({
  field,
  value,
  groups,
  issues,
  onChange,
}: Readonly<{
  blockId: string
  field: string
  value: unknown
  groups: OptionGroups
  issues: readonly ConfigReferenceIssue[]
  onChange: (field: string, value: unknown) => void
}>) {
  const selectedKeys = useMemo(() => {
    if (!Array.isArray(value)) return new Set<string>()
    return new Set(
      value
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map((item) => {
          const name = item.metric ?? item.derived
          if (typeof name === "string" && typeof item.statistic === "string") {
            return `${name}:${item.statistic}`
          }
          return ""
        })
        .filter(Boolean)
    )
  }, [value])

  const toggle = (option: MetricOption, checked: boolean) => {
    const current = Array.isArray(value) ? (value as unknown[]) : []
    if (!checked) {
      const remaining = current.filter((item) => {
        if (typeof item !== "object" || item === null) return true
        const record = item as Record<string, unknown>
        const name = record.metric ?? record.derived
        if (typeof name === "string" && typeof record.statistic === "string") {
          return `${name}:${record.statistic}` !== option.key
        }
        return true
      })
      onChange(field, remaining)
    } else {
      const stored = {
        ...(option.metric !== undefined ? { metric: option.metric } : {}),
        ...(option.derived !== undefined ? { derived: option.derived } : {}),
        statistic: option.statistic,
      }
      onChange(field, [...current, stored])
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {issues.length > 0 && <InvalidBanner issues={issues} />}
      <div
        className="flex flex-col gap-1"
        role="listbox"
        aria-multiselectable="true"
        aria-label={`${field} options`}
      >
        {groups.metrics.map((option) => (
          <OptionButton
            key={option.key}
            selected={selectedKeys.has(option.key)}
            label={option.label}
            estimated={option.estimated}
            unit={option.unit}
            onClick={() => toggle(option, !selectedKeys.has(option.key))}
          />
        ))}
        {groups.metrics.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No metrics selected for this block&apos;s scope. Add metrics on step 4.
          </p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ColumnListPicker — for `columns` (resource_table, top_n_table)
// ---------------------------------------------------------------------------

function ColumnListPicker({
  field,
  value,
  groups,
  issues,
  onChange,
}: Readonly<{
  blockId: string
  field: string
  value: unknown
  groups: OptionGroups
  issues: readonly ConfigReferenceIssue[]
  onChange: (field: string, value: unknown) => void
}>) {
  const liveRef = useRef<HTMLDivElement>(null)
  const announce = (msg: string) => {
    if (liveRef.current) liveRef.current.textContent = msg
  }

  // Parse current selections
  const selections: ColumnEntryValue[] = useMemo(() => {
    if (!Array.isArray(value)) return []
    return value
      .map((item) => parseColumnEntry(item))
      .filter((entry): entry is ColumnEntryValue => entry !== null)
  }, [value])

  const selectedKeys = useMemo(
    () => new Set(selections.map(columnEntryKey)),
    [selections]
  )

  const totalColumns = useMemo(() => totalCompiledColumns(selections), [selections])
  const factCount = useMemo(
    () => selections.filter((e) => e.kind === "fact").length,
    [selections]
  )

  const addColumn = (option: ConfigOption) => {
    const entry = columnEntryFromOption(option)
    const key = columnEntryKey(entry)
    if (selectedKeys.has(key)) return

    const newSelections = [...selections, entry]
    onChange(field, newSelections)
    announce(`Added ${option.label ?? option.key}`)
  }

  const removeColumn = (entry: ColumnEntryValue) => {
    const key = columnEntryKey(entry)
    const remaining = selections.filter((e) => columnEntryKey(e) !== key)
    onChange(field, remaining)
    announce(`Removed ${entryLabel(entry)}`)
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={liveRef}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />

      {issues.length > 0 && <InvalidBanner issues={issues} />}

      {/* Column count statement */}
      <p className="text-xs text-muted-foreground">
        {totalColumns === 0
          ? "No columns selected."
          : `${selections.length} ${selections.length === 1 ? "entry" : "entries"} → ${totalColumns} table ${totalColumns === 1 ? "column" : "columns"}`}
        {factCount > 0 && (
          <span>
            {" "}
            (a fact gains a second column only in a run where its instants differ)
          </span>
        )}
      </p>

      {/* Selected entries */}
      {selections.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selections.map((entry) => {
            const key = columnEntryKey(entry)
            return (
              <span
                key={key}
                className="inline-flex items-center gap-1 rounded-4xl border border-border bg-muted/50 px-2 py-0.5 text-xs"
              >
                <KindBadge kind={entry.kind} />
                <span className="font-mono">{entryLabel(entry)}</span>
                {entry.kind === "fact" && (
                  <span className="text-muted-foreground">·2 cols</span>
                )}
                <button
                  type="button"
                  onClick={() => removeColumn(entry)}
                  className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Remove ${entryLabel(entry)}`}
                >
                  <X size={12} weight="bold" />
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* Option groups */}
      <div className="flex flex-col gap-3">
        {/* Metrics group */}
        {groups.metrics.length > 0 && (
          <OptionGroup label="Metrics">
            {groups.metrics.map((option) => (
              <OptionButton
                key={option.key}
                selected={selectedKeys.has(`metric:${option.metric ?? option.derived ?? ""}:${option.statistic}`)}
                label={option.label}
                estimated={option.estimated}
                unit={option.unit}
                onClick={() => addColumn(option)}
              />
            ))}
          </OptionGroup>
        )}

        {/* Attributes group */}
        {groups.attributes.length > 0 && (
          <OptionGroup label="Attributes">
            {groups.attributes.map((option) => (
              <OptionButton
                key={option.key}
                selected={selectedKeys.has(`attribute:${option.attribute}`)}
                label={option.label}
                disabled={option.implicit}
                disabledReason={
                  option.implicit
                    ? "Already implicit — shown without being selected"
                    : undefined
                }
                onClick={() => addColumn(option)}
              />
            ))}
          </OptionGroup>
        )}

        {/* Facts group */}
        {groups.facts.length > 0 && (
          <OptionGroup label="Facts">
            {groups.facts.map((option) => (
              <OptionButton
                key={option.key}
                selected={selectedKeys.has(`fact:${option.factKey}`)}
                label={`${option.factKey} (${option.valueKind})`}
                onClick={() => addColumn(option)}
              />
            ))}
          </OptionGroup>
        )}

        {groups.metrics.length === 0 &&
          groups.attributes.length === 0 &&
          groups.facts.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No column options available for this block&apos;s scope. Add metrics on
              step 4 or connect a resource type that declares facts.
            </p>
          )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function OptionGroup({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-col gap-0.5" role="group" aria-label={label}>
        {children}
      </div>
    </div>
  )
}

function OptionButton({
  selected,
  label,
  estimated,
  unit,
  disabled,
  disabledReason,
  onClick,
}: Readonly<{
  selected: boolean
  label: string
  estimated?: boolean
  unit?: string
  disabled?: boolean
  disabledReason?: string
  onClick: () => void
}>) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={disabled}
      title={disabledReason}
      onClick={disabled ? undefined : onClick}
      className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${
        selected
          ? "border-primary/40 bg-primary/5 text-foreground"
          : disabled
            ? "cursor-not-allowed border-border bg-muted/30 text-muted-foreground opacity-60"
            : "border-border bg-transparent text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      }`}
    >
      {selected && (
        <Check size={14} weight="bold" className="shrink-0 text-primary" />
      )}
      <span className="font-mono">{label}</span>
      {estimated && (
        <span className="text-muted-foreground">estimated</span>
      )}
      {unit !== undefined && (
        <span className="text-muted-foreground">{unit}</span>
      )}
    </button>
  )
}

function KindBadge({ kind }: Readonly<{ kind: string }>) {
  const colors: Record<string, string> = {
    metric: "bg-primary/10 text-primary",
    attribute: "bg-muted text-muted-foreground",
    fact: "bg-muted text-muted-foreground",
  }
  return (
    <span
      className={`rounded-sm px-1 py-px text-[9px] font-medium uppercase ${colors[kind] ?? ""}`}
    >
      {kind}
    </span>
  )
}

function InvalidBanner({
  issues,
}: Readonly<{ issues: readonly ConfigReferenceIssue[] }>) {
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2"
      role="status"
      aria-live="polite"
    >
      <Warning
        size={16}
        weight="regular"
        className="mt-0.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <div className="flex flex-col gap-0.5 text-xs text-foreground">
        {issues.map((issue, i) => (
          <p key={i}>
            <span className="font-mono">{issue.reference}</span> — {issue.message}
          </p>
        ))}
      </div>
    </div>
  )
}

function entryLabel(entry: ColumnEntryValue): string {
  if (entry.kind === "metric") {
    const name = entry.metric ?? entry.derived ?? ""
    return `${name}:${entry.statistic ?? ""}`
  }
  if (entry.kind === "attribute") return entry.attribute ?? ""
  return entry.fact_key ?? ""
}
