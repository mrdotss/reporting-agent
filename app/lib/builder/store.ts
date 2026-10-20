import { produce, type Draft } from "immer"
import { temporal } from "zundo"
import { createStore } from "zustand/vanilla"

import { EACH_RESOURCE_SLOT, type MetricCatalogSnapshot } from "@/lib/templates/definition"

import { sectionEntry, type Language } from "./catalogue"
import { newSection, newUserBlockId, settled } from "./draft"
import {
  explicitBlocks,
  isEachEntry,
  isAddedEntry,
  orderedSections,
  type BlockEntry,
  type BlockStyle,
  type DefinitionV4,
  type EachEntry,
  type SectionV4,
  type SlotEntry,
  type AddedEntry,
  type AddedKind,
  type TextEntry,
} from "./model"

/**
 * The builder's state: the draft being edited, what is selected, and which panels are open.
 *
 * One store for the whole screen, so the outline, the page and the inspector read one
 * selection and one draft and cannot disagree about either. Undo and redo cover the draft
 * only — selecting a block is not an edit, and undoing it would be a surprise.
 */

export type BlockRef =
  | { readonly kind: "slot"; readonly slot: string; readonly inEach: boolean }
  | { readonly kind: "added"; readonly id: string }
  | { readonly kind: "each" }

/** A block's key within its section — stable across edits, used by the outline and the page. */
export function blockKey(ref: BlockRef): string {
  if (ref.kind === "added") return `added:${ref.id}`
  if (ref.kind === "each") return "each"
  return `${ref.inEach ? "in" : "top"}:${ref.slot}`
}

export type Selection =
  | { readonly kind: "section"; readonly sectionId: string }
  | { readonly kind: "block"; readonly sectionId: string; readonly ref: BlockRef }
  | { readonly kind: "front"; readonly part: "cover" | "control" | "toc" }
  | null

export type LeftTab = "outline" | "add" | "theme" | "document"
export type InspectorTab = "content" | "style" | "data"

export type BuilderState = {
  readonly definition: DefinitionV4
  readonly selection: Selection
  readonly leftTab: LeftTab
  readonly inspectorTab: InspectorTab
  readonly mode: "edit" | "preview"

  select(selection: Selection): void
  setLeftTab(tab: LeftTab): void
  setInspectorTab(tab: InspectorTab): void
  setMode(mode: "edit" | "preview"): void

  /** Any edit to the draft, as an immer recipe. Every named action below goes through it. */
  edit(recipe: (draft: Draft<DefinitionV4>) => void): void

  addSection(type: string, afterSectionId?: string): string | null
  removeSection(sectionId: string): void
  moveSection(sectionId: string, offset: -1 | 1): void
  moveSectionTo(sectionId: string, targetSectionId: string): void

  toggleHidden(sectionId: string, ref: BlockRef): void
  moveBlock(sectionId: string, ref: BlockRef, offset: -1 | 1): void
  moveBlockTo(sectionId: string, ref: BlockRef, toIndex: number): void
  addBlock(sectionId: string, kind: AddedKind, after?: BlockRef): string | null
  removeAdded(sectionId: string, id: string): void
  setText(sectionId: string, id: string, language: Language, text: string): void
  setCallout(sectionId: string, id: string, patch: Partial<Pick<AddedEntry, "when" | "tone" | "threshold">>): void
  setTitle(sectionId: string, slot: string, language: Language, text: string): void
  setColumns(sectionId: string, ref: BlockRef, columns: readonly string[] | null): void
  /** Sets (or, with `undefined`, clears) keys of a chart or table slot's own look; `null` clears it all. */
  setSlotStyle(sectionId: string, ref: BlockRef, patch: { [K in keyof BlockStyle]?: BlockStyle[K] | undefined } | null): void
}

type Options = {
  readonly initial: DefinitionV4
  readonly catalog: MetricCatalogSnapshot
}

