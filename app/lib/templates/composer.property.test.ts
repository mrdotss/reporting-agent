import { describe, expect, test } from "vitest"
import fc from "fast-check"

import {
  BLOCK_CONFIG,
  BLOCK_TYPES,
  type BlockType,
} from "@/lib/templates/blocks"
import {
  blockTypeLabel,
  countBlocks,
  findBlock,
  flattenBlockIds,
  locateBlock,
  reduce,
  refusalFor,
  type ComposerAction,
  type ComposerState,
  type ContainerRef,
  type InsertionPoint,
} from "@/lib/templates/composer"
import {
  BLOCK_ID_MAX_LENGTH,
  BLOCK_ID_MIN_LENGTH,
  MAX_BLOCKS_TOTAL,
  MAX_CHILDREN_PER_COLUMN,
  MAX_ROW_COLUMNS,
  MIN_ROW_COLUMNS,
  collectDefinitionIssues,
  type LeafBlock,
  type RowBlock,
  type ScopeSpec,
  type TemplateBlock,
  type TemplateDefinition,
} from "@/lib/templates/definition"

/**
 * **Property 10: the composer reducer is confined, announced and refusal-safe.**
 *
 * **Validates: Requirements 12.4, 12.5, 12.6, 12.12, 12.13, 12.14, 6.3, 45.1,
 * 45.3, 45.4**
 *
 * *For any* composer state and any sequence of composer actions, a nudge moves a
 * block exactly one position within the container it already occupies or refuses
 * at a boundary; a refused action returns the same state object; every completed
 * move produces exactly one announcement whose position and total match the
 * resulting tree; a row is never nested in a row by any action sequence; and the
 * canvas's DOM order always equals the document order the definition declares.
 *
 * ## The defect this exists to kill, and why a unit test would not
 *
 * The obvious `nudge` implementation flattens the tree, finds the block's index
 * in that flat list, and swaps with the neighbour. It is correct for every block
 * in the *middle* of a container — which is every block a hand-written example
 * naturally reaches for — and wrong at exactly the four positions a user meets
 * first: the last child of a row column (the block teleports into the next
 * column, or out of the row entirely into the top-level sequence), the first
 * child of one (it teleports onto the row itself), and both ends of the
 * top-level sequence around a row. A keyboard user hits it within a minute.
 *
 * So the load-bearing assertion here is **not** "the nudged block moved". It is
 * **"no block's container membership changed"**, checked for every block in the
 * tree before and after, on every nudge. A flattened-index nudge fails that
 * assertion the first time the generator lands on a column boundary, and the
 * generator lands there constantly because rows carry 0–8 children.
 *
 * Three more assertions are each aimed at one named implementation:
 *
 * - **A boundary that clamps** returns `ok: true` having changed nothing. The
 *   nudged block's index is asserted to have changed by **exactly `delta`**, so
 *   a clamp fails rather than reporting a move it did not make and announcing a
 *   position the block was already at.
 * - **A refusal implemented as a silent no-op** returns a fresh state object
 *   that happens to be equal. `result.state === state` is asserted by
 *   **reference identity**, which equality cannot fake.
 * - **An announcer that fires on both paths** for one move shows up as an
 *   `announcement` key on a refusal result. Asserted absent with
 *   `Object.hasOwn`, so "one result, one string" is a checked invariant rather
 *   than a convention.
 *
 * ## Why `refusalFor` is checked against `reduce` on every pair
 *
 * The pointer path paints the blocked cursor and the "a row holds no row" hint
 * from `refusalFor` **during** the drag; the drop then goes through `reduce`. A
 * preview that disagrees with the commit is worse than no preview, because the
 * user has already been told what will happen. The two share one private
 * decision procedure in the module, so agreement is structural — and it is
 * asserted anyway on every generated pair, because "they call the same function
 * today" is not a property, it is an implementation detail that a future
 * optimisation of `refusalFor` would quietly remove.
 *
 * ## Legality, and where this property stops
 *
 * Every reachable state is checked against the bounds directly after each action
 * (unique ids, one level of nesting, ≤200 blocks, 2–3 columns, ≤8 children per
 * column) and then, once per sequence, embedded in a real `TemplateDefinition`
 * and run through `collectDefinitionIssues` — so "structurally legal" means
 * legal to the actual `Template_Validator` rather than legal to a restatement of
 * it here. Config *values* are not checked: the reducer does not validate them
 * (see its docstring), the validator does, and Property 8 already covers that.
 *
 * ## Declared cases
 *
 * Six, in one array (Requirement 45.5), and each one is a boundary the generator
 * reaches but that deserves to be pinned by name: the first and last block of
 * the top-level sequence, the first and last of a row column, a `row` moved into
 * a row column, and the only block in a column — which is simultaneously first
 * and last, and is the case a clamping implementation looks most correct on.
 * `numRuns` is raised to `100 + CASES.length` because fast-check draws declared
 * cases from the same budget as generated ones (Requirement 45.1's floor is a
 * floor on *generated* cases).
 */

