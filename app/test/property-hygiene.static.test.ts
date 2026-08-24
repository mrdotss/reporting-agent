import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"
import { describe, expect, test } from "vitest"

import * as ledger from "./property-ledger"

/**
 * Hygiene guards for the web-side properties themselves (Requirements 42.1,
 * 42.7, 42.8).
 *
 * A property test that passes by testing nothing is worse than no test, because
 * it reports green. Each rule below makes one specific way of doing that a
 * failure:
 *
 * 1. **No property is skipped, isolated, or expected to fail** (Requirement
 *    42.7). `test.skip`, `test.todo`, `test.fails` and `test.only` are all
 *    rejected — `.only` because it skips every sibling in the file, which is the
 *    same outcome reached from the other direction.
 * 2. **No `fc.assert` runs fewer than 100 generated cases** (Requirement 42.1).
 *    `test/setup.ts` sets the global floor, so the failure mode is a local
 *    `numRuns` below it.
 * 3. **A property carrying declared cases raises its budget to match.**
 *    fast-check draws declared examples from the *same* budget as generated
 *    ones: `SourceValuesIterator` yields the examples first and then takes at
 *    most `numRuns` values in total. So a property with five declared cases at
 *    `numRuns: 100` runs **95** generated cases, not 100 — Requirement 42.1
 *    quietly violated by the very act of satisfying Requirement 42.8. The rule
 *    is therefore `numRuns >= 100 + declared cases`, which is the convention
 *    both property modules already document.
 * 4. **A fixed counterexample stays fixed** (Requirement 42.8). Retention is a
 *    **ratchet**: {@link MINIMUM_DECLARED_CASES} records how many declared cases
 *    each module carries today and the count may only grow. Adding a case is
 *    free; deleting one fails.
 *
 * Two further rules read what the run actually **did** rather than what the source
 * says, because the four above share one blind spot: every one of them passes over
 * a property that was written correctly and never executed.
 *
 * 5. **The set of properties executed equals the set this spec declares**
 *    (Requirement 45.7). `test/property-ledger.ts` names the web-side set —
 *    design.md's Properties 8 to 12 — alongside the foundation's three web
 *    properties. A property added to design.md and never registered fails, a
 *    module registered and absent from the tree fails, and a module in the tree
 *    belonging to no property fails.
 * 6. **Each property records its framework, its accepted-case count, its
 *    precondition rejection fraction and its seed** (Requirement 45.8), taken
 *    from fast-check's own `RunDetails` by the global `reporter` in
 *    `test/setup.ts`. Requirement 45.4's thresholds are then read off that ledger
 *    rather than assumed.
 *
 *    Rule 6 is enforced in two places for one reason. Vitest evaluates each test
 *    file in its own module registry and runs files in parallel, so *this* file
 *    can only see the records that happen to be on disk by the time it executes.
 *    `test/property-ledger.global.ts` — the node project's `globalSetup` — runs
 *    once after every file and is the only vantage point that sees the whole run,
 *    so it owns the completeness half. What this file owns is the declaration, the
 *    thresholds over whatever has been recorded, and the proof that the recording
 *    is wired up at all.
 *
 * Every rule is asserted over the **TypeScript AST**, not over text. These
 * modules explain in prose why they declare what they declare — the `numRuns`
 * convention above is spelled out in a comment in each of them — so a regex for
 * `numRuns` or for `skip` would fail on exactly the tree that documents the
 * rules best. `typescript` is already a dev dependency; nothing is added for
 * this.
 *
 * The agent half of these rules is `agent/tests/test_property_hygiene.py`. One
 * requirement, two languages, deliberately parallel in structure.
 */

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)

/** Requirement 42.1 — the floor, and the base of the rule 3 arithmetic. */
const MINIMUM_RUNS = 100

/** What makes a module a property module. */
const PROPERTY_MODULE_SUFFIX = ".property.test.ts"

/** Directories the discovery walk descends. `test/` holds this guard, not a property. */
const PROPERTY_SEARCH_DIRECTORIES = [
  "lib",
  "app",
  "components",
  "hooks",
  // `test/property/` is where the breadth-and-document spec puts its web-side properties.
  // Without it a module there would be invisible to every rule in this file — unscanned for a
  // lowered `numRuns`, for a `test.skip`, and for belonging to no declared property — while
  // `vitest.config.ts`'s node project collects and runs it perfectly happily. A property the
  // hygiene guard cannot see is the exact hole this guard exists to be.
  "test",
] as const

const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".next"])

/**
 * Requirement 42.8 — the ratchet. Distinct declared cases per module: the sum of
 * the lengths of the case arrays each module hands to fast-check, counted once
 * each however many properties share them.
 *
 * Every property module must appear here, which is what stops a new one from
 * arriving unratcheted. Raise an entry when a counterexample is added; never
 * lower one.
 */