/** Keystrokes inside this window collapse into one undo step. */
const UNDO_GROUP_MS = 600

function groupedHandleSet<T extends (...args: never[]) => void>(handleSet: T): T {
  let last = 0
  return ((...args: Parameters<T>) => {
    const now = Date.now()
    if (now - last > UNDO_GROUP_MS) handleSet(...args)
    last = now
  }) as T
}

function findSection(draft: Draft<DefinitionV4>, sectionId: string): Draft<SectionV4> | undefined {
  return draft.sections.find((section) => section.id === sectionId)
}

/**
 * The section's blocks written out in full before an edit changes them, so every edit acts
 * on a list that names every slot in print order.
 */
function materialise(draft: Draft<DefinitionV4>, section: Draft<SectionV4>): Draft<BlockEntry>[] {
  const entry = sectionEntry(draft.provider, section.type)
  if (entry === undefined) return (section.blocks ?? []) as Draft<BlockEntry>[]
  if (!section.blocks || section.blocks.length === 0 || needsFilling(section, entry.slots.length)) {
    section.blocks = explicitBlocks(section as SectionV4, entry) as Draft<BlockEntry>[]
  }
  return section.blocks as Draft<BlockEntry>[]
}

function needsFilling(section: Draft<SectionV4>, slotCount: number): boolean {
  let named = 0
  for (const block of section.blocks ?? []) {
    if (isAddedEntry(block as BlockEntry)) continue
    if (isEachEntry(block as BlockEntry)) named += (block as EachEntry).blocks?.length ?? 0
    else named += 1
  }
  return named < slotCount
}

/** The list a block lives in, and its index there. */
function locate(
  blocks: Draft<BlockEntry>[],
  ref: BlockRef
): { list: Draft<BlockEntry>[] | Draft<SlotEntry>[]; index: number } | null {
  if (ref.kind === "added") {
    const index = blocks.findIndex((b) => isAddedEntry(b as BlockEntry) && (b as AddedEntry).id === ref.id)
    return index === -1 ? null : { list: blocks, index }
  }
  if (ref.kind === "each") {
    const index = blocks.findIndex((b) => isEachEntry(b as BlockEntry))
    return index === -1 ? null : { list: blocks, index }
  }
  if (ref.inEach) {
    const each = blocks.find((b) => isEachEntry(b as BlockEntry)) as Draft<EachEntry> | undefined
    const children = (each?.blocks ?? []) as Draft<SlotEntry>[]
    const index = children.findIndex((child) => child.slot === ref.slot)
    return index === -1 ? null : { list: children, index }
  }
  const index = blocks.findIndex(
    (b) => !isAddedEntry(b as BlockEntry) && (b as SlotEntry).slot === ref.slot
  )
  return index === -1 ? null : { list: blocks, index }
}

function setTyped(target: { text?: unknown } | { title?: unknown }, key: "text" | "title", language: Language, value: string) {
  const record = target as Record<string, Record<string, string> | undefined>
  const current = { ...(record[key] ?? {}) }
  if (value === "") delete current[language]
  else current[language] = value
  if (key === "title" && Object.keys(current).length === 0) delete record[key]
  else record[key] = current
}