// --- Local tree helpers, written here rather than imported -------------------

function isRowBlock(block: TemplateBlock): block is RowBlock {
  return block.type === "row"
}

/**
 * The document order, derived from **list indices alone**.
 *
 * Deliberately not a second copy of the module's walk: every block is labelled
 * with the tuple `(topLevelIndex, columnIndex, childIndex)` — a row itself
 * taking `columnIndex = -1` so it precedes its own children — and the records
 * are then *sorted* by that tuple. Requirement 6.3 says the list order of the
 * definition **is** the document order and no other ordering field is read, so
 * sorting by position is exactly the requirement restated as an oracle. A
 * flattener that emitted a row's children before the row, or visited column 2
 * before column 1, disagrees with this and matches no reordering of its own
 * recursion.
 */
function oracleDocumentOrder(blocks: readonly TemplateBlock[]): string[] {
  const records: {
    readonly key: readonly [number, number, number]
    readonly id: string
  }[] = []

  blocks.forEach((block, topIndex) => {
    records.push({ key: [topIndex, -1, -1], id: block.id })
    if (!isRowBlock(block)) return
    block.columns.forEach((column, columnIndex) => {
      column.forEach((child, childIndex) => {
        records.push({ key: [topIndex, columnIndex, childIndex], id: child.id })
      })
    })
  })

  records.sort((a, b) => {
    for (let i = 0; i < 3; i += 1) {
      if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i]
    }
    return 0
  })

  return records.map((record) => record.id)
}

/** Every block's container and index, keyed by id — the confinement oracle. */
function membership(
  blocks: readonly TemplateBlock[]
): Map<string, { container: string; index: number }> {
  const map = new Map<string, { container: string; index: number }>()

  blocks.forEach((block, topIndex) => {
    map.set(block.id, { container: "root", index: topIndex })
    if (!isRowBlock(block)) return
    block.columns.forEach((column, columnIndex) => {
      column.forEach((child, childIndex) => {
        map.set(child.id, {
          container: `row:${block.id}#${columnIndex}`,
          index: childIndex,
        })
      })
    })
  })

  return map
}

function rowsOf(blocks: readonly TemplateBlock[]): readonly RowBlock[] {
  return blocks.filter(isRowBlock)
}

// --- Generators: the state --------------------------------------------------

const NON_ROW_TYPES = BLOCK_TYPES.filter(
  (type): type is Exclude<BlockType, "row"> => type !== "row"
)

/** One valid scope, reused, so `scope_override` rides along without generating one. */
const FIXED_SCOPE: ScopeSpec = {
  resource_types: ["Microsoft.Compute/virtualMachines"],
  tag_filters: [],
  resource_groups: [],
  top_n: null,
  sort: null,
}

const CONFIG_DEFAULTS: Readonly<Record<string, unknown>> = {
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

function configSchemaFor(type: Exclude<BlockType, "row">): {
  readonly required: readonly string[]
  readonly optional: readonly string[]
  readonly enums: Readonly<Record<string, readonly string[]>>
} {
  return BLOCK_CONFIG[type]
}

function configFor(type: Exclude<BlockType, "row">): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const field of configSchemaFor(type).required) {
    config[field] = CONFIG_DEFAULTS[field] ?? ""
  }
  return config
}

type LeafDraw = {
  readonly node: "leaf"
  readonly type: Exclude<BlockType, "row">
  readonly withScopeOverride: boolean
}

type RowDraw = {
  readonly node: "row"
  readonly columnCount: 2 | 3
  readonly children: readonly (readonly LeafDraw[])[]
}

type NodeDraw = LeafDraw | RowDraw

function leafDrawArb(): fc.Arbitrary<LeafDraw> {
  return fc.record({
    node: fc.constant("leaf" as const),
    type: fc.constantFrom(...NON_ROW_TYPES),
    // Requirement 3.2 — some blocks narrowed, some inheriting, so both states
    // ride through every move.
    withScopeOverride: fc.boolean(),
  })
}

