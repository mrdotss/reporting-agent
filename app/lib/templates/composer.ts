/**
 * The composer reducer — the one place every canvas operation is expressed
 * (Requirements 12.3, 12.4, 12.5, 12.6, 12.7, 12.9, 12.12, 12.13, 12.14, 6.3,
 * 6.4, 6.7).
 *
 * **Pure. No React, no DOM, no dnd-kit.** This module imports nothing but the
 * block vocabulary and the definition's own bounds. It never reads `document`,
 * `window`, a clock, or `crypto`. That is not tidiness: it is what makes the
 * `aria-live` sentence a unit-testable value rather than a side effect of a
 * component render, and it is what lets one property (design.md's Property 10)
 * cover both input paths at once.
 *
 * ## Why a reducer at all, when dnd-kit is already installed
 *
 * dnd-kit drives the **pointer** path. It does not drive the keyboard path —
 * design.md's "dnd-kit for the pointer, a pure reducer for the keyboard"
 * decision explains why (Requirement 12.4 describes a *command*, `Mod`+Arrow
 * moving one position within a container, not a lift-move-drop gesture; and
 * bare arrows during a lift are the pattern that fails with a screen reader
 * on). So both paths dispatch the identical {@link ComposerAction} into
 * {@link reduce}, and there is exactly one implementation of every rule.
 *
 * ## The three shapes of that signature that *are* the accessibility design
 *
 * 1. **`announcement` is produced here, not by the component.** Exactly one
 *    string per completed action, because a result carries exactly one
 *    (Requirement 12.5's "exactly one announcement per completed move"). The
 *    refusal branch carries **no `announcement` key at all** — a refusal is
 *    announced through {@link Refusal.message}, so the invariant is "one
 *    result, one string", and an announcer that fired on both paths for one
 *    move would be visible in the type.
 * 2. **A refusal is a value, never a silent no-op.** {@link reduce} returns the
 *    **same state object by reference identity** on refusal, so a caller can
 *    assert `result.state === input`. The {@link Refusal} carries a
 *    machine-readable {@link RefusalCode} plus the human sentence, and the UI
 *    renders one cause two ways: a blocked cursor plus the hint for the pointer
 *    (Requirement 12.9), the same sentence through the `polite` region for the
 *    keyboard (Requirement 12.14). One cause, one `Refusal`, two renderings —
 *    there is no second implementation of the rule to drift.
 * 3. **`nudge` is confined to the container the block already occupies.** The
 *    reducer resolves that container *from the block id* ({@link locateBlock}),
 *    reads only that one list, and writes only that one list. A nudge therefore
 *    **cannot** move a block out of a row column, and at a container boundary it
 *    refuses with the first/last sentence (Requirement 12.12) rather than
 *    clamping silently or overflowing into the top-level sequence.
 *
 * The third point is the whole reason this module is worth a property. The
 * obvious implementation flattens the tree to a list, finds the block's index in
 * that flat list, and swaps with its neighbour — and it works perfectly until a
 * keyboard user nudges the last child of a row column, at which point the block
 * teleports out of the row into the top-level sequence. It is the single most
 * likely defect here and a keyboard user meets it within a minute.
 *
 * ## `refusalFor` exists because the pointer needs the refusal *during* the drag
 *
 * Requirement 12.9 asks for a blocked cursor and the "a row holds no row" hint
 * **while** a row is dragged over a row column, before any drop happens. That is
 * the same predicate {@link reduce} applies at commit time, so it is exposed
 * separately rather than duplicated: {@link refusalFor} and {@link reduce} both
 * call one private `plan()`, so their agreement is **structural**. If
 * `refusalFor` returns non-null, `reduce` refuses with that identical refusal,
 * and vice versa — and the property asserts it on every generated pair anyway,
 * because a drag preview that disagrees with the drop is worse than no preview.
 *
 * ## Where validation stops
 *
 * Every reachable state is **structurally** legal for
 * `lib/templates/definition.ts`: one level of nesting (6.4), unique ids (6.7),
 * at most {@link MAX_BLOCKS_TOTAL} blocks counting rows and their children
 * (6.3), 2–3 columns per row and at most {@link MAX_CHILDREN_PER_COLUMN}
 * children per column (6.2), ids within
 * {@link BLOCK_ID_MIN_LENGTH}–{@link BLOCK_ID_MAX_LENGTH}, and only declared
 * block types (6.9).
 *
 * It does **not** re-implement config validation. `patchConfig` refuses a
 * non-object patch, an `undefined` value, and a field name the type's
 * {@link BLOCK_CONFIG} schema does not declare — the three checks that would
 * otherwise let the composer build a tree the `Template_Validator` rejects for a
 * reason the composer could have named immediately. It does not check a config
 * *value's* type, range, or enum membership: that is one schema's job, it is
 * already written, and a second copy of it here is exactly the kind of duplicate
 * that drifts. The wizard runs `collectDefinitionIssues` over the whole
 * definition before a save either way.
 *
 * ## The label map lives here, not in `blocks.ts`
 *
 * Requirement 12.5's announcement needs `kpi_row` → `"KPI row"`. That map is
 * **not** in `blocks.ts`, for two reasons. `blocks.ts` is mirrored to
 * `agent/src/reporting_agent/compile/definition.py` between sentinels, and
 * `test/mirror.static.test.ts` compares the sentinel regions' quoted strings —
 * a label map inside a sentinel region would have to be mirrored into Python
 * for no reason, and one outside them would sit in a file whose own docstring
 * states it exports only the three mirrored values. And the labels are a
 * **presentation** concern of the composer's announcements, not part of the
 * save/compile contract: the agent never reads them. {@link BLOCK_TYPE_LABELS}
 * is `satisfies Record<BlockType, string>`, so a seventeenth block type fails
 * to compile until it has a label.
 */

