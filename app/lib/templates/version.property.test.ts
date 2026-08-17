import { createHash } from "node:crypto"

import { describe, expect, test } from "vitest"
import fc from "fast-check"

import { type CanonicalizableValue } from "@/lib/templates/canonical-json"
import {
  DENSITY_VALUES,
  DESIGN_PRESETS,
  NAME_MAX_LENGTH,
  PAGE_SIZE_VALUES,
  TABLE_STYLE_VALUES,
  collectDefinitionIssues,
  type TemplateDefinition,
} from "@/lib/templates/definition"
import {
  canonicalDefinitionJson,
  definitionSha256,
} from "@/lib/templates/version"

/**
 * **Property 11: the definition digest is stable, sensitive and cross-language.**
 *
 * **Validates: Requirements 9.4, 9.5, 2.11, 45.1, 45.3, 45.4**
 *
 * *For any* definition, `definition_sha256` is byte-identical under every
 * permutation of object key insertion order, and differs for any change to any
 * value or key spelling — including a change that is only a Unicode
 * normalization form.
 *
 * ## The cross-language half is task 5.2's, not this file's
 *
 * design.md's Property 11 has three assertions and this module can only carry
 * two of them. "For every fixture in the shared corpus, the app's digest equals
 * the agent's" is by construction not assertable from one language: it needs
 * `agent/src/reporting_agent/compile/definition.py`'s canonicalization to exist
 * and the shared fixture corpus to be readable from both halves. That is the
 * Mirror_Guard's job in `app/test/mirror.static.test.ts` (task 5.2), which
 * imports {@link definitionSha256} from this same module — so the two halves of
 * the property agree on which function is under test.
 *
 * What this file can do, and does, is make the *single-language* half sharp
 * enough that a cross-language disagreement is the only failure left for the
 * Mirror_Guard to find. In particular, permutation invariance alone does **not**
 * kill the implementation design.md names first — a digest over `JSON.stringify`
 * with `Object.keys().sort()` is *also* permutation-invariant, because it sorts
 * too; it just sorts by UTF-16 code unit where RFC 8785 and Python's
 * `sorted()` sort by code point. A property that only permuted would pass on it
 * and leave the defect for task 5.2. So the ordering is pinned directly, against
 * a key pair whose two orderings genuinely disagree:
 *
 *   * `"\uFB00"` (U+FB00) is one UTF-16 code unit, `0xFB00`.
 *   * `"\u{1F9EA}"` (U+1F9EA) is the surrogate pair `0xD83E 0xDDEA`.
 *
 * As code points, `0xFB00 < 0x1F9EA`. As UTF-16 code units, `0xD83E < 0xFB00` —
 * the opposite order. Both keys are present in **every** value this module
 * generates, in both generator branches, and the divergence itself is asserted
 * ("the astral/BMP key pair orders one way by code point and the other by
 * UTF-16") rather than trusted from the arithmetic above. Two named cases then
 * assert the canonical string is in code-point order and that the naive digest
 * built the other way differs from this module's.
 *
 * ## Why the generator is purpose-built rather than reusing Property 8's
 *
 * `definition.property.test.ts` carries a mature `validCaseArb`. It is not
 * reused here, and not exported for the purpose, for two reasons.
 *
 * The first is that Property 11's generator needs things a *definition-shaped*
 * generator structurally cannot express: keys that differ only by letter case,
 * keys that differ only by NFC/NFD spelling, a key above the BMP beside a key in
 * `U+E000`–`U+FFFF`, an empty object, and nesting deeper than a definition's own
 * grammar. `validCaseArb` draws valid definitions, and a definition's key set is
 * closed — every undeclared key is a validation error — so the character classes
 * design.md's table names have nowhere to live in it.
 *
 * The second is that the subject under test is the **digest construction**, not
 * template semantics. `definitionSha256` never looks at what a key means. A
 * generator over arbitrary canonicalizable values covers strictly more of its
 * input space than one over definitions, and the alternative — exporting
 * `validCaseArb` from a test module so a second test module can import it —
 * couples two properties through a shared fixture that neither owns.
 *
 * design.md's table does name "definitions from Property 8's valid space", so
 * that branch is present rather than dropped: {@link definitionArb} generates
 * genuinely valid definitions (asserted by `collectDefinitionIssues` returning
 * an empty list, so the branch cannot rot into an invalid shape), with the
 * hostile character classes placed in the fields that legitimately admit them —
 * `identity.name`, `identity.description`, `identity.report_title`, block
 * `heading`/`rich_text` text, and the `metrics` object's resource-type **keys**,
 * which are the one key position in a definition that is an open string.
 *
 * ## Declared cases
 *
 * Six, shared by all four properties (Requirement 45.5 / 42.8). They are the
 * character classes the task text names, each as a complete value rather than a
 * fragment, because the sensitivity property applies every mutator to every case
 * and a fragment would make half the mutators inapplicable. `numRuns` is raised
 * to `100 + HOSTILE_EXAMPLES.length`: fast-check draws declared cases from the
 * same budget as generated ones, so the floor of 100 *generated* cases
 * (Requirement 45.1) has to be asked for explicitly.
 */