function rowDrawArb(maxChildren: number): fc.Arbitrary<RowDraw> {
  return fc
    .record({
      columnCount: fc.constantFrom(MIN_ROW_COLUMNS as 2, MAX_ROW_COLUMNS as 3),
      children: fc.array(fc.array(leafDrawArb(), { maxLength: maxChildren }), {
        minLength: MAX_ROW_COLUMNS,
        maxLength: MAX_ROW_COLUMNS,
      }),
    })
    .map(({ columnCount, children }) => ({
      node: "row" as const,
      columnCount,
      children: children.slice(0, columnCount),
    }))
}

function nodeDrawArb(maxChildren: number): fc.Arbitrary<NodeDraw> {
  // Rows are a minority of nodes but common enough that a state of a dozen nodes
  // usually holds two or three — the column boundaries are where this property
  // does its work.
  return fc.oneof(
    { arbitrary: leafDrawArb(), weight: 3 },
    { arbitrary: rowDrawArb(maxChildren), weight: 2 }
  )
}

type StateDraw = {
  readonly nodes: readonly NodeDraw[]
  readonly selectionSelector: number
  readonly selectNothing: boolean
}

/**
 * Ids are counter-based rather than generated: uniqueness across the whole tree
 * is a hard rule (Requirement 6.7), and this property's job is to check the
 * *reducer* preserves it, not to explore states that violate it on arrival.
 *
 * The build truncates at {@link MAX_BLOCKS_TOTAL}, which is also how the
 * 200-block ceiling becomes reachable: the large branch of the generator draws
 * more nodes than fit, so a meaningful fraction of generated states sit exactly
 * at the bound where `insert` must refuse.
 */
function buildState(draw: StateDraw): ComposerState {
  let counter = 0
  const nextId = (): string => {
    counter += 1
    return `b${counter}`
  }

  const blocks: TemplateBlock[] = []
  let total = 0

  for (const node of draw.nodes) {
    if (node.node === "leaf") {
      if (total + 1 > MAX_BLOCKS_TOTAL) break
      total += 1
      const leaf: LeafBlock = node.withScopeOverride
        ? {
            id: nextId(),
            type: node.type,
            config: configFor(node.type),
            scope_override: FIXED_SCOPE,
          }
        : { id: nextId(), type: node.type, config: configFor(node.type) }
      blocks.push(leaf)
      continue
    }

    if (total + 1 > MAX_BLOCKS_TOTAL) break
    total += 1
    const rowId = nextId()
    const columns: LeafBlock[][] = []
    for (const column of node.children) {
      const built: LeafBlock[] = []
      for (const child of column.slice(0, MAX_CHILDREN_PER_COLUMN)) {
        if (total + 1 > MAX_BLOCKS_TOTAL) break
        total += 1
        built.push(
          child.withScopeOverride
            ? {
                id: nextId(),
                type: child.type,
                config: configFor(child.type),
                scope_override: FIXED_SCOPE,
              }
            : { id: nextId(), type: child.type, config: configFor(child.type) }
        )
      }
      columns.push(built)
    }
    blocks.push({ id: rowId, type: "row", columns })
  }

  const ids = flattenBlockIds(blocks)
  const selectedBlockId =
    draw.selectNothing || ids.length === 0
      ? null
      : ids[draw.selectionSelector % ids.length]

  return { blocks, selectedBlockId }
}

function stateDrawArb(
  maxNodes: number,
  maxChildren: number,
  options: {
    readonly minNodes?: number
    readonly size?: fc.SizeForArbitrary
  } = {}
): fc.Arbitrary<StateDraw> {
  return fc.record({
    nodes: fc.array(nodeDrawArb(maxChildren), {
      minLength: options.minNodes ?? 0,
      maxLength: maxNodes,
      ...(options.size === undefined ? {} : { size: options.size }),
    }),
    selectionSelector: fc.nat({ max: 1023 }),
    selectNothing: fc.boolean(),
  })
}

/**
 * 0–200 blocks. The small branch dominates so shrinking produces readable
 * counterexamples and 50-action sequences stay fast; the large branch exists so
 * the 200-block ceiling and the 8-child column are genuinely reached, which the
 * coverage test below counts rather than assumes.
 */
const stateArb: fc.Arbitrary<ComposerState> = fc
  .oneof(
    { arbitrary: stateDrawArb(14, 4), weight: 8 },
    {
      arbitrary: stateDrawArb(60, MAX_CHILDREN_PER_COLUMN, {
        minNodes: 24,
        size: "max",
      }),
      weight: 1,
    }
  )
  .map(buildState)

