import {
  EACH_RESOURCE_SLOT,
  type SlotShape,
} from "@/lib/templates/definition"

import {
  GROUP_ORDER,
  catalogueFor,
  sectionEntry,
  sectionTitle,
  type CatalogueSection,
  type Language,
  type Provider,
} from "./catalogue"

/**
 * A schema v4 preset as the builder edits it, and the two readings both the canvas and the
 * runtime must agree on: which order sections print in, and which blocks a section prints.
 *
 * The runtime's readings are `compile/sections.py`'s `_section_sort_key` and `_v4_layout`.
 * These are their ports, kept equal by `test/builder-layout-mirror.static.test.ts`, which
 * runs the Python half over the same cases. A canvas that ordered sections one way and a
 * report that printed them another is the defect the old wizard had, where dragging a
 * section changed the preview and not the document.
 */

export type TypedText = Partial<Record<Language, string>>

export type SlotEntry = {
  readonly slot: string
  readonly hidden?: boolean
  readonly title?: TypedText
  readonly columns?: readonly string[]
}

export type EachEntry = {
  readonly slot: typeof EACH_RESOURCE_SLOT
  readonly hidden?: boolean
  readonly blocks?: readonly SlotEntry[]
}

/** The blocks an author can add to a section — `SECTION_BLOCK_KINDS` in the validator. */
export type AddedKind =
  | "text"
  | "key_figures"
  | "top_list"
  | "month_vs_month"
  | "coverage"
  | "page_break"
  | "callout"
  | "heatmap"
  | "sparklines"

export type CalloutCondition =
  | "peak_at_or_above"
  | "without_backup"
  | "housekeeping"
  | "stopped"
  | "coverage_gaps"

/**
 * A block the author added. Text and callouts carry words; a callout also carries the
 * condition that prints it, and a peak callout its threshold.
 */
export type AddedEntry = {
  readonly kind: AddedKind
  readonly id: string
  readonly text?: TypedText
  readonly when?: CalloutCondition
  readonly tone?: "info" | "attention"
  readonly threshold?: number
}

export type TextEntry = {
  readonly kind: "text"
  readonly id: string
  readonly text: TypedText
}

export type BlockEntry = SlotEntry | EachEntry | AddedEntry

export type ScopeSelection = {
  readonly resource_types: readonly string[]
  readonly tag_filters: readonly { readonly key: string; readonly value: string }[]
  readonly resource_groups: readonly string[]
  readonly top_n: { readonly count: number; readonly metric: string; readonly statistic: string } | null
  readonly sort: "descending" | "ascending" | null
  readonly locations?: readonly string[]
}

export type MetricItem = {
  readonly metric?: string
  readonly derived?: string
  readonly statistic: string
  readonly estimator?: string
  readonly fidelity_tier?: string
}

export type SectionV4 = {
  readonly id: string
  readonly type: string
  readonly position: number
  readonly selection?: ScopeSelection
  readonly metrics?: readonly MetricItem[]
  readonly lookback?: number
  readonly blocks?: readonly BlockEntry[]
}

export type DefinitionV4 = {
  readonly schema_version: 4
  readonly identity: {
    readonly name: string
    readonly language: Language
    readonly description?: string
    readonly report_title?: string
    readonly customer_name?: string
  }
  readonly provider: Provider
  readonly sections: readonly SectionV4[]
  readonly period: { readonly kind: string; readonly start?: string; readonly end?: string }
  readonly design: Readonly<Record<string, unknown>>
  readonly front_matter: Readonly<Record<string, unknown>>
}

export function isAddedEntry(entry: BlockEntry): entry is AddedEntry {
  return "kind" in entry
}

export function isEachEntry(entry: BlockEntry): entry is EachEntry {
  return !isAddedEntry(entry) && entry.slot === EACH_RESOURCE_SLOT
}

// --- Section order -------------------------------------------------------------------

/**
 * Sections in print order: group, then the authored `position` for a free section, the
 * catalogue's order for a fixed one, the appendix last; the catalogue number breaks ties.
 */
export function orderedSections(
  definition: Pick<DefinitionV4, "provider" | "sections">
): SectionV4[] {
  const catalogue = catalogueFor(definition.provider)
  const fixedOrder = new Map(
    catalogue.filter((entry) => entry.position === "fixed").map((entry, index) => [entry.key, index])
  )
  const key = (section: SectionV4): [number, number, number] => {
    const entry = catalogue.find((candidate) => candidate.key === section.type)
    const group = entry ? GROUP_ORDER.indexOf(entry.group) : GROUP_ORDER.length
    const rank =
      entry?.position === "fixed"
        ? (fixedOrder.get(entry.key) ?? 9999)
        : entry?.position === "always"
          ? 99999
          : Number.isInteger(section.position)
            ? section.position
            : 9999
    return [group, rank, entry?.number ?? 0]
  }
  return [...definition.sections].sort((a, b) => {
    const [ga, ra, na] = key(a)
    const [gb, rb, nb] = key(b)
    return ga - gb || ra - rb || na - nb
  })
}

// --- A section's layout ----------------------------------------------------------------

export type LayoutSlot = {
  readonly kind: "slot"
  readonly slot: string
  readonly shape: SlotShape
  readonly entry: SlotEntry
  readonly hidden: boolean
}