import {
  BLOCK_CONFIG,
  BLOCK_TYPES,
  type BlockType,
} from "@/lib/templates/blocks"
import {
  BLOCK_ID_MAX_LENGTH,
  BLOCK_ID_MIN_LENGTH,
  MAX_BLOCKS_TOTAL,
  MAX_CHILDREN_PER_COLUMN,
  MAX_ROW_COLUMNS,
  MIN_ROW_COLUMNS,
  type LeafBlock,
  type RowBlock,
  type TemplateBlock,
} from "@/lib/templates/definition"

// --- Labels (Requirement 12.5) ---------------------------------------------

/**
 * The human label every announcement names a block by.
 *
 * Sentence case, not title case, because these are read aloud mid-sentence:
 * "Resource table moved to position 2 of 4". `top_n_table` keeps its hyphen
 * ("Top-N table") because that is how the palette names it and a screen reader
 * reads "Top-N" as two syllables rather than spelling it.
 */
export const BLOCK_TYPE_LABELS = {
  cover: "Cover",
  executive_summary: "Executive summary",
  kpi_row: "KPI row",
  resource_table: "Resource table",
  top_n_table: "Top-N table",
  timeseries_chart: "Time-series chart",
  distribution_chart: "Distribution chart",
  capacity_vs_usage: "Capacity vs usage",
  gaps_and_coverage: "Gaps and coverage",
  comparison_delta: "Comparison delta",
  verification_record: "Verification record",
  appendix_methodology: "Methodology appendix",
  row: "Row",
  page_break: "Page break",
  heading: "Heading",
  rich_text: "Rich text",
  historical_trend: "Historical trend",
} as const satisfies Record<BlockType, string>

/** The label for `type`, or the raw type for an undeclared one. */
export function blockTypeLabel(type: string): string {
  return (BLOCK_TYPE_LABELS as Record<string, string>)[type] ?? type
}

// --- Default config for a freshly inserted block ---------------------------

/**
 * The value a newly inserted block's required config field starts at, keyed by
 * **field name** rather than by block type, so the defaults follow
 * {@link BLOCK_CONFIG} rather than restating it. `composer.test.ts` asserts
 * every required field of every declared type is covered here.
 *
 * Empty rather than plausible, deliberately. A fresh `kpi_row` carries
 * `metrics: []`, not a guessed metric name: the reducer has no Metric_Catalog
 * and inventing `"Percentage CPU"` here would put a metric into a definition
 * that the run may not collect (Requirement 5.3). The inspector fills these in;
 * an unconfigured block is an honest state and the wizard's own validation is
 * what refuses to *save* one that still needs a value.
 */
const DEFAULT_CONFIG_VALUES: Readonly<Record<string, unknown>> = {
  metrics: [],
  columns: [],
  order_by: "",
  capacity_metric: "",
  usage_metric: "",
  run_a: "",
  run_b: "",
  level: 2,
  text: "",
}

function defaultConfigFor(
  type: Exclude<BlockType, "row">
): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const field of BLOCK_CONFIG[type].required) {
    config[field] = DEFAULT_CONFIG_VALUES[field] ?? ""
  }
  return config
}

// --- State, containers, insertion points -----------------------------------

/**
 * The composer's whole state: the block tree in document order, plus the
 * selection.
 *
 * `blocks` is the definition's own `blocks` list, not a flattened or indexed
 * copy of it — Requirement 6.3 is explicit that list order *is* document order
 * and that no other ordering or index field is read, so there is nothing else
 * to hold. The rest of a `TemplateDefinition` (identity, scope, period,
 * metrics, design) is owned by the other wizard steps and is untouched by every
 * action here.
 */
export type ComposerState = {
  readonly blocks: readonly TemplateBlock[]
  readonly selectedBlockId: string | null
}

/** The top-level sequence. */
export type RootContainer = { readonly kind: "root" }