// --- The character classes, named once -------------------------------------

/** Above the BMP: the surrogate pair `0xD83E 0xDDEA`. */
const ASTRAL_KEY = "\u{1F9EA}"

/**
 * `U+FB00`, one UTF-16 code unit above the surrogate range. Paired with
 * {@link ASTRAL_KEY} this is the key pair whose code-point order and UTF-16
 * code-unit order disagree — the pair that makes the ordering assertions
 * non-vacuous.
 */
const BMP_ABOVE_SURROGATES_KEY = "\uFB00"

/** A second astral character, for a value rather than a key. */
const ASTRAL_TEXT = "\u{1D11E}"

/** Two keys differing only by letter case. */
const CASE_LOWER_KEY = "casesensitive"
const CASE_UPPER_KEY = "CaseSensitive"

/** Two spellings of `é` differing only by normalization form. */
const NFC_TEXT = "\u00e9"
const NFD_TEXT = "e\u0301"

/** Every character JSON has to escape, plus two control characters. */
const ESCAPE_HEAVY_TEXT = '"\\\b\f\n\r\t\u0000\u001f'

const ASCII_TEXT = "plain-ascii-0123"

// --- Digest-independent helpers --------------------------------------------

/**
 * Local narrowing helpers rather than bare `Array.isArray` / `typeof`.
 *
 * `Array.isArray`'s signature narrows to `any[]`, which does not admit the
 * `readonly CanonicalizableValue[]` member of the union, so the walkers below
 * would end up casting at every call site. One predicate each, once.
 */
function isArrayValue(
  value: CanonicalizableValue
): value is readonly CanonicalizableValue[] {
  return Array.isArray(value)
}

type ObjectValue = { readonly [key: string]: CanonicalizableValue }

function isObjectValue(value: CanonicalizableValue): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function keysOf(value: ObjectValue): string[] {
  return Object.keys(value)
}

/** The top-level key order, as a comparable string. */
function keyOrderOf(value: CanonicalizableValue): string {
  return JSON.stringify(isObjectValue(value) ? keysOf(value) : [])
}

/** Unicode-code-point comparison, restated locally rather than imported. */
function byCodePoint(a: string, b: string): number {
  const left = Array.from(a, (char) => char.codePointAt(0) ?? 0)
  const right = Array.from(b, (char) => char.codePointAt(0) ?? 0)

  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference
  }

  return left.length - right.length
}

/**
 * A small linear congruential generator.
 *
 * Deterministic from a drawn seed, so a reported counterexample reproduces the
 * exact set of key orders that broke — which `Math.random` would not.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function shuffled(items: readonly string[], random: () => number): string[] {
  const output = [...items]
  for (let i = output.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[output[i], output[j]] = [output[j], output[i]]
  }
  return output
}

/**
 * `value` rebuilt with every object's keys in the order `order` chooses,
 * recursively.
 *
 * Recursive on purpose: a shuffle of only the top-level keys would leave every
 * nested object in its generated order, and the nested objects are where a
 * definition's real key sets live. Arrays keep their element order — JSON arrays
 * are ordered, and reordering one is a *change*, which the sensitivity property
 * asserts separately.
 */
function reorderKeys(
  value: CanonicalizableValue,
  order: (keys: readonly string[]) => readonly string[]
): CanonicalizableValue {
  if (isArrayValue(value)) {
    return value.map((item) => reorderKeys(item, order))
  }
  if (isObjectValue(value)) {
    const rebuilt: Record<string, CanonicalizableValue> = {}
    for (const key of order(keysOf(value))) {
      rebuilt[key] = reorderKeys(value[key], order)
    }
    return rebuilt
  }
  return value
}

/** How many key orders each generated value is digested under. */
const PERMUTATION_COUNT = 12

/**
 * `PERMUTATION_COUNT` orderings of `value`.
 *
 * The first four are fixed rather than random — identity, reversed, code-point
 * ascending, code-point descending — so "the permuter actually reordered
 * something" is true by construction for any object with two or more keys,
 * instead of being true with high probability for a drawn seed. A property whose
 * non-vacuity depends on a lucky shuffle is a property that flakes.
 */