export type LayoutAdded = {
  readonly kind: "added"
  readonly id: string
  readonly entry: AddedEntry
}

export type LayoutEach = {
  readonly kind: "each"
  readonly entry: EachEntry
  readonly hidden: boolean
  readonly children: readonly LayoutSlot[]
}

export type LayoutItem = LayoutSlot | LayoutAdded | LayoutEach

/**
 * Every block of a section in print order, hidden ones included and flagged.
 *
 * The author's `blocks` first, in their order; then any catalogue slot it does not name, in
 * catalogue order. Dropping the hidden items gives exactly what the runtime emits.
 */
export function sectionLayout(section: SectionV4, entry: CatalogueSection): LayoutItem[] {
  const shapes = new Map(entry.slots.map((shape) => [shape.slot, shape]))
  const catalogueOrder: string[] = []
  for (const shape of entry.slots) {
    const name = shape.per === "resource" ? EACH_RESOURCE_SLOT : shape.slot
    if (!catalogueOrder.includes(name)) catalogueOrder.push(name)
  }
  const resourceSlots = entry.slots.filter((shape) => shape.per === "resource").map((s) => s.slot)

  const authored = section.blocks ?? []
  const named = new Set(authored.flatMap((item) => (isAddedEntry(item) ? [] : [item.slot])))
  const ordered: BlockEntry[] = [
    ...authored,
    ...catalogueOrder.filter((name) => !named.has(name)).map((slot) => ({ slot })),
  ]

  const items: LayoutItem[] = []
  for (const item of ordered) {
    if (isAddedEntry(item)) {
      items.push({ kind: "added", id: item.id, entry: item })
      continue
    }
    if (item.slot === EACH_RESOURCE_SLOT) {
      const each = item as EachEntry
      const inner = [...(each.blocks ?? [])]
      const innerNamed = new Set(inner.map((child) => child.slot))
      for (const slot of resourceSlots) if (!innerNamed.has(slot)) inner.push({ slot })
      const children = inner.flatMap((child): LayoutSlot[] => {
        const shape = shapes.get(child.slot)
        return shape
          ? [{ kind: "slot", slot: child.slot, shape, entry: child, hidden: child.hidden === true }]
          : []
      })
      if (resourceSlots.length > 0) {
        items.push({ kind: "each", entry: each, hidden: each.hidden === true, children })
      }
      continue
    }
    const shape = shapes.get(item.slot)
    if (shape && shape.per === "section") {
      const slotEntry = item as SlotEntry
      items.push({ kind: "slot", slot: item.slot, shape, entry: slotEntry, hidden: slotEntry.hidden === true })
    }
  }
  return items
}

/** What the runtime prints, as nested slot names — the shape the mirror test compares. */
export function visibleLayout(section: SectionV4, entry: CatalogueSection): (string | string[])[] {
  return sectionLayout(section, entry).flatMap((item): (string | string[])[] => {
    if (item.kind === "added") return [item.id]
    if (item.hidden) return []
    if (item.kind === "each") {
      const children = item.children.filter((child) => !child.hidden).map((child) => child.slot)
      return children.length > 0 ? [children] : []
    }
    return [item.slot]
  })
}

/**
 * A section's layout written out in full: every slot named, in print order.
 *
 * What the builder stores after the first edit to a section, so the order on the canvas is
 * the order in the definition and nothing depends on where an unnamed slot would fall.
 */
export function explicitBlocks(section: SectionV4, entry: CatalogueSection): BlockEntry[] {
  return sectionLayout(section, entry).map((item): BlockEntry => {
    if (item.kind === "added") return item.entry
    if (item.kind === "each") {
      return {
        ...item.entry,
        slot: EACH_RESOURCE_SLOT,
        blocks: item.children.map((child) => child.entry),
      }
    }
    return item.entry
  })
}

/** The provider's catalogue entry for a section, or undefined for a type it does not have. */
export function entryOf(
  definition: Pick<DefinitionV4, "provider">,
  section: SectionV4
): CatalogueSection | undefined {
  return sectionEntry(definition.provider, section.type)
}

/** A section's title as it prints: the author's rename in the report's language, else the catalogue's. */
export function displayTitle(section: SectionV4, entry: CatalogueSection | undefined, language: Language): string {
  const title = section.blocks?.find(
    (block): block is SlotEntry => !isAddedEntry(block) && block.slot === "title"
  )?.title?.[language]
  return title || sectionTitle(entry, language)
}

/**
 * What a section's added metric blocks rank and compare by — `compile/sections.py`'s
 * `_ranking_of`: the section's own top-N rule, else the catalogue's ranking where the
 * section collects it, else the section's first metric.
 */
export function rankingOf(
  section: SectionV4,
  entry: CatalogueSection | undefined
): { metric: string; statistic: string } | null {
  const topN = section.selection?.top_n
  if (topN) return { metric: topN.metric, statistic: topN.statistic }
  const metrics = section.metrics ?? []
  const order = entry?.orderBy
  if (order && metrics.some((m) => (m.metric ?? m.derived) === order.metric && m.statistic === order.statistic)) {
    return order
  }
  const first = metrics.find((m) => (m.metric ?? m.derived) && m.statistic)
  return first ? { metric: (first.metric ?? first.derived)!, statistic: first.statistic } : null
}