// --- Generators: the actions ------------------------------------------------

/**
 * An action *recipe* rather than an action.
 *
 * A `ComposerAction` names block ids, and the ids that exist change as the
 * sequence runs — a block inserted by action 3 is a legitimate target for action
 * 4, and a block removed by action 5 must not be. So the recipe carries
 * selectors, and {@link resolveAction} resolves them against the **current**
 * state at each step. `unknownBlock` is drawn at roughly one in ten, which is
 * what puts unknown-id refusals in the space (design.md's generator table).
 */
type ActionRecipe = {
  readonly kind: ComposerAction["kind"]
  readonly blockSelector: number
  readonly unknownBlock: boolean
  readonly blockType: BlockType
  readonly delta: -1 | 1
  readonly columns: 2 | 3
  readonly selectNothing: boolean
  readonly configUndeclared: boolean
  readonly configUndefined: boolean
  readonly configSelector: number
  readonly target: {
    readonly preferRow: boolean
    readonly unknownRow: boolean
    readonly rowSelector: number
    readonly columnSelector: number
    readonly indexSelector: number
    readonly overshoot: boolean
  }
}

const oneInTen = (): fc.Arbitrary<boolean> =>
  fc.integer({ min: 0, max: 9 }).map((n) => n === 0)

const recipeArb: fc.Arbitrary<ActionRecipe> = fc.record({
  kind: fc.constantFrom(
    "insert",
    "move",
    // Weighted toward `nudge` by naming it three times: it is the action the
    // property is really about, and an even split over seven kinds would spend
    // most of a 50-action sequence elsewhere.
    "nudge",
    "nudge",
    "nudge",
    "remove",
    "select",
    "splitRow",
    "patchConfig"
  ),
  blockSelector: fc.nat({ max: 1023 }),
  unknownBlock: oneInTen(),
  blockType: fc.constantFrom(...BLOCK_TYPES),
  delta: fc.constantFrom(-1 as const, 1 as const),
  columns: fc.constantFrom(MIN_ROW_COLUMNS as 2, MAX_ROW_COLUMNS as 3),
  selectNothing: oneInTen(),
  configUndeclared: oneInTen(),
  configUndefined: oneInTen(),
  configSelector: fc.nat({ max: 63 }),
  target: fc.record({
    preferRow: fc.boolean(),
    unknownRow: oneInTen(),
    rowSelector: fc.nat({ max: 63 }),
    columnSelector: fc.nat({ max: 63 }),
    indexSelector: fc.nat({ max: 255 }),
    overshoot: oneInTen(),
  }),
})

function resolveBlockId(recipe: ActionRecipe, state: ComposerState): string {
  const ids = flattenBlockIds(state.blocks)
  if (recipe.unknownBlock || ids.length === 0) {
    return `absent-${recipe.blockSelector}`
  }
  return ids[recipe.blockSelector % ids.length]
}

function resolveInsertionPoint(
  recipe: ActionRecipe,
  state: ComposerState
): InsertionPoint {
  const { target } = recipe

  if (target.unknownRow) {
    return {
      container: {
        kind: "row",
        rowId: `absent-row-${target.rowSelector}`,
        columnIndex: 0,
      },
      index: 0,
    }
  }

  const rows = rowsOf(state.blocks)
  if (target.preferRow && rows.length > 0) {
    const row = rows[target.rowSelector % rows.length]
    const columnIndex = target.columnSelector % row.columns.length
    const container: ContainerRef = { kind: "row", rowId: row.id, columnIndex }
    const length = row.columns[columnIndex].length
    return {
      container,
      index: target.overshoot
        ? length + 1
        : target.indexSelector % (length + 1),
    }
  }

  const length = state.blocks.length
  return {
    container: { kind: "root" },
    index: target.overshoot ? length + 2 : target.indexSelector % (length + 1),
  }
}

function resolveConfigPatch(
  recipe: ActionRecipe,
  state: ComposerState,
  blockId: string
): unknown {
  if (recipe.configUndeclared)
    return { [`undeclared_${recipe.configSelector}`]: 1 }

  const block = findBlock(state.blocks, blockId)
  if (block === null || block.type === "row") return {}

  const schema = configSchemaFor(block.type)
  const fields = [
    ...schema.required,
    ...schema.optional,
    ...Object.keys(schema.enums),
  ]
  if (fields.length === 0) return {}

  const field = fields[recipe.configSelector % fields.length]
  if (recipe.configUndefined) return { [field]: undefined }

  const enumValues = schema.enums[field]
  const value =
    enumValues !== undefined
      ? enumValues[recipe.configSelector % enumValues.length]
      : (CONFIG_DEFAULTS[field] ?? `patched-${recipe.configSelector}`)
  return { [field]: value }
}

