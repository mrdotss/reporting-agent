import { describe, expect, test } from "vitest"

import {
  BLOCK_CONFIG,
  BLOCK_TYPES,
  type BlockType,
} from "@/lib/templates/blocks"
import {
  BLOCK_TYPE_LABELS,
  blockTypeLabel,
  countBlocks,
  flattenBlockIds,
  freshBlockId,
  locateBlock,
  reduce,
  refusalFor,
  type ComposerState,
} from "@/lib/templates/composer"
import {
  MAX_BLOCKS_TOTAL,
  MAX_CHILDREN_PER_COLUMN,
  type LeafBlock,
  type RowBlock,
  type TemplateBlock,
} from "@/lib/templates/definition"

/**
 * `lib/templates/composer.ts` — the exact-string half.
 *
 * The exhaustive claim about this module is design.md's **Property 10**, in
 * `composer.property.test.ts`: confinement, refusal-safety, announcement
 * arithmetic and structural legality over generated trees and generated action
 * sequences. That property deliberately re-derives an announcement's position
 * and total from the resulting tree rather than trusting the sentence, which is
 * the right way to check the *arithmetic* and the wrong way to check the
 * *wording*.
 *
 * So the wording lives here, spelled out character for character —
 * `"KPI row moved to position 3 of 7"` and
 * `"Resource table moved to position 2 of 4 in column 1 of 2"` are the two
 * sentences design.md quotes, and a regex that matched them both would also
 * match a sentence with the label missing. Same for the sixteen labels and for
 * the fresh-block defaults, both of which are exhaustive facts about a fixed
 * set rather than properties over a generated one.
 */

// --- Fixtures ---------------------------------------------------------------

function leaf(id: string, type: Exclude<BlockType, "row">): LeafBlock {
  return { id, type, config: {} }
}

function row(id: string, columns: readonly (readonly LeafBlock[])[]): RowBlock {
  return { id, type: "row", columns }
}

function stateOf(
  blocks: readonly TemplateBlock[],
  selectedBlockId: string | null = null
): ComposerState {
  return { blocks, selectedBlockId }
}

/**
 * Seven top-level positions, so design.md's `"… position 3 of 7"` is reachable
 * exactly as written, with the third of them a row whose first column holds four
 * children so `"… position 2 of 4 in column 1 of 2"` is too.
 */
function sevenPositionState(): ComposerState {
  return stateOf([
    leaf("t1", "cover"),
    leaf("t2", "heading"),
    leaf("t3", "kpi_row"),
    row("t4", [
      [
        leaf("c1", "rich_text"),
        leaf("c2", "page_break"),
        leaf("c3", "resource_table"),
        leaf("c4", "gaps_and_coverage"),
      ],
      [leaf("d1", "verification_record")],
    ]),
    leaf("t5", "distribution_chart"),
    leaf("t6", "appendix_methodology"),
    leaf("t7", "comparison_delta"),
  ])
}

// --- Labels ----------------------------------------------------------------

describe("Requirement 12.5 — every declared block type has a human label", () => {
  test("all sixteen types are labelled and no label is missing", () => {
    // `satisfies Record<BlockType, string>` already makes an omission a compile
    // error; this asserts the runtime object matches the vocabulary too, so a
    // label map that drifted from BLOCK_TYPES by a rename fails here rather
    // than announcing a raw snake_case type to a screen reader.
    expect(Object.keys(BLOCK_TYPE_LABELS).sort()).toEqual(
      [...BLOCK_TYPES].sort()
    )

    for (const type of BLOCK_TYPES) {
      const label = BLOCK_TYPE_LABELS[type]
      expect(label.length, `${type} has an empty label`).toBeGreaterThan(0)
      expect(label, `${type}'s label is still snake_case`).not.toMatch(/_/)
    }
  })

  test("the labels design.md quotes are exactly those two strings", () => {
    expect(BLOCK_TYPE_LABELS.kpi_row).toBe("KPI row")
    expect(BLOCK_TYPE_LABELS.resource_table).toBe("Resource table")
  })

  test("an undeclared type falls back to its own name rather than to blank", () => {
    expect(blockTypeLabel("not_a_block")).toBe("not_a_block")
  })
})

// --- Announcement wording --------------------------------------------------

