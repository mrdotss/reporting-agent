import { produce, type Draft } from "immer"
import { temporal } from "zundo"
import { createStore } from "zustand/vanilla"

import { EACH_RESOURCE_SLOT, MAX_AGENT_BLOCKS, type MetricCatalogSnapshot } from "@/lib/templates/definition"

import { sectionEntry, type Language } from "./catalogue"
import { newSection, newUserBlockId, settled } from "./draft"
import {
  agentCount,
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
import type { CanvasData } from "./sample"

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

/**
 * The last "Try it" of one agent paragraph: what the runtime's `try_agent` returned against a
 * real snapshot. Session-only — not saved, not in the undo history, and never what a report
 * prints: every run writes its own.
 */
export type AgentTry = {
  readonly outcome: "written" | "note" | "omitted"
  readonly reason: string
  readonly text: string
  readonly figures: number
  readonly instruction: string
  readonly at: string
}
export type InspectorTab = "content" | "style" | "data"

/** Where the block menu is open: after one block of one section. */
export type InsertPoint = { readonly sectionId: string; readonly after: BlockRef }

/**
 * The page's estimated length, measured from the canvas: one entry per run of pages that
 * starts on a fresh page (the cover, the front matter, each section and each page break).
 */
export type PageRun = {
  readonly key: string
  readonly label: string
  readonly pages: number
  /** The section this run belongs to, for jumping to it; absent for the cover and front matter. */
  readonly sectionId?: string
}

export type BuilderState = {
  readonly definition: DefinitionV4
  readonly selection: Selection
  readonly leftTab: LeftTab
  readonly inspectorTab: InspectorTab
  readonly mode: "edit" | "preview"
  /** Each agent paragraph's last try, by `<sectionId>__<blockId>`. */
  readonly agentTries: Readonly<Record<string, AgentTry>>
  /** The open block menu, from a + between blocks or / on a selected block. */
  readonly insertAt: InsertPoint | null
  /** The canvas's measured page runs, `null` until it has been drawn once. */
  readonly pageRuns: readonly PageRun[] | null
  /** Real figures the canvas draws instead of the sample, `null` for the sample. Never saved. */
  readonly canvasData: CanvasData | null

  select(selection: Selection): void
  setAgentTry(blockId: string, result: AgentTry): void
  setLeftTab(tab: LeftTab): void
  setInspectorTab(tab: InspectorTab): void
  setMode(mode: "edit" | "preview"): void
  openInsert(at: InsertPoint | null): void
  setPageRuns(runs: readonly PageRun[]): void
  setCanvasData(data: CanvasData | null): void

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
  /** An agent paragraph's settings; choosing a note as the fallback starts an empty one. */
  setAgent(sectionId: string, id: string, patch: Partial<Pick<AddedEntry, "reads" | "length" | "voice" | "fallback">>): void
  setAgentText(sectionId: string, id: string, field: "instruction" | "note", language: Language, text: string): void
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

function setTyped(
  target: { text?: unknown } | { title?: unknown } | { instruction?: unknown } | { note?: unknown },
  key: "text" | "title" | "instruction" | "note",
  language: Language,
  value: string
) {
  const record = target as Record<string, Record<string, string> | undefined>
  const current = { ...(record[key] ?? {}) }
  if (value === "") delete current[language]
  else current[language] = value
  if (key === "title" && Object.keys(current).length === 0) delete record[key]
  else record[key] = current
}

/**
 * What a new agent paragraph reads: the block it was asked about, or — placed with nothing
 * selected, or after the per-resource group — the whole section.
 */
function readsOf(blocks: readonly Draft<BlockEntry>[], after: BlockRef | undefined): string[] {
  if (after?.kind === "slot") return [after.slot]
  if (after?.kind === "added") {
    const target = blocks.find((block) => isAddedEntry(block as BlockEntry) && (block as AddedEntry).id === after.id)
    return target && (target as AddedEntry).kind !== "agent" ? [after.id] : []
  }
  return []
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
        agentTries: {},
        insertAt: null,
        pageRuns: null,
        canvasData: null,
        openInsert: (insertAt) => set({ insertAt }),
        setPageRuns: (pageRuns) => set({ pageRuns }),
        setCanvasData: (canvasData) => set({ canvasData }),
        setAgentTry: (blockId, result) => set({ agentTries: { ...get().agentTries, [blockId]: result } }),

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
            if (kind === "agent" && agentCount(draft as DefinitionV4) >= MAX_AGENT_BLOCKS) return
            const entry: AddedEntry =
              kind === "text"
                ? { kind, id, text: { [language]: "" } }
                : kind === "callout"
                  ? { kind, id, when: "coverage_gaps", tone: "info", text: { [language]: "" } }
                  : kind === "agent"
                    ? { kind, id, instruction: { [language]: "" }, reads: readsOf(blocks, after), length: "short", voice: "plain", fallback: "omit" }
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

        setAgent: (sectionId, id, patch) =>
          get().edit((draft) => {
            const section = findSection(draft, sectionId)
            if (!section) return
            const found = locate(materialise(draft, section), { kind: "added", id })
            if (!found) return
            const agent = found.list[found.index] as Draft<AddedEntry>
            Object.assign(agent, patch)
            // A note belongs to the note fallback only. Left behind under "Leave it out", an
            // empty one is an issue the author can neither see nor edit, since the field is
            // hidden; undo brings a removed note back.
            if (agent.fallback === "note" && agent.note === undefined) {
              agent.note = { [get().definition.identity.language]: "" }
            } else if (agent.fallback !== "note") {
              delete agent.note
            }
          }),

        setAgentText: (sectionId, id, field, language, text) =>
          get().edit((draft) => {
            const section = findSection(draft, sectionId)
            if (!section) return
            const found = locate(materialise(draft, section), { kind: "added", id })
            if (!found) return
            setTyped(found.list[found.index] as Draft<AddedEntry>, field, language, text)
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
