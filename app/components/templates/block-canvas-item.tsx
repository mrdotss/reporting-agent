"use client"

import { useEffect, useRef, type KeyboardEvent } from "react"
import { useDraggable } from "@dnd-kit/react"

import type { TemplateBlock } from "@/lib/templates/definition"
import {
  blockTypeLabel,
  type ContainerRef,
} from "@/lib/templates/composer"

/**
 * One block on the canvas: a keyboard command target, and a drag source
 * (Requirements 12.4, 12.10, 12.12, 12.13, 12.14).
 *
 * ## Both paths dispatch the identical action
 *
 * Requirement 12.13 requires a keyboard path for every pointer operation, and
 * the cheapest way to hold that is to make the two paths *the same code below
 * the event*. A pointer drop and a `Mod`+ArrowDown both end in one
 * `ComposerAction` handed to `lib/templates/composer.ts#reduce`. Nothing here
 * mutates a block list, so there is no second implementation for the keyboard
 * path to fall behind.
 *
 * ## The keyboard model, and why it is not dnd-kit's keyboard sensor
 *
 * Requirement 12.4 describes a **one-position command**: press `Mod`+ArrowUp,
 * the block moves one place toward the start of its own container, focus and
 * selection stay on it. dnd-kit's keyboard sensor models something else — a
 * lift, a series of moves accumulating a pixel delta, and a drop — and two
 * things go wrong with it here.
 *
 * First, bare arrows during a lift are exactly the keys a screen reader consumes
 * for its own navigation, so the gesture is unavailable to the users this
 * requirement exists for. Second, a pixel delta has to be translated back into a
 * position, and the translation is the part that behaves differently for a block
 * in a row column than for one at the top level — which is precisely the
 * containment rule 12.4 states.
 *
 * So the sensor is not used, and this component handles the keys itself.
 *
 * ## Selection is a ring and nothing else
 *
 * Requirement 12.10: a `--ring` outline, **no** colour fill and **no**
 * background change, "so that the canvas keeps resembling the document it
 * previews". A selected block that turned blue would make the preview stop
 * previewing at the moment the consultant is looking hardest at it.
 */

export type BlockKeyCommand =
  | { readonly kind: "nudge"; readonly delta: -1 | 1 }
  /** `Mod`+ArrowLeft — out of a row column into the top-level sequence. */
  | { readonly kind: "promote" }
  /** `Mod`+ArrowRight — into the adjacent row column. */
  | { readonly kind: "demote" }
  | { readonly kind: "remove" }

/** Ctrl on Windows and Linux, Command on macOS. */
function hasModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey
}

function commandFor(event: KeyboardEvent): BlockKeyCommand | null {
  if (event.key === "Delete" || event.key === "Backspace") {
    return { kind: "remove" }
  }

  if (!hasModifier(event)) return null

  switch (event.key) {
    case "ArrowUp":
      return { kind: "nudge", delta: -1 }
    case "ArrowDown":
      return { kind: "nudge", delta: 1 }
    case "ArrowLeft":
      return { kind: "promote" }
    case "ArrowRight":
      return { kind: "demote" }
    default:
      return null
  }
}

export function BlockCanvasItem({
  block,
  container,
  position,
  total,
  columnNumber,
  columnCount,
  selected,
  focusRequested,
  onSelect,
  onCommand,
}: Readonly<{
  block: TemplateBlock
  container: ContainerRef
  /** 1-based, as announced and as named on the accessible label. */
  position: number
  total: number
  /** 1-based column, or `null` at the top level. */
  columnNumber: number | null
  columnCount: number | null
  selected: boolean
  /**
   * Whether this block should take keyboard focus on this render.
   *
   * Requirement 12.3 moves focus to a block appended from the palette, and
   * Requirement 12.4 retains it across a move. Both are expressed as *the
   * composer asking for focus on one id*, rather than each call site reaching
   * for a DOM node — one place decides who is focused, which is what stops a
   * move and an insert fighting over it.
   */
  focusRequested: boolean
  onSelect: () => void
  onCommand: (command: BlockKeyCommand) => void
}>) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (focusRequested) ref.current?.focus()
  }, [focusRequested])

  // The pointer half. `data` is what the drop handler reads to know what is
  // being dragged — a block already on the canvas, identified by id, versus a
  // fresh type from the palette.
  const { ref: dragRef, isDragging } = useDraggable({
    id: block.id,
    data: { blockId: block.id, blockType: block.type },
  })

  const label = [
    blockTypeLabel(block.type),
    `position ${position} of ${total}`,
    columnNumber === null ? null : `column ${columnNumber} of ${columnCount}`,
  ]
    .filter((part) => part !== null)
    .join(", ")

  return (
    <div
      ref={(element) => {
        ref.current = element
        dragRef(element)
      }}
      data-slot="block-canvas-item"
      data-block-id={block.id}
      data-block-type={block.type}
      data-container={container.kind}
      data-selected={selected ? "true" : "false"}
      data-dragging={isDragging ? "true" : "false"}
      // A single tab stop for the whole canvas would be the roving-tabindex
      // pattern; every block being tabbable is the simpler one and the right one
      // here, because a document of twenty blocks is a list a consultant reads
      // through rather than a grid they navigate within.
      tabIndex={0}
      role="button"
      aria-pressed={selected}
      aria-label={label}
      onClick={onSelect}
      onFocus={onSelect}
      onKeyDown={(event) => {
        const command = commandFor(event)
        if (command === null) return

        // Both are needed. `preventDefault` stops `Mod`+ArrowUp scrolling the
        // page and Backspace navigating back; `stopPropagation` keeps a nested
        // block's command from also reaching the row that contains it.
        event.preventDefault()
        event.stopPropagation()

        onCommand(command)
      }}
      className={[
        "rounded-lg border px-3 py-2 text-sm focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none",
        // Requirement 12.10 — a ring, never a fill. The border stays neutral so
        // the canvas keeps looking like the page it previews.
        selected ? "border-border ring-2 ring-ring" : "border-border",
        // The dragged block dims rather than leaving a hole: Requirement 12.8
        // forbids shifting surrounding blocks to represent a pending insertion,
        // and removing the source from the flow would shift every one after it.
        isDragging ? "opacity-40" : "",
      ].join(" ")}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span>{blockTypeLabel(block.type)}</span>

        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {position}/{total}
        </span>
      </span>
    </div>
  )
}