/** One column of one row — the only other container the grammar admits. */
export type RowColumnContainer = {
  readonly kind: "row"
  readonly rowId: string
  readonly columnIndex: number
}

export type ContainerRef = RootContainer | RowColumnContainer

export const ROOT_CONTAINER: RootContainer = { kind: "root" }

/**
 * Where a block goes: a container plus a 1-based-on-display, 0-based-here
 * index.
 *
 * `index` is the position in the **destination list as it will be after the
 * move** — so moving a block one place later within its own container is
 * `index === currentIndex + 1`, not `+ 2`. Stated explicitly because the
 * off-by-one is invisible in a passing test that only ever moves between
 * containers.
 */
export type InsertionPoint = {
  readonly container: ContainerRef
  readonly index: number
}

/** Where a block currently is, and how big its container is. */
export type BlockLocation = {
  readonly container: ContainerRef
  readonly index: number
  /** Blocks in that container, including this one. */
  readonly total: number
  /** The row's column count, or `null` at the top level. */
  readonly columnCount: number | null
}

// --- Actions and results ---------------------------------------------------

export type ComposerAction =
  | {
      readonly kind: "insert"
      readonly blockType: BlockType
      readonly at: InsertionPoint
    }
  | {
      readonly kind: "move"
      readonly blockId: string
      readonly to: InsertionPoint
    }
  /** Requirement 12.4 — `Mod`+ArrowUp is `-1`, `Mod`+ArrowDown is `+1`. */
  | { readonly kind: "nudge"; readonly blockId: string; readonly delta: -1 | 1 }
  | { readonly kind: "remove"; readonly blockId: string }
  | { readonly kind: "select"; readonly blockId: string | null }
  | {
      readonly kind: "splitRow"
      readonly blockId: string
      readonly columns: 2 | 3
    }
  | {
      readonly kind: "patchConfig"
      readonly blockId: string
      readonly config: unknown
    }

export type RefusalCode =
  /** No block in the tree carries that id. */
  | "unknown_block"
  /** Requirements 6.4, 12.9, 12.14 — one level of nesting only. */
  | "row_holds_no_row"
  /** Requirement 12.12 — a nudge toward the start of the container's first position. */
  | "already_first"
  /** Requirement 12.12 — a nudge toward the end of the container's last position. */
  | "already_last"
  /** The insertion point names a row or column that does not exist. */
  | "unknown_insertion_point"
  /** The insertion index is outside the destination list. */
  | "position_out_of_range"
  /** Requirement 6.2 — a column already holds `MAX_CHILDREN_PER_COLUMN` children. */
  | "column_full"
  /** Requirement 6.3 — the definition already holds `MAX_BLOCKS_TOTAL` blocks. */
  | "definition_full"
  /** Requirement 6.9 — not one of the sixteen declared types. */
  | "unknown_block_type"
  /** Requirement 6.2 — a row declares 2 or 3 columns. */
  | "invalid_column_count"
  /** Narrowing a row would drop a column that still holds blocks. */
  | "column_not_empty"
  /** A row carries its columns on the block, not a config (Requirement 6.2). */
  | "row_has_no_config"
  /** The patch is not an object, carries `undefined`, or names an undeclared field. */
  | "invalid_config"
  /** The id generator produced an unusable or already-taken id. */
  | "unusable_generated_id"

/**
 * One cause, rendered two ways (Requirements 12.9, 12.14).
 *
 * `code` is what a component switches on to choose a cursor or an icon;
 * `message` is the sentence, and it is the **same** sentence on both paths — the
 * pointer shows it as the hint beside the blocked cursor, the keyboard sends it
 * through the `polite` region. There is deliberately no second, shorter string
 * for the pointer: two strings for one cause is two places to change and one
 * place to forget.
 */
export type Refusal = {
  readonly code: RefusalCode
  readonly message: string
  /** The block the refusal is about, when the action named one. */
  readonly blockId?: string
}

export type ComposerResult =
  | {
      readonly ok: true
      readonly state: ComposerState
      readonly announcement: string
    }
  /** `state` is the input object, by reference identity. */
  | {
      readonly ok: false
      readonly state: ComposerState
      readonly refusal: Refusal
    }

/**
 * How a fresh block's id is produced.
 *
 * `generateId` **must be a pure function of the state**, because
 * {@link refusalFor} calls it too — the pointer path needs to know mid-drag
 * whether a drop would be refused, and one of the refusals is "the generated id
 * is unusable". A counter-based generator that advanced on every call would make
 * `refusalFor` observable, and a preview with a side effect is a bug waiting for
 * a re-render. The default, {@link freshBlockId}, derives the id from the ids
 * already in the tree, so it is pure by construction and needs no `crypto`,
 * which keeps this module importable from a client component in any context.
 */
export type ComposerOptions = {
  readonly generateId?: (state: ComposerState) => string
}

// --- Reading the tree ------------------------------------------------------