function permutations(
  value: CanonicalizableValue,
  seed: number
): CanonicalizableValue[] {
  const random = seededRandom(seed)

  const orders: ((keys: readonly string[]) => readonly string[])[] = [
    (keys) => keys,
    (keys) => [...keys].reverse(),
    (keys) => [...keys].sort(byCodePoint),
    (keys) => [...keys].sort((a, b) => byCodePoint(b, a)),
  ]

  while (orders.length < PERMUTATION_COUNT) {
    orders.push((keys) => shuffled(keys, random))
  }

  return orders.map((order) => reorderKeys(value, order))
}

/**
 * A key not already present on `value`, derived rather than hoped for.
 *
 * The generators draw keys from fast-check's binary alphabet, so no hand-picked
 * literal can be *guaranteed* absent. Deriving one keeps the "renamed key" and
 * "added key" mutators from silently colliding with an existing key, which would
 * turn a rename into a value overwrite and quietly change what is being tested.
 */
function unusedKey(value: ObjectValue): string {
  let candidate = "$$property-11-probe$$"
  while (candidate in value) candidate += "z"
  return candidate
}

// --- Sensitivity mutators ---------------------------------------------------

type Mutation = {
  readonly changed: boolean
  readonly value: CanonicalizableValue
}

/**
 * `value` with the **first** node matching `match`, in depth-first pre-order,
 * replaced by `transform`'s result.
 *
 * Structure-sharing rather than mutating: every object and array on the path is
 * rebuilt and nothing else is touched, so a mutator cannot accidentally become
 * the thing the no-mutation property is meant to catch.
 */
function transformFirst(
  value: CanonicalizableValue,
  match: (candidate: CanonicalizableValue) => boolean,
  transform: (matched: CanonicalizableValue) => CanonicalizableValue
): Mutation {
  if (match(value)) return { changed: true, value: transform(value) }

  if (isArrayValue(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = transformFirst(value[index], match, transform)
      if (result.changed) {
        const rebuilt = [...value]
        rebuilt[index] = result.value
        return { changed: true, value: rebuilt }
      }
    }
    return { changed: false, value }
  }

  if (isObjectValue(value)) {
    for (const key of keysOf(value)) {
      const result = transformFirst(value[key], match, transform)
      if (result.changed) {
        return { changed: true, value: { ...value, [key]: result.value } }
      }
    }
    return { changed: false, value }
  }

  return { changed: false, value }
}

type Mutator = {
  readonly what: string
  readonly apply: (value: CanonicalizableValue) => Mutation
}

/**
 * Every kind of change the task text names, each one applicable to **every**
 * value either generator produces — which is asserted, not assumed: the
 * sensitivity property fails a mutator that found nothing to change, because a
 * mutator that silently no-ops turns "the digest differs" into a comparison of
 * a value with itself, which would pass while proving nothing.
 */
