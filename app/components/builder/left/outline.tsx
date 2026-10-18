"use client"

import { DragDropProvider } from "@dnd-kit/react"
import { isSortableOperation, useSortable } from "@dnd-kit/react/sortable"
import {
  CaretDownIcon,
  CaretRightIcon,
  DotsSixVerticalIcon,
  EyeIcon,
  EyeSlashIcon,
  LockSimpleIcon,
  PlusIcon,
  RepeatIcon,
  TextTIcon,
} from "@phosphor-icons/react"
import { useState, type ReactNode } from "react"

import { useBuilder, useIssues } from "@/components/builder/context"
import { blockLabel } from "@/components/builder/canvas/labels"
import {
  GROUP_ORDER,
  resourceNoun,
  sectionEntry,
  type CatalogueSection,
} from "@/lib/builder/catalogue"
import { issuesForSection } from "@/lib/builder/issues"
import { displayTitle, orderedSections, sectionLayout, type LayoutItem, type SectionV4 } from "@/lib/builder/model"
import { blockKey, type BlockRef, type Selection } from "@/lib/builder/store"
import { cn } from "@/lib/utils"

/**
 * The document as a tree: front matter, then each group's sections in print order, each
 * opening onto its blocks.
 *
 * The same order the canvas draws and the report prints, because all three read
 * `orderedSections`. Dragging a section rewrites its position; dragging a block reorders
 * the section's own layout. A fixed section shows a lock instead of a handle: the catalogue
 * decides where it prints.
 */

const GROUP_LABELS: Readonly<Record<string, string>> = {
  summary: "Summary",
  inventory: "Inventory",
  utilisation: "Utilisation",
  closing: "Closing",
}

const ROW =
  "flex min-h-[30px] w-full items-center gap-2 rounded-md px-1.5 text-left text-[13px] hover:bg-muted"

const refKey = blockKey

function refFromKey(key: string): BlockRef {
  if (key.startsWith("text:")) return { kind: "text", id: key.slice(5) }
  if (key === "each") return { kind: "each" }
  const [where, slot] = key.split(":")
  return { kind: "slot", slot: slot ?? "", inEach: where === "in" }
}

export function Outline() {
  const definition = useBuilder((state) => state.definition)
  const moveSectionTo = useBuilder((state) => state.moveSectionTo)
  const moveBlockTo = useBuilder((state) => state.moveBlockTo)
  const setLeftTab = useBuilder((state) => state.setLeftTab)
  const sections = orderedSections(definition)

  return (
    <DragDropProvider
      onDragEnd={(event) => {
        if (event.canceled) return
        const { operation } = event
        if (!isSortableOperation(operation) || operation.source === null) return
        const { source } = operation
        if (source.initialIndex === source.index) return
        const group = String(source.group)
        const id = String(source.id)
        if (group.startsWith("sections:")) {
          const groupKey = group.slice("sections:".length)
          const free = sections.filter((section) => {
            const entry = sectionEntry(definition.provider, section.type)
            return entry?.group === groupKey && entry.position === "free"
          })
          const target = free[source.index]
          if (target) moveSectionTo(id, target.id)
          return
        }
        if (group.startsWith("blocks:")) {
          const [, sectionId] = group.split(":")
          if (sectionId) moveBlockTo(sectionId, refFromKey(id.split("|")[1] ?? ""), source.index)
        }
      }}
    >
      <nav aria-label="Document outline" className="flex flex-col pb-4">
        <FrontMatterGroup />
        {GROUP_ORDER.map((group) => {
          const inGroup = sections.filter(
            (section) => sectionEntry(definition.provider, section.type)?.group === group
          )
          if (inGroup.length === 0) return null
          let freeIndex = -1
          return (
            <div key={group} className="flex flex-col">
              <span className="px-1.5 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {GROUP_LABELS[group]}
              </span>
              {inGroup.map((section) => {
                const entry = sectionEntry(definition.provider, section.type)
                if (!entry) return null
                if (entry.position === "free") freeIndex += 1
                return (
                  <SectionRow
                    key={section.id}
                    section={section}
                    entry={entry}
                    number={sections.indexOf(section) + 1}
                    sortIndex={entry.position === "free" ? freeIndex : -1}
                  />
                )
              })}
            </div>
          )
        })}
        <button
          type="button"
          onClick={() => setLeftTab("add")}
          className="mt-3 inline-flex h-8 items-center gap-2 rounded-md px-2 text-[13px] font-medium text-primary hover:bg-muted"
        >
          <PlusIcon aria-hidden className="size-3.5" />
          Add section
        </button>
      </nav>
    </DragDropProvider>
  )
}

