"use client"

import { useCallback, useMemo, useState } from "react"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon } from "@phosphor-icons/react"

import { messageText, type MessageId } from "@/lib/messages/catalog"
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
  readonly metric_bearing: boolean
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
}: {
  definition: unknown
  onChange: (next: unknown) => void
  sectionCatalogue: readonly SectionCatalogueEntry[]
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

  // Group authored sections by their catalogue group
  const grouped = useMemo(() => {
    const groups: Record<string, { entry: SectionCatalogueEntry | undefined; section: AuthoredSection }[]> = {
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
        metrics: [],
        presentation: "chart_and_table",
      }
      updateSections([...sections, newSection])
    },
    [catalogueMap, sections, updateSections]
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
    return sectionCatalogue.filter(
      (e) => e.repeatable || !usedTypes.has(e.key)
    )
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
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
                            className="rounded p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => moveSection(section.id, "up")}
                          >
                            <ArrowUpIcon size={14} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${resolveTitle(entry, language)} down`}
                            className="rounded p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Select a section to see its details.
          </p>
        )}
      </div>

      {/* Announce reorder to screen readers */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" id="section-move-announcer" />
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
}: {
  addable: readonly SectionCatalogueEntry[]
  language: "en" | "id"
  onAdd: (type: string) => void
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
      {addable.map((entry) => (
        <button
          key={entry.key}
          type="button"
          className="rounded px-2 py-1 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            onAdd(entry.key)
            setOpen(false)
          }}
          data-testid={`add-section-${entry.key}`}
        >
          <span className="font-mono text-xs text-muted-foreground">
            {entry.number}
          </span>{" "}
          {resolveTitle(entry, language)}
        </button>
      ))}
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
}: {
  section: AuthoredSection
  entry: SectionCatalogueEntry
  language: "en" | "id"
  onRemove: () => void
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
        <div>
          <dt className="text-muted-foreground">Metric-bearing</dt>
          <dd>{entry.metric_bearing ? "Yes" : "No"}</dd>
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