export function createBuilderStore({ initial, catalog }: Options) {
  return createStore<BuilderState>()(
    temporal(
      (set, get) => ({
        definition: initial,
        selection: null,
        leftTab: "outline",
        inspectorTab: "content",
        mode: "edit",

        select: (selection) => set({ selection, inspectorTab: "content" }),
        setLeftTab: (leftTab) => set({ leftTab }),
        setInspectorTab: (inspectorTab) => set({ inspectorTab }),
        setMode: (mode) => set({ mode, selection: mode === "preview" ? null : get().selection }),

        edit: (recipe) =>
          set((state) => ({ definition: produce(state.definition, recipe) })),

        addSection: (type, afterSectionId) => {
          const { definition } = get()
          const entry = sectionEntry(definition.provider, type)
          if (entry === undefined) return null
          const added = newSection(definition.provider, type, catalog)
          const ordered = orderedSections(definition)
          const after = ordered.findIndex((section) => section.id === afterSectionId)
          const sameGroup =
            after !== -1 && sectionEntry(definition.provider, ordered[after]!.type)?.group === entry.group
          let index: number
          if (sameGroup) {
            index = after + 1
          } else {
            // The end of its own group: past the last section of that group or any before it.
            const groups = ["summary", "inventory", "utilisation", "closing"]
            const rank = groups.indexOf(entry.group)
            const lastBefore = ordered.findLastIndex(
              (section) => groups.indexOf(sectionEntry(definition.provider, section.type)?.group ?? "") <= rank
            )
            index = lastBefore + 1
          }
          const next = [...ordered.slice(0, index), added, ...ordered.slice(index)]
          set((state) => ({
            definition: { ...state.definition, sections: settled(state.definition.provider, next) },
            selection: { kind: "section", sectionId: added.id },
            inspectorTab: "content",
          }))
          return added.id
        },

        removeSection: (sectionId) =>
          set((state) => ({
            definition: {
              ...state.definition,
              sections: settled(
                state.definition.provider,
                orderedSections(state.definition).filter((section) => section.id !== sectionId)
              ),
            },
            selection: null,
          })),

        moveSection: (sectionId, offset) => {
          const { definition } = get()
          const ordered = orderedSections(definition)
          const index = ordered.findIndex((section) => section.id === sectionId)
          const target = ordered[index + offset]
          if (index === -1 || target === undefined) return
          get().moveSectionTo(sectionId, target.id)
        },

        moveSectionTo: (sectionId, targetSectionId) => {
          const { definition } = get()
          const ordered = orderedSections(definition)
          const from = ordered.findIndex((section) => section.id === sectionId)
          const to = ordered.findIndex((section) => section.id === targetSectionId)
          if (from === -1 || to === -1 || from === to) return
          const moving = ordered[from]!
          const movingEntry = sectionEntry(definition.provider, moving.type)
          const targetEntry = sectionEntry(definition.provider, ordered[to]!.type)
          // Only free sections move, and only within their group: the group decides where a
          // section prints, so a drag across groups would be undone by the first render.
          if (movingEntry?.position !== "free" || targetEntry?.group !== movingEntry.group) return
          const next = [...ordered]
          next.splice(from, 1)
          next.splice(to, 0, moving)
          set((state) => ({
            definition: { ...state.definition, sections: settled(state.definition.provider, next) },
          }))
        },

        toggleHidden: (sectionId, ref) =>
          get().edit((draft) => {
            const section = findSection(draft, sectionId)
            if (!section) return
            const found = locate(materialise(draft, section), ref)
            if (!found) return
            const block = found.list[found.index] as Draft<SlotEntry | EachEntry>
            if (block.hidden) delete block.hidden
            else block.hidden = true
          }),

        moveBlock: (sectionId, ref, offset) =>
          get().edit((draft) => {
            const target = findSection(draft, sectionId)
            if (!target) return
            const found = locate(materialise(draft, target), ref)
            if (!found) return
            const to = found.index + offset
            if (to < 0 || to >= found.list.length) return
            const [moved] = found.list.splice(found.index, 1)
            ;(found.list as unknown[]).splice(to, 0, moved)
          }),

        moveBlockTo: (sectionId, ref, toIndex) =>
          get().edit((draft) => {
            const target = findSection(draft, sectionId)
            if (!target) return
            const found = locate(materialise(draft, target), ref)
            if (!found || toIndex < 0 || toIndex >= found.list.length || toIndex === found.index) return
            const [moved] = found.list.splice(found.index, 1)
            ;(found.list as unknown[]).splice(toIndex, 0, moved)
          }),

        addBlock: (sectionId, kind, after) => {
          const id = newUserBlockId()
          const language = get().definition.identity.language
          let added = false
          get().edit((draft) => {
            const section = findSection(draft, sectionId)
            if (!section) return
            const blocks = materialise(draft, section)
            // Added blocks sit at section level. Placed after a block inside the
            // per-resource group, one goes after the group itself.
            const anchor: BlockRef | undefined =
              after?.kind === "slot" && after.inEach ? { kind: "each" } : after
            const found = anchor ? locate(blocks, anchor) : null
            const index = found && found.list === blocks ? found.index + 1 : blocks.length
            const entry: AddedEntry =
              kind === "text"
                ? { kind, id, text: { [language]: "" } }
                : kind === "callout"
                  ? { kind, id, when: "coverage_gaps", tone: "info", text: { [language]: "" } }
                  : { kind, id }
            blocks.splice(index, 0, entry as Draft<AddedEntry>)
            added = true
          })
          if (!added) return null
          set({ selection: { kind: "block", sectionId, ref: { kind: "added", id } }, inspectorTab: "content" })
          return id
        },

        removeAdded: (sectionId, id) => {
          get().edit((draft) => {
            const section = findSection(draft, sectionId)
            if (!section?.blocks) return
            section.blocks = section.blocks.filter(
              (block) => !(isAddedEntry(block as BlockEntry) && (block as AddedEntry).id === id)
            )
          })
          set({ selection: { kind: "section", sectionId } })
        },

        setText: (sectionId, id, language, text) =>
          get().edit((draft) => {
            const section = findSection(draft, sectionId)
            if (!section) return
            const found = locate(materialise(draft, section), { kind: "added", id })
            if (!found) return
            setTyped(found.list[found.index] as Draft<TextEntry>, "text", language, text)
          }),

        setCallout: (sectionId, id, patch) =>
          get().edit((draft) => {
            const section = findSection(draft, sectionId)
            if (!section) return
            const found = locate(materialise(draft, section), { kind: "added", id })
            if (!found) return
            const callout = found.list[found.index] as Draft<AddedEntry>
            Object.assign(callout, patch)
            // A threshold belongs to a peak condition only; the validator refuses it elsewhere.
            if (callout.when !== "peak_at_or_above") delete callout.threshold
            else if (callout.threshold === undefined) callout.threshold = 80
          }),

        setTitle: (sectionId, slot, language, text) =>
          get().edit((draft) => {
            const section = findSection(draft, sectionId)
            if (!section) return
            const found = locate(materialise(draft, section), { kind: "slot", slot, inEach: false })
            if (!found) return
            setTyped(found.list[found.index] as Draft<SlotEntry>, "title", language, text)
          }),

        setColumns: (sectionId, ref, columns) =>
          get().edit((draft) => {
            const section = findSection(draft, sectionId)
            if (!section) return
            const found = locate(materialise(draft, section), ref)
            if (!found) return
            const block = found.list[found.index] as Draft<SlotEntry>
            if (columns === null) delete block.columns
            else block.columns = [...columns]
          }),

        setSlotStyle: (sectionId, ref, patch) =>
          get().edit((draft) => {
            const section = findSection(draft, sectionId)
            if (!section || ref.kind !== "slot") return
            const found = locate(materialise(draft, section), ref)
            if (!found) return
            const block = found.list[found.index] as Draft<SlotEntry>
            const next: Record<string, unknown> = patch === null ? {} : { ...block.style }
            for (const [key, value] of Object.entries(patch ?? {})) {
              if (value === undefined) delete next[key]
              else next[key] = value
            }
            if (Object.keys(next).length === 0) delete block.style
            else block.style = next as BlockStyle
          }),
      }),
      {
        partialize: (state) => ({ definition: state.definition }),
        equality: (past, current) => past.definition === current.definition,
        handleSet: (handleSet) => groupedHandleSet(handleSet),
        limit: 100,
      }
    )
  )
}

export type BuilderStore = ReturnType<typeof createBuilderStore>

export { EACH_RESOURCE_SLOT }
