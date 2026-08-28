"use client"

import { useCallback, useMemo, useState } from "react"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon } from "@phosphor-icons/react"

import { messageText, type MessageId } from "@/lib/messages/catalog"
import { missingInputs } from "@/lib/profiles/offerability"
import {
  DEFAULT_PRESET_NAME,
  expandPresets,
  matchPresetName,
  type ExpandedPreset,
} from "@/lib/profiles/presets"
import {
  HISTORICAL_LOOKBACK_MAX,
  HISTORICAL_LOOKBACK_MIN,
  type MetricCatalogSnapshot,
  type MetricSelectionItem,
} from "@/lib/templates/definition"
import { Button } from "@/components/ui/button"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The catalogue entry shape, threaded as a prop from the server (sections.ts is
 * `server-only`). Only the fields this first-pass component uses are declared
 * here to keep the prop contract narrow.
 */
export type SectionCatalogueEntry = {
  readonly key: string
  readonly number: number
  readonly title_id: string
  readonly group: "inventory" | "utilisation" | "closing"
  readonly position: "free" | "fixed" | "always"
  readonly repeatable: boolean
  readonly needs_resource_types: readonly string[]
  readonly needs_fact_sources: readonly string[]
  readonly metric_bearing: boolean
  /**
   * The catalogue's named metric bundles (Requirement 10.3), e.g.
   * `standard_utilization`. Expanded to concrete metric items by
   * `lib/profiles/presets.ts` when a preset is chosen — never stored by name.
   *
   * Optional because the narrow fixtures in this component's own tests declare
   * none; a section whose entry declares no preset simply offers no preset row.
   */
  readonly presets?: Readonly<
    Record<
      string,
      readonly { readonly metric: string; readonly statistic: string }[] | "*"
    >
  >
}

/**
 * An authored section instance (v3 definition shape, per
 * `accept-schema-version-3-minimal.json`). The definition is treated as
 * `unknown` at the shell boundary; this type describes what we read
 * defensively inside this component.
 */
type AuthoredSection = {
  readonly id: string
  readonly type: string
  readonly selection?: unknown
  readonly metrics?: unknown
  readonly presentation?: string
  /** Months of history, required for `historical_vm_utilization` alone. */
  readonly lookback?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GROUP_LABELS: Record<string, string> = {
  inventory: "Inventory",
  utilisation: "Utilisation",
  closing: "Closing",
}

function readSections(definition: unknown): AuthoredSection[] {
  if (typeof definition !== "object" || definition === null) return []
  const sections = (definition as Record<string, unknown>).sections
  if (!Array.isArray(sections)) return []
  return sections.filter(
    (s): s is AuthoredSection =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as Record<string, unknown>).id === "string" &&
      typeof (s as Record<string, unknown>).type === "string"
  )
}

function resolveTitle(
  entry: SectionCatalogueEntry | undefined,
  language: "en" | "id"
): string {
  if (!entry) return "(Unknown section)"
  const text = messageText(entry.title_id as MessageId, language)
  return text ?? entry.key
}

function readLanguage(definition: unknown): "en" | "id" {
  if (typeof definition !== "object" || definition === null) return "en"
  const identity = (definition as Record<string, unknown>).identity
  if (typeof identity !== "object" || identity === null) return "en"
  const lang = (identity as Record<string, unknown>).language
  return lang === "id" ? "id" : "en"
}

