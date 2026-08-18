"use client"

import { useDroppable } from "@dnd-kit/react"

import {
  BlockCanvasItem,
  type BlockKeyCommand,
} from "@/components/templates/block-canvas-item"
import { RowSplitter } from "@/components/templates/row-splitter"
import type { RowBlock, TemplateBlock } from "@/lib/templates/definition"
import {
  blockTypeLabel,
  ROOT_CONTAINER,
  type ContainerRef,
  type InsertionPoint,
} from "@/lib/templates/composer"

/**
 * The canvas — the composed document, in the order it will emit
 * (Requirements 12.6, 12.7, 12.8, 12.9).
 *
 * ## The DOM order *is* the document order
 *
 * Requirement 12.6, and it is the structural commitment everything else here
 * rests on: an `<ol>` whose item sequence is the block sequence, with each row's
 * children rendered inside it column by column. Not a positioned canvas that a
 * screen reader traverses in whatever order the layout produced, and not a list
 * carrying an `order` field a stylesheet could contradict. Reading order matches
 * document order because it is the same order, expressed once.
 *
 * ## Every drop target names where it would put the block
 *
 * Requirement 12.7 forbids a target whose accessible name states only that it
 * accepts a drop. "Drop zone" repeated eleven times down a document is a screen
 * reader reading out a wall of identical strings; *"insert at position 3 of 7"*
 * and *"insert at position 1 of 2, column 2 of 3"* are how a non-visual user
 * knows which one they are on.
 *
 * ## The drop indicator shifts nothing
 *
 * Requirement 12.8 — a 2-pixel `--primary` rule at the insertion point, and **no
 * surrounding block moves** to represent the pending insertion. The rule is
 * drawn inside a fixed-height gap that is always present, so showing it changes
 * a colour rather than a layout. A ghost that pushed blocks apart would reflow
 * the page under the pointer, which is how a drop lands one position away from
 * where it was aimed.
 *
 * ## A row column refuses a row, visibly
 *
 * Requirement 12.9. The refusal is rendered — blocked cursor, the hint, no
 * insertion rule — rather than the drop simply doing nothing, "because a drag
 * that silently does nothing reads as a defect and invites repetition". The
 * keyboard half of the same refusal is Requirement 12.14's, announced through
 * the live region by the composer.
 */

export type DragState = {
  /** The block type being dragged, from the palette or from the canvas. */
  readonly blockType: string
  /** The canvas block being dragged, or `null` for a palette drag. */
  readonly blockId: string | null
} | null

export type CanvasProps = Readonly<{
  blocks: readonly TemplateBlock[]
  selectedBlockId: string | null
  /** The block that should take focus on this render, or `null`. */
  focusBlockId: string | null
  /**
   * What is currently being dragged, or `null`.
   *
   * Read for one purpose: deciding which columns refuse the drag
   * (Requirement 12.9). dnd-kit tracks the *position*; this tracks the
   * *kind*, because "a row is being dragged" is a fact about the payload
   * rather than about where the pointer is.
   */
  drag: DragState
  onSelect: (blockId: string) => void
  onCommand: (blockId: string, command: BlockKeyCommand) => void
  onSplitRow: (rowId: string, columns: 2 | 3) => void
}>

/**
 * A droppable id that round-trips to an insertion point.
 *
 * dnd-kit identifies targets by a scalar id, and the drop handler needs the
 * container and the index back. Encoding them in the id rather than reading
 * `droppable.data` means the mapping is one function and its inverse, both
 * here, and `composer.test.ts`-style round-trip reasoning applies to it.
 */
export function insertionId(at: InsertionPoint): string {
  return at.container.kind === "root"
    ? `root:${at.index}`
    : `row:${at.container.rowId}:${at.container.columnIndex}:${at.index}`
}