const MINIMUM_DECLARED_CASES: Readonly<Record<string, number>> = {
  "lib/crypto.property.test.ts": 11,
  "lib/aws/redact.property.test.ts": 5,
  // Property 12. Four declared cases: the three the task names, plus
  // `Alice/reports/…` — which mutation-testing showed the other three miss. A
  // case-folding **actor** comparison survived all of them, because each
  // differed in the segment or in the prefix rather than in the id's case
  // alone.
  "lib/aws/s3.property.test.ts": 4,
  "lib/subscriptions/azure-artifacts.property.test.ts": 8,
  // Property 8 (definition validation). Zero, on purpose and not as an
  // oversight: design.md's Property 8 declares no examples — unlike Properties
  // 5, 6, 7 and 9, whose tables carry a "Declared examples" row — because its
  // inputs are whole generated definitions plus an injected defect set, and a
  // hand-written tuple of the two reads as noise rather than as a retained
  // counterexample. The named cases the property's kills list calls for live in
  // that module as ordinary `test()` cases instead, where a fixed readable
  // fixture states each one far better. Raise this the day a *generated*
  // counterexample is worth pinning.
  "lib/templates/definition.property.test.ts": 0,
  // Property 11 (the definition digest). Six, shared by all four of that
  // module's properties and counted once: design.md's Property 11 table carries
  // no "Declared examples" row, but the task text names the character classes
  // the generator must reach — astral-plane, an NFC/NFD pair, a case-differing
  // pair, a JSON-escaping string, an empty object and an empty array — and each
  // is worth retaining as a fixed case as well as being a guaranteed
  // constituent of every generated value.
  "lib/templates/version.property.test.ts": 6,
  // Property 9 (period resolution). Twenty, across three arrays — one per
  // property, because the three properties take different argument shapes and a
  // shared array would not typecheck against any two of them.
  //
  // Thirteen for the six resolution rules: the three design.md's table declares,
  // the DST case that kills a millisecond-arithmetic resolver, both date-line
  // directions, both non-whole-hour offsets, and the four bound edges. Four for
  // the same-local-day identity, two of which straddle a DST transition inside a
  // single local day. Three for the process-`TZ` invariance.
  //
  // The fourth case the task text names — "the result is unchanged when the
  // process `TZ` is set to three different zones" — is a declared case *and* a
  // named `test()`, deliberately. It manipulates process state, so the property
  // that carries it needs a `try`/`finally` and a separate assertion that the
  // reassignment takes effect at all; a tuple in an `examples` array cannot say
  // either of those things, and an invariance check that silently runs under one
  // unchanged zone is worse than none.
  "lib/templates/period.property.test.ts": 20,
  // Property 10 (the composer reducer). Six, in one array shared by the
  // single-action property: the first and last block of the top-level sequence,
  // the first and last of a row column, a `row` moved into a row column, and
  // the only block in a column. design.md's Property 10 table names four
  // groups; the first two are two cases each, so six is the count actually
  // declared. Each is a boundary a flattened-index or clamping nudge looks
  // correct on, which is exactly why they are pinned rather than left to the
  // generator to rediscover.
  //
  // The sequence property carries none: its input is a state plus an action
  // *recipe* list whose selectors resolve against the state as it changes, and
  // a hand-written recipe tuple names nothing a reader can recognise. The named
  // boundaries live in the single-action property, where the action is concrete.
  "lib/templates/composer.property.test.ts": 6,
  /**
   * Property 8 of the breadth spec (block-config options). Three, in one array: an override
   * that narrows the template default, one that widens it, and one that disjoins from it
   * entirely.
   *
   * They are declared rather than left to the generator because the third is the one with the
   * discriminating power — a block whose scope names only resource types the definition
   * selected **no** metrics for — and it is the rarest of the three under a random override.
   * The relation is a separate property argument for exactly that reason: a case naming a
   * relation is readable, whereas a hand-written whole `Case` object would not be.
   */
  "test/property/config-options.property.test.ts": 3,
  /**
   * breadth Property 4 (`gap_grouping_lossless`). Four, shared by all five of that
   * module's properties and counted once: the 512-entry shape a live run actually
   * produced (8 metrics of 1 resource in one gapType, asserting at most 9 rows before
   * expansion while the counts still sum to 512), an entry carrying a null metric, an
   * entry carrying an empty resourceId, and a group whose starts are one grain step
   * apart except for one hole — the case that must record NO range. Each pins a
   * totality rule a random draw reaches only by luck.
   */
  "test/property/gap-groups.property.test.ts": 4,
  /**
   * breadth Property 7 (`scope_stays_a_rule`). Two, exactly the two the task
   * declares: an inventory whose resource group name contains a
   * subscription-like identifier substring, and a definition carrying a
   * resource type the response does not list. Both are retained as fixed cases
   * because each pins a rule a generator would only reach by luck — the first
   * that a group name *looking* like an identifier is still stored verbatim,
   * the second that a stored value absent from the current inventory is neither
   * deselected nor pruned.
   */
  "test/property/scope-picker.property.test.ts": 2,
  /**
   * Fifteen distinct declared cases across four arrays: three languages, six pairs of language
   * and declared separator, three colliding resolved pairs, and three version-1 shapes.
   */
  "test/property/number-format-defaults.property.test.ts": 15,
}

/** Recorded from the tree, so deleting a whole entry above is caught too. */
const MINIMUM_DECLARED_CASES_TOTAL = 63

/**
 * Requirement 42.7 — modifiers that stop a property from running or accept its
 * failure.
 *
 * `only` earns its place: it does not mark *this* property as skipped, it skips
 * every other one in the file. `skipIf` and `runIf` are conditional forms of the
 * same thing, and a condition that is true on CI and false locally is the worst
 * version of it.
 */
const FORBIDDEN_MODIFIERS = new Set([
  "skip",
  "skipIf",
  "runIf",
  "todo",
  "fails",
  "only",
])

/** The callers those modifiers would hang off. */
const TEST_CALLERS = new Set(["test", "it", "describe", "suite", "bench"])

// --- Reading ---------------------------------------------------------------

function readProjectFile(relativePath: string): string {
  const absolutePath = path.join(projectRoot, relativePath)
  expect(
    existsSync(absolutePath),
    `${relativePath} is missing from ${projectRoot}`
  ).toBe(true)
  return readFileSync(absolutePath, "utf8")
}

/** Parsed with position info, so `getText` works for the identifier reads below. */
function parseModule(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readProjectFile(relativePath),
    ts.ScriptTarget.Latest,
    true
  )
}

/** Parse a source string, for the detector self-tests at the end. */
function parseSource(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "synthetic.property.test.ts",
    source,
    ts.ScriptTarget.Latest,
    true
  )
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

