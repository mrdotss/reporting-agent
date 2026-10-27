import { ADDED_BLOCKS, blockLabel } from "@/components/builder/canvas/labels"
import { sectionEntry } from "@/lib/builder/catalogue"
import {
  displayTitle,
  orderedSections,
  sectionLayout,
  visibleLayout,
  type DefinitionV4,
  type LayoutItem,
  type SectionV4,
} from "@/lib/builder/model"

/**
 * What the draft changes against the live version, as a list a person reads: sections added,
 * removed or moved, blocks added, removed, hidden or shown, and settings changed.
 *
 * An outline diff, not a text diff. Sections and added blocks are matched by their ids,
 * which a draft keeps from the version it was opened from. Catalogue blocks are matched by
 * slot. What a save adds on its own (the pinned number format, the stored cover image keys)
 * is not a change, the same rule as the presets list's "edits pending".
 */

export type OutlineChange = {
  readonly kind: "added" | "removed" | "moved" | "changed"
  readonly text: string
  /** The draft section the change is in, to open it; absent for a removed section and document-wide changes. */
  readonly sectionId?: string
}

/** JSON with keys sorted, so two objects that differ only in key order compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stable(inner)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function same(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b)
}

function withoutSaveAdditions(definition: DefinitionV4): { design: unknown; front: unknown } {
  const design = { ...(definition.design as Record<string, unknown>) }
  if (design.number_format && typeof design.number_format === "object") {
    const format = { ...(design.number_format as Record<string, unknown>) }
    delete format.trim_trailing_zeros
    delete format.bytes_as_gib
    if (Object.keys(format).length === 0) delete design.number_format
    else design.number_format = format
  }
  const front = { ...definition.front_matter }
  if (front.cover && typeof front.cover === "object") {
    const cover = { ...(front.cover as Record<string, unknown>) }
    delete cover.logo_key
    delete cover.background_key
    front.cover = cover
  }
  return { design, front }
}

function itemKey(item: LayoutItem): string {
  return item.kind === "added" ? `added:${item.id}` : item.kind === "each" ? "each" : `slot:${item.slot}`
}

type SectionChange = Pick<OutlineChange, "kind" | "text">

function sectionChanges(
  live: SectionV4,
  draft: SectionV4,
  provider: DefinitionV4["provider"],
  title: string
): SectionChange[] {
  const entry = sectionEntry(provider, draft.type)
  if (entry === undefined) return same(live, draft) ? [] : [{ kind: "changed", text: `${title}: changed` }]
  const changes: SectionChange[] = []
  const note = (text: string, kind: OutlineChange["kind"] = "changed") => {
    changes.push({ kind, text })
  }
  if (!same(live.metrics ?? [], draft.metrics ?? [])) note(`${title}: metrics changed`)
  if (!same(live.selection ?? null, draft.selection ?? null)) note(`${title}: which resources it covers changed`)
  if ((live.lookback ?? null) !== (draft.lookback ?? null)) note(`${title}: history length changed`)

  const before = new Map(sectionLayout(live, entry).map((item) => [itemKey(item), item]))
  const after = sectionLayout(draft, entry)
  for (const item of after) {
    const old = before.get(itemKey(item))
    if (item.kind === "added") {
      const label = ADDED_BLOCKS[item.entry.kind].label
      if (old === undefined) note(`${title}: ${label} added`, "added")
      else if (!same(old.entry, item.entry)) note(`${title}: ${label} edited`)
      continue
    }
    if (old === undefined || old.kind === "added") continue
    const label = item.kind === "each" ? "Per-resource blocks" : blockLabel(entry, item.slot)
    if (old.hidden !== item.hidden) note(`${title}: ${label} ${item.hidden ? "hidden" : "shown"}`)
    else if (item.kind === "slot" && !same({ ...old.entry, hidden: undefined }, { ...item.entry, hidden: undefined })) {
      note(`${title}: ${label} settings changed`)
    } else if (item.kind === "each" && old.kind === "each") {
      const oldChildren = new Map(old.children.map((child) => [child.slot, child]))
      for (const child of item.children) {
        const was = oldChildren.get(child.slot)
        if (was === undefined) continue
        const childLabel = blockLabel(entry, child.slot)
        if (was.hidden !== child.hidden) note(`${title}: ${childLabel} ${child.hidden ? "hidden" : "shown"}`)
        else if (!same({ ...was.entry, hidden: undefined }, { ...child.entry, hidden: undefined })) {
          note(`${title}: ${childLabel} settings changed`)
        }
      }
    }
  }
  for (const [key, item] of before) {
    if (item.kind === "added" && !after.some((next) => itemKey(next) === key)) {
      note(`${title}: ${ADDED_BLOCKS[item.entry.kind].label} removed`, "removed")
    }
  }

  // The order of what prints, once additions and removals are set aside.
  const flat = (layout: (string | string[])[]) => layout.map((item) => (Array.isArray(item) ? item.join("+") : item))
  const liveVisible = flat(visibleLayout(live, entry))
  const draftVisible = flat(visibleLayout(draft, entry))
  const both = new Set(liveVisible.filter((item) => draftVisible.includes(item)))
  if (!same(liveVisible.filter((item) => both.has(item)), draftVisible.filter((item) => both.has(item)))) {
    note(`${title}: blocks reordered`, "moved")
  }
  return changes
}

export function compareToLive(live: DefinitionV4, draft: DefinitionV4): OutlineChange[] {
  const changes: OutlineChange[] = []
  const language = draft.identity.language

  if (!same(live.identity, draft.identity)) changes.push({ kind: "changed", text: "Document details changed" })
  if (!same(live.period, draft.period)) changes.push({ kind: "changed", text: "Report period changed" })
  const liveRest = withoutSaveAdditions(live)
  const draftRest = withoutSaveAdditions(draft)
  if (!same(liveRest.front, draftRest.front)) changes.push({ kind: "changed", text: "Cover or front matter changed" })
  if (!same(liveRest.design, draftRest.design)) changes.push({ kind: "changed", text: "Theme changed" })

  const liveSections = orderedSections(live)
  const draftSections = orderedSections(draft)
  const liveById = new Map(liveSections.map((section) => [section.id, section]))
  const draftIds = new Set(draftSections.map((section) => section.id))
  const titleOf = (section: SectionV4, definition: DefinitionV4) =>
    displayTitle(section, sectionEntry(definition.provider, section.type), language)

  for (const section of draftSections) {
    if (!liveById.has(section.id)) {
      changes.push({ kind: "added", text: `${titleOf(section, draft)} added`, sectionId: section.id })
    }
  }
  for (const section of liveSections) {
    if (!draftIds.has(section.id)) changes.push({ kind: "removed", text: `${titleOf(section, live)} removed` })
  }

  // A section moved when it is not part of the longest run that kept its relative order, so
  // moving one section reports that one, not every section it passed.
  const liveIndex = new Map(liveSections.map((section, index) => [section.id, index]))
  const common = draftSections.filter((section) => liveById.has(section.id))
  for (const id of outOfOrder(common.map((section) => liveIndex.get(section.id)!), common.map((s) => s.id))) {
    const section = common.find((candidate) => candidate.id === id)!
    changes.push({ kind: "moved", text: `${titleOf(section, draft)} moved`, sectionId: id })
  }

  for (const section of draftSections) {
    const old = liveById.get(section.id)
    if (old === undefined) continue
    for (const change of sectionChanges(old, section, draft.provider, titleOf(section, draft))) {
      changes.push({ ...change, sectionId: section.id })
    }
  }
  return changes
}

/** The ids whose positions are not in a longest increasing run of `positions`. */
function outOfOrder(positions: readonly number[], ids: readonly string[]): string[] {
  const length = positions.map(() => 1)
  const previous = positions.map(() => -1)
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (positions[j]! < positions[i]! && length[j]! + 1 > length[i]!) {
        length[i] = length[j]! + 1
        previous[i] = j
      }
    }
  }
  let end = length.indexOf(Math.max(0, ...length))
  const keep = new Set<number>()
  while (end !== -1) {
    keep.add(end)
    end = previous[end]!
  }
  return ids.filter((_, index) => !keep.has(index))
}