function resolveAction(
  recipe: ActionRecipe,
  state: ComposerState
): ComposerAction {
  const blockId = resolveBlockId(recipe, state)

  switch (recipe.kind) {
    case "insert":
      return {
        kind: "insert",
        blockType: recipe.blockType,
        at: resolveInsertionPoint(recipe, state),
      }
    case "move":
      return { kind: "move", blockId, to: resolveInsertionPoint(recipe, state) }
    case "nudge":
      return { kind: "nudge", blockId, delta: recipe.delta }
    case "remove":
      return { kind: "remove", blockId }
    case "select":
      return { kind: "select", blockId: recipe.selectNothing ? null : blockId }
    case "splitRow":
      return { kind: "splitRow", blockId, columns: recipe.columns }
    case "patchConfig":
      return {
        kind: "patchConfig",
        blockId,
        config: resolveConfigPatch(recipe, state, blockId),
      }
  }
}

// --- The announcement parser ------------------------------------------------

const PLACEMENT_PATTERN =
  /position (\d+) of (\d+)(?: in column (\d+) of (\d+))?/g

type Placement = {
  readonly position: number
  readonly total: number
  readonly column: number | null
  readonly columnCount: number | null
}

/**
 * The placement clauses in an announcement.
 *
 * Returned as a list rather than a single match on purpose: "exactly one
 * announcement per completed move" is enforced partly by the result type (one
 * string) and partly here — a sentence carrying two positions would be one
 * string announcing two moves.
 */
function placementsIn(announcement: string): readonly Placement[] {
  return [...announcement.matchAll(PLACEMENT_PATTERN)].map((match) => ({
    position: Number(match[1]),
    total: Number(match[2]),
    column: match[3] === undefined ? null : Number(match[3]),
    columnCount: match[4] === undefined ? null : Number(match[4]),
  }))
}

// --- Structural legality ----------------------------------------------------

/** The bounds, checked directly — cheap enough to run after every action. */
function assertStructurallyLegal(state: ComposerState): void {
  const ids = flattenBlockIds(state.blocks)

  // Requirement 6.7 — unique across top-level blocks and every row child.
  expect(new Set(ids).size, `duplicate block id in [${ids.join(", ")}]`).toBe(
    ids.length
  )

  for (const id of ids) {
    expect(id.length).toBeGreaterThanOrEqual(BLOCK_ID_MIN_LENGTH)
    expect(id.length).toBeLessThanOrEqual(BLOCK_ID_MAX_LENGTH)
  }

  // Requirement 6.3 — counting rows and their children.
  expect(countBlocks(state.blocks)).toBeLessThanOrEqual(MAX_BLOCKS_TOTAL)

  for (const block of state.blocks) {
    expect(BLOCK_TYPES as readonly string[]).toContain(block.type)
    if (!isRowBlock(block)) continue

    // Requirement 6.2 — 2 or 3 columns, at most 8 children each.
    expect(block.columns.length).toBeGreaterThanOrEqual(MIN_ROW_COLUMNS)
    expect(block.columns.length).toBeLessThanOrEqual(MAX_ROW_COLUMNS)

    for (const column of block.columns) {
      expect(column.length).toBeLessThanOrEqual(MAX_CHILDREN_PER_COLUMN)
      for (const child of column) {
        // Requirement 6.4 — one level of nesting. The claim the whole grammar
        // rests on, checked on every reachable state rather than at save time.
        expect(child.type, `row ${block.id} holds a row`).not.toBe("row")
      }
    }
  }

  // The selection names a block that exists, or nothing.
  if (state.selectedBlockId !== null) {
    expect(findBlock(state.blocks, state.selectedBlockId)).not.toBe(null)
  }

  // Requirement 12.6 — DOM order is document order, derived from list indices.
  expect(flattenBlockIds(state.blocks)).toEqual(
    oracleDocumentOrder(state.blocks)
  )
}