function generateSectionId(): string {
  return `sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StepSections({
  definition,
  onChange,
  sectionCatalogue,
  catalog,
  scanTypeCounts,
  collectedFactSources,
}: {
  definition: unknown
  onChange: (next: unknown) => void
  sectionCatalogue: readonly SectionCatalogueEntry[]
  /**
   * The Metric_Catalog, threaded from the server because
   * `lib/templates/catalog.ts` is `server-only`.
   *
   * Requirement 10.3's preset row expands against it and writes CONCRETE metrics
   * into the section, rather than storing the preset's name: a stored name would be
   * resolved at compile time against whatever `sections.v1.json` the running image
   * ships, and since replay recompiles a pinned version demanding a byte-identical
   * ledger, editing a preset later would fail replay on reports that were correct
   * when issued. See `lib/profiles/presets.ts`.
   *
   * Optional so the existing tests that render this step without a catalogue keep
   * working — with none, the preset row is absent and a section is added with no
   * metrics, exactly as before this landed.
   */
  catalog?: MetricCatalogSnapshot
  /**
   * The most recent scan's `type_counts`, for Req 16.1's "disabled with the missing input
   * named" surface (task 6.5). Omitted (or `undefined`) means "no scan to check against
   * yet" — every section renders offerable rather than every section renders disabled,
   * because a wizard with no scan data at all must not look broken; it looks exactly as it
   * did before this task landed.
   */
  scanTypeCounts?: Readonly<Record<string, number>>
  /**
   * Which fact sources the catalogue actually collects — `lib/profiles/facts.ts`'s
   * `COLLECTED_FACT_SOURCES`, threaded down rather than imported here because this is a
   * client component and that module is `server-only`. Omitted means the same "no scan yet"
   * default as `scanTypeCounts`.
   */
  collectedFactSources?: ReadonlySet<string>
}) {
  const language = readLanguage(definition)
  const sections = useMemo(() => readSections(definition), [definition])
  const [selectedId, setSelectedId] = useState<string | null>(
    sections[0]?.id ?? null
  )

  const catalogueMap = useMemo(
    () => new Map(sectionCatalogue.map((e) => [e.key, e])),
    [sectionCatalogue]
  )

  /**
   * A catalogue entry's presets, expanded against the Metric_Catalog.
   *
   * Memoized per entry key, because expanding `"*"` walks every metric the
   * catalogue declares for the section's types and the inspector re-renders on
   * every keystroke elsewhere in the step.
   */
  const expandedByKey = useMemo(() => {
    const out = new Map<string, readonly ExpandedPreset[]>()
    if (catalog === undefined) return out
    for (const entry of sectionCatalogue) {
      if (entry.presets === undefined) continue
      out.set(
        entry.key,
        expandPresets(
          {
            key: entry.key,
            needs_resource_types: entry.needs_resource_types,
            presets: entry.presets,
          },
          catalog
        )
      )
    }
    return out
  }, [sectionCatalogue, catalog])

  const presetMetricsFor = useCallback(
    (
      entry: SectionCatalogueEntry,
      presetName: string
    ): readonly MetricSelectionItem[] =>
      expandedByKey.get(entry.key)?.find((p) => p.name === presetName)
        ?.metrics ?? [],
    [expandedByKey]
  )

  // Offerability against the most recent scan (task 6.5, Req 15.9, 16.1-16.3). `undefined`
  // props mean "nothing to check against yet" — treated as offerable rather than as
  // disabled, so a wizard opened before any scan completed behaves as it always has.
  const missingInputsByKey = useMemo(() => {
    if (scanTypeCounts === undefined || collectedFactSources === undefined) {
      return new Map<string, readonly string[]>()
    }
    return new Map(
      sectionCatalogue.map((entry) => [
        entry.key,
        missingInputs(entry, scanTypeCounts, collectedFactSources),
      ])
    )
  }, [sectionCatalogue, scanTypeCounts, collectedFactSources])

  // Group authored sections by their catalogue group
  const grouped = useMemo(() => {
    const groups: Record<
      string,
      { entry: SectionCatalogueEntry | undefined; section: AuthoredSection }[]
    > = {
      inventory: [],
      utilisation: [],
      closing: [],
    }
    for (const section of sections) {
      const entry = catalogueMap.get(section.type)
      const group = entry?.group ?? "inventory"
      groups[group]!.push({ entry, section })
    }
    return groups
  }, [sections, catalogueMap])

  const updateSections = useCallback(
    (newSections: AuthoredSection[]) => {
      if (typeof definition !== "object" || definition === null) return
      onChange({ ...(definition as object), sections: newSections })
    },
    [definition, onChange]
  )

  /**
   * Set or clear one section's `lookback`.
   *
   * `undefined` DELETES the key rather than writing `undefined` into it: the
   * validator branches on `"lookback" in entry`, so a present-but-undefined key
   * would take the range branch and report "must be an integer" for a field the
   * author has simply not filled in yet, instead of the "requires lookback"
   * message that actually tells them what to do.
   */
  const setLookback = useCallback(
    (id: string, months: number | undefined) => {
      updateSections(
        sections.map((section) => {
          if (section.id !== id) return section
          if (months === undefined) {
            const { lookback: _dropped, ...rest } = section
            return rest
          }
          return { ...section, lookback: months }
        })
      )
    },
    [sections, updateSections]
  )

  const moveSection = useCallback(
    (id: string, direction: "up" | "down") => {
      const idx = sections.findIndex((s) => s.id === id)
      if (idx < 0) return
      const entry = catalogueMap.get(sections[idx]!.type)
      // Fixed/always sections cannot be reordered
      if (entry && entry.position !== "free") return

      const targetIdx = direction === "up" ? idx - 1 : idx + 1
      if (targetIdx < 0 || targetIdx >= sections.length) return

      // Don't swap past a fixed/always section
      const targetEntry = catalogueMap.get(sections[targetIdx]!.type)
      if (targetEntry && targetEntry.position !== "free") return

      const next = [...sections]
      const [moved] = next.splice(idx, 1)
      next.splice(targetIdx, 0, moved!)
      updateSections(next)
      announceMove(resolveTitle(entry, language), targetIdx + 1, next.length)
    },
    [sections, catalogueMap, updateSections, language]
  )

  const addSection = useCallback(
    (type: string) => {
      const entry = catalogueMap.get(type)
      if (!entry) return
      if ((missingInputsByKey.get(type)?.length ?? 0) > 0) return
      const newSection: AuthoredSection = {
        id: generateSectionId(),
        type,
        selection: {
          resource_types: [...entry.needs_resource_types],
          resource_groups: [],
          tag_filters: [],
          top_n: null,
          sort: null,
        },
        // Seeded from the catalogue's default preset, expanded to concrete items.
        // This used to be a hardcoded `[]`, which meant every metric-bearing
        // section a consultant added requested NO metric: the collector asked Azure
        // for nothing, produced no statistic, and the run died `NO_STATISTICS` with
        // an empty `collection_log`, so nothing explained the absence. The preset's
        // metrics are written INTO the section rather than referenced by name —
        // see the `catalog` prop's own note for why a stored name breaks replay.
        metrics: presetMetricsFor(entry, DEFAULT_PRESET_NAME),
        presentation: "chart_and_table",
      }
      updateSections([...sections, newSection])
    },
    [
      catalogueMap,
      sections,
      updateSections,
      missingInputsByKey,
      presetMetricsFor,
    ]
  )

  /**
   * Replace one section's metrics with a preset's, or clear them.
   *
   * `null` clears — the author choosing `Custom` with no per-metric tier yet built
   * (Requirement 10.4/10.5) has no way to express a partial selection, so clearing
   * is the only honest meaning available and the section then reads as Custom.
   */
  const setPreset = useCallback(
    (id: string, presetName: string | null) => {
      const section = sections.find((candidate) => candidate.id === id)
      if (section === undefined) return
      const entry = catalogueMap.get(section.type)
      if (entry === undefined) return

      updateSections(
        sections.map((candidate) =>
          candidate.id === id
            ? {
                ...candidate,
                metrics:
                  presetName === null
                    ? []
                    : presetMetricsFor(entry, presetName),
              }
            : candidate
        )
      )
    },
    [sections, catalogueMap, updateSections, presetMetricsFor]
  )

  const removeSection = useCallback(
    (id: string) => {
      updateSections(sections.filter((s) => s.id !== id))
      if (selectedId === id) setSelectedId(null)
    },
    [sections, selectedId, updateSections]
  )

  // Available catalogue entries for "Add section" dropdown
  const addable = useMemo(() => {
    const usedTypes = new Set(sections.map((s) => s.type))
    return sectionCatalogue.filter((e) => e.repeatable || !usedTypes.has(e.key))
  }, [sectionCatalogue, sections])

  const selectedSection = sections.find((s) => s.id === selectedId)
  const selectedEntry = selectedSection
    ? catalogueMap.get(selectedSection.type)
    : undefined

  return (
    <div className="flex gap-4" data-testid="step-sections">
      {/* Left: section list */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {(["inventory", "utilisation", "closing"] as const).map((group) => {
          const items = grouped[group]!
          if (items.length === 0) return null
          return (
            <div key={group} className="flex flex-col gap-1">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {GROUP_LABELS[group]}
              </h3>
              <ol
                className="flex flex-col gap-1"
                aria-label={`${GROUP_LABELS[group]} sections`}
              >
                {items.map(({ entry, section }) => {
                  const isFixed =
                    entry?.position === "fixed" || entry?.position === "always"
                  const isCurrent = section.id === selectedId
                  return (
                    <li
                      key={section.id}
                      className={[
                        "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                        isCurrent
                          ? "border-primary bg-accent"
                          : "border-border",
                      ].join(" ")}
                    >
                      <button
                        type="button"
                        className="flex-1 text-left"
                        onClick={() => setSelectedId(section.id)}
                        aria-current={isCurrent ? "true" : undefined}
                      >
                        <span className="font-mono text-xs text-muted-foreground">
                          {entry?.number ?? "?"}
                        </span>{" "}
                        {resolveTitle(entry, language)}
                      </button>

                      {!isFixed && (
                        <span className="flex gap-0.5">
                          <button
                            type="button"
                            aria-label={`Move ${resolveTitle(entry, language)} up`}
                            className="rounded p-0.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                            onClick={() => moveSection(section.id, "up")}
                          >
                            <ArrowUpIcon size={14} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${resolveTitle(entry, language)} down`}
                            className="rounded p-0.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                            onClick={() => moveSection(section.id, "down")}
                          >
                            <ArrowDownIcon size={14} aria-hidden="true" />
                          </button>
                        </span>
                      )}

                      {isFixed && (
                        <span className="text-xs text-muted-foreground">
                          Fixed
                        </span>
                      )}
                    </li>
                  )
                })}
              </ol>
            </div>
          )
        })}

        {/* Add section */}
        {addable.length > 0 && (
          <AddSectionControl
            addable={addable}
            language={language}
            onAdd={addSection}
            missingInputsByKey={missingInputsByKey}
          />
        )}
      </div>

      {/* Right: inspector */}
      <div className="w-64 shrink-0 rounded-xl border border-border p-3">
        {selectedSection && selectedEntry ? (
          <SectionInspector
            section={selectedSection}
            entry={selectedEntry}
            language={language}
            onRemove={() => removeSection(selectedSection.id)}
            onLookbackChange={(months) =>
              setLookback(selectedSection.id, months)
            }
            presets={expandedByKey.get(selectedSection.type) ?? []}
            activePreset={matchPresetName(
              Array.isArray(selectedSection.metrics)
                ? (selectedSection.metrics as readonly MetricSelectionItem[])
                : [],
              expandedByKey.get(selectedSection.type) ?? []
            )}
            onPresetChange={(presetName) =>
              setPreset(selectedSection.id, presetName)
            }
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Select a section to see its details.
          </p>
        )}
      </div>

      {/* Announce reorder to screen readers */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        id="section-move-announcer"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add Section
// ---------------------------------------------------------------------------

function AddSectionControl({
  addable,
  language,
  onAdd,
  missingInputsByKey,
}: {
  addable: readonly SectionCatalogueEntry[]
  language: "en" | "id"
  onAdd: (type: string) => void
  missingInputsByKey: ReadonlyMap<string, readonly string[]>
}) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="add-section-trigger"
      >
        <PlusIcon aria-hidden="true" size={14} />
        Add section
      </Button>
    )
  }

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border p-2">
      <p className="text-xs font-medium text-muted-foreground">
        Choose a section to add:
      </p>
      {addable.map((entry) => {
        const missing = missingInputsByKey.get(entry.key) ?? []
        const isDisabled = missing.length > 0
        return (
          <button
            key={entry.key}
            type="button"
            disabled={isDisabled}
            aria-disabled={isDisabled}
            title={
              isDisabled
                ? `Not yet available: needs ${missing.join(", ")}`
                : undefined
            }
            className={[
              "rounded px-2 py-1 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              isDisabled
                ? "cursor-not-allowed text-muted-foreground opacity-60"
                : "hover:bg-muted",
            ].join(" ")}
            onClick={() => {
              if (isDisabled) return
              onAdd(entry.key)
              setOpen(false)
            }}
            data-testid={`add-section-${entry.key}`}
          >
            <span className="font-mono text-xs text-muted-foreground">
              {entry.number}
            </span>{" "}
            {resolveTitle(entry, language)}
            {isDisabled && (
              <span className="ml-1 text-xs text-muted-foreground">
                (needs {missing.join(", ")})
              </span>
            )}
          </button>
        )
      })}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(false)}
      >
        Cancel
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