/** Every property module, as repository-relative sorted paths. */
function listPropertyModules(): readonly string[] {
  const found: string[] = []

  const descend = (relative: string): void => {
    const absolute = path.join(projectRoot, relative)
    if (!existsSync(absolute)) return

    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue
        descend(path.join(relative, entry.name))
        continue
      }
      if (entry.isFile() && entry.name.endsWith(PROPERTY_MODULE_SUFFIX)) {
        found.push(path.join(relative, entry.name))
      }
    }
  }

  for (const directory of PROPERTY_SEARCH_DIRECTORIES) descend(directory)

  return found.sort()
}

// --- Array literals declared at module scope -------------------------------

/**
 * Every `const NAME = [ … ]` in the module, by name, with its element count.
 *
 * Used twice: to resolve an `examples: EXAMPLES` reference to a case count, and
 * to resolve a `numRuns: NUM_RUNS` whose initializer reads `100 +
 * EXAMPLES.length`.
 */
function arrayLengthsByName(
  source: ts.SourceFile
): ReadonlyMap<string, number> {
  const lengths = new Map<string, number>()

  walk(source, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      lengths.set(node.name.text, node.initializer.elements.length)
    }
  })

  return lengths
}

/** Every `const NAME = <expression>` in the module, by name. */
function initializersByName(
  source: ts.SourceFile
): ReadonlyMap<string, ts.Expression> {
  const initializers = new Map<string, ts.Expression>()

  walk(source, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      initializers.set(node.name.text, node.initializer)
    }
  })

  return initializers
}

// --- `fc.assert` call sites ------------------------------------------------

type AssertSite = {
  readonly modulePath: string
  readonly line: number
  /** The options object, when one was passed. */
  readonly options?: ts.ObjectLiteralExpression
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

/** Is this call `fc.assert(…)`, however `fast-check` was imported? */
function isFcAssert(
  node: ts.Node,
  source: ts.SourceFile
): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (ts.isPropertyAccessExpression(callee))
    return callee.name.text === "assert"
  return (
    ts.isIdentifier(callee) && callee.text === "assert" && source !== undefined
  )
}

function assertSites(
  modulePath: string,
  source: ts.SourceFile
): readonly AssertSite[] {
  const sites: AssertSite[] = []

  walk(source, (node) => {
    if (!isFcAssert(node, source)) return

    const options = node.arguments[1]
    sites.push({
      modulePath,
      line: lineOf(source, node),
      options:
        options !== undefined && ts.isObjectLiteralExpression(options)
          ? options
          : undefined,
    })
  })

  return sites
}

function optionValue(
  options: ts.ObjectLiteralExpression | undefined,
  key: string
): ts.Expression | undefined {
  if (options === undefined) return undefined

  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (property.name.getText() === key) return property.initializer
  }

  return undefined
}

/** Thrown-shaped result: a resolved number, or the reason it could not be read. */
type Resolved = { readonly value: number } | { readonly unreadable: string }

/**
 * Resolve a `numRuns` expression to a number.
 *
 * Two forms are accepted, which are the two the property modules use: a numeric
 * literal, and `<integer> + <identifier>.length` where the identifier names a
 * module-scope array literal. Anything else is **unreadable**, and unreadable
 * fails — a hygiene guard that guesses at a budget it cannot evaluate is not
 * enforcing a floor, it is hoping for one.
 */
function resolveRunCount(
  expression: ts.Expression,
  source: ts.SourceFile
): Resolved {
  if (ts.isNumericLiteral(expression)) {
    return { value: Number(expression.text) }
  }

  if (ts.isIdentifier(expression)) {
    const initializer = initializersByName(source).get(expression.text)
    if (initializer === undefined) {
      return { unreadable: `${expression.text} is not declared in this module` }
    }
    return resolveRunCount(initializer, source)
  }

  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = resolveRunCount(expression.left, source)
    const right = resolveRunCount(expression.right, source)
    if ("unreadable" in left) return left
    if ("unreadable" in right) return right
    return { value: left.value + right.value }
  }

  // `EXAMPLES.length`, the only property access the convention uses.
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "length" &&
    ts.isIdentifier(expression.expression)
  ) {
    const length = arrayLengthsByName(source).get(expression.expression.text)
    if (length === undefined) {
      return {
        unreadable: `${expression.expression.text} is not a module-scope array literal`,
      }
    }
    return { value: length }
  }

  return { unreadable: expression.getText() }
}

/**
 * How many declared cases this `examples:` value carries.
 *
 * An inline array literal is counted directly; an identifier is resolved to a
 * module-scope array literal. Anything else is unreadable and fails.
 */
function resolveCaseCount(
  expression: ts.Expression,
  source: ts.SourceFile
): Resolved {
  if (ts.isArrayLiteralExpression(expression)) {
    return { value: expression.elements.length }
  }

  if (ts.isIdentifier(expression)) {
    const length = arrayLengthsByName(source).get(expression.text)
    if (length === undefined) {
      return {
        unreadable: `${expression.text} is not a module-scope array literal`,
      }
    }
    return { value: length }
  }

  return { unreadable: expression.getText() }
}

/**
 * Distinct declared cases in a module (Requirement 42.8's ratchet).
 *
 * Distinct rather than summed per call site: three properties sharing one
 * five-case array have retained five counterexamples, not fifteen. Summing would
 * make the floor rise by adding a property, which is not what the requirement is
 * about.
 */
function declaredCaseCount(modulePath: string): number {
  const source = parseModule(modulePath)
  const bySource = new Map<string, number>()

  for (const site of assertSites(modulePath, source)) {
    const examples = optionValue(site.options, "examples")
    if (examples === undefined) continue

    const key = ts.isIdentifier(examples)
      ? examples.text
      : `inline@${site.line}`
    const resolved = resolveCaseCount(examples, source)

    expect(
      resolved,
      `${modulePath}:${site.line} declares examples the guard cannot read`
    ).toHaveProperty("value")

    if ("value" in resolved) bySource.set(key, resolved.value)
  }

  return [...bySource.values()].reduce((total, count) => total + count, 0)
}