function FrontMatterGroup() {
  const selection = useBuilder((state) => state.selection)
  const select = useBuilder((state) => state.select)
  const rows: { part: "cover" | "control" | "toc"; label: string }[] = [
    { part: "cover", label: "Cover" },
    { part: "control", label: "Document control" },
    { part: "toc", label: "Contents" },
  ]
  return (
    <div className="flex flex-col">
      <span className="px-1.5 pt-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Front matter
      </span>
      {rows.map((row) => {
        const on = selection?.kind === "front" && selection.part === row.part
        return (
          <button
            key={row.part}
            type="button"
            onClick={() => select({ kind: "front", part: row.part })}
            className={cn(ROW, on && "bg-primary/10 font-semibold text-primary")}
          >
            <span className="w-[18px]" />
            {row.label}
          </button>
        )
      })}
    </div>
  )
}

function SectionRow({
  section,
  entry,
  number,
  sortIndex,
}: Readonly<{ section: SectionV4; entry: CatalogueSection; number: number; sortIndex: number }>) {
  const definition = useBuilder((state) => state.definition)
  const selection = useBuilder((state) => state.selection)
  const select = useBuilder((state) => state.select)
  const issues = issuesForSection(useIssues(), section.id)
  const inSection = selection !== null && "sectionId" in selection && selection.sectionId === section.id
  const [open, setOpen] = useState(false)
  const expanded = open || inSection
  const { ref, handleRef, isDragging } = useSortable({
    id: section.id,
    index: Math.max(0, sortIndex),
    group: `sections:${entry.group}`,
    disabled: sortIndex < 0,
  })
  const title = displayTitle(section, entry, definition.identity.language)
  const sectionSelected = selection?.kind === "section" && selection.sectionId === section.id

  return (
    <div ref={ref} className={cn("flex flex-col", isDragging && "relative z-10 rounded-md bg-background shadow-md")}>
      <div className="group/row flex items-center gap-0.5">
        {sortIndex >= 0 ? (
          <button
            ref={handleRef}
            type="button"
            aria-label={`Drag ${title} to reorder`}
            className="grid size-5 shrink-0 cursor-grab touch-none place-items-center rounded text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
          >
            <DotsSixVerticalIcon aria-hidden weight="bold" className="size-3.5" />
          </button>
        ) : (
          <span className="grid size-5 shrink-0 place-items-center text-muted-foreground" title="The catalogue fixes where this section prints">
            <LockSimpleIcon aria-hidden className="size-3" />
          </span>
        )}
        <button
          type="button"
          onClick={() => select({ kind: "section", sectionId: section.id })}
          aria-current={sectionSelected || undefined}
          className={cn(ROW, "min-w-0 flex-1", sectionSelected && "bg-primary/10 font-semibold text-primary")}
        >
          <span className="w-[18px] shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
            {String(number).padStart(2, "0")}
          </span>
          <span className="truncate">{title}</span>
          {issues.length > 0 && (
            <span
              aria-label={`${issues.length} to fix`}
              className="ml-auto size-1.5 shrink-0 rounded-full bg-[var(--status-attention,#b7791f)]"
            />
          )}
        </button>
        <button
          type="button"
          aria-label={expanded ? `Collapse ${title}` : `Show the blocks in ${title}`}
          aria-expanded={expanded}
          onClick={() => setOpen(!expanded)}
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted"
        >
          {expanded ? <CaretDownIcon className="size-3" /> : <CaretRightIcon className="size-3" />}
        </button>
      </div>
      {expanded && <BlockTree section={section} entry={entry} />}
    </div>
  )
}

function BlockTree({ section, entry }: Readonly<{ section: SectionV4; entry: CatalogueSection }>) {
  const layout = sectionLayout(section, entry)
  return (
    <div className="my-0.5 mr-1 ml-[26px] flex flex-col gap-px border-l border-border pl-2">
      {layout.map((item, index) => (
        <TreeItem key={itemKey(item)} item={item} index={index} section={section} entry={entry} />
      ))}
    </div>
  )
}