/** The inverse of {@link insertionId}, or `null` for an id it did not produce. */
export function insertionFromId(id: string): InsertionPoint | null {
  const parts = id.split(":")

  if (parts[0] === "root" && parts.length === 2) {
    const index = Number(parts[1])
    return Number.isInteger(index) ? { container: ROOT_CONTAINER, index } : null
  }

  if (parts[0] === "row" && parts.length === 4) {
    const columnIndex = Number(parts[2])
    const index = Number(parts[3])
    if (!Number.isInteger(columnIndex) || !Number.isInteger(index)) return null

    return {
      container: { kind: "row", rowId: parts[1]!, columnIndex },
      index,
    }
  }

  return null
}

/**
 * One insertion point, always rendered, showing a rule only while hovered.
 *
 * Always in the DOM rather than conditionally inserted: a target that appears
 * mid-drag changes the layout under the pointer at the moment precision matters.
 *
 * A `div`, deliberately **not** an `li`. Requirement 12.6 makes the canvas "a
 * list whose DOM order equals the order the document emits", and interleaving
 * eleven drop targets into a seven-block list makes it an eighteen-item list
 * that a screen reader announces as such. Each target lives *inside* the list
 * item of the block it follows, so `ol > li` stays exactly the block sequence.
 */
function DropTarget({
  at,
  total,
  columnNumber,
  columnCount,
  refused,
}: Readonly<{
  at: InsertionPoint
  total: number
  columnNumber: number | null
  columnCount: number | null
  /** Requirement 12.9 — a row over a row column. */
  refused: boolean
}>) {
  const id = insertionId(at)

  // `disabled` on a refusing target rather than a target that accepts and then
  // rejects: dnd-kit then never nominates it as the collision winner, so no
  // insertion rule is drawn on it (Requirement 12.9) and a release over it
  // resolves to no target at all, leaving the order unchanged.
  const { ref, isDropTarget } = useDroppable({
    id,
    disabled: refused,
    data: { insertion: at },
  })

  // Requirement 12.7 — position, total, and the column pair inside a row.
  const label = [
    `Insert at position ${at.index + 1} of ${total + 1}`,
    columnNumber === null ? null : `column ${columnNumber} of ${columnCount}`,
  ]
    .filter((part) => part !== null)
    .join(", ")

  return (
    <div
      ref={ref}
      data-slot="drop-target"
      data-insertion-id={id}
      data-insertion-index={at.index}
      data-hovered={isDropTarget ? "true" : "false"}
      data-refused={refused ? "true" : "false"}
      aria-label={label}
      className={[
        // A fixed height that is always occupied, so painting the rule changes a
        // colour rather than a layout (Requirement 12.8).
        "relative h-2",
        refused ? "cursor-no-drop" : "",
      ].join(" ")}
    >
      {isDropTarget && !refused ? (
        <span
          data-slot="drop-indicator"
          aria-hidden="true"
          // Requirement 12.8 — exactly 2px, `--primary`. Absolutely positioned
          // inside the fixed gap so it overlays rather than occupies.
          className="absolute inset-x-0 top-1/2 block h-[2px] -translate-y-1/2 bg-primary"
        />
      ) : null}
    </div>
  )
}