// --- The forbidden modifiers ----------------------------------------------

/**
 * Every forbidden `test.skip` / `describe.only` style call in the module, as
 * readable labels.
 *
 * Matched on the AST, so a comment or a string mentioning `skip` is not a hit —
 * and neither is a legitimate `expect(…).toBe("skip")`.
 */
function modifierOffenders(
  modulePath: string,
  source: ts.SourceFile
): readonly string[] {
  const offenders: string[] = []

  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return

    let callee = node.expression
    const modifiers: string[] = []

    // Unwind `test.concurrent.skip` as well as `test.skip`.
    while (ts.isPropertyAccessExpression(callee)) {
      modifiers.unshift(callee.name.text)
      callee = callee.expression
    }

    if (!ts.isIdentifier(callee) || !TEST_CALLERS.has(callee.text)) return

    for (const modifier of modifiers) {
      if (FORBIDDEN_MODIFIERS.has(modifier)) {
        offenders.push(
          `${modulePath}:${lineOf(source, node)} ${callee.text}.${modifier}`
        )
      }
    }
  })

  return offenders
}

// ---------------------------------------------------------------------------

describe("Requirements 42.1, 42.7 — the scan sees the properties at all", () => {
  test("property modules are found", () => {
    const modules = listPropertyModules()

    expect(
      modules.length,
      `no ${PROPERTY_MODULE_SUFFIX} module was found under ` +
        `${PROPERTY_SEARCH_DIRECTORIES.join(", ")}, so every rule below would ` +
        `assert nothing`
    ).toBeGreaterThan(0)

    // Named anchors. A listing that stopped reaching one of these would leave
    // the rules green over the remainder.
    expect(modules).toEqual([...Object.keys(MINIMUM_DECLARED_CASES)].sort())
  })

  test("every property module registers in the ratchet", () => {
    // Exhaustive in the direction that matters: a module added later must be
    // registered before the suite passes, so its declared cases are ratcheted
    // from the day it lands.
    const unregistered = listPropertyModules().filter(
      (modulePath) => !(modulePath in MINIMUM_DECLARED_CASES)
    )

    expect(
      unregistered,
      `these property modules carry no entry in MINIMUM_DECLARED_CASES, so ` +
        `their declared counterexamples are not retained (Requirement 42.8)`
    ).toEqual([])
  })

  test("every property module contains at least one fc.assert", () => {
    for (const modulePath of listPropertyModules()) {
      const sites = assertSites(modulePath, parseModule(modulePath))

      expect(
        sites.length,
        `${modulePath} is named a property module but hands nothing to fast-check`
      ).toBeGreaterThan(0)
    }
  })

  test("the assert-site reader finds every call in a known module", () => {
    // The anchor for the reader. `lib/crypto.property.test.ts` carries five
    // properties, four of them with declared cases and one relying on the global
    // floor — which is the shape rule 3 below has to handle correctly.
    const modulePath = "lib/crypto.property.test.ts"
    const sites = assertSites(modulePath, parseModule(modulePath))

    expect(sites.length).toBe(5)
    expect(sites.filter((site) => site.options !== undefined).length).toBe(4)
  })
})

describe("Requirement 42.7 — no property is skipped, isolated or expected to fail", () => {
  test("no forbidden modifier appears in any property module", () => {
    const offenders = listPropertyModules().flatMap((modulePath) =>
      modifierOffenders(modulePath, parseModule(modulePath))
    )

    expect(
      offenders,
      `a property that does not run reports green while proving nothing; ` +
        `.only is included because it skips every sibling in the file`
    ).toEqual([])
  })

  test.each([
    ['test.skip("p", () => {})', true],
    ['it.skip("p", () => {})', true],
    ['describe.skip("p", () => {})', true],
    ['test.only("p", () => {})', true],
    ['describe.only("p", () => {})', true],
    ['test.todo("p")', true],
    ['test.fails("p", () => {})', true],
    ["test.skipIf(process.env.CI)('p', () => {})", true],
    ["test.runIf(process.env.CI)('p', () => {})", true],
    ['test.concurrent.skip("p", () => {})', true],
    // Permitted: the ordinary forms, and prose or data that merely says "skip".
    ['test("p", () => {})', false],
    ['describe("p", () => {})', false],
    ['test.each([1, 2])("p %i", () => {})', false],
    ["// do not test.skip this property", false],
    ['const message = "test.skip is forbidden here"', false],
    ['expect(outcome).toBe("skip")', false],
    // `fc.pre` is a precondition, not a skip: the global `maxSkipsPerRun` is
    // what bounds it, and Requirement 42.7 wants it bounded rather than banned.
    ["fc.pre(value > 0)", false],
  ] as const)("the detector on %s → %s", (source, expected) => {
    const parsed = parseSource(source)
    expect(modifierOffenders("synthetic", parsed).length > 0).toBe(expected)
  })
})