const MUTATORS: readonly Mutator[] = [
  {
    what: "a string value",
    apply: (value) =>
      transformFirst(
        value,
        (candidate) => typeof candidate === "string",
        (matched) => `${matched as string}\u2603`
      ),
  },
  {
    what: "a number",
    apply: (value) =>
      transformFirst(
        value,
        (candidate) => typeof candidate === "number",
        (matched) => (matched as number) + 1
      ),
  },
  {
    what: "a boolean",
    apply: (value) =>
      transformFirst(
        value,
        (candidate) => typeof candidate === "boolean",
        (matched) => !(matched as boolean)
      ),
  },
  {
    what: "null replaced by false",
    apply: (value) =>
      transformFirst(
        value,
        (candidate) => candidate === null,
        () => false
      ),
  },
  {
    what: "an array's element order",
    apply: (value) =>
      transformFirst(
        value,
        (candidate) =>
          isArrayValue(candidate) &&
          candidate.length >= 2 &&
          // Two elements with the same canonical form make a swap a no-op, so
          // the match requires elements that actually differ. JSON arrays are
          // ordered, so a real swap must change the digest.
          canonicalDefinitionJson(candidate[0]) !==
            canonicalDefinitionJson(candidate[1]),
        (matched) => {
          const items = [...(matched as readonly CanonicalizableValue[])]
          const head = items[0]
          items[0] = items[1]
          items[1] = head
          return items
        }
      ),
  },
  {
    what: "an empty array swapped for an empty object",
    apply: (value) =>
      transformFirst(
        value,
        (candidate) => isArrayValue(candidate) && candidate.length === 0,
        () => ({})
      ),
  },
  {
    what: "a renamed top-level key",
    apply: (value) => {
      if (!isObjectValue(value)) return { changed: false, value }
      const keys = keysOf(value)
      if (keys.length === 0) return { changed: false, value }
      const [first, ...rest] = keys
      const rebuilt: Record<string, CanonicalizableValue> = {
        [unusedKey(value)]: value[first],
      }
      for (const key of rest) rebuilt[key] = value[key]
      return { changed: true, value: rebuilt }
    },
  },
  {
    what: "an added key",
    apply: (value) => {
      if (!isObjectValue(value)) return { changed: false, value }
      return { changed: true, value: { ...value, [unusedKey(value)]: null } }
    },
  },
  {
    what: "a removed key",
    apply: (value) => {
      if (!isObjectValue(value)) return { changed: false, value }
      const keys = keysOf(value)
      if (keys.length === 0) return { changed: false, value }
      const rebuilt: Record<string, CanonicalizableValue> = {}
      for (const key of keys.slice(1)) rebuilt[key] = value[key]
      return { changed: true, value: rebuilt }
    },
  },
  {
    what: "a renamed nested key",
    apply: (value) =>
      transformFirst(
        value,
        // `candidate !== value` is what makes this reach *below* the root: the
        // walk is pre-order, so without it this mutator would be a second copy
        // of the top-level rename.
        (candidate) =>
          candidate !== value &&
          isObjectValue(candidate) &&
          keysOf(candidate).length > 0,
        (matched) => {
          const object = matched as ObjectValue
          const [first, ...rest] = keysOf(object)
          const rebuilt: Record<string, CanonicalizableValue> = {
            [unusedKey(object)]: object[first],
          }
          for (const key of rest) rebuilt[key] = object[key]
          return rebuilt
        }
      ),
  },
]

// --- Generators -------------------------------------------------------------

const hostileFragmentArb = fc.constantFrom(
  ASCII_TEXT,
  ASTRAL_TEXT,
  NFC_TEXT,
  NFD_TEXT,
  ESCAPE_HEAVY_TEXT,
  CASE_LOWER_KEY,
  CASE_UPPER_KEY,
  ""
)

/**
 * A string built from the named classes, plus one drawn from fast-check's own
 * binary alphabet so combining marks, control characters and code points nobody
 * thought to name are reached too. `unit: "binary"` excludes half surrogates,
 * which is what keeps every generated value one a JSON document could actually
 * carry.
 */
const hostileStringArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.array(hostileFragmentArb, { minLength: 1, maxLength: 3 }),
    fc.string({ unit: "binary", maxLength: 8 })
  )
  .map(([fragments, free]) => fragments.join("") + free)

const hostileKeyArb: fc.Arbitrary<string> = fc.oneof(
  hostileStringArb,
  fc.constantFrom(
    ASTRAL_KEY,
    BMP_ABOVE_SURROGATES_KEY,
    CASE_LOWER_KEY,
    CASE_UPPER_KEY,
    NFC_TEXT,
    NFD_TEXT
  )
)

const leafArb: fc.Arbitrary<CanonicalizableValue> = fc.oneof(
  hostileStringArb,
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.boolean(),
  fc.constant(null)
)

/** An unconstrained canonicalizable subtree, bounded so a case stays cheap. */
const subtreeArb: fc.Arbitrary<CanonicalizableValue> = fc.letrec<{
  node: CanonicalizableValue
}>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3, depthSize: "small" },
    leafArb,
    fc.array(tie("node"), { maxLength: 3 }),
    fc.dictionary(hostileKeyArb, tie("node"), { maxKeys: 3 })
  ),
})).node

/**
 * `value` wrapped in `depth` alternating object/array layers.
 *
 * Alternating rather than object-only so the nesting exercises both container
 * kinds at depth, which is where a canonicalizer that recursed into objects and
 * flattened arrays (or vice versa) would still agree with a correct one at the
 * top level.
 */
function nest(
  value: CanonicalizableValue,
  depth: number
): CanonicalizableValue {
  let current = value
  for (let level = 0; level < depth; level += 1) {
    current = { [`level_${level}`]: [current] }
  }
  return current
}

/** Every structural shape the sensitivity mutators and the ordering assertions need. */
type HostileParts = {
  readonly text: string
  readonly number: number
  readonly flag: boolean
  readonly astral: CanonicalizableValue
  readonly bmp: CanonicalizableValue
  readonly deep: CanonicalizableValue
  readonly free: CanonicalizableValue
}