function isRow(block: TemplateBlock): block is RowBlock {
  return block.type === "row"
}

/**
 * Every block id in **document order**: each top-level block, and immediately
 * after a row, that row's children column by column, in list order
 * (Requirement 12.6). This is the order the canvas renders in and the order the
 * document emits, which is the same claim stated twice.
 */
export function flattenBlockIds(blocks: readonly TemplateBlock[]): string[] {
  const ids: string[] = []
  for (const block of blocks) {
    ids.push(block.id)
    if (isRow(block)) {
      for (const column of block.columns) {
        for (const child of column) ids.push(child.id)
      }
    }
  }
  return ids
}

/** Every block, rows and their children alike (Requirement 6.3's count). */
export function countBlocks(blocks: readonly TemplateBlock[]): number {
  return flattenBlockIds(blocks).length
}

/** Where `blockId` sits, or `null` when no block carries that id. */
export function locateBlock(
  blocks: readonly TemplateBlock[],
  blockId: string
): BlockLocation | null {
  const topIndex = blocks.findIndex((block) => block.id === blockId)
  if (topIndex !== -1) {
    return {
      container: ROOT_CONTAINER,
      index: topIndex,
      total: blocks.length,
      columnCount: null,
    }
  }

  for (const block of blocks) {
    if (!isRow(block)) continue
    for (
      let columnIndex = 0;
      columnIndex < block.columns.length;
      columnIndex += 1
    ) {
      const column = block.columns[columnIndex]
      const childIndex = column.findIndex((child) => child.id === blockId)
      if (childIndex === -1) continue
      return {
        container: { kind: "row", rowId: block.id, columnIndex },
        index: childIndex,
        total: column.length,
        columnCount: block.columns.length,
      }
    }
  }

  return null
}

/** The block itself, or `null`. */
export function findBlock(
  blocks: readonly TemplateBlock[],
  blockId: string
): TemplateBlock | null {
  for (const block of blocks) {
    if (block.id === blockId) return block
    if (!isRow(block)) continue
    for (const column of block.columns) {
      for (const child of column) if (child.id === blockId) return child
    }
  }
  return null
}

function findRow(
  blocks: readonly TemplateBlock[],
  rowId: string
): RowBlock | null {
  const block = blocks.find((candidate) => candidate.id === rowId)
  return block !== undefined && isRow(block) ? block : null
}

function sameContainer(a: ContainerRef, b: ContainerRef): boolean {
  if (a.kind === "root") return b.kind === "root"
  return (
    b.kind === "row" && a.rowId === b.rowId && a.columnIndex === b.columnIndex
  )
}

/** The list a container holds, or `null` when the container does not exist. */
function readContainer(
  blocks: readonly TemplateBlock[],
  container: ContainerRef
): readonly TemplateBlock[] | null {
  if (container.kind === "root") return blocks
  const row = findRow(blocks, container.rowId)
  if (row === null) return null
  if (container.columnIndex < 0 || container.columnIndex >= row.columns.length)
    return null
  return row.columns[container.columnIndex]
}

/**
 * `blocks` with `container`'s list replaced.
 *
 * The one write path. Every action that changes the tree goes through it, which
 * is why a nudge cannot touch a container other than its own: it reads one list
 * and writes that same list back.
 */
function writeContainer(
  blocks: readonly TemplateBlock[],
  container: ContainerRef,
  next: readonly TemplateBlock[]
): readonly TemplateBlock[] {
  if (container.kind === "root") return next

  return blocks.map((block) => {
    if (block.id !== container.rowId || !isRow(block)) return block
    return {
      ...block,
      columns: block.columns.map((column, index) =>
        index === container.columnIndex
          ? (next as readonly LeafBlock[])
          : column
      ),
    }
  })
}

// --- Ids -------------------------------------------------------------------

/**
 * The lowest unused `block-<n>`.
 *
 * Pure, deterministic, and short enough to satisfy Requirement 6.2's 1–64
 * characters at any reachable `n` (the tree holds at most
 * {@link MAX_BLOCKS_TOTAL} blocks, so the scan terminates within
 * `MAX_BLOCKS_TOTAL + 1` steps). `crypto.randomUUID` would also fit the length
 * bound, but it makes every insertion non-reproducible and forces a secure
 * context; deriving from the state costs nothing and keeps the reducer a
 * function.
 */
export function freshBlockId(state: ComposerState): string {
  const used = new Set(flattenBlockIds(state.blocks))
  for (let n = 1; n <= MAX_BLOCKS_TOTAL + 1; n += 1) {
    const candidate = `block-${n}`
    if (!used.has(candidate)) return candidate
  }
  // Unreachable while the tree respects Requirement 6.3, and a refusal rather
  // than a throw if it ever is not.
  return ""
}