function itemKey(item: LayoutItem): string {
  return item.kind === "text" ? `text:${item.id}` : item.kind === "each" ? "each" : `top:${item.slot}`
}

function TreeItem({
  item,
  index,
  section,
  entry,
}: Readonly<{ item: LayoutItem; index: number; section: SectionV4; entry: CatalogueSection }>) {
  const definition = useBuilder((state) => state.definition)
  const language = definition.identity.language
  if (item.kind === "each") {
    return (
      <div className="flex flex-col">
        <BlockRow
          section={section}
          ref_={{ kind: "each" }}
          index={index}
          group={`blocks:${section.id}:top`}
          hidden={item.hidden}
          icon={<RepeatIcon aria-hidden className="size-3.5" />}
          label={`For each ${resourceNoun(entry)}`}
          strong
        />
        {!item.hidden && (
          <div className="ml-3 flex flex-col gap-px border-l border-dashed border-primary/30 pl-2">
            {item.children.map((child, childIndex) => (
              <BlockRow
                key={child.slot}
                section={section}
                ref_={{ kind: "slot", slot: child.slot, inEach: true }}
                index={childIndex}
                group={`blocks:${section.id}:each`}
                hidden={child.hidden}
                label={blockLabel(entry, child.slot)}
                locked={child.shape.required}
              />
            ))}
          </div>
        )}
      </div>
    )
  }
  if (item.kind === "text") {
    const text = item.entry.text[language]
    return (
      <BlockRow
        section={section}
        ref_={{ kind: "text", id: item.id }}
        index={index}
        group={`blocks:${section.id}:top`}
        icon={<TextTIcon aria-hidden className="size-3.5" />}
        label={text ? `“${text.slice(0, 28)}${text.length > 28 ? "…" : ""}”` : "Text (empty)"}
      />
    )
  }
  return (
    <BlockRow
      section={section}
      ref_={{ kind: "slot", slot: item.slot, inEach: false }}
      index={index}
      group={`blocks:${section.id}:top`}
      hidden={item.hidden}
      label={blockLabel(entry, item.slot)}
      locked={item.shape.required}
    />
  )
}

function BlockRow({
  section,
  ref_,
  index,
  group,
  hidden = false,
  locked = false,
  icon,
  label,
  strong = false,
}: Readonly<{
  section: SectionV4
  ref_: BlockRef
  index: number
  group: string
  hidden?: boolean
  locked?: boolean
  icon?: ReactNode
  label: string
  strong?: boolean
}>) {
  const selection = useBuilder((state) => state.selection)
  const select = useBuilder((state) => state.select)
  const toggleHidden = useBuilder((state) => state.toggleHidden)
  const { ref, handleRef, isDragging } = useSortable({ id: `${section.id}|${refKey(ref_)}`, index, group })
  const selected = isSelected(selection, section.id, ref_)
  return (
    <div ref={ref} className={cn("group/row flex items-center gap-0.5", isDragging && "relative z-10 rounded bg-background shadow-md")}>
      <button
        ref={handleRef}
        type="button"
        aria-label={`Drag ${label} to reorder`}
        className="grid size-4 shrink-0 cursor-grab touch-none place-items-center text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
      >
        <DotsSixVerticalIcon aria-hidden weight="bold" className="size-3" />
      </button>
      <button
        type="button"
        onClick={() => select({ kind: "block", sectionId: section.id, ref: ref_ })}
        aria-current={selected || undefined}
        className={cn(
          "flex min-h-[26px] min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 text-left text-[12.5px] hover:bg-muted",
          selected && "bg-primary/10 font-semibold text-primary",
          hidden && "text-muted-foreground line-through",
          strong && !selected && "font-semibold text-primary"
        )}
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
      {ref_.kind !== "text" && (
        <button
          type="button"
          aria-label={locked ? `${label} always prints` : hidden ? `Show ${label}` : `Hide ${label}`}
          aria-pressed={hidden}
          disabled={locked}
          onClick={() => toggleHidden(section.id, ref_)}
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        >
          {hidden ? <EyeSlashIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
        </button>
      )}
    </div>
  )
}

function isSelected(selection: Selection, sectionId: string, ref: BlockRef): boolean {
  if (selection?.kind !== "block" || selection.sectionId !== sectionId) return false
  return refKey(selection.ref) === refKey(ref)
}
