"use client"

import { useCallback, useMemo, useState } from "react"
import { DragDropProvider, PointerSensor } from "@dnd-kit/react"

import type { BlockKeyCommand } from "@/components/templates/block-canvas-item"
import {
  BlockCanvas,
  insertionFromId,
  type DragState,
} from "@/components/templates/block-canvas"
import { BlockInspector } from "@/components/templates/block-inspector"
import { BlockPalette } from "@/components/templates/block-palette"
import { MoveAnnouncer } from "@/components/templates/move-announcer"
import type { BlockType } from "@/lib/templates/blocks"
import {
  findBlock,
  locateBlock,
  reduce,
  ROOT_CONTAINER,
  type ComposerAction,
  type ComposerState,
  type InsertionPoint,
} from "@/lib/templates/composer"
import type {
  LeafBlock,
  ScopeSpec,
  TemplateBlock,
  TemplateDefinition,
} from "@/lib/templates/definition"

/**
 * The three-pane composer (Requirement 12).
 *
 * ## Every path ends in one `reduce` call
 *
 * Requirement 12.13 requires a keyboard path for every pointer operation, and
 * the way this file holds that line is that **no component below it changes a
 * block list**. A palette Enter, a pointer drop, a `Mod`+ArrowDown and a Delete
 * all arrive at {@link dispatch} as a `ComposerAction`, and
 * `lib/templates/composer.ts#reduce` is the only thing that produces a new
 * block list. The reducer is pure and separately tested, so what remains here is
 * event translation — which is exactly the part that should be small.
 *
 * ## Focus and selection are one decision, made here
 *
 * Three criteria move focus: 12.3 (a block appended from the palette becomes
 * selected and takes focus), 12.4 (a nudged block keeps both), and 12.12/12.14
 * (a refused move keeps both). Holding `focusBlockId` in one place is what stops
 * an insert and a move fighting over the DOM — a component that called
 * `.focus()` for itself would win or lose that race depending on render order.
 *
 * `focusBlockId` is cleared after the canvas has acted on it, so a later
 * re-render for an unrelated reason does not yank focus back.
 *
 * ## Announcements: exactly one per completed move, successes and refusals alike
 *
 * `announce` is set from the reducer's own `announcement` on success and from
 * `Refusal.message` on refusal, and there is one `aria-live` region
 * (`move-announcer.tsx`). The counter appended to the announcement state is what
 * makes two identical consecutive messages — nudging into the first position
 * twice — announce twice: a live region whose text does not change is not
 * re-announced, so "already first" would be spoken once and then silently
 * ignored, which reads as the key having stopped working.
 */

type Announcement = { readonly message: string; readonly seq: number }