describe("Requirement 42.1 — every property runs at least 100 generated cases", () => {
  test("the global floor is configured in test/setup.ts", () => {
    // Read from the AST of the real file rather than trusted: this is the single
    // declaration that gives a property with no options of its own its 100 runs.
    const setup = parseModule(path.join("test", "setup.ts"))
    let configured: ts.ObjectLiteralExpression | undefined

    walk(setup, (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText().endsWith("configureGlobal") &&
        node.arguments[0] !== undefined &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        configured = node.arguments[0]
      }
    })

    expect(
      configured,
      "test/setup.ts calls no fc.configureGlobal"
    ).toBeDefined()

    const runs = optionValue(configured, "numRuns")
    expect(runs, "fc.configureGlobal declares no numRuns").toBeDefined()

    const resolved = resolveRunCount(runs!, setup)
    expect(resolved).toHaveProperty("value")
    expect("value" in resolved && resolved.value).toBeGreaterThanOrEqual(
      MINIMUM_RUNS
    )

    // Requirement 42.7's precondition bound. `maxSkips = maxSkipsPerRun *
    // numRuns`, so this is what makes a property that filters away most of its
    // input fail rather than pass over the remainder. Asserted as a ceiling so
    // it cannot be loosened.
    const skips = optionValue(configured, "maxSkipsPerRun")
    expect(skips, "fc.configureGlobal declares no maxSkipsPerRun").toBeDefined()
    expect(Number(skips!.getText())).toBeLessThanOrEqual(0.25)

    // Requirement 42.3 — the failure report carries the shrunk counterexample
    // with the seed that re-runs it.
    expect(optionValue(configured, "verbose")).toBeDefined()
  })

  test("no fc.assert declares a run count below the floor", () => {
    const offenders: string[] = []

    for (const modulePath of listPropertyModules()) {
      const source = parseModule(modulePath)

      for (const site of assertSites(modulePath, source)) {
        const runs = optionValue(site.options, "numRuns")
        // No declaration is fine: the global floor above applies.
        if (runs === undefined) continue

        const resolved = resolveRunCount(runs, source)
        if ("unreadable" in resolved) {
          offenders.push(
            `${modulePath}:${site.line} declares numRuns the guard cannot read: ` +
              resolved.unreadable
          )
        } else if (resolved.value < MINIMUM_RUNS) {
          offenders.push(
            `${modulePath}:${site.line} declares numRuns=${resolved.value}, below ` +
              `the floor of ${MINIMUM_RUNS}`
          )
        }
      }
    }

    expect(offenders).toEqual([])
  })

  test("a property with declared cases raises its budget to cover them", () => {
    // The rule that is easy to get wrong in the direction that looks right:
    // fast-check yields declared examples from the same budget as generated
    // ones, so retaining five counterexamples at the floor of 100 silently
    // drops the generated count to 95. Satisfying Requirement 42.8 must not
    // cost Requirement 42.1.
    const offenders: string[] = []

    for (const modulePath of listPropertyModules()) {
      const source = parseModule(modulePath)

      for (const site of assertSites(modulePath, source)) {
        const examples = optionValue(site.options, "examples")
        if (examples === undefined) continue

        const cases = resolveCaseCount(examples, source)
        if ("unreadable" in cases) {
          offenders.push(
            `${modulePath}:${site.line} declares examples the guard cannot read: ` +
              cases.unreadable
          )
          continue
        }

        const runs = optionValue(site.options, "numRuns")
        if (runs === undefined) {
          offenders.push(
            `${modulePath}:${site.line} declares ${cases.value} cases but no ` +
              `numRuns, so it generates ${MINIMUM_RUNS - cases.value} cases ` +
              `rather than ${MINIMUM_RUNS}`
          )
          continue
        }

        const resolved = resolveRunCount(runs, source)
        if ("unreadable" in resolved) {
          offenders.push(
            `${modulePath}:${site.line} declares numRuns the guard cannot read: ` +
              resolved.unreadable
          )
        } else if (resolved.value < MINIMUM_RUNS + cases.value) {
          offenders.push(
            `${modulePath}:${site.line} declares ${cases.value} cases at ` +
              `numRuns=${resolved.value}; needs at least ` +
              `${MINIMUM_RUNS + cases.value}`
          )
        }
      }
    }

    expect(offenders).toEqual([])
  })

  test.each([
    ["128", 128],
    ["100", 100],
    ["NUM_RUNS", 105],
    ["100 + EXAMPLES.length", 105],
    ["EXAMPLES.length", 5],
  ] as const)(
    "the run-count resolver reads %s as %i",
    (expression, expected) => {
      const source = parseSource(
        "const EXAMPLES = [1, 2, 3, 4, 5]\n" +
          "const NUM_RUNS = 100 + EXAMPLES.length\n" +
          `fc.assert(fc.property(g, f), { numRuns: ${expression} })\n`
      )
      const runs = optionValue(
        assertSites("synthetic", source)[0].options,
        "numRuns"
      )

      expect(resolveRunCount(runs!, source)).toEqual({ value: expected })
    }
  )

  test.each(["someRunCount", "config.numRuns", "Math.max(100, 4)", "100 * 2"])(
    "the resolver refuses to guess at %s",
    (expression) => {
      // Failing closed is the point. A guard that assumed an unreadable
      // expression was ≥ 100 would be enforcing nothing on exactly the sites that
      // stopped being simple.
      const source = parseSource(
        `fc.assert(fc.property(g, f), { numRuns: ${expression} })\n`
      )
      const runs = optionValue(
        assertSites("synthetic", source)[0].options,
        "numRuns"
      )

      expect(resolveRunCount(runs!, source)).toHaveProperty("unreadable")
    }
  )
})