function usableId(state: ComposerState, id: string): boolean {
  if (typeof id !== "string") return false
  if (id.length < BLOCK_ID_MIN_LENGTH || id.length > BLOCK_ID_MAX_LENGTH)
    return false
  return findBlock(state.blocks, id) === null
}

// --- Announcements (Requirements 12.5, 12.7, 12.12, 12.14) ------------------

/**
 * The position clause every completed placement shares: the block's label, what
 * happened, its 1-based position within its container, that container's total,
 * and — only when the block sits in a row — the row's 1-based column number and
 * column count (Requirements 12.5, 12.7).
 *
 * `"KPI row moved to position 3 of 7"`, and inside a row
 * `"Resource table moved to position 2 of 4 in column 1 of 2"`. No trailing
 * period: these are the exact sentences design.md declares, and a screen reader
 * pauses on the region change rather than on punctuation.
 */
function placementSentence(
  label: string,
  verb: string,
  location: BlockLocation
): string {
  const base = `${label} ${verb} position ${location.index + 1} of ${location.total}`
  if (location.container.kind === "root") return base
  return (
    `${base} in column ${location.container.columnIndex + 1} of ` +
    `${location.columnCount ?? "?"}`
  )
}

function containerPhrase(location: BlockLocation): string {
  if (location.container.kind === "root") return "the top-level sequence"
  return `column ${location.container.columnIndex + 1} of ${location.columnCount ?? "?"}`
}

// --- Refusal constructors --------------------------------------------------

const ROW_HOLDS_NO_ROW_MESSAGE =
  "A row holds no row — one level of nesting only"

function refuse(code: RefusalCode, message: string, blockId?: string): Refusal {
  return blockId === undefined ? { code, message } : { code, message, blockId }
}

function unknownBlock(blockId: string): Refusal {
  return refuse(
    "unknown_block",
    `No block on the canvas carries the id "${blockId}"`,
    blockId
  )
}

function rowHoldsNoRow(blockId?: string): Refusal {
  return refuse("row_holds_no_row", ROW_HOLDS_NO_ROW_MESSAGE, blockId)
}

// --- The plan --------------------------------------------------------------

/**
 * The single decision procedure. {@link reduce} and {@link refusalFor} both call
 * it, which is what makes them agree by construction rather than by discipline.
 */
type Plan =
  | {
      readonly ok: true
      readonly state: ComposerState
      readonly announcement: string
    }
  | { readonly ok: false; readonly refusal: Refusal }

function refused(refusal: Refusal): Plan {
  return { ok: false, refusal }
}

/** Validates an insertion point's container, independently of what goes in it. */
function resolveDestination(
  state: ComposerState,
  point: InsertionPoint
): {
  readonly list: readonly TemplateBlock[]
  readonly columnCount: number | null
} | null {
  if (point.container.kind === "root") {
    return { list: state.blocks, columnCount: null }
  }
  const row = findRow(state.blocks, point.container.rowId)
  if (row === null) return null
  if (
    point.container.columnIndex < 0 ||
    point.container.columnIndex >= row.columns.length
  ) {
    return null
  }
  return {
    list: row.columns[point.container.columnIndex],
    columnCount: row.columns.length,
  }
}

function planInsert(
  state: ComposerState,
  action: Extract<ComposerAction, { kind: "insert" }>,
  options: ComposerOptions
): Plan {
  if (!(BLOCK_TYPES as readonly string[]).includes(action.blockType)) {
    return refused(
      refuse(
        "unknown_block_type",
        `"${action.blockType}" is not one of the sixteen declared block types`
      )
    )
  }

  // Requirements 6.4, 12.9 — refused before anything else about the point is
  // considered, so the reason the pointer paints is the reason that matters.
  if (action.blockType === "row" && action.at.container.kind === "row") {
    return refused(rowHoldsNoRow())
  }

  const destination = resolveDestination(state, action.at)
  if (destination === null) {
    return refused(
      refuse(
        "unknown_insertion_point",
        "That insertion point no longer exists on the canvas"
      )
    )
  }

  if (action.at.index < 0 || action.at.index > destination.list.length) {
    return refused(
      refuse(
        "position_out_of_range",
        `Position ${action.at.index + 1} is outside a container holding ` +
          `${destination.list.length} blocks`
      )
    )
  }

  if (countBlocks(state.blocks) + 1 > MAX_BLOCKS_TOTAL) {
    return refused(
      refuse(
        "definition_full",
        `A report holds at most ${MAX_BLOCKS_TOTAL} blocks, counting rows and their children`
      )
    )
  }

  if (
    action.at.container.kind === "row" &&
    destination.list.length + 1 > MAX_CHILDREN_PER_COLUMN
  ) {
    return refused(
      refuse(
        "column_full",
        `A row column holds at most ${MAX_CHILDREN_PER_COLUMN} blocks`
      )
    )
  }

  const id = (options.generateId ?? freshBlockId)(state)
  if (!usableId(state, id)) {
    return refused(
      refuse(
        "unusable_generated_id",
        "Could not mint a unique id for the new block"
      )
    )
  }

  const inserted: TemplateBlock =
    action.blockType === "row"
      ? {
          id,
          type: "row",
          columns: Array.from(
            { length: MIN_ROW_COLUMNS },
            () => [] as readonly LeafBlock[]
          ),
        }
      : {
          id,
          type: action.blockType,
          config: defaultConfigFor(action.blockType),
        }

  const nextList = [...destination.list]
  nextList.splice(action.at.index, 0, inserted)
  const blocks = writeContainer(state.blocks, action.at.container, nextList)

  // Requirement 12.3 — the appended block becomes the selection, so a keyboard
  // user's next nudge acts on what they just inserted.
  const next: ComposerState = { blocks, selectedBlockId: id }
  const location = locateBlock(blocks, id)

  return {
    ok: true,
    state: next,
    announcement: placementSentence(
      blockTypeLabel(action.blockType),
      "inserted at",
      location ?? {
        container: action.at.container,
        index: action.at.index,
        total: nextList.length,
        columnCount: destination.columnCount,
      }
    ),
  }
}