export function BlockComposer({
  definition,
  onChange,
}: Readonly<{
  definition: TemplateDefinition
  onChange: (next: TemplateDefinition) => void
}>) {
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState<Announcement>({
    message: "",
    seq: 0,
  })
  const [drag, setDrag] = useState<DragState>(null)

  const state: ComposerState = useMemo(
    () => ({ blocks: definition.blocks, selectedBlockId }),
    [definition.blocks, selectedBlockId]
  )

  const announce = useCallback((message: string) => {
    setAnnouncement((previous) => ({ message, seq: previous.seq + 1 }))
  }, [])

  /**
   * Apply one action, and carry its outcome to the three things that react to
   * it: the definition, the announcement, and focus.
   *
   * A refusal reaches the announcer and changes nothing else — Requirements
   * 12.12 and 12.14 both require the order unchanged and focus and selection
   * retained, and returning the input state by reference identity is how the
   * reducer already expresses that.
   */
  const dispatch = useCallback(
    (action: ComposerAction, focusAfter: string | null = null) => {
      const result = reduce(state, action)

      if (!result.ok) {
        announce(result.refusal.message)
        return
      }

      onChange({ ...definition, blocks: result.state.blocks })
      announce(result.announcement)

      if (result.state.selectedBlockId !== null) {
        setSelectedBlockId(result.state.selectedBlockId)
      }

      if (focusAfter !== null) setFocusBlockId(focusAfter)
    },
    [announce, definition, onChange, state]
  )

  /**
   * Requirement 12.3 — append, select, and move focus to the appended block.
   *
   * The new block's id is not known until the reducer has run, so it is read off
   * the result rather than predicted: the reducer's own `generateId` is a pure
   * function of the state, and asking for it twice would be a second call site
   * that has to stay in step with it.
   */
  const insertFromPalette = useCallback(
    (blockType: BlockType) => {
      const action: ComposerAction = {
        kind: "insert",
        blockType,
        at: { container: ROOT_CONTAINER, index: definition.blocks.length },
      }

      const result = reduce(state, action)

      if (!result.ok) {
        announce(result.refusal.message)
        return
      }

      onChange({ ...definition, blocks: result.state.blocks })
      announce(result.announcement)

      const appended = result.state.selectedBlockId
      if (appended !== null) {
        setSelectedBlockId(appended)
        setFocusBlockId(appended)
      }
    },
    [announce, definition, onChange, state]
  )

  /**
   * Translate a key command into an action.
   *
   * `promote` and `demote` are the two that need the block's current location:
   * promoting means "out of this row column, to just after the row at the top
   * level", and demoting means "into the adjacent column of the row that follows
   * this block". Both are `move` actions — the reducer decides whether they are
   * legal, including Requirement 12.14's refusal of a row into a column.
   */
  const runCommand = useCallback(
    (blockId: string, command: BlockKeyCommand) => {
      // Focus stays on the block across every outcome (Requirements 12.4,
      // 12.12, 12.14), so it is requested before the branch rather than in each.
      const focusAfter = command.kind === "remove" ? null : blockId

      if (command.kind === "nudge") {
        dispatch({ kind: "nudge", blockId, delta: command.delta }, focusAfter)
        return
      }

      if (command.kind === "remove") {
        dispatch({ kind: "remove", blockId })
        setSelectedBlockId(null)
        return
      }

      const location = locateBlock(definition.blocks, blockId)
      if (location === null) return

      if (command.kind === "promote") {
        if (location.container.kind !== "row") {
          // Already at the top level. Announced rather than ignored: silence is
          // indistinguishable from a key that did not register.
          announce(
            "This block is already in the document's top-level sequence."
          )
          return
        }

        // Landing just *after* the row it came out of, rather than at the end
        // of the document: promoting is "step out one level", and a block that
        // jumped to the bottom of a twenty-block report would have to be nudged
        // back nineteen times.
        const rowId = location.container.rowId
        const rowIndex = definition.blocks.findIndex(
          (block) => block.id === rowId
        )

        dispatch(
          {
            kind: "move",
            blockId,
            to: {
              container: ROOT_CONTAINER,
              index: rowIndex === -1 ? definition.blocks.length : rowIndex + 1,
            },
          },
          focusAfter
        )
        return
      }

      // `demote` — into the next column of the row this block sits in, or into
      // the first column of the row that follows it at the top level.
      const target = demotionTarget(definition.blocks, blockId, location)

      if (target === null) {
        announce(
          "There is no row column beside this block to move it into. Add a row first."
        )
        return
      }

      dispatch({ kind: "move", blockId, to: target }, focusAfter)
    },
    [announce, definition.blocks, dispatch]
  )

  const selected =
    selectedBlockId === null
      ? null
      : (findBlock(definition.blocks, selectedBlockId) ?? null)

  return (
    <div className="flex flex-col gap-3">
      <MoveAnnouncer message={announcement.message} />

      {/*
        Requirement 12.1 — palette, canvas, inspector, in that order in the DOM,
        so tab order is that order without a `tabIndex` anywhere. The grid places
        them visually in the same sequence, so the two cannot diverge.

        `sensors` names **`PointerSensor` alone**, and the omission is the
        design. dnd-kit ships a `KeyboardSensor`, and Requirement 12.4 describes
        something it does not model: a one-position command, not a lift with an
        accumulating pixel delta and a drop. Worse, that gesture binds bare
        arrow keys, which a screen reader consumes for its own navigation — so
        the primitive's keyboard path is unavailable to exactly the users
        Requirement 12 exists for. The keyboard path is
        `block-canvas-item.tsx`'s own, and Requirement 12.13 is satisfied by it
        rather than by the sensor.
      */}
      <DragDropProvider
        sensors={[PointerSensor]}
        onDragStart={(event) => {
          const data = event.operation.source?.data as
            { blockId?: string; blockType?: string } | undefined

          setDrag(
            data?.blockType === undefined
              ? null
              : { blockType: data.blockType, blockId: data.blockId ?? null }
          )
        }}
        onDragEnd={(event) => {
          const dragged = drag
          setDrag(null)

          if (dragged === null) return
          if (event.canceled) return

          const targetId = event.operation.target?.id
          if (typeof targetId !== "string") return

          const at = insertionFromId(targetId)
          if (at === null) return

          if (dragged.blockId === null) {
            dispatch({
              kind: "insert",
              blockType: dragged.blockType as BlockType,
              at,
            })
            return
          }

          dispatch(
            { kind: "move", blockId: dragged.blockId, to: at },
            dragged.blockId
          )
        }}
      >
        <div className="grid gap-3 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,18rem)]">
          <BlockPalette onInsert={insertFromPalette} />

          <BlockCanvas
            blocks={definition.blocks}
            selectedBlockId={selectedBlockId}
            focusBlockId={focusBlockId}
            drag={drag}
            onSelect={setSelectedBlockId}
            onCommand={runCommand}
            onSplitRow={(rowId, columns) =>
              dispatch({ kind: "splitRow", blockId: rowId, columns })
            }
          />

          <BlockInspector
            block={selected}
            templateDefault={definition.scope}
            onPatchConfig={(blockId, config) =>
              dispatch({ kind: "patchConfig", blockId, config })
            }
            onPatchScope={(blockId, scope) =>
              onChange({
                ...definition,
                blocks: withScopeOverride(definition.blocks, blockId, scope),
              })
            }
          />
        </div>
      </DragDropProvider>
    </div>
  )
}

