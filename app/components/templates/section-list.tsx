"use client"

import { DragDropProvider } from "@dnd-kit/react"
import { isSortableOperation, useSortable } from "@dnd-kit/react/sortable"
import { ArrowDownIcon, ArrowUpIcon, DotsSixVerticalIcon, LockSimpleIcon } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"

/**
 * The report's sections, grouped, reordered by dragging.
 *
 * Each group is its own sortable list, so a section moves within Inventory or within
 * Utilisation but never across — the group is the catalogue's, not a position the author
 * chooses. Fixed sections sit in their place with a lock and are not draggable.
 *
 * Drag starts from the grip, so a click on the row still selects it. The grip is also
 * keyboard-operable through dnd-kit's keyboard sensor, and a Move up / Move down pair is
 * kept on every free row for anyone who prefers buttons; they appear on focus and hover
 * so they do not clutter the list at rest.
 */

export type SectionListItem = {
  readonly id: string
  readonly title: string
  readonly number: number | string
  readonly fixed: boolean
}

export type SectionListGroup = {
  readonly key: string
  readonly label: string
  readonly items: readonly SectionListItem[]
}

export function SectionList({
  groups,
  selectedId,
  onSelect,
  onReorder,
  onMoveStep,
}: Readonly<{
  groups: readonly SectionListGroup[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** The group's free section ids in their new order. */
  onReorder: (groupKey: string, orderedIds: readonly string[]) => void
  onMoveStep: (id: string, direction: "up" | "down") => void
}>) {
  return (
    <DragDropProvider
      onDragEnd={(event) => {
        if (event.canceled) return
        const { operation } = event
        if (!isSortableOperation(operation)) return
        const { source } = operation
        if (source === null) return
        const from = source.initialIndex
        const to = source.index
        const groupKey = String(source.group)
        if (from === to) return
        const group = groups.find((candidate) => candidate.key === groupKey)
        if (group === undefined) return
        const free = group.items.filter((item) => !item.fixed).map((item) => item.id)
        const [moved] = free.splice(from, 1)
        if (moved === undefined) return
        free.splice(to, 0, moved)
        onReorder(groupKey, free)
      }}
    >
      <div className="flex flex-col gap-4">
        {groups.map((group) => {
          if (group.items.length === 0) return null
          let freeIndex = -1
          return (
            <div key={group.key} className="flex flex-col gap-1.5">
              <h3 className="text-micro text-muted-foreground uppercase">{group.label}</h3>
              <ol
                aria-label={`${group.label} sections`}
                className="flex flex-col overflow-hidden rounded-lg border border-border"
              >
                {group.items.map((item) => {
                  if (!item.fixed) freeIndex += 1
                  return item.fixed ? (
                    <FixedRow
                      key={item.id}
                      item={item}
                      selected={item.id === selectedId}
                      onSelect={onSelect}
                    />
                  ) : (
                    <SortableRow
                      key={item.id}
                      item={item}
                      index={freeIndex}
                      group={group.key}
                      selected={item.id === selectedId}
                      onSelect={onSelect}
                      onMoveStep={onMoveStep}
                    />
                  )
                })}
              </ol>
            </div>
          )
        })}
      </div>
    </DragDropProvider>
  )
}

const ROW =
  "group/row flex min-h-11 items-center gap-2 border-t border-border/60 bg-card px-2.5 text-sm first:border-t-0"

function RowButton({
  item,
  selected,
  onSelect,
}: Readonly<{ item: SectionListItem; selected: boolean; onSelect: (id: string) => void }>) {
  return (
    <button
      type="button"
      className="flex min-w-0 flex-1 items-baseline gap-2 py-2 text-left outline-none focus-visible:underline"
      onClick={() => onSelect(item.id)}
      aria-current={selected ? "true" : undefined}
    >
      <span className="w-5 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
        {item.number}
      </span>
      <span className={cn("min-w-0 break-words", selected && "font-medium")}>{item.title}</span>
    </button>
  )
}

function FixedRow({
  item,
  selected,
  onSelect,
}: Readonly<{ item: SectionListItem; selected: boolean; onSelect: (id: string) => void }>) {
  return (
    <li className={cn(ROW, selected && "bg-primary/5")}>
      <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center text-muted-foreground">
        <LockSimpleIcon className="size-3.5" />
      </span>
      <RowButton item={item} selected={selected} onSelect={onSelect} />
      <span className="shrink-0 text-xs text-muted-foreground">Fixed</span>
    </li>
  )
}

function SortableRow({
  item,
  index,
  group,
  selected,
  onSelect,
  onMoveStep,
}: Readonly<{
  item: SectionListItem
  index: number
  group: string
  selected: boolean
  onSelect: (id: string) => void
  onMoveStep: (id: string, direction: "up" | "down") => void
}>) {
  const { ref, handleRef, isDragging } = useSortable({ id: item.id, index, group })

  return (
    <li
      ref={ref}
      data-dragging={isDragging || undefined}
      className={cn(
        ROW,
        selected && "bg-primary/5",
        isDragging && "relative z-10 shadow-md ring-1 ring-primary/30"
      )}
    >
      <button
        ref={handleRef}
        type="button"
        aria-label={`Drag ${item.title} to reorder`}
        className="grid size-6 shrink-0 cursor-grab touch-none place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
      >
        <DotsSixVerticalIcon aria-hidden="true" weight="bold" className="size-4" />
      </button>
      <RowButton item={item} selected={selected} onSelect={onSelect} />
      <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
        <button
          type="button"
          aria-label={`Move ${item.title} up`}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => onMoveStep(item.id, "up")}
        >
          <ArrowUpIcon size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`Move ${item.title} down`}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => onMoveStep(item.id, "down")}
        >
          <ArrowDownIcon size={13} aria-hidden="true" />
        </button>
      </span>
    </li>
  )
}