/**
 * The guaranteed-shape hostile object.
 *
 * Every class design.md's generator table names is present in **every** value,
 * rather than present in some draws: the astral/BMP key pair whose two orderings
 * disagree, the case-differing key pair, the NFC/NFD key pair, a
 * JSON-escaping string, one empty object, one empty array, and a subtree nested
 * four levels deep. A generator that reached these only sometimes would make the
 * ordering assertion vacuous on most runs, and the whole point of pinning them
 * is that the one case that matters is not left to the draw.
 */
function hostileObject(parts: HostileParts): CanonicalizableValue {
  return {
    ascii: ASCII_TEXT,
    text: parts.text,
    number: parts.number,
    flag: parts.flag,
    nothing: null,
    escaped: ESCAPE_HEAVY_TEXT,
    ordered: [1, 2, 3],
    empty_object: {},
    empty_array: [],
    [ASTRAL_KEY]: parts.astral,
    [BMP_ABOVE_SURROGATES_KEY]: parts.bmp,
    [CASE_LOWER_KEY]: "lower",
    [CASE_UPPER_KEY]: "upper",
    [NFC_TEXT]: "precomposed",
    [NFD_TEXT]: "decomposed",
    deep: nest(parts.deep, 4),
    free: parts.free,
  }
}

const hostileObjectArb: fc.Arbitrary<CanonicalizableValue> = fc
  .record({
    text: hostileStringArb,
    number: fc.integer({ min: -1_000_000, max: 1_000_000 }),
    flag: fc.boolean(),
    astral: subtreeArb,
    bmp: subtreeArb,
    deep: subtreeArb,
    free: subtreeArb,
  })
  .map(hostileObject)

/**
 * A genuinely valid `TemplateDefinition`, carrying the hostile classes in the
 * positions a definition legitimately admits them.
 *
 * `metrics` is the one open key position in the grammar — its keys are
 * resource-type strings the `Template_Validator` does not constrain in
 * character or length — so the astral/BMP, case-differing and NFC/NFD key pairs
 * live there. Everything else goes into the free-text identity and block fields.
 */
const definitionArb: fc.Arbitrary<TemplateDefinition> = fc
  .record({
    name: hostileStringArb,
    description: hostileStringArb,
    reportTitle: hostileStringArb,
    headingText: hostileStringArb,
    prose: hostileStringArb,
    statistic: fc.constantFrom("avg", "min", "max"),
    preset: fc.constantFrom(...DESIGN_PRESETS),
    density: fc.constantFrom(...DENSITY_VALUES),
    tableStyle: fc.constantFrom(...TABLE_STYLE_VALUES),
    pageSize: fc.constantFrom(...PAGE_SIZE_VALUES),
    decimalPlaces: fc.integer({ min: 0, max: 3 }),
    coverPage: fc.boolean(),
    headingLevel: fc.integer({ min: 1, max: 3 }),
  })
  .map((parts) => {
    const item = { metric: "Percentage CPU", statistic: parts.statistic }

    return {
      schema_version: 1,
      identity: {
        // Requirement 2.10 — 1 to 120 characters. The fragments are short, so a
        // prefix is enough to clear the lower bound without truncating (which
        // could split a surrogate pair) to clear the upper one.
        name: `T${parts.name}`.slice(0, NAME_MAX_LENGTH),
        description: parts.description,
        report_title: parts.reportTitle,
      },
      scope: {
        resource_types: ["Microsoft.Compute/virtualMachines"],
        tag_filters: [],
        resource_groups: [],
        top_n: null,
        sort: null,
      },
      period: { kind: "last_full_month" as const },
      metrics: {
        "Microsoft.Compute/virtualMachines": [item],
        [ASTRAL_KEY]: [item],
        [BMP_ABOVE_SURROGATES_KEY]: [item],
        [CASE_LOWER_KEY]: [item],
        [CASE_UPPER_KEY]: [item],
        [NFC_TEXT]: [item],
        [NFD_TEXT]: [item],
      },
      blocks: [
        {
          id: "heading-1",
          type: "heading" as const,
          config: { level: parts.headingLevel, text: parts.headingText },
        },
        {
          id: "rich-1",
          type: "rich_text" as const,
          config: { text: parts.prose },
        },
      ],
      design: {
        preset: parts.preset,
        accent_color: "#1f6f78",
        density: parts.density,
        table_style: parts.tableStyle,
        number_format: {
          decimal_places: parts.decimalPlaces,
          group_thousands: true,
        },
        cover_page: parts.coverPage,
        logo: null,
        page_size: parts.pageSize,
      },
    }
  })

/**
 * `TemplateDefinition` is not structurally assignable to
 * `CanonicalizableValue` — a block's `config` is `Record<string, unknown>` —
 * which is exactly why {@link definitionSha256} accepts the union and checks at
 * run time. The cast here is the test-side mirror of that, and nothing else in
 * this module casts.
 */