/**
 * Where `Mod`+ArrowRight puts a block.
 *
 * Two cases, and only two, because the grammar has only two containers. A block
 * already inside a row column moves to the **next column of that row**; a
 * top-level block moves into the **first column of the row immediately after
 * it**. Anything else — a top-level block with no row after it, a block in the
 * last column — has no target, and the caller announces that rather than
 * guessing at one.
 */
function demotionTarget(
  blocks: readonly TemplateBlock[],
  blockId: string,
  location: NonNullable<ReturnType<typeof locateBlock>>
): InsertionPoint | null {
  if (location.container.kind === "row") {
    const next = location.container.columnIndex + 1
    if (location.columnCount === null || next >= location.columnCount)
      return null

    return {
      container: {
        kind: "row",
        rowId: location.container.rowId,
        columnIndex: next,
      },
      index: 0,
    }
  }

  const index = blocks.findIndex((block) => block.id === blockId)
  const following = blocks[index + 1]

  if (following === undefined || following.type !== "row") return null

  return {
    container: { kind: "row", rowId: following.id, columnIndex: 0 },
    index: 0,
  }
}

/**
 * Set or clear one block's `scope_override`, anywhere in the tree.
 *
 * Not a reducer action, deliberately: `lib/templates/composer.ts` owns block
 * *arrangement* — where blocks are and which is selected — and a scope override
 * is block *content*, the same category as a config field. Adding a
 * `patchScope` action would widen the reducer's surface for one field that needs
 * none of its ordering logic.
 */
function withScopeOverride(
  blocks: readonly TemplateBlock[],
  blockId: string,
  scope: ScopeSpec | null
): TemplateBlock[] {
  return blocks.map((block) => {
    if (block.type === "row") {
      return {
        ...block,
        columns: block.columns.map((column) =>
          column.map((child) => {
            if (child.id !== blockId) return child
            return applyScope(child, scope)
          })
        ),
      }
    }

    if (block.id !== blockId) return block

    return applyScope(block, scope)
  })
}

/**
 * One leaf block with its `scope_override` set or removed.
 *
 * Removed rather than set to `null`: the schema has no nullable
 * `scope_override`, so a block that inherits is a block with **no key**, and
 * `{scope_override: null}` would be a definition the validator rejects and the
 * canonical digest would differ from an otherwise identical template.
 */
function applyScope(block: LeafBlock, scope: ScopeSpec | null): LeafBlock {
  if (scope !== null) return { ...block, scope_override: scope }

  const next = { ...block }
  delete (next as { scope_override?: ScopeSpec }).scope_override
  return next
}