/** The same state, run through the real `Template_Validator`. */
function assertAcceptedByTheValidator(state: ComposerState): void {
  const definition: TemplateDefinition = {
    schema_version: 1,
    identity: { name: "Composer state" },
    scope: FIXED_SCOPE,
    period: { kind: "last_full_month" },
    metrics: {},
    blocks: state.blocks,
    design: {
      preset: "editorial",
      accent_color: "#0f766e",
      density: "normal",
      table_style: "hairline",
      number_format: { decimal_places: 1, group_thousands: true },
      cover_page: true,
      logo: null,
      page_size: "A4",
    },
  }

  const issues = collectDefinitionIssues(definition, { mode: "draft" })
  // Config *values* are the validator's business and the reducer's defaults are
  // deliberately empty, so only block-structure issues are asserted absent here
  // — a nesting violation, a duplicate id, an over-long id, an unknown type, an
  // over-full column or an over-count definition would all land on a
  // `blocks…` path.
  const structural = issues.filter((issue) => issue.path[0] === "blocks")
  expect(
    structural.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
  ).toEqual([])
}

// --- One step, fully checked ------------------------------------------------

/**
 * Apply `action` to `state`, assert everything Property 10 claims about that one
 * step, and return the state to carry forward.
 */
function step(state: ComposerState, action: ComposerAction): ComposerState {
  const snapshot = structuredClone(state) as ComposerState
  const beforeOrder = flattenBlockIds(state.blocks)
  const before = membership(state.blocks)

  // The drag preview and the drop must agree, or the user is told one thing and
  // shown another.
  const predicted = refusalFor(action, state)
  const result = reduce(state, action)

  if (result.ok) {
    expect(
      predicted,
      `refusalFor predicted ${JSON.stringify(predicted)} but reduce succeeded`
    ).toBe(null)
  } else {
    expect(predicted).toEqual(result.refusal)
  }

  // The reducer is pure: the input object it was handed is untouched.
  expect(state).toEqual(snapshot)

  if (!result.ok) {
    // Reference identity, which a "silent no-op returning a fresh equal object"
    // cannot satisfy.
    expect(result.state).toBe(state)
    // One result, one string. An announcer that fired here too would announce a
    // move that did not happen.
    expect(Object.hasOwn(result, "announcement")).toBe(false)
    expect(result.refusal.message.length).toBeGreaterThan(0)
    expect(flattenBlockIds(result.state.blocks)).toEqual(beforeOrder)

    if (
      action.kind === "nudge" &&
      findBlock(state.blocks, action.blockId) !== null
    ) {
      // Requirement 12.12 — the only reason a nudge on an existing block is
      // refused is that it is already at that end of its container, and the
      // sentence has to say which end.
      expect(["already_first", "already_last"]).toContain(result.refusal.code)
      const expected =
        result.refusal.code === "already_first"
          ? /first position/
          : /last position/
      expect(result.refusal.message).toMatch(expected)
    }

    return state
  }

  const next = result.state
  assertStructurallyLegal(next)

  expect(typeof result.announcement).toBe("string")
  expect(result.announcement.length).toBeGreaterThan(0)

  const placements = placementsIn(result.announcement)

  if (action.kind === "nudge") {
    const after = membership(next.blocks)

    // Same blocks, no losses and no arrivals.
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())

    // **The confinement assertion.** Not "the nudged block stayed put" — every
    // block's container membership, before and after. A flattened-index nudge
    // moves the nudged block into a *different* container, and this is the line
    // that fails.
    const moved: string[] = []
    for (const [id, position] of before) {
      const now = after.get(id)!
      expect(
        now.container,
        `block ${id} changed container from ${position.container} to ${now.container}`
      ).toBe(position.container)
      if (now.index !== position.index) moved.push(id)
    }

    // A nudge is a swap of adjacent siblings, so exactly two indices change: the
    // nudged block by `delta`, and the sibling it passed by `-delta`. Anything
    // else — zero (a clamp), or three or more (a rotation) — fails.
    const nudged = before.get(action.blockId)!
    const nowNudged = after.get(action.blockId)!
    expect(nowNudged.index - nudged.index).toBe(action.delta)
    expect(moved.sort()).toEqual(
      [
        action.blockId,
        [...before.entries()].find(
          ([id, position]) =>
            id !== action.blockId &&
            position.container === nudged.container &&
            position.index === nudged.index + action.delta
        )![0],
      ].sort()
    )
    expect(moved.length).toBe(2)
  }

  if (action.kind === "nudge" || action.kind === "move") {
    // Requirement 12.5 — exactly one announcement, whose 1-based position and
    // container total are re-derived from the **resulting** tree rather than
    // trusted from the string.
    expect(placements.length).toBe(1)
    const location = locateBlock(next.blocks, action.blockId)!
    const placement = placements[0]

    expect(placement.position).toBe(location.index + 1)
    expect(placement.total).toBe(location.total)

    if (location.container.kind === "row") {
      // Requirement 12.7 — a block inside a row names the column and the count.
      expect(placement.column).toBe(location.container.columnIndex + 1)
      expect(placement.columnCount).toBe(location.columnCount)
    } else {
      expect(placement.column).toBe(null)
    }

    const block = findBlock(next.blocks, action.blockId)!
    expect(result.announcement.startsWith(blockTypeLabel(block.type))).toBe(
      true
    )
  }

  if (action.kind === "insert") {
    // Requirement 12.3 — the inserted block is the selection, and the sentence
    // places it where it actually landed.
    expect(next.selectedBlockId).not.toBe(null)
    expect(countBlocks(next.blocks)).toBe(countBlocks(state.blocks) + 1)
    expect(placements.length).toBe(1)
    const location = locateBlock(next.blocks, next.selectedBlockId!)!
    expect(placements[0].position).toBe(location.index + 1)
    expect(placements[0].total).toBe(location.total)
  }

  if (action.kind === "select") {
    expect(next.blocks).toBe(state.blocks)
    expect(next.selectedBlockId).toBe(action.blockId)
  }

  if (action.kind === "patchConfig") {
    // A config patch reorders nothing.
    expect(flattenBlockIds(next.blocks)).toEqual(beforeOrder)
  }

  return next
}