function asCanonicalizable(
  definition: TemplateDefinition
): CanonicalizableValue {
  return definition as unknown as CanonicalizableValue
}

const valueArb: fc.Arbitrary<CanonicalizableValue> = fc.oneof(
  hostileObjectArb,
  definitionArb.map(asCanonicalizable)
)

const seedArb = fc.integer({ min: 1, max: 0x7fff_ffff })

// --- Declared cases ---------------------------------------------------------

function fixedParts(overrides: Partial<HostileParts> = {}): HostileParts {
  return {
    text: ASCII_TEXT,
    number: 0,
    flag: true,
    astral: "astral-value",
    bmp: "bmp-value",
    deep: 1,
    free: null,
    ...overrides,
  }
}

/**
 * Requirement 45.5 / 42.8 — the retained cases, each a complete value so every
 * mutator applies to it. Shared by all four properties below; the hygiene guard
 * counts one shared array once.
 */
const HOSTILE_EXAMPLES: [CanonicalizableValue, number][] = [
  [hostileObject(fixedParts()), 1],
  [hostileObject(fixedParts({ text: ESCAPE_HEAVY_TEXT })), 2],
  [hostileObject(fixedParts({ text: NFC_TEXT })), 3],
  [hostileObject(fixedParts({ text: NFD_TEXT })), 4],
  [hostileObject(fixedParts({ text: ASTRAL_TEXT, free: [[[[{}]]]] })), 5],
  [
    hostileObject(
      fixedParts({
        astral: { [BMP_ABOVE_SURROGATES_KEY]: [{ [ASTRAL_KEY]: [] }] },
        deep: { [CASE_UPPER_KEY]: [{ [CASE_LOWER_KEY]: {} }] },
      })
    ),
    6,
  ],
]

const NUM_RUNS = 100 + HOSTILE_EXAMPLES.length

const HEX_64 = /^[0-9a-f]{64}$/

// --- Ground truth the properties rest on ------------------------------------

describe("the classes the generators promise are the classes they carry", () => {
  test("NFC and NFD are two different strings that normalize to each other", () => {
    expect(NFC_TEXT).not.toBe(NFD_TEXT)
    expect(NFC_TEXT.normalize("NFD")).toBe(NFD_TEXT)
    expect(NFD_TEXT.normalize("NFC")).toBe(NFC_TEXT)
  })

  test("the astral/BMP key pair orders one way by code point and the other by UTF-16", () => {
    // The single fact every ordering assertion below depends on. Without it the
    // permutation property would be satisfied by a UTF-16 sort, which is the
    // implementation design.md names first in Property 11's kills list.
    expect(byCodePoint(BMP_ABOVE_SURROGATES_KEY, ASTRAL_KEY)).toBeLessThan(0)
    expect([ASTRAL_KEY, BMP_ABOVE_SURROGATES_KEY].sort()).toEqual([
      ASTRAL_KEY,
      BMP_ABOVE_SURROGATES_KEY,
    ])
    expect([ASTRAL_KEY, BMP_ABOVE_SURROGATES_KEY].sort(byCodePoint)).toEqual([
      BMP_ABOVE_SURROGATES_KEY,
      ASTRAL_KEY,
    ])
  })

  test("the case-differing pair is two distinct keys", () => {
    expect(CASE_LOWER_KEY).not.toBe(CASE_UPPER_KEY)
    expect(CASE_LOWER_KEY.toLowerCase()).toBe(CASE_UPPER_KEY.toLowerCase())
  })

  test("every generated definition is valid", () => {
    // The definition branch cannot be allowed to rot into an invalid shape: it
    // is there because design.md's generator table names "definitions from
    // Property 8's valid space", and an invalid definition is not in it.
    fc.assert(
      fc.property(definitionArb, (definition) => {
        expect(collectDefinitionIssues(definition, { mode: "run" })).toEqual([])
      })
    )
  })

  test("every generated value carries the structure the mutators need", () => {
    fc.assert(
      fc.property(valueArb, (value) => {
        expect(isObjectValue(value)).toBe(true)
        const object = value as ObjectValue

        // Both members of the divergent key pair, at some depth. Asserted on the
        // canonical form rather than by walking, because the canonical form is
        // what the digest is taken over.
        const canonical = canonicalDefinitionJson(value)
        expect(canonical).toContain(JSON.stringify(ASTRAL_KEY))
        expect(canonical).toContain(JSON.stringify(BMP_ABOVE_SURROGATES_KEY))
        expect(canonical).toContain(JSON.stringify(NFC_TEXT))
        expect(canonical).toContain(JSON.stringify(NFD_TEXT))
        expect(canonical).toContain(JSON.stringify(CASE_LOWER_KEY))
        expect(canonical).toContain(JSON.stringify(CASE_UPPER_KEY))

        // Enough keys that "reversed" is a different order from "identity".
        expect(keysOf(object).length).toBeGreaterThanOrEqual(7)
      })
    )
  })
})

