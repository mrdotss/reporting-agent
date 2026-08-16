"use client"

import { DragDropProvider } from "@dnd-kit/react"

/**
 * The composer canvas — **the minimum an empty canvas needs**, no more.
 *
 * ## Scope
 *
 * This file exists so the drag primitive is mounted and smoke-tested at the point the
 * dependency is pinned, rather than discovered to be incompatible several tasks later.
 * Selection, the inspector, the row splitter, keyboard reordering and the `aria-live`
 * announcements are **not here** — the composer tasks own those. What is here is the one
 * structural commitment those tasks build on, and it is the one worth locking early:
 *
 * **The canvas is a real list in the DOM order the document emits** (Requirement 12.6).
 * Reading order equals document order because it is the *same* order — an `<ol>` whose
 * item sequence is the block sequence, not a positioned canvas that a screen reader
 * traverses in whatever order the layout happened to produce. Given no blocks it renders
 * an empty list and nothing else.
 *
 * ## Why the provider is here rather than added later
 *
 * `DragDropProvider` is the piece with a lifecycle. It constructs a `DragDropManager`,
 * which registers plugins and sensors against the document, so it is exactly the part
 * that can misbehave under React 19's StrictMode double-invoke — and misbehave *quietly*,
 * as an intermittent reorder rather than as an error. Mounting it from the start means
 * `block-canvas.smoke.test.tsx` is asserting something real.
 *
 * The default preset of `@dnd-kit/dom` already carries `PointerSensor` **and**
 * `KeyboardSensor` plus the `Accessibility` plugin, which is why this line of dnd-kit was
 * chosen: Requirement 12.13 makes a keyboard path for every pointer operation a condition
 * of the requirement passing, not a later addition, so a primitive without one is
 * disqualified before any styling question is asked. The sensors are left at their
 * defaults here — the composer configures them when it has operations to configure.
 */

/**
 * A placeholder shape carrying only what a DOM-ordered list needs: an identity to key on
 * and a type to label. The real definition — the block config schemas mirrored against
 * the compiler — lands with `lib/templates/blocks.ts`, and this type is replaced by it
 * rather than widened to meet it.
 */
export type CanvasBlock = {
  readonly id: string
  readonly type: string
}

export function BlockCanvas({
  blocks = [],
}: {
  readonly blocks?: readonly CanvasBlock[]
}) {
  return (
    <DragDropProvider>
      <ol
        data-slot="block-canvas"
        aria-label="Composed blocks"
        className="flex flex-col gap-2"
      >
        {blocks.map((block) => (
          <li key={block.id} data-block-id={block.id}>
            {block.type}
          </li>
        ))}
      </ol>
    </DragDropProvider>
  )
}