function planMove(
  state: ComposerState,
  action: Extract<ComposerAction, { kind: "move" }>
): Plan {
  const from = locateBlock(state.blocks, action.blockId)
  if (from === null) return refused(unknownBlock(action.blockId))

  const block = findBlock(state.blocks, action.blockId)
  if (block === null) return refused(unknownBlock(action.blockId))

  // Requirements 6.4, 12.14 — the keyboard statement of the pointer's 12.9.
  if (isRow(block) && action.to.container.kind === "row") {
    return refused(rowHoldsNoRow(action.blockId))
  }

  if (resolveDestination(state, action.to) === null) {
    return refused(
      refuse(
        "unknown_insertion_point",
        "That insertion point no longer exists on the canvas",
        action.blockId
      )
    )
  }

  // The index is read against the destination **after** the block is lifted, so
  // a within-container move is off by one otherwise.
  const lifted = removeBlock(state.blocks, action.blockId, from)
  const destination = resolveDestination(
    { ...state, blocks: lifted },
    action.to
  )
  if (destination === null) {
    return refused(
      refuse(
        "unknown_insertion_point",
        "That insertion point no longer exists on the canvas",
        action.blockId
      )
    )
  }

  if (action.to.index < 0 || action.to.index > destination.list.length) {
    return refused(
      refuse(
        "position_out_of_range",
        `Position ${action.to.index + 1} is outside a container holding ` +
          `${destination.list.length} blocks`,
        action.blockId
      )
    )
  }

  if (
    action.to.container.kind === "row" &&
    !sameContainer(from.container, action.to.container) &&
    destination.list.length + 1 > MAX_CHILDREN_PER_COLUMN
  ) {
    return refused(
      refuse(
        "column_full",
        `A row column holds at most ${MAX_CHILDREN_PER_COLUMN} blocks`,
        action.blockId
      )
    )
  }

  const nextList = [...destination.list]
  nextList.splice(action.to.index, 0, block)
  const blocks = writeContainer(lifted, action.to.container, nextList)

  // Requirement 12.4 — selection survives a move.
  const next: ComposerState = { blocks, selectedBlockId: state.selectedBlockId }
  const location = locateBlock(blocks, action.blockId)
  if (location === null) {
    return refused(
      refuse(
        "unknown_insertion_point",
        "That move could not be applied",
        action.blockId
      )
    )
  }

  return {
    ok: true,
    state: next,
    announcement: placementSentence(
      blockTypeLabel(block.type),
      "moved to",
      location
    ),
  }
}

function planNudge(
  state: ComposerState,
  action: Extract<ComposerAction, { kind: "nudge" }>
): Plan {
  const from = locateBlock(state.blocks, action.blockId)
  if (from === null) return refused(unknownBlock(action.blockId))

  const block = findBlock(state.blocks, action.blockId)
  if (block === null) return refused(unknownBlock(action.blockId))

  // The confinement. `list` is the block's own container and the only list this
  // function reads or writes; a flattened index is not even in scope here.
  const list = readContainer(state.blocks, from.container)
  if (list === null) return refused(unknownBlock(action.blockId))

  const target = from.index + action.delta
  const label = blockTypeLabel(block.type)

  if (target < 0) {
    // Requirement 12.12 — a boundary refuses and says so. It does not clamp:
    // a key press that changes nothing and announces nothing reads as a defect.
    return refused(
      refuse(
        "already_first",
        `${label} already occupies the first position of ${containerPhrase(from)}`,
        action.blockId
      )
    )
  }
  if (target > list.length - 1) {
    return refused(
      refuse(
        "already_last",
        `${label} already occupies the last position of ${containerPhrase(from)}`,
        action.blockId
      )
    )
  }

  const nextList = [...list]
  nextList.splice(from.index, 1)
  nextList.splice(target, 0, block)
  const blocks = writeContainer(state.blocks, from.container, nextList)

  const location = locateBlock(blocks, action.blockId)
  if (location === null) {
    return refused(
      refuse("unknown_block", "That nudge could not be applied", action.blockId)
    )
  }

  return {
    ok: true,
    // Requirement 12.4 — focus and selection stay on the nudged block. Focus is
    // the component's business; selection is state, and it is preserved here.
    state: { blocks, selectedBlockId: state.selectedBlockId },
    announcement: placementSentence(label, "moved to", location),
  }
}