describe("Requirement 42.8 — a fixed counterexample stays fixed", () => {
  test.each(Object.entries(MINIMUM_DECLARED_CASES))(
    "%s retains at least %i declared cases",
    (modulePath, minimum) => {
      // The ratchet. A declared case is the committed form of "this input broke
      // us once" — the only form that runs for everyone on every subsequent
      // execution.
      expect(
        existsSync(path.join(projectRoot, modulePath)),
        `${modulePath} is absent`
      ).toBe(true)

      expect(
        declaredCaseCount(modulePath),
        `${modulePath} declares fewer cases than it did; raise the entry when you ` +
          `add one, never lower it`
      ).toBeGreaterThanOrEqual(minimum)
    }
  )

  test("the recorded total still accounts for the tree", () => {
    // Catches what the per-module ratchet cannot: deleting an entry from the map
    // together with the cases it guarded. The per-module test would then simply
    // not run for that module, and report green.
    const total = listPropertyModules().reduce(
      (sum, modulePath) => sum + declaredCaseCount(modulePath),
      0
    )

    expect(total).toBeGreaterThanOrEqual(MINIMUM_DECLARED_CASES_TOTAL)
    expect(
      Object.values(MINIMUM_DECLARED_CASES).reduce((sum, n) => sum + n, 0)
    ).toBeGreaterThanOrEqual(MINIMUM_DECLARED_CASES_TOTAL)
  })

  test("cases shared by several properties are counted once", () => {
    // The distinctness rule, proven rather than described. Three properties
    // sharing one five-case array have retained five counterexamples; summing
    // per call site would report fifteen and let the floor rise by adding a
    // property that retains nothing new.
    const source = parseSource(
      "const EXAMPLES = [1, 2, 3, 4, 5]\n" +
        "fc.assert(fc.property(g, f), { numRuns: 105, examples: EXAMPLES })\n" +
        "fc.assert(fc.property(g, f), { numRuns: 105, examples: EXAMPLES })\n" +
        "fc.assert(fc.property(g, f), { numRuns: 105, examples: EXAMPLES })\n"
    )

    const distinct = new Map<string, number>()
    for (const site of assertSites("synthetic", source)) {
      const examples = optionValue(site.options, "examples")!
      const resolved = resolveCaseCount(examples, source)
      if ("value" in resolved) {
        distinct.set((examples as ts.Identifier).text, resolved.value)
      }
    }

    expect(assertSites("synthetic", source).length).toBe(3)
    expect([...distinct.values()].reduce((a, b) => a + b, 0)).toBe(5)
  })

  test("the case counter reads both the inline and the referenced form", () => {
    const source = parseSource(
      "const EXAMPLES = [1, 2]\n" +
        "fc.assert(fc.property(g, f), { numRuns: 102, examples: EXAMPLES })\n" +
        "fc.assert(fc.property(g, f), { numRuns: 103, examples: [[1], [2], [3]] })\n"
    )
    const sites = assertSites("synthetic", source)

    expect(
      resolveCaseCount(optionValue(sites[0].options, "examples")!, source)
    ).toEqual({ value: 2 })
    expect(
      resolveCaseCount(optionValue(sites[1].options, "examples")!, source)
    ).toEqual({ value: 3 })
  })
})

/** A clean execution: 100 accepted generated cases, nothing rejected, one seed. */
function execution(
  overrides: Partial<ledger.Execution> = {}
): ledger.Execution {
  return {
    modulePath: "lib/synthetic.property.test.ts",
    testName: "a synthetic property",
    framework: ledger.FAST_CHECK,
    accepted: 100,
    rejected: 0,
    declaredCases: 0,
    seed: 42,
    failed: false,
    ...overrides,
  }
}

describe("Requirement 45.7 — the set executed equals the set declared", () => {
  test("every property module belongs to exactly one declared property", () => {
    // A module belonging to no declared property is a property added to the
    // design and never registered: it runs, but nothing asserts that it ran and
    // nothing would notice if it stopped.
    expect(
      ledger.unclassifiedModules(),
      `these property modules belong to no declared property, so nothing asserts ` +
        `that they ran; register each one in test/property-ledger.ts under the ` +
        `design property it realizes`
    ).toEqual([])

    // And the other direction: a declared module absent from disk is a rename
    // that took its property's identity with it.
    expect(
      ledger.undeclaredModules(),
      `these modules are declared in test/property-ledger.ts and absent from disk; ` +
        `a renamed property module takes its declaration with it`
    ).toEqual([])
  })

  test("the two discovery walks descend the same directories", () => {
    // The walk above (`listPropertyModules`) scans for hygiene; the ledger's own walk
    // classifies. They are separate implementations on purpose, and nothing but this
    // assertion forces them to agree — so a directory added to one alone splits the
    // guarantee in a way that reads green from either side. A module under a directory
    // only the ledger knows is registered and never scanned for a lowered `numRuns` or
    // a `test.skip`; a module under a directory only the scan knows is reported by
    // `undeclaredModules()` as a rename that never happened. Both were live: `test/`
    // was added to the scan first and this test is what caught the ledger still missing it.
    expect([...PROPERTY_SEARCH_DIRECTORIES].sort()).toEqual(
      [...ledger.SEARCH_DIRECTORIES].sort()
    )
  })

  test("the declared set is design.md's Properties 8 to 12", () => {
    expect(
      Object.keys(ledger.SPEC_PROPERTIES)
        .map(Number)
        .sort((a, b) => a - b)
    ).toEqual([8, 9, 10, 11, 12])

    // Each declared property names at least one module, and each module is named
    // once. A property declared over zero modules would pass every gate below.
    const named = Object.values(ledger.SPEC_PROPERTIES).flatMap(
      (d) => d.modules
    )
    expect(named.length).toBeGreaterThanOrEqual(5)
    expect(new Set(named).size).toBe(named.length)
  })

  test("the ratchet and the property registry name the same modules", () => {
    // The two maps are indexed differently and nothing forces them to agree, so a
    // module added to one and not the other would be half-guarded: ratcheted but
    // unregistered, or registered but with its declared cases free to be deleted.
    expect([...ledger.declaredModules().keys()].sort()).toEqual(
      Object.keys(MINIMUM_DECLARED_CASES).sort()
    )
  })

  test("every declared module hands at least one property to fast-check", () => {
    // The other half of "registered and never run": a module emptied of its
    // `fc.assert` calls satisfies both directions above and contributes nothing.
    for (const [modulePath, owner] of ledger.declaredModules()) {
      const sites = assertSites(modulePath, parseModule(modulePath))

      expect(
        sites.length,
        `${modulePath} is declared as ${owner} and hands nothing to fast-check`
      ).toBeGreaterThan(0)
    }
  })
})