// --- Property 11, part 1: permutation invariance ---------------------------

describe("Requirement 9.4 — the digest is invariant under key insertion order", () => {
  test("every one of 12 key orders yields one digest", () => {
    fc.assert(
      fc.property(valueArb, seedArb, (value, seed) => {
        const orders = permutations(value, seed)
        expect(orders.length).toBe(PERMUTATION_COUNT)

        // The permuter did something. Without this the property would pass on a
        // `reorderKeys` that returned its input, and "invariant under every
        // permutation" would be "invariant under no permutation".
        expect(new Set(orders.map(keyOrderOf)).size).toBeGreaterThanOrEqual(2)

        const digests = new Set(orders.map(definitionSha256))
        expect(digests.size).toBe(1)
        expect([...digests][0]).toBe(definitionSha256(value))

        // And the canonical form itself is one string, which is the reason the
        // digest is one digest.
        expect(new Set(orders.map(canonicalDefinitionJson)).size).toBe(1)
      }),
      { numRuns: NUM_RUNS, examples: HOSTILE_EXAMPLES }
    )
  })
})

// --- Property 11, part 2: sensitivity --------------------------------------

describe("Requirement 9.5 — any change to any key or value changes the digest", () => {
  test("every kind of change yields a different digest", () => {
    fc.assert(
      fc.property(valueArb, seedArb, (value, seed) => {
        const original = definitionSha256(value)

        for (const mutator of MUTATORS) {
          const result = mutator.apply(value)

          // A mutator that found nothing to change would compare a value with
          // itself and pass. Requirement 9.5 is about a change actually being
          // made, so an inapplicable mutator is a generator defect, not a pass.
          expect(
            result.changed,
            `no node to change for "${mutator.what}"`
          ).toBe(true)

          expect(
            definitionSha256(result.value),
            `changing ${mutator.what} left the digest unchanged`
          ).not.toBe(original)
        }

        // And the change survives re-permutation: a mutated value's digest is
        // not merely different, it is stably different.
        const mutated = MUTATORS[0].apply(value).value
        for (const order of permutations(mutated, seed)) {
          expect(definitionSha256(order)).not.toBe(original)
        }
      }),
      { numRuns: NUM_RUNS, examples: HOSTILE_EXAMPLES }
    )
  })
})

// --- Property 11, part 3: no normalization --------------------------------

describe("Requirement 9.4 — NFC and NFD spellings yield different digests", () => {
  test("the normalization form is part of the content, as a key and as a value", () => {
    fc.assert(
      fc.property(valueArb, seedArb, (value, seed) => {
        // As keys.
        expect(definitionSha256({ [NFC_TEXT]: value })).not.toBe(
          definitionSha256({ [NFD_TEXT]: value })
        )

        // As values.
        expect(definitionSha256({ marker: NFC_TEXT, payload: value })).not.toBe(
          definitionSha256({ marker: NFD_TEXT, payload: value })
        )

        // And the distinction is not an artefact of key order.
        const [firstOrder] = permutations(
          { marker: NFC_TEXT, payload: value },
          seed
        )
        expect(definitionSha256(firstOrder)).not.toBe(
          definitionSha256({ marker: NFD_TEXT, payload: value })
        )
      }),
      { numRuns: NUM_RUNS, examples: HOSTILE_EXAMPLES }
    )
  })
})

// --- Property 11, part 4: purity, determinism, shape ----------------------

describe("Requirements 9.4, 45.1 — the digest is pure, repeatable and 64 lowercase hex", () => {
  test("the input is untouched and the output is well formed", () => {
    fc.assert(
      fc.property(valueArb, seedArb, (value, seed) => {
        const before = structuredClone(value)

        const first = definitionSha256(value)
        const second = definitionSha256(value)
        const onAClone = definitionSha256(structuredClone(value))

        // Requirement 9.4's rendering, asserted rather than assumed: 64
        // characters, hexadecimal, lowercase.
        expect(first).toMatch(HEX_64)
        expect(first).toBe(first.toLowerCase())
        expect(first.length).toBe(64)

        expect(second).toBe(first)
        expect(onAClone).toBe(first)

        // Property 11's third kill: an implementation that sorted the caller's
        // object in place while canonicalizing. Deep equality *and* key order,
        // because a sort would leave the value deep-equal and reordered — and
        // `toEqual` does not compare key order.
        expect(value).toEqual(before)
        expect(keyOrderOf(value)).toBe(keyOrderOf(before))
        expect(canonicalDefinitionJson(value)).toBe(
          canonicalDefinitionJson(before)
        )

        // A permuted copy digests the same and leaves the original alone too.
        const [, reversed] = permutations(value, seed)
        expect(definitionSha256(reversed)).toBe(first)
        expect(value).toEqual(before)
      }),
      { numRuns: NUM_RUNS, examples: HOSTILE_EXAMPLES }
    )
  })
})