// --- Declared cases ---------------------------------------------------------

function leaf(id: string, type: Exclude<BlockType, "row">): LeafBlock {
  return { id, type, config: configFor(type) }
}

/**
 * Two rows and three top-level leaves, so all six cases below are boundaries of
 * this one tree: `t1` is first and `t3` last at the top level, `c1` is first and
 * `c3` last in a four-deep column, `d1` is the only block in its column, and
 * `r2` is a second row for a row to be refused into.
 */
const CASE_STATE: ComposerState = {
  blocks: [
    leaf("t1", "cover"),
    {
      id: "r1",
      type: "row",
      columns: [
        [
          leaf("c1", "rich_text"),
          leaf("c2", "page_break"),
          leaf("c3", "resource_table"),
        ],
        [leaf("d1", "verification_record")],
      ],
    },
    leaf("t2", "kpi_row"),
    { id: "r2", type: "row", columns: [[], []] },
    leaf("t3", "heading"),
  ],
  selectedBlockId: "t2",
}

type Pair = readonly [ComposerState, ComposerAction]

/**
 * Six, and every one is a position a clamping or flattening implementation looks
 * correct on until it does not.
 */
const CASES: [Pair][] = [
  // 1. The first block of the top-level sequence, nudged toward the start.
  [[CASE_STATE, { kind: "nudge", blockId: "t1", delta: -1 }]],
  // 2. The last block of the top-level sequence, nudged toward the end. A
  //    flattened-index nudge has nowhere to go here and may clamp silently.
  [[CASE_STATE, { kind: "nudge", blockId: "t3", delta: 1 }]],
  // 3. The first child of a row column. A flattened index would swap it with
  //    the row itself.
  [[CASE_STATE, { kind: "nudge", blockId: "c1", delta: -1 }]],
  // 4. The last child of a row column. **The** case: a flattened index moves it
  //    into the sibling column, which is a container change the user never asked
  //    for and which reads as the block vanishing.
  [[CASE_STATE, { kind: "nudge", blockId: "c3", delta: 1 }]],
  // 5. A `row` moved into a row column ⇒ refusal, unchanged order, "a row holds
  //    no row" (Requirements 6.4, 12.14).
  [
    [
      CASE_STATE,
      {
        kind: "move",
        blockId: "r1",
        to: {
          container: { kind: "row", rowId: "r2", columnIndex: 0 },
          index: 0,
        },
      },
    ],
  ],
  // 6. The only block in a column, which is first and last at once. A clamp
  //    looks most plausible here, because there is genuinely nowhere to move.
  [[CASE_STATE, { kind: "nudge", blockId: "d1", delta: 1 }]],
]

const CASE_NUM_RUNS = 100 + CASES.length

const pairArb: fc.Arbitrary<Pair> = stateArb.chain((state) =>
  recipeArb.map((recipe): Pair => [state, resolveAction(recipe, state)])
)

// --- The generators reach what they exist for -------------------------------