/** `blocks` without the block at `location`. */
function removeBlock(
  blocks: readonly TemplateBlock[],
  blockId: string,
  location: BlockLocation
): readonly TemplateBlock[] {
  const list = readContainer(blocks, location.container)
  if (list === null) return blocks
  const nextList = list.filter((candidate) => candidate.id !== blockId)
  return writeContainer(blocks, location.container, nextList)
}

function planRemove(
  state: ComposerState,
  action: Extract<ComposerAction, { kind: "remove" }>
): Plan {
  const from = locateBlock(state.blocks, action.blockId)
  if (from === null) return refused(unknownBlock(action.blockId))

  const block = findBlock(state.blocks, action.blockId)
  if (block === null) return refused(unknownBlock(action.blockId))

  const blocks = removeBlock(state.blocks, action.blockId, from)

  // A removed row takes its children with it, so the selection may have pointed
  // at a block that no longer exists.
  const selectedBlockId =
    state.selectedBlockId !== null &&
    findBlock(blocks, state.selectedBlockId) === null
      ? null
      : state.selectedBlockId

  const remaining = (readContainer(blocks, from.container) ?? []).length

  return {
    ok: true,
    state: { blocks, selectedBlockId },
    announcement:
      `${blockTypeLabel(block.type)} removed from ${containerPhrase(from)}, ` +
      `which now holds ${remaining} blocks`,
  }
}

function planSelect(
  state: ComposerState,
  action: Extract<ComposerAction, { kind: "select" }>
): Plan {
  if (action.blockId === null) {
    return {
      ok: true,
      state: { blocks: state.blocks, selectedBlockId: null },
      announcement: "Selection cleared",
    }
  }

  const location = locateBlock(state.blocks, action.blockId)
  const block = findBlock(state.blocks, action.blockId)
  if (location === null || block === null)
    return refused(unknownBlock(action.blockId))

  return {
    ok: true,
    state: { blocks: state.blocks, selectedBlockId: action.blockId },
    announcement: placementSentence(
      blockTypeLabel(block.type),
      "selected at",
      location
    ),
  }
}