function RowColumns({
  row,
  props,
}: Readonly<{ row: RowBlock; props: CanvasProps }>) {
  // Requirement 12.9 — a `row` dragged over a row's column is refused, whether
  // it came from the palette or from the canvas.
  const refused = props.drag?.blockType === "row"

  return (
    <div
      data-slot="row-columns"
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${row.columns.length}, 1fr)` }}
    >
      {row.columns.map((column, columnIndex) => {
        const container: ContainerRef = {
          kind: "row",
          rowId: row.id,
          columnIndex,
        }

        return (
          <div
            key={columnIndex}
            className="flex flex-col rounded-lg border border-dashed border-border p-1.5"
          >
            <DropTarget
              at={{ container, index: 0 }}
              total={column.length}
              columnNumber={columnIndex + 1}
              columnCount={row.columns.length}
              refused={refused}
            />

            <ol
              data-slot="row-column"
              data-column-index={columnIndex}
              aria-label={`Column ${columnIndex + 1} of ${row.columns.length}`}
              className="flex flex-col"
            >
            {column.map((child, childIndex) => (
              <li
                key={child.id}
                data-block-id={child.id}
                className="list-none"
              >
                <BlockCanvasItem
                  block={child}
                  container={container}
                  position={childIndex + 1}
                  total={column.length}
                  columnNumber={columnIndex + 1}
                  columnCount={row.columns.length}
                  selected={props.selectedBlockId === child.id}
                  focusRequested={props.focusBlockId === child.id}
                  onSelect={() => props.onSelect(child.id)}
                  onCommand={(command) => props.onCommand(child.id, command)}
                />

                <DropTarget
                  at={{ container, index: childIndex + 1 }}
                  total={column.length}
                  columnNumber={columnIndex + 1}
                  columnCount={row.columns.length}
                  refused={refused}
                />
              </li>
            ))}

            </ol>

            {column.length === 0 ? (
              <p className="px-1 py-2 text-center text-xs text-muted-foreground">
                Empty
              </p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export function BlockCanvas(props: CanvasProps) {
  const { blocks } = props

  return (
    <div
      data-slot="block-canvas-pane"
      role="region"
      aria-label="Composed document"
      className="rounded-xl border border-border px-3 py-3"
    >
      {/*
        The leading insertion point sits outside the list, so the list holds
        blocks and nothing else (Requirement 12.6).
      */}
      <DropTarget
        at={{ container: ROOT_CONTAINER, index: 0 }}
        total={blocks.length}
        columnNumber={null}
        columnCount={null}
        refused={false}
      />

      <ol
        data-slot="block-canvas"
        aria-label="Composed blocks"
        className="flex flex-col"
      >
        {blocks.map((block, index) => (
          // `data-block-id` on the **list item**, not only on the block inside
          // it: the item's position in this list is the block's position in the
          // document (Requirement 12.6), so reading the sequence off `ol > li`
          // is reading document order rather than a rendering detail.
          <li key={block.id} data-block-id={block.id} className="list-none">
            <BlockCanvasItem
              block={block}
              container={ROOT_CONTAINER}
              position={index + 1}
              total={blocks.length}
              columnNumber={null}
              columnCount={null}
              selected={props.selectedBlockId === block.id}
              focusRequested={props.focusBlockId === block.id}
              onSelect={() => props.onSelect(block.id)}
              onCommand={(command) => props.onCommand(block.id, command)}
            />

            {block.type === "row" ? (
              <div className="mt-1.5 flex flex-col gap-1.5 pl-3">
                <RowSplitter
                  row={block}
                  onSplit={(columns) => props.onSplitRow(block.id, columns)}
                />

                <RowColumns row={block} props={props} />
              </div>
            ) : null}

            <DropTarget
              at={{ container: ROOT_CONTAINER, index: index + 1 }}
              total={blocks.length}
              columnNumber={null}
              columnCount={null}
              refused={false}
            />
          </li>
        ))}
      </ol>

      {blocks.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground">
          Nothing composed yet. Choose a block from the palette — press Enter on
          one and it lands here, selected and focused.
        </p>
      ) : (
        <p className="mt-2 px-1 text-xs text-muted-foreground">
          {blocks.length} top-level block{blocks.length === 1 ? "" : "s"}, in the
          order the document emits. Select one and use{" "}
          <kbd className="font-mono">Ctrl</kbd>/
          <kbd className="font-mono">⌘</kbd> with the arrow keys to move it;{" "}
          <kbd className="font-mono">Delete</kbd> removes it. {blockTypeLabel("row")}{" "}
          blocks hold two or three columns and hold no row.
        </p>
      )}
    </div>
  )
}