describe("Requirements 12.5, 12.7 — the announcement is the sentence design.md declares", () => {
  test("a top-level move announces position and container total", () => {
    // `t2` at index 1 nudged to index 2 is the 3rd of 7.
    const result = reduce(sevenPositionState(), {
      kind: "nudge",
      blockId: "t3",
      delta: -1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Nudging t3 (index 2) toward the start lands it at index 1 → position 2.
    expect(result.announcement).toBe("KPI row moved to position 2 of 7")
  })

  test("the exact sentence design.md quotes, character for character", () => {
    // A `kpi_row` at index 3 of seven top-level blocks, nudged toward the start,
    // lands at index 2 — the 3rd of 7. Design.md's first quoted sentence.
    const state = stateOf([
      leaf("a", "cover"),
      leaf("b", "cover"),
      leaf("c", "cover"),
      leaf("d", "kpi_row"),
      leaf("e", "cover"),
      leaf("f", "cover"),
      leaf("g", "cover"),
    ])
    const moved = reduce(state, { kind: "nudge", blockId: "d", delta: -1 })
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(moved.announcement).toBe("KPI row moved to position 3 of 7")
  })

  test("a move inside a row names the column and the column count", () => {
    // `c3` is the `resource_table` at index 2 of a four-child column; nudged
    // toward the start it lands at index 1 → position 2 of 4 in column 1 of 2.
    // Design.md's second quoted sentence.
    const result = reduce(sevenPositionState(), {
      kind: "nudge",
      blockId: "c3",
      delta: -1,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.announcement).toBe(
      "Resource table moved to position 2 of 4 in column 1 of 2"
    )
  })

  test("an insert, a selection and a removal each announce once", () => {
    const inserted = reduce(sevenPositionState(), {
      kind: "insert",
      blockType: "heading",
      at: { container: { kind: "root" }, index: 0 },
    })
    expect(inserted.ok).toBe(true)
    if (!inserted.ok) return
    expect(inserted.announcement).toBe("Heading inserted at position 1 of 8")

    const selected = reduce(sevenPositionState(), {
      kind: "select",
      blockId: "d1",
    })
    expect(selected.ok).toBe(true)
    if (!selected.ok) return
    expect(selected.announcement).toBe(
      "Verification record selected at position 1 of 1 in column 2 of 2"
    )

    const cleared = reduce(sevenPositionState(), {
      kind: "select",
      blockId: null,
    })
    expect(cleared.ok).toBe(true)
    if (!cleared.ok) return
    expect(cleared.announcement).toBe("Selection cleared")

    const removed = reduce(sevenPositionState(), {
      kind: "remove",
      blockId: "c3",
    })
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.announcement).toBe(
      "Resource table removed from column 1 of 2, which now holds 3 blocks"
    )
  })
})

// --- Requirement 12.12: the boundary refusal -------------------------------

describe("Requirement 12.12 — a boundary refuses and says which end", () => {
  test("the first and last of the top-level sequence", () => {
    const state = sevenPositionState()

    const first = reduce(state, { kind: "nudge", blockId: "t1", delta: -1 })
    expect(first.ok).toBe(false)
    if (first.ok) return
    expect(first.refusal.code).toBe("already_first")
    expect(first.refusal.message).toBe(
      "Cover already occupies the first position of the top-level sequence"
    )
    // The refusal branch carries the input object itself, and no announcement.
    expect(first.state).toBe(state)
    expect(Object.hasOwn(first, "announcement")).toBe(false)

    const last = reduce(state, { kind: "nudge", blockId: "t7", delta: 1 })
    expect(last.ok).toBe(false)
    if (last.ok) return
    expect(last.refusal.code).toBe("already_last")
    expect(last.refusal.message).toBe(
      "Comparison delta already occupies the last position of the top-level sequence"
    )
  })

  test("the first and last of a row column, and the only block in a column", () => {
    const state = sevenPositionState()

    const first = reduce(state, { kind: "nudge", blockId: "c1", delta: -1 })
    expect(first.ok).toBe(false)
    if (first.ok) return
    expect(first.refusal.message).toBe(
      "Rich text already occupies the first position of column 1 of 2"
    )

    const last = reduce(state, { kind: "nudge", blockId: "c4", delta: 1 })
    expect(last.ok).toBe(false)
    if (last.ok) return
    expect(last.refusal.code).toBe("already_last")

    // The only block in a column is simultaneously the first and the last, so
    // both directions refuse — and neither escapes into the sibling column or
    // into the top-level sequence, which is what a flattened index would do.
    const onlyUp = reduce(state, { kind: "nudge", blockId: "d1", delta: -1 })
    const onlyDown = reduce(state, { kind: "nudge", blockId: "d1", delta: 1 })
    expect(onlyUp.ok).toBe(false)
    expect(onlyDown.ok).toBe(false)
    if (onlyUp.ok || onlyDown.ok) return
    expect(onlyUp.refusal.code).toBe("already_first")
    expect(onlyDown.refusal.code).toBe("already_last")
    expect(flattenBlockIds(onlyDown.state.blocks)).toEqual(
      flattenBlockIds(state.blocks)
    )
  })
})

// --- Requirements 12.9, 12.14: a row holds no row --------------------------

describe("Requirements 6.4, 12.9, 12.14 — one cause, one refusal, two renderings", () => {
  const state = stateOf([
    row("r1", [[leaf("x", "cover")], []]),
    row("r2", [[], []]),
    leaf("t", "heading"),
  ])

  test("moving a row into a row column is refused, with the order unchanged", () => {
    const action = {
      kind: "move" as const,
      blockId: "r1",
      to: {
        container: { kind: "row" as const, rowId: "r2", columnIndex: 0 },
        index: 0,
      },
    }

    const result = reduce(state, action)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe("row_holds_no_row")
    expect(result.refusal.message).toMatch(/a row holds no row/i)
    expect(result.state).toBe(state)
    expect(flattenBlockIds(result.state.blocks)).toEqual(["r1", "x", "r2", "t"])

    // The pointer path gets the identical value mid-drag, without dispatching.
    expect(refusalFor(action, state)).toEqual(result.refusal)
  })

  test("inserting a row from the palette into a row column is refused the same way", () => {
    const action = {
      kind: "insert" as const,
      blockType: "row" as const,
      at: {
        container: { kind: "row" as const, rowId: "r1", columnIndex: 1 },
        index: 0,
      },
    }
    expect(refusalFor(action, state)?.code).toBe("row_holds_no_row")
  })

  test("splitting a block that already sits in a row column is refused the same way", () => {
    expect(
      refusalFor({ kind: "splitRow", blockId: "x", columns: 2 }, state)?.code
    ).toBe("row_holds_no_row")
  })
})

// --- Bounds ----------------------------------------------------------------

describe("Requirements 6.2, 6.3 — every reachable state stays inside the bounds", () => {
  test("a ninth child is refused rather than accepted", () => {
    const full = Array.from(
      { length: MAX_CHILDREN_PER_COLUMN },
      (_unused, index) => leaf(`k${index}`, "page_break")
    )
    const state = stateOf([row("r", [full, []])])

    const result = reduce(state, {
      kind: "insert",
      blockType: "heading",
      at: { container: { kind: "row", rowId: "r", columnIndex: 0 }, index: 0 },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe("column_full")
  })

  test("a 201st block is refused rather than accepted", () => {
    const state = stateOf(
      Array.from({ length: MAX_BLOCKS_TOTAL }, (_unused, index) =>
        leaf(`k${index}`, "page_break")
      )
    )
    expect(countBlocks(state.blocks)).toBe(MAX_BLOCKS_TOTAL)

    const result = reduce(state, {
      kind: "insert",
      blockType: "heading",
      at: { container: { kind: "root" }, index: 0 },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe("definition_full")
  })

  test("narrowing a row refuses rather than silently dropping a column's blocks", () => {
    const state = stateOf([row("r", [[], [], [leaf("keep", "cover")]])])
    const result = reduce(state, { kind: "splitRow", blockId: "r", columns: 2 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe("column_not_empty")
    expect(findChild(result.state.blocks, "keep")).toBe(true)
  })

  test("widening a row appends an empty column and keeps every child", () => {
    const state = stateOf([
      row("r", [[leaf("a", "cover")], [leaf("b", "cover")]]),
    ])
    const result = reduce(state, { kind: "splitRow", blockId: "r", columns: 3 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const grown = result.state.blocks[0] as RowBlock
    expect(grown.columns.length).toBe(3)
    expect(grown.columns[2]).toEqual([])
    expect(flattenBlockIds(result.state.blocks)).toEqual(["r", "a", "b"])
    expect(result.announcement).toBe("Row now holds 3 columns")
  })
})

function findChild(blocks: readonly TemplateBlock[], id: string): boolean {
  return flattenBlockIds(blocks).includes(id)
}

// --- Fresh blocks ----------------------------------------------------------

describe("Requirements 6.2, 6.7, 6.9 — a freshly inserted block is legal on arrival", () => {
  test("every required config field of every declared type has a default", () => {
    // The reducer builds a fresh block's config from BLOCK_CONFIG's `required`
    // list. A required field with no declared default would produce a block the
    // Template_Validator rejects for a missing field the composer could have
    // filled — so this is asserted over the whole vocabulary, not sampled.
    const missing: string[] = []

    for (const type of BLOCK_TYPES) {
      if (type === "row") continue
      const result = reduce(stateOf([]), {
        kind: "insert",
        blockType: type,
        at: { container: { kind: "root" }, index: 0 },
      })
      expect(result.ok, `inserting a ${type} was refused`).toBe(true)
      if (!result.ok) continue

      const inserted = result.state.blocks[0] as LeafBlock
      for (const field of BLOCK_CONFIG[type].required) {
        if (!(field in inserted.config)) missing.push(`${type}.${field}`)
      }
    }

    expect(missing).toEqual([])
  })

  test("a fresh row arrives with two empty columns and counts as one block", () => {
    const result = reduce(stateOf([]), {
      kind: "insert",
      blockType: "row",
      at: { container: { kind: "root" }, index: 0 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const inserted = result.state.blocks[0] as RowBlock
    expect(inserted.columns).toEqual([[], []])
    expect(countBlocks(result.state.blocks)).toBe(1)
  })

  test("the id generator is a pure function of the state and skips taken ids", () => {
    const state = stateOf([
      leaf("block-1", "cover"),
      row("block-3", [[leaf("block-2", "cover")], []]),
    ])
    expect(freshBlockId(state)).toBe("block-4")
    expect(freshBlockId(state)).toBe("block-4")
  })

  test("an injected generator that collides is refused rather than duplicating an id", () => {
    // Requirement 6.7 — a duplicate id is a definition-level rejection, so the
    // composer refuses to create one even when the caller hands it one.
    const state = stateOf([leaf("taken", "cover")])
    const options = { generateId: () => "taken" }
    const action = {
      kind: "insert" as const,
      blockType: "heading" as const,
      at: { container: { kind: "root" as const }, index: 0 },
    }

    expect(reduce(state, action, options).ok).toBe(false)
    expect(refusalFor(action, state, options)?.code).toBe(
      "unusable_generated_id"
    )
  })

  test("insertion selects the new block, so the next nudge acts on it (Req 12.3)", () => {
    const result = reduce(stateOf([leaf("a", "cover")], "a"), {
      kind: "insert",
      blockType: "heading",
      at: { container: { kind: "root" }, index: 1 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.selectedBlockId).toBe("block-1")
    expect(locateBlock(result.state.blocks, "block-1")?.index).toBe(1)
  })
})

// --- Selection and configuration ------------------------------------------

describe("Requirements 12.4, 12.10 — selection survives a move and a removal cleans up", () => {
  test("a nudge keeps the selection on the nudged block", () => {
    const state = sevenPositionState()
    const selected = reduce(state, { kind: "select", blockId: "t3" })
    expect(selected.ok).toBe(true)
    if (!selected.ok) return

    const nudged = reduce(selected.state, {
      kind: "nudge",
      blockId: "t3",
      delta: 1,
    })
    expect(nudged.ok).toBe(true)
    if (!nudged.ok) return
    expect(nudged.state.selectedBlockId).toBe("t3")
  })

  test("removing a row clears a selection pointing at one of its children", () => {
    const state = stateOf([row("r", [[leaf("child", "cover")], []])], "child")
    const result = reduce(state, { kind: "remove", blockId: "r" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.selectedBlockId).toBe(null)
    expect(result.state.blocks).toEqual([])
  })

  test("a config patch merges declared fields and refuses undeclared ones", () => {
    const state = stateOf([
      { id: "h", type: "heading", config: { level: 2, text: "One" } },
    ])

    const patched = reduce(state, {
      kind: "patchConfig",
      blockId: "h",
      config: { text: "Two" },
    })
    expect(patched.ok).toBe(true)
    if (!patched.ok) return
    expect((patched.state.blocks[0] as LeafBlock).config).toEqual({
      level: 2,
      text: "Two",
    })
    expect(patched.announcement).toBe("Heading settings updated")

    // The line this reducer draws: undeclared *field names* are refused here,
    // because they are the case the composer can name immediately (Req 6.9).
    // A declared field's *value* type is the Template_Validator's business, and
    // is deliberately not re-checked — one schema, not two.
    expect(
      refusalFor(
        { kind: "patchConfig", blockId: "h", config: { nope: 1 } },
        state
      )?.code
    ).toBe("invalid_config")
    expect(
      reduce(state, {
        kind: "patchConfig",
        blockId: "h",
        config: { level: "not a number" },
      }).ok
    ).toBe(true)

    expect(
      refusalFor({ kind: "patchConfig", blockId: "h", config: null }, state)
        ?.code
    ).toBe("invalid_config")
  })

  test("a row has no config to patch", () => {
    const state = stateOf([row("r", [[], []])])
    expect(
      refusalFor({ kind: "patchConfig", blockId: "r", config: {} }, state)?.code
    ).toBe("row_has_no_config")
  })
})

// --- Unknown ids ----------------------------------------------------------

describe("an action naming a block that is not there is refused, never ignored", () => {
  test.each([
    ["nudge", { kind: "nudge" as const, blockId: "ghost", delta: 1 as const }],
    [
      "move",
      {
        kind: "move" as const,
        blockId: "ghost",
        to: { container: { kind: "root" as const }, index: 0 },
      },
    ],
    ["remove", { kind: "remove" as const, blockId: "ghost" }],
    ["select", { kind: "select" as const, blockId: "ghost" }],
    [
      "splitRow",
      { kind: "splitRow" as const, blockId: "ghost", columns: 2 as const },
    ],
    [
      "patchConfig",
      { kind: "patchConfig" as const, blockId: "ghost", config: {} },
    ],
  ])("%s refuses with unknown_block", (_name, action) => {
    const state = sevenPositionState()
    const result = reduce(state, action)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe("unknown_block")
    expect(result.state).toBe(state)
  })

  test("an insertion point naming a row that is not there is refused", () => {
    const state = sevenPositionState()
    expect(
      refusalFor(
        {
          kind: "insert",
          blockType: "heading",
          at: {
            container: { kind: "row", rowId: "ghost", columnIndex: 0 },
            index: 0,
          },
        },
        state
      )?.code
    ).toBe("unknown_insertion_point")

    // A leaf is not a container, so naming one as a row is the same refusal.
    expect(
      refusalFor(
        {
          kind: "insert",
          blockType: "heading",
          at: {
            container: { kind: "row", rowId: "t1", columnIndex: 0 },
            index: 0,
          },
        },
        state
      )?.code
    ).toBe("unknown_insertion_point")

    // A column index past the row's column count, likewise.
    expect(
      refusalFor(
        {
          kind: "insert",
          blockType: "heading",
          at: {
            container: { kind: "row", rowId: "t4", columnIndex: 2 },
            index: 0,
          },
        },
        state
      )?.code
    ).toBe("unknown_insertion_point")
  })
})

// --- Move index semantics -------------------------------------------------

describe("Requirement 12.6 — a move reads its index against the destination after the lift", () => {
  test("moving one place later within the top-level sequence", () => {
    const state = stateOf([
      leaf("a", "cover"),
      leaf("b", "cover"),
      leaf("c", "cover"),
    ])
    const result = reduce(state, {
      kind: "move",
      blockId: "a",
      to: { container: { kind: "root" }, index: 1 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(flattenBlockIds(result.state.blocks)).toEqual(["b", "a", "c"])
  })

  test("moving a child out of a row column into the top-level sequence", () => {
    const state = stateOf([
      row("r", [[leaf("x", "cover")], []]),
      leaf("t", "cover"),
    ])
    const result = reduce(state, {
      kind: "move",
      blockId: "x",
      to: { container: { kind: "root" }, index: 2 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(flattenBlockIds(result.state.blocks)).toEqual(["r", "t", "x"])
    expect(locateBlock(result.state.blocks, "x")?.container).toEqual({
      kind: "root",
    })
  })

  test("an index past the end of the destination is refused, not clamped", () => {
    // Two blocks, so lifting `a` leaves one; the admissible indices are 0 and 1
    // — 1 being "after the block that stayed". Index 2 is off the end.
    const state = stateOf([leaf("a", "cover"), leaf("b", "cover")])
    expect(
      refusalFor(
        {
          kind: "move",
          blockId: "a",
          to: { container: { kind: "root" }, index: 1 },
        },
        state
      )
    ).toBe(null)
    expect(
      refusalFor(
        {
          kind: "move",
          blockId: "a",
          to: { container: { kind: "root" }, index: 2 },
        },
        state
      )?.code
    ).toBe("position_out_of_range")
  })
})