describe("the generated space contains the cases the property needs", () => {
  test("states reach the 200-block ceiling, an 8-child column and both column counts", () => {
    // A property over trees that are all four blocks deep and never hold a row
    // would pass on a flattened-index nudge. Counted, not assumed.
    let large = 0
    let fullColumn = 0
    let twoColumns = 0
    let threeColumns = 0
    let empty = 0

    fc.assert(
      fc.property(stateArb, (state) => {
        const total = countBlocks(state.blocks)
        if (total === 0) empty += 1
        if (total > 150) large += 1
        for (const block of state.blocks) {
          if (!isRowBlock(block)) continue
          if (block.columns.length === 2) twoColumns += 1
          else threeColumns += 1
          if (
            block.columns.some(
              (column) => column.length === MAX_CHILDREN_PER_COLUMN
            )
          ) {
            fullColumn += 1
          }
        }
        return true
      }),
      { numRuns: 1_500 }
    )

    expect(large, "no state reached 150+ blocks").toBeGreaterThan(5)
    expect(fullColumn, "no column ever held 8 children").toBeGreaterThan(5)
    expect(twoColumns).toBeGreaterThan(20)
    expect(threeColumns).toBeGreaterThan(20)
    expect(empty, "the empty state was never generated").toBeGreaterThan(0)
  })

  test("actions reach every kind, unknown ids near one in ten, and both nudge boundaries", () => {
    const kinds = new Map<string, number>()
    const codes = new Map<string, number>()
    let unknownIds = 0
    let total = 0
    let nudgesInsideARow = 0

    fc.assert(
      fc.property(pairArb, ([state, action]) => {
        total += 1
        kinds.set(action.kind, (kinds.get(action.kind) ?? 0) + 1)

        const refusal = refusalFor(action, state)
        if (refusal !== null)
          codes.set(refusal.code, (codes.get(refusal.code) ?? 0) + 1)
        if (refusal?.code === "unknown_block") unknownIds += 1

        if (action.kind === "nudge" && refusal === null) {
          const location = locateBlock(state.blocks, action.blockId)
          if (location?.container.kind === "row") nudgesInsideARow += 1
        }
        return true
      }),
      { numRuns: 2_000 }
    )

    for (const kind of [
      "insert",
      "move",
      "nudge",
      "remove",
      "select",
      "splitRow",
      "patchConfig",
    ]) {
      expect(
        kinds.get(kind) ?? 0,
        `no ${kind} action was generated`
      ).toBeGreaterThan(20)
    }

    // The boundary refusals are what Requirement 12.12 is about, and the
    // row-nesting refusal is Requirement 12.14's. A space that never produced
    // them would leave both criteria unchecked.
    for (const code of [
      "already_first",
      "already_last",
      "row_holds_no_row",
      "unknown_block",
    ]) {
      expect(
        codes.get(code) ?? 0,
        `no ${code} refusal was generated`
      ).toBeGreaterThan(5)
    }

    // Successful nudges *inside a row column* are the positive half of the
    // confinement claim; without them the assertion could pass vacuously.
    expect(nudgesInsideARow).toBeGreaterThan(50)

    // Roughly one in ten ids drawn from outside the state (design.md's table).
    // A loose band, because an id drawn from outside a state that is empty
    // anyway is indistinguishable from one drawn from inside it.
    expect(unknownIds / total).toBeGreaterThan(0.03)
    expect(unknownIds / total).toBeLessThan(0.3)
  })
})

// --- Property 10, part 1: one action, every claim ---------------------------

describe("Property 10 — one action is confined, announced or refused as a value", () => {
  test("every generated state and action", () => {
    fc.assert(
      fc.property(pairArb, ([state, action]) => {
        step(state, action)
      }),
      { numRuns: CASE_NUM_RUNS, examples: CASES }
    )
  })
})

// --- Property 10, part 2: sequences ----------------------------------------

describe("Property 10 — no sequence of actions reaches an illegal state", () => {
  test("1–50 actions leave a state the Template_Validator accepts", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.array(recipeArb, { minLength: 1, maxLength: 50 }),
        (initial, recipes) => {
          // The initial state is legal, or the sequence would prove nothing.
          assertStructurallyLegal(initial)

          let state = initial
          for (const recipe of recipes) {
            state = step(state, resolveAction(recipe, state))
          }

          // Requirement 6.4, at the end of the whole sequence and against the
          // real validator rather than against a restatement of it here.
          assertAcceptedByTheValidator(state)
        }
      )
    )
  })
})