describe("Requirement 45.8 — each property records four values, observably", () => {
  test("test/setup.ts installs a reporter that records them", () => {
    // Read from the AST of the real file. A `reporter` is what makes fast-check
    // call back on **every** run rather than only on a failure, so it is the
    // observation point — and because it also replaces fast-check's own
    // throw-on-failure, the `throw` beside it is load-bearing rather than
    // decorative. Both are asserted here.
    const setup = parseModule(path.join("test", "setup.ts"))
    let configured: ts.ObjectLiteralExpression | undefined

    walk(setup, (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText().endsWith("configureGlobal") &&
        node.arguments[0] !== undefined &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        configured = node.arguments[0]
      }
    })

    const reporter = optionValue(configured, "reporter")
    expect(
      reporter,
      "fc.configureGlobal declares no reporter, so no property records anything " +
        "(Requirement 45.8)"
    ).toBeDefined()

    const body = reporter!.getText()
    for (const field of [
      "framework",
      "accepted",
      "rejected",
      "declaredCases",
      "seed",
    ]) {
      expect(
        body.includes(field),
        `the reporter records no ${field}; Requirement 45.8 names the framework, the ` +
          `accepted-case count, the precondition rejection fraction and the seed`
      ).toBe(true)
    }

    let throws = false
    walk(reporter!, (node) => {
      if (ts.isThrowStatement(node)) throws = true
    })
    expect(
      throws,
      "a configured reporter replaces fast-check's throw-on-failure, so a reporter " +
        "that does not throw turns every failing property into a passing test"
    ).toBe(true)
  })

  test("test/setup.ts gates each module's records in an afterAll", () => {
    // Where enforcement has to live. Vitest logs an error thrown from a
    // `globalSetup` teardown and still exits zero, so a gate there would read like
    // one and not be one. An `afterAll` fails its file, and a failed file fails
    // the run.
    const setup = readProjectFile(path.join("test", "setup.ts"))

    expect(setup).toContain("afterAll")
    expect(setup).toContain("gateModule")
    expect(
      /throw new Error\(/.test(setup),
      "test/setup.ts computes the gate and does not throw on it, so a property that " +
        "stopped running would be printed and passed"
    ).toBe(true)
  })

  test("vitest.config.ts registers the whole-run roll-up", () => {
    // The roll-up reports what a per-file check cannot see. It does not enforce —
    // see the module header — but if it is not registered, the ledger directory is
    // never emptied either, and stale records from an earlier run would be read as
    // this one's.
    const config = readProjectFile("vitest.config.ts")

    expect(config).toContain("globalSetup")
    expect(config).toContain("./test/property-ledger.global.ts")
  })

  test("every declared module is inside the node project's include patterns", () => {
    // The one case a per-file gate structurally cannot reach: a module Vitest never
    // collects has no `afterAll` to fail in. Closed here instead, statically. The
    // node project includes `lib/**/*.test.ts`, so a declared module outside `lib/`
    // or not ending in `.test.ts` would silently never run.
    const config = readProjectFile("vitest.config.ts")
    // Both patterns, read from the config rather than assumed: the node project collects
    // `lib/**` and `test/**`, and a declared module outside both would silently never run.
    for (const pattern of ['"lib/**/*.test.ts"', '"test/**/*.test.ts"']) {
      expect(config).toContain(pattern)
    }

    for (const modulePath of ledger.declaredModules().keys()) {
      expect(
        (modulePath.startsWith("lib/") || modulePath.startsWith("test/")) &&
          modulePath.endsWith(".test.ts"),
        `${modulePath} is declared as a property module and does not match the node ` +
          `project's include patterns, so Vitest would never collect it`
      ).toBe(true)
    }
  })

  test("the execution ratchet is at least the fc.assert calls each module holds", () => {
    // Ties the runtime ratchet to the source. Adding an `fc.assert` therefore
    // forces the entry up rather than leaving a new property unwatched; the counts
    // are executions rather than sites because a `test.each` block is one site run
    // many times.
    for (const [modulePath] of ledger.declaredModules()) {
      const sites = assertSites(modulePath, parseModule(modulePath)).length
      const declared = ledger.MINIMUM_EXECUTIONS[modulePath]

      expect(
        declared,
        `${modulePath} carries no entry in MINIMUM_EXECUTIONS, so nothing would ` +
          `notice one of its properties going inert`
      ).toBeDefined()
      expect(
        declared,
        `${modulePath} holds ${sites} fc.assert calls and ratchets only ${declared} ` +
          `executions; raise the entry`
      ).toBeGreaterThanOrEqual(sites)
    }

    // And no entry names a module that is not a declared property module.
    expect(Object.keys(ledger.MINIMUM_EXECUTIONS).sort()).toEqual(
      [...ledger.declaredModules().keys()].sort()
    )
  })

  test("every recorded execution carries four values and meets the thresholds", () => {
    // Over whatever is on disk when this runs — a real check and not a complete
    // one; see this module's header for why completeness belongs to the global
    // teardown. An empty ledger is not a failure here, because this file may be
    // the first one Vitest finished.
    const recorded = ledger.readLedger()
    const offenders = recorded.flatMap((execution) =>
      ledger.gateExecution(execution)
    )

    expect(
      offenders,
      `the recorded executions do not meet the thresholds Requirements 45.1 and ` +
        `45.4 declare`
    ).toEqual([])

    for (const execution of recorded) {
      expect(execution.framework).toBe(ledger.FAST_CHECK)
      expect(Number.isInteger(execution.seed)).toBe(true)
      expect(execution.accepted).toBeGreaterThan(0)
    }
  })

  test.each([
    // A run below the floor once its declared cases are taken back out —
    // Requirement 45.5's "in addition to", which is the arithmetic a property
    // satisfying 42.8 at the bare floor gets wrong.
    [{ accepted: 104, declaredCases: 5 }, true],
    [{ accepted: 105, declaredCases: 5 }, false],
    [{ accepted: 99 }, true],
    [{ accepted: 100 }, false],
    // Requirement 45.4's precondition ceiling: 25 skips against 100 accepted is
    // 20% of what was generated, and 26 is over.
    [{ rejected: 25 }, false],
    [{ rejected: 26 }, true],
    // Requirements 45.3 and 45.8: a run nobody can reproduce.
    [{ seed: Number.NaN }, true],
    // A property that quietly moved to another engine.
    [{ framework: "hypothesis" }, true],
    // A failure the reporter recorded rather than raised.
    [{ failed: true }, true],
  ] as const)("the gate on %o → offends: %s", (overrides, expected) => {
    expect(ledger.gateExecution(execution(overrides)).length > 0).toBe(expected)
  })

  test("the property gate reports a declared property that never ran", () => {
    const offenders = ledger.gateProperty(ledger.SPEC_PROPERTIES[12], [])

    expect(offenders.length).toBe(1)
    expect(offenders[0]).toContain("executed no property at all")
  })

  test("the module gate reports a module that ran fewer properties than it holds", () => {
    // The case a per-execution check cannot see: eight of nine `fc.assert` calls
    // ran, so every recorded number is healthy and one property never executed.
    const [modulePath] = ledger.SPEC_PROPERTIES[12].modules
    const one = execution({ modulePath, testName: "one of several" })

    const offenders = ledger.gateModule(modulePath, [one])
    expect(offenders.length).toBe(1)
    expect(offenders[0]).toContain(
      `recorded 1 property executions, down from ` +
        `${ledger.MINIMUM_EXECUTIONS[modulePath]}`
    )
  })

  test("the module gate reads the aggregate across a module's assertions", () => {
    // Requirement 45.1 bounds a *property*, and a property here is every
    // `fc.assert` in its module. The floor is therefore on the claim rather than on
    // each assertion of it — while a module whose assertions total ninety fails.
    const [modulePath] = ledger.SPEC_PROPERTIES[12].modules
    const minimum = ledger.MINIMUM_EXECUTIONS[modulePath]
    const runs = (accepted: number): readonly ledger.Execution[] =>
      Array.from({ length: minimum }, (_unused, index) =>
        execution({ modulePath, testName: `assertion ${index}`, accepted })
      )

    // Each assertion below the per-execution floor, so both rules report.
    const thin = ledger.gateModule(modulePath, runs(9))
    expect(thin.some((line) => line.includes("below the floor"))).toBe(true)

    expect(ledger.gateModule(modulePath, runs(100))).toEqual([])
  })

  test("an unregistered module is recorded and not gated", () => {
    // `lib/session-id.test.ts` and `lib/db/views.test.ts` reach for fast-check for
    // one assertion each without being properties of this spec. Holding them to a
    // property's contract would make the contract about the tool rather than about
    // the claim.
    const stranger = execution({
      modulePath: "lib/session-id.test.ts",
      accepted: 3,
      seed: Number.NaN,
    })

    expect(ledger.gateModule("lib/session-id.test.ts", [stranger])).toEqual([])
  })

  test("gateLedger narrows to the properties an invocation selected", () => {
    // A single-file run is not this spec's suite, and reporting it as a suite in
    // which eleven properties failed to run would train everyone to ignore the
    // output. An unreadable file list reports on everything instead.
    const everything = ledger.gateLedger([])
    expect(everything.length).toBe(ledger.declaredProperties().length)

    const [selected] = ledger.SPEC_PROPERTIES[12].modules
    const narrowed = ledger.gateLedger([], new Set([selected]))
    expect(narrowed.length).toBe(1)
    expect(narrowed[0]).toContain(selected)
  })

  test("the printed table carries all four values for every execution", () => {
    const [modulePath] = ledger.SPEC_PROPERTIES[12].modules
    const rendered = ledger
      .formatLedger([
        execution({
          modulePath,
          accepted: 145,
          rejected: 10,
          declaredCases: 5,
          seed: 777,
        }),
      ])
      .join("\n")

    expect(rendered).toContain(ledger.FAST_CHECK) // framework
    expect(rendered).toContain("140 accepted") // accepted cases, minus the declared
    expect(rendered).toContain("6.5%") // precondition rejection fraction
    expect(rendered).toContain("seed=777") // the seed that reproduces it
    expect(rendered).toContain("+5 declared") // Requirement 45.5, in addition
  })
})

// ---------------------------------------------------------------------------
// Requirement 22.10 — the paper rendering's deciding test must be present, not
// skipped, and not marked as an expected failure. Without this, the fallback to
// "text_extract" that Requirement 22.8 declares is entered on a test nobody ran
// rather than on a proven condition.
// ---------------------------------------------------------------------------

describe("Requirement 22.10 — the deciding test is present and not disabled", () => {
  const DECIDING_TEST = "test/paper-render.dom.test.tsx"

  test("the deciding test file exists", () => {
    expect(
      existsSync(path.join(projectRoot, DECIDING_TEST)),
      `${DECIDING_TEST} is absent; the paper rendering's claim (Requirement 22.8) ` +
        `falls back to "text_extract" on a condition nobody proved`
    ).toBe(true)
  })

  test("no forbidden modifier appears in the deciding test", () => {
    const source = parseModule(DECIDING_TEST)
    const offenders = modifierOffenders(DECIDING_TEST, source)

    expect(
      offenders,
      `the deciding test carries a skip or expected-failure marker; the ` +
        `paper rendering's claim cannot be "approximation" on a test that ` +
        `does not run`
    ).toEqual([])
  })
})