// --- Named cases: the construction is right, not merely self-consistent ---

/**
 * A digest built the way Property 11's first kill describes: `JSON.stringify`
 * over keys sorted by `Array.prototype.sort`'s default UTF-16 code-unit
 * comparison.
 *
 * Written out here so the difference is visible in the test rather than
 * described in a comment. It is deliberately *not* a general implementation —
 * one level of object, primitive values — because that is all the case below
 * needs.
 */
function utf16SortedDigest(object: Record<string, string | number>): string {
  const members = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(object[key])}`)
  return createHash("sha256")
    .update(`{${members.join(",")}}`, "utf8")
    .digest("hex")
}

describe("Requirement 9.4 — the canonical form is RFC 8785's, not a lookalike", () => {
  test("object keys sort by code point, so an astral key follows U+FB00", () => {
    const value: Record<string, number> = {}
    value[ASTRAL_KEY] = 1
    value[BMP_ABOVE_SURROGATES_KEY] = 2
    value.a = 3

    // Code-point order: U+0061 < U+FB00 < U+1F9EA.
    expect(canonicalDefinitionJson(value)).toBe(
      `{"a":3,"${BMP_ABOVE_SURROGATES_KEY}":2,"${ASTRAL_KEY}":1}`
    )

    // The naive sort puts the astral key second, and therefore produces a
    // different digest — the disagreement with Python's code-point `sorted()`
    // that would give one definition two ids. This is the single-language form
    // of Property 11's first kill; the corpus comparison in task 5.2 is the
    // other half.
    expect(Object.keys(value).sort()).toEqual([
      "a",
      ASTRAL_KEY,
      BMP_ABOVE_SURROGATES_KEY,
    ])
    expect(definitionSha256(value)).not.toBe(utf16SortedDigest(value))
  })

  test("the digest of a known canonical form is the known SHA-256 of its bytes", () => {
    // Both values below were computed outside this process, with `sha256sum`
    // over the exact UTF-8 bytes, so they are independent of `node:crypto` and
    // of this module. A self-consistent digest — one that agrees with its own
    // canonicalizer and with nothing else — passes every other assertion in
    // this file; only a known answer catches it.
    const simple = { b: [true, null, ""], a: 1 }

    expect(canonicalDefinitionJson(simple)).toBe('{"a":1,"b":[true,null,""]}')
    expect(definitionSha256(simple)).toBe(
      "79590c9eecbe6ae63613aabab7646d07e4a03585b0b300a29a57ac1971752f07"
    )

    const ordered: Record<string, number> = {}
    ordered[ASTRAL_KEY] = 1
    ordered[BMP_ABOVE_SURROGATES_KEY] = 2
    ordered.a = 3

    expect(definitionSha256(ordered)).toBe(
      "1474a9b22135f23e78164f99eef8127dcab441202f8931b52f3ffd7162c8ec54"
    )
  })

  test("an empty object and an empty array are different content", () => {
    expect(canonicalDefinitionJson({})).toBe("{}")
    expect(canonicalDefinitionJson([])).toBe("[]")
    expect(definitionSha256({})).not.toBe(definitionSha256([]))
  })

  test("a string requiring JSON escaping escapes exactly what JSON escapes", () => {
    expect(canonicalDefinitionJson({ s: ESCAPE_HEAVY_TEXT })).toBe(
      '{"s":"\\"\\\\\\b\\f\\n\\r\\t\\u0000\\u001f"}'
    )
  })

  test("a non-ASCII character is carried literally, not escaped", () => {
    // RFC 8785 escapes only what it must, so the astral character survives as
    // UTF-8 bytes rather than as a `\uD83E\uDDEA` pair. A canonicalizer that
    // ASCII-escaped (Python's `json.dumps` default) would disagree with this.
    expect(canonicalDefinitionJson({ s: ASTRAL_TEXT })).toBe(
      `{"s":"${ASTRAL_TEXT}"}`
    )
  })
})