function planSplitRow(
  state: ComposerState,
  action: Extract<ComposerAction, { kind: "splitRow" }>,
  options: ComposerOptions
): Plan {
  if (action.columns < MIN_ROW_COLUMNS || action.columns > MAX_ROW_COLUMNS) {
    return refused(
      refuse(
        "invalid_column_count",
        `A row declares ${MIN_ROW_COLUMNS} or ${MAX_ROW_COLUMNS} columns`,
        action.blockId
      )
    )
  }

  const from = locateBlock(state.blocks, action.blockId)
  if (from === null) return refused(unknownBlock(action.blockId))

  const block = findBlock(state.blocks, action.blockId)
  if (block === null) return refused(unknownBlock(action.blockId))

  // Re-columning an existing row.
  if (isRow(block)) {
    const dropped = block.columns.slice(action.columns)
    if (dropped.some((column) => column.length > 0)) {
      return refused(
        refuse(
          "column_not_empty",
          `Narrowing this row to ${action.columns} columns would drop a column that ` +
            "still holds blocks. Move them first",
          action.blockId
        )
      )
    }

    const columns: readonly (readonly LeafBlock[])[] = Array.from(
      { length: action.columns },
      (_unused, index) => block.columns[index] ?? []
    )
    const blocks = state.blocks.map((candidate) =>
      candidate.id === block.id ? { ...block, columns } : candidate
    )

    return {
      ok: true,
      state: { blocks, selectedBlockId: state.selectedBlockId },
      announcement: `Row now holds ${action.columns} columns`,
    }
  }

  // Splitting a leaf into a row that holds it. A leaf inside a row column
  // cannot be split, because the row it would become is a row inside a row.
  if (from.container.kind === "row") {
    return refused(rowHoldsNoRow(action.blockId))
  }

  if (countBlocks(state.blocks) + 1 > MAX_BLOCKS_TOTAL) {
    return refused(
      refuse(
        "definition_full",
        `A report holds at most ${MAX_BLOCKS_TOTAL} blocks, counting rows and their children`,
        action.blockId
      )
    )
  }

  const rowId = (options.generateId ?? freshBlockId)(state)
  if (!usableId(state, rowId)) {
    return refused(
      refuse(
        "unusable_generated_id",
        "Could not mint a unique id for the new row",
        action.blockId
      )
    )
  }

  const columns: readonly (readonly LeafBlock[])[] = Array.from(
    { length: action.columns },
    (_unused, index) => (index === 0 ? [block as LeafBlock] : [])
  )
  const row: RowBlock = { id: rowId, type: "row", columns }
  const blocks = state.blocks.map((candidate) =>
    candidate.id === block.id ? row : candidate
  )

  const location = locateBlock(blocks, rowId)
  if (location === null) {
    return refused(
      refuse("unknown_block", "That split could not be applied", action.blockId)
    )
  }

  return {
    ok: true,
    state: { blocks, selectedBlockId: rowId },
    announcement: placementSentence(
      `${BLOCK_TYPE_LABELS.row} of ${action.columns} columns`,
      "inserted at",
      location
    ),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function planPatchConfig(
  state: ComposerState,
  action: Extract<ComposerAction, { kind: "patchConfig" }>
): Plan {
  const from = locateBlock(state.blocks, action.blockId)
  if (from === null) return refused(unknownBlock(action.blockId))

  const block = findBlock(state.blocks, action.blockId)
  if (block === null) return refused(unknownBlock(action.blockId))

  if (isRow(block)) {
    return refused(
      refuse(
        "row_has_no_config",
        "A row carries its columns on the block itself and has no config to edit",
        action.blockId
      )
    )
  }

  if (!isPlainObject(action.config)) {
    return refused(
      refuse(
        "invalid_config",
        "A config patch must be an object",
        action.blockId
      )
    )
  }

  const schema = BLOCK_CONFIG[block.type]
  const declared = new Set<string>([
    ...schema.required,
    ...schema.optional,
    ...Object.keys(schema.enums),
  ])

  for (const [key, value] of Object.entries(action.config)) {
    if (!declared.has(key)) {
      return refused(
        refuse(
          "invalid_config",
          `"${blockTypeLabel(block.type)}" declares no setting named "${key}"`,
          action.blockId
        )
      )
    }
    if (value === undefined) {
      return refused(
        refuse(
          "invalid_config",
          `"${key}" cannot be set to nothing; remove the block instead of emptying it`,
          action.blockId
        )
      )
    }
  }

  const patched: LeafBlock = {
    ...block,
    config: { ...block.config, ...action.config },
  }
  const blocks = writeContainer(
    state.blocks,
    from.container,
    (readContainer(state.blocks, from.container) ?? []).map((candidate) =>
      candidate.id === block.id ? patched : candidate
    )
  )

  return {
    ok: true,
    state: { blocks, selectedBlockId: state.selectedBlockId },
    announcement: `${blockTypeLabel(block.type)} settings updated`,
  }
}

function plan(
  state: ComposerState,
  action: ComposerAction,
  options: ComposerOptions
): Plan {
  switch (action.kind) {
    case "insert":
      return planInsert(state, action, options)
    case "move":
      return planMove(state, action)
    case "nudge":
      return planNudge(state, action)
    case "remove":
      return planRemove(state, action)
    case "select":
      return planSelect(state, action)
    case "splitRow":
      return planSplitRow(state, action, options)
    case "patchConfig":
      return planPatchConfig(state, action)
  }
}

// --- The two exports every caller uses -------------------------------------

/**
 * Apply `action`, or refuse it.
 *
 * On success the result carries a **new** state and exactly one
 * `announcement`. On refusal it carries the **input state object itself** —
 * `result.state === state` — and a {@link Refusal}, and **no `announcement`
 * key**, so "one result, one string" holds on both branches and no caller can
 * accidentally announce twice for one gesture.
 *
 * The input state is never mutated.
 */
export function reduce(
  state: ComposerState,
  action: ComposerAction,
  options: ComposerOptions = {}
): ComposerResult {
  const outcome = plan(state, action, options)
  if (outcome.ok) {
    return {
      ok: true,
      state: outcome.state,
      announcement: outcome.announcement,
    }
  }
  return { ok: false, state, refusal: outcome.refusal }
}

/**
 * Whether `action` would be refused, without applying it — so the pointer path
 * can paint a blocked cursor and the "a row holds no row" hint **during** the
 * drag (Requirement 12.9), before a drop exists to refuse.
 *
 * Argument order follows design.md's sketch (`action` first here, `state` first
 * on {@link reduce}); both delegate to one decision procedure, so a non-null
 * return here is exactly the refusal {@link reduce} would produce, and `null`
 * here means {@link reduce} would succeed.
 */
export function refusalFor(
  action: ComposerAction,
  state: ComposerState,
  options: ComposerOptions = {}
): Refusal | null {
  const outcome = plan(state, action, options)
  return outcome.ok ? null : outcome.refusal
}