function SectionInspector({
  section,
  entry,
  language,
  onRemove,
  onLookbackChange,
  presets,
  activePreset,
  onPresetChange,
}: {
  section: AuthoredSection
  entry: SectionCatalogueEntry
  language: "en" | "id"
  onRemove: () => void
  onLookbackChange: (months: number | undefined) => void
  /** The entry's presets, already expanded against the Metric_Catalog. */
  presets: readonly ExpandedPreset[]
  /** Which preset the current metrics match, or `null` for Custom. */
  activePreset: string | null
  onPresetChange: (presetName: string | null) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-heading text-sm font-medium">
        {resolveTitle(entry, language)}
      </h3>

      <dl className="flex flex-col gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Group</dt>
          <dd>{GROUP_LABELS[entry.group] ?? entry.group}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Position</dt>
          <dd className="capitalize">{entry.position}</dd>
        </div>
        {entry.needs_resource_types.length > 0 && (
          <div>
            <dt className="text-muted-foreground">Resource types</dt>
            <dd className="flex flex-wrap gap-1 pt-0.5">
              {entry.needs_resource_types.map((rt) => (
                <span
                  key={rt}
                  className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs"
                >
                  {rt.split("/").pop()}
                </span>
              ))}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground">Presentation</dt>
          <dd className="capitalize">
            {(section.presentation ?? "chart_and_table").replaceAll("_", " ")}
          </dd>
        </div>
      </dl>

      {/*
        Requirement 10.3's preset row. It replaces a read-only "Metric-bearing:
        Yes", which told the consultant the section carried metrics while offering
        no way to choose any — and `addSection` wrote none, so the section shipped
        an empty selection and the run collected nothing.

        Only the tiers the catalogue declares are offered, plus `Custom`. The
        per-metric chips and the statistic multi-select (Requirement 10.4, 10.5) are
        NOT here yet: this is the first tier only, which is what makes a report
        possible at all. `Custom` therefore clears the selection rather than opening
        a picker that does not exist, and says so.
      */}
      {presets.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2">
          <p className="text-xs font-medium">Metrics</p>

          <div className="flex flex-col gap-1">
            {presets.map((preset) => (
              <label
                key={preset.name}
                className="flex items-start gap-2 text-xs has-focus-visible:ring-3 has-focus-visible:ring-ring/30"
              >
                <input
                  type="radio"
                  name={`preset-${section.id}`}
                  value={preset.name}
                  checked={activePreset === preset.name}
                  onChange={() => onPresetChange(preset.name)}
                  className="mt-0.5"
                />
                <span className="flex flex-col">
                  <span>{preset.label}</span>
                  <span className="font-mono text-muted-foreground tabular-nums">
                    {preset.metrics.length}{" "}
                    {preset.metrics.length === 1 ? "metric" : "metrics"}
                  </span>
                </span>
              </label>
            ))}

            <label className="flex items-start gap-2 text-xs">
              <input
                type="radio"
                name={`preset-${section.id}`}
                value="__custom__"
                checked={activePreset === null}
                onChange={() => onPresetChange(null)}
                className="mt-0.5"
              />
              <span className="flex flex-col">
                <span>Custom</span>
                <span className="text-muted-foreground">
                  Clears the selection. Per-metric choice is not built yet, so a
                  section left on Custom collects nothing.
                </span>
              </span>
            </label>
          </div>
        </div>
      )}

      {/*
        `lookback` — required by the validator for exactly one section type, and
        until now settable by no control anywhere in the wizard, which made a
        profile containing section 9 impossible to save: the validator asked for a
        depth and the UI offered no way to give one.

        Rendered ONLY for the type that reads it. A number input on every section
        would imply the other fourteen have a configurable depth, and
        `compile/sections.py` threads it into `historical_trend`'s config alone.
      */}
      {section.type === "historical_vm_utilization" && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2">
          <label
            htmlFor={`lookback-${section.id}`}
            className="text-xs font-medium"
          >
            Lookback (months)
          </label>
          <input
            id={`lookback-${section.id}`}
            type="number"
            inputMode="numeric"
            min={HISTORICAL_LOOKBACK_MIN}
            max={HISTORICAL_LOOKBACK_MAX}
            step={1}
            value={typeof section.lookback === "number" ? section.lookback : ""}
            onChange={(event) => {
              const raw = event.target.value
              // An empty field clears the key rather than writing 0 or NaN: the
              // validator's message ("requires lookback") is the correct thing to
              // show for "not chosen yet", and a 0 would trade it for a
              // range error that describes the UI rather than the author's intent.
              if (raw === "") {
                onLookbackChange(undefined)
                return
              }
              const parsed = Number(raw)
              if (!Number.isInteger(parsed)) return
              onLookbackChange(parsed)
            }}
            className="h-8 w-24 rounded-md border border-input bg-background px-2.5 font-mono text-sm tabular-nums focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
          />
          <p className="text-xs text-muted-foreground">
            How many months of history the trend covers, from{" "}
            <span className="font-mono tabular-nums">
              {HISTORICAL_LOOKBACK_MIN}
            </span>{" "}
            to{" "}
            <span className="font-mono tabular-nums">
              {HISTORICAL_LOOKBACK_MAX}
            </span>
            . Each month is collected as its own window, so a deeper trend is a
            longer run.
          </p>
        </div>
      )}

      {entry.position === "free" && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 text-destructive"
          onClick={onRemove}
        >
          Remove section
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Aria announcement helper
// ---------------------------------------------------------------------------

function announceMove(title: string, newPosition: number, total: number) {
  const el = document.getElementById("section-move-announcer")
  if (el) {
    el.textContent = `${title} moved to position ${newPosition} of ${total}.`
  }
}
