import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { BLOCK_CONFIG, BLOCK_TYPES } from "@/lib/templates/blocks"
import {
  FRONT_MATTER_FORBIDDEN_BLOCK_TYPES,
  FRONT_MATTER_KEYS,
  IDENTITY_KEYS,
  LANGUAGES,
  MAX_SUPPORTED_SCHEMA_VERSION,
  MIN_SCHEMA_VERSION,
  NUMBER_FORMAT_KEYS,
  REQUIRED_IDENTITY_KEYS,
  REQUIRED_TOP_LEVEL_KEYS,
} from "@/lib/templates/definition"
import {
  collectDefinitionIssues,
  type FieldIssue,
} from "@/lib/templates/definition"
import { definitionSha256 } from "@/lib/templates/version"

/**
 * The block-definition mirror guard — declaration half (Requirements 2.5, 2.6).
 *
 * One block-type vocabulary and one per-type config schema, declared twice:
 * `app/lib/templates/blocks.ts` and `agent/src/reporting_agent/compile/definition.py`
 * each carry the same `BLOCK_TYPES` list and the same `BLOCK_CONFIG` shape between
 * sentinel comments. This guard reads both files from disk, extracts the
 * sentinel-delimited regions, and compares:
 *
 *  - the block-type sets themselves;
 *  - for each type, the set of required config field names;
 *  - for each type, the set of optional config field names;
 *  - for each type, the set of enum keys, and for each enum key, its set of
 *    permitted values.
 *
 * It parses neither language, for the same reason `event-mirror.static.test.ts`
 * parses neither for the event vocabulary: a guard that needed a Python parser
 * and a TypeScript parser would be a third thing able to drift from the two it
 * guards. What the block config needs beyond the event vocabulary's flat string
 * list is a small amount of *structure* — required vs optional vs enums, per
 * type — so this file adds a brace/bracket-balancing scan rather than a real
 * parser (see {@link matchBalanced}). That scan is sound only because both
 * declarations are written, in this same task, in a deliberately restricted
 * literal style: every block-type name, field name and enum value is a short
 * identifier-like word, and no bracket or brace character ever appears inside a
 * string value on either side. A generic TS or Python object literal would need
 * to handle quoting, escaping, comments and expressions; this only has to count
 * matching delimiters, which is exactly the same reduction the sentinel
 * convention already relies on.
 *
 * The **behavioural** half follows below: the shared fixture corpus in
 * `agent/tests/fixtures/definitions/`, run through both the
 * `Template_Validator` and the `Block_Compiler`, with matching verdicts,
 * matching offender locations and matching canonical digests (Requirements
 * 2.6, 2.11, 9.4). Declaration equality is necessary and not sufficient: a
 * definition the app can *save* and the compiler cannot *compile* turns a
 * save-time validation error into a failed run minutes later, after inventory
 * and metrics have already been spent — and two `BLOCK_CONFIG` literals that
 * agree say nothing about that.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** The monorepo root — `agent/` is a sibling of `app/`. */
const repoRoot = path.resolve(appRoot, "..")

const TS_DECLARATION = path.join(appRoot, "lib", "templates", "blocks.ts")
const PY_DECLARATION = path.join(
  repoRoot,
  "agent",
  "src",
  "reporting_agent",
  "compile",
  "definition.py"
)

const BEGIN_TYPES_SENTINEL = "--- BEGIN BLOCK TYPES"
const END_TYPES_SENTINEL = "--- END BLOCK TYPES"
const BEGIN_CONFIG_SENTINEL = "--- BEGIN BLOCK CONFIG"
const END_CONFIG_SENTINEL = "--- END BLOCK CONFIG"

/** Every single- or double-quoted string literal on a line. */
const QUOTED_STRING = /"([^"\n]*)"|'([^'\n]*)'/g

/** The sixteen types, as a fact about the requirement rather than about the files. */
const EXPECTED_TYPE_COUNT = 16

function read(absolutePath: string): string {
  expect(
    existsSync(absolutePath),
    `${path.relative(repoRoot, absolutePath)} is missing`
  ).toBe(true)
  return readFileSync(absolutePath, "utf8")
}

/**
 * The raw text between two sentinels, exclusive of the sentinel lines
 * themselves.
 *
 * Both sentinels must be present and ordered, and the block between them
 * must be non-empty — a guard that passes because it found nothing is the
 * failure mode this whole file exists to avoid (the same defensive shape
 * `event-mirror.static.test.ts` applies to the event vocabulary's sentinels).
 */
function sentinelBody(
  absolutePath: string,
  beginSentinel: string,
  endSentinel: string
): string {
  const where = path.relative(repoRoot, absolutePath)
  const lines = read(absolutePath).split("\n")

  const begin = lines.findIndex((line) => line.includes(beginSentinel))
  const end = lines.findIndex((line) => line.includes(endSentinel))

  expect(
    begin,
    `${where} declares no ${beginSentinel} sentinel`
  ).toBeGreaterThan(-1)
  expect(end, `${where} declares no ${endSentinel} sentinel`).toBeGreaterThan(
    -1
  )
  expect(
    end,
    `${where} closes the ${beginSentinel} block before it opens it`
  ).toBeGreaterThan(begin)

  const body = lines.slice(begin + 1, end).join("\n")

  expect(
    body.trim().length,
    `${where} declares an empty block between ${beginSentinel} and ${endSentinel}`
  ).toBeGreaterThan(0)

  return body
}

function quotedStrings(text: string): readonly string[] {
  const found: string[] = []
  for (const match of text.matchAll(QUOTED_STRING)) {
    found.push(match[1] ?? match[2])
  }
  return found
}

/** The quoted block-type strings between the `BLOCK TYPES` sentinels, in order. */
function declaredBlockTypes(absolutePath: string): readonly string[] {
  return quotedStrings(
    sentinelBody(absolutePath, BEGIN_TYPES_SENTINEL, END_TYPES_SENTINEL)
  )
}

/**
 * The substring of `text` starting at the opening delimiter at `openIndex`,
 * through its matching closer, exclusive of both delimiters.
 *
 * A depth counter, not a parser — see the file-level doc comment for why that
 * reduction is sound for these two specific files.
 */
function matchBalanced(
  text: string,
  openIndex: number,
  open: string,
  close: string
): string {
  if (text[openIndex] !== open) {
    throw new Error(
      `matchBalanced: expected '${open}' at index ${openIndex}, found ` +
        `'${text[openIndex] ?? "<eof>"}'`
    )
  }

  let depth = 0
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === open) depth += 1
    else if (text[i] === close) {
      depth -= 1
      if (depth === 0) return text.slice(openIndex + 1, i)
    }
  }

  throw new Error(
    `matchBalanced: '${open}' at index ${openIndex} is never closed`
  )
}

/**
 * The `{ ... }` or `[ ... ]` body following `key:`, where `key` may appear
 * quoted (Python's `"key": {`) or bare (TypeScript's `key: {`).
 *
 * Returns `undefined` when `key` is not found at all, which the caller turns
 * into a named mismatch rather than a thrown error — a field one side omits
 * entirely is exactly the case this guard exists to catch.
 */
function findKeyedBlock(
  text: string,
  key: string,
  open: "{" | "[",
  close: "}" | "]"
): string | undefined {
  const escapedOpen = open === "{" ? "\\{" : "\\["
  const pattern = new RegExp(
    `(?:"${key}"|'${key}')\\s*:\\s*${escapedOpen}|\\b${key}\\s*:\\s*${escapedOpen}`
  )
  const match = pattern.exec(text)
  if (match === null) return undefined

  const openIndex = match.index + match[0].length - 1
  return matchBalanced(text, openIndex, open, close)
}

/** The quoted strings inside `key: [ ... ]`, or `undefined` if `key` is absent. */
function extractArrayField(
  sectionText: string,
  key: string
): readonly string[] | undefined {
  const body = findKeyedBlock(sectionText, key, "[", "]")
  return body === undefined ? undefined : quotedStrings(body)
}

/** Every `key: [ ... ]` pair inside an `enums: { ... }` body, or `{}` if absent. */
function extractEnums(sectionText: string): Record<string, readonly string[]> {
  const enumsBody = findKeyedBlock(sectionText, "enums", "{", "}")
  if (enumsBody === undefined) return {}

  const result: Record<string, readonly string[]> = {}
  const keyPattern =
    /(?:"([A-Za-z_][\w]*)"|'([A-Za-z_][\w]*)')\s*:\s*\[|\b([A-Za-z_][\w]*)\s*:\s*\[/g

  for (const match of enumsBody.matchAll(keyPattern)) {
    const key = match[1] ?? match[2] ?? match[3]
    if (key === undefined) continue
    const openIndex = match.index + match[0].length - 1
    result[key] = quotedStrings(matchBalanced(enumsBody, openIndex, "[", "]"))
  }

  return result
}

type ParsedBlockConfig = {
  readonly required: readonly string[]
  readonly optional: readonly string[]
  readonly enums: Readonly<Record<string, readonly string[]>>
}

/**
 * Every declared type's config schema between the `BLOCK CONFIG` sentinels of
 * one file, keyed by block type.
 *
 * `typeNames` comes from that same file's own `BLOCK TYPES` sentinel rather
 * than from the other file or from the TypeScript export, so a file that
 * declares a type in one sentinel block and omits it from the other is
 * caught as a missing config section rather than silently skipped.
 */
function parseBlockConfigs(
  absolutePath: string,
  typeNames: readonly string[]
): ReadonlyMap<string, ParsedBlockConfig | undefined> {
  const body = sentinelBody(
    absolutePath,
    BEGIN_CONFIG_SENTINEL,
    END_CONFIG_SENTINEL
  )

  const result = new Map<string, ParsedBlockConfig | undefined>()

  for (const typeName of typeNames) {
    const section = findKeyedBlock(body, typeName, "{", "}")
    if (section === undefined) {
      result.set(typeName, undefined)
      continue
    }

    result.set(typeName, {
      required: extractArrayField(section, "required") ?? [],
      optional: extractArrayField(section, "optional") ?? [],
      enums: extractEnums(section),
    })
  }

  return result
}

/** Set equality, independent of declaration order or duplicate literals. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size !== setB.size) return false
  for (const value of setA) if (!setB.has(value)) return false
  return true
}

describe("Requirements 2.5, 2.6 — the block-type vocabulary is mirrored", () => {
  test("the TypeScript declaration is the sixteen declared types", () => {
    const declared = declaredBlockTypes(TS_DECLARATION)

    expect(declared).toEqual([...new Set(declared)])
    expect(declared.length).toBe(EXPECTED_TYPE_COUNT)
  })

  test("the Python declaration is the sixteen declared types", () => {
    const declared = declaredBlockTypes(PY_DECLARATION)

    expect(declared).toEqual([...new Set(declared)])
    expect(declared.length).toBe(EXPECTED_TYPE_COUNT)
  })

  test("the two declared type sets are equal", () => {
    // Sorted rather than order-sensitive: the requirement is that the two
    // vocabularies are the same set, and declaration order carries no
    // meaning in either language.
    expect([...declaredBlockTypes(TS_DECLARATION)].sort()).toEqual(
      [...declaredBlockTypes(PY_DECLARATION)].sort()
    )
  })

  test("the TypeScript sentinel block is the module's actual BLOCK_TYPES export", () => {
    // Extraction is textual, so on its own it would still pass if the
    // sentinels wrapped a decorative comment and the module exported a
    // different list. Comparing against the imported export closes that hole
    // from the app side, the same way event-mirror does for EVENT_TYPES.
    expect([...declaredBlockTypes(TS_DECLARATION)]).toEqual([...BLOCK_TYPES])
  })
})

describe("Requirements 2.5, 2.6 — every type's config schema is mirrored", () => {
  const tsTypes = declaredBlockTypes(TS_DECLARATION)
  const pyTypes = declaredBlockTypes(PY_DECLARATION)
  // The union, so a type declared as a *type* on only one side still gets a
  // named "missing config section" failure on the other rather than being
  // silently skipped because it was never looked up there.
  const allTypes = [...new Set([...tsTypes, ...pyTypes])].sort()

  const tsConfigs = parseBlockConfigs(TS_DECLARATION, allTypes)
  const pyConfigs = parseBlockConfigs(PY_DECLARATION, allTypes)

  test("every declared type has a config section in both files", () => {
    const missing: string[] = []

    for (const typeName of allTypes) {
      if (tsConfigs.get(typeName) === undefined) {
        missing.push(`${typeName}: absent from app/lib/templates/blocks.ts`)
      }
      if (pyConfigs.get(typeName) === undefined) {
        missing.push(`${typeName}: absent from agent/.../compile/definition.py`)
      }
    }

    expect(missing).toEqual([])
  })

  test("required fields, optional fields and enum values agree for every type", () => {
    // One assertion covering every type and every field, so a failure names
    // *every* differing type and field (Req 2.6) rather than only the first
    // mismatch found.
    const mismatches: string[] = []

    for (const typeName of allTypes) {
      const ts = tsConfigs.get(typeName)
      const py = pyConfigs.get(typeName)
      if (ts === undefined || py === undefined) continue // named above already

      if (!sameSet(ts.required, py.required)) {
        mismatches.push(
          `${typeName}.required: ts=[${[...ts.required].sort().join(", ")}] ` +
            `py=[${[...py.required].sort().join(", ")}]`
        )
      }

      if (!sameSet(ts.optional, py.optional)) {
        mismatches.push(
          `${typeName}.optional: ts=[${[...ts.optional].sort().join(", ")}] ` +
            `py=[${[...py.optional].sort().join(", ")}]`
        )
      }

      const tsEnumKeys = Object.keys(ts.enums)
      const pyEnumKeys = Object.keys(py.enums)
      if (!sameSet(tsEnumKeys, pyEnumKeys)) {
        mismatches.push(
          `${typeName}.enums keys: ts=[${[...tsEnumKeys].sort().join(", ")}] ` +
            `py=[${[...pyEnumKeys].sort().join(", ")}]`
        )
        continue
      }

      for (const enumKey of tsEnumKeys) {
        const tsValues = ts.enums[enumKey] ?? []
        const pyValues = py.enums[enumKey] ?? []
        if (!sameSet(tsValues, pyValues)) {
          mismatches.push(
            `${typeName}.enums.${enumKey}: ts=[${[...tsValues].sort().join(", ")}] ` +
              `py=[${[...pyValues].sort().join(", ")}]`
          )
        }
      }
    }

    expect(mismatches).toEqual([])
  })

  test("the TypeScript sentinel block matches the module's actual BLOCK_CONFIG export", () => {
    // Same reasoning as the BLOCK_TYPES check above: the sentinel-extracted
    // schema has to be the schema the module actually exports, or the guard
    // could pass against decorative sentinel text while the real export
    // drifts unnoticed.
    const mismatches: string[] = []

    for (const typeName of tsTypes) {
      const extracted = tsConfigs.get(typeName)
      const actual = (
        BLOCK_CONFIG as Record<
          string,
          {
            readonly required: readonly string[]
            readonly optional: readonly string[]
            readonly enums: Readonly<Record<string, readonly string[]>>
          }
        >
      )[typeName]

      if (extracted === undefined || actual === undefined) {
        mismatches.push(`${typeName}: not found on one side`)
        continue
      }

      if (!sameSet(extracted.required, actual.required)) {
        mismatches.push(`${typeName}.required: sentinel vs export differ`)
      }
      if (!sameSet(extracted.optional, actual.optional)) {
        mismatches.push(`${typeName}.optional: sentinel vs export differ`)
      }
      if (!sameSet(Object.keys(extracted.enums), Object.keys(actual.enums))) {
        mismatches.push(`${typeName}.enums keys: sentinel vs export differ`)
      }
    }

    expect(mismatches).toEqual([])
  })
})

// ===========================================================================
// Mirror_Guard — the schema-version declarations (Requirements 13.10, 15.10)
// ===========================================================================

/**
 * `lib/templates/definition.ts` and `agent/.../compile/definition.py` each declare the
 * version-conditional key sets between `--- BEGIN SCHEMA VERSIONS ---` sentinels, and the
 * whole point of declaring them **as data** rather than as two validators is that this guard
 * can then be a set comparison with no parser on either side.
 *
 * What it protects is specific. A key admitted at one version in one half and not the other
 * presents as a definition the wizard **saves** and the compiler **refuses** — minutes into a
 * run, after the collection has been spent. Nothing in either suite would catch that: each
 * half is internally consistent and each half's tests pass.
 *
 * The extraction is deliberately textual and per-key, so a failure names the differing key
 * rather than reporting that two blocks of text are unequal.
 */

const BEGIN_VERSIONS_SENTINEL = "--- BEGIN SCHEMA VERSIONS"
const END_VERSIONS_SENTINEL = "--- END SCHEMA VERSIONS"

/** The declaration for `definition.ts`; the block types live in `blocks.ts`. */
const TS_VERSIONS_DECLARATION = path.join(
  appRoot,
  "lib",
  "templates",
  "definition.ts"
)

/**
 * The two scalars, the four per-version records and the three flat lists — every name the two
 * halves must agree on, and the list this guard iterates rather than a set of hand-written
 * assertions. A declaration added to one half and not to this list would be unguarded, so the
 * completeness check below reads the sentinel bodies themselves.
 */
const VERSION_SCALARS = [
  "MIN_SCHEMA_VERSION",
  "MAX_SUPPORTED_SCHEMA_VERSION",
] as const
const VERSION_RECORDS = [
  "REQUIRED_TOP_LEVEL_KEYS",
  "NUMBER_FORMAT_KEYS",
  "IDENTITY_KEYS",
  "REQUIRED_IDENTITY_KEYS",
] as const
const VERSION_LISTS = [
  "LANGUAGES",
  "FRONT_MATTER_KEYS",
  "FRONT_MATTER_FORBIDDEN_BLOCK_TYPES",
] as const

const DECLARED_VERSION_NAMES: readonly string[] = [
  ...VERSION_SCALARS,
  ...VERSION_RECORDS,
  ...VERSION_LISTS,
]

function versionsBody(absolutePath: string): string {
  return sentinelBody(
    absolutePath,
    BEGIN_VERSIONS_SENTINEL,
    END_VERSIONS_SENTINEL
  )
}

/**
 * An integer assigned to `name` inside the sentinel body.
 *
 * One pattern for both languages: `MIN_SCHEMA_VERSION = 1` and
 * `MIN_SCHEMA_VERSION: Final[int] = 1` differ only in an annotation this skips over.
 */
function declaredScalar(body: string, name: string): number | undefined {
  const pattern = new RegExp(`\\b${name}\\b[^=\\n]*=\\s*(-?\\d+)`)
  const match = pattern.exec(body)
  return match === null ? undefined : Number(match[1])
}

/** The quoted strings inside the `[ ... ]` or `( ... )` following `name`'s assignment. */
function declaredList(
  body: string,
  name: string
): readonly string[] | undefined {
  const pattern = new RegExp(`\\b${name}\\b[^=\\n]*=\\s*([\\[(])`)
  const match = pattern.exec(body)
  if (match === null) return undefined
  const open = match[1] as "[" | "("
  const close = open === "[" ? "]" : ")"
  const openIndex = match.index + match[0].length - 1
  return quotedStrings(matchBalanced(body, openIndex, open, close as "]" | ")"))
}

/**
 * A per-version record as `version -> the quoted strings it declares`.
 *
 * TypeScript spells the record `{ 1: [...], 2: [...] }` and Python spells it
 * `{1: (...), 2: (...)}`; the numeric key is bare in both, and each version's members are
 * bracketed in one language and parenthesised in the other. Reading the members by balanced
 * delimiter rather than by line makes both spellings one code path.
 */
function declaredRecord(
  body: string,
  name: string
): Record<number, readonly string[]> | undefined {
  const pattern = new RegExp(`\\b${name}\\b[^=\\n]*=\\s*\\{`)
  const match = pattern.exec(body)
  if (match === null) return undefined
  const record = matchBalanced(
    body,
    match.index + match[0].length - 1,
    "{",
    "}"
  )

  const found: Record<number, readonly string[]> = {}
  const entry = /(\d+)\s*:\s*([[(])/g
  for (const hit of record.matchAll(entry)) {
    const open = hit[2] as "[" | "("
    const close = open === "[" ? "]" : ")"
    const openIndex = (hit.index ?? 0) + hit[0].length - 1
    found[Number(hit[1])] = quotedStrings(
      matchBalanced(record, openIndex, open, close as "]" | ")")
    )
  }
  return found
}

describe("Requirement 13.10 — the schema-version declarations are mirrored", () => {
  const tsBody = versionsBody(TS_VERSIONS_DECLARATION)
  const pyBody = versionsBody(PY_DECLARATION)

  test("both halves declare every name this guard compares", () => {
    // The first failure mode to rule out: a guard that passes because it extracted nothing.
    // `undefined` from any reader below would make the comparison `undefined === undefined`,
    // which is exactly the shape of a rule that has quietly stopped applying.
    const missing: string[] = []
    for (const name of DECLARED_VERSION_NAMES) {
      for (const [half, body] of [
        ["typescript", tsBody],
        ["python", pyBody],
      ] as const) {
        if (!new RegExp(`\\b${name}\\b`).test(body)) {
          missing.push(`${half}: ${name}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  test.each(VERSION_SCALARS)(
    "%s is the same integer in both halves",
    (name) => {
      const ts = declaredScalar(tsBody, name)
      const py = declaredScalar(pyBody, name)
      expect(ts, `typescript declares no readable ${name}`).toBeTypeOf("number")
      expect(py, `python declares no readable ${name}`).toBeTypeOf("number")
      expect({ name, ts }).toEqual({ name, ts: py })
    }
  )

  test.each(VERSION_LISTS)(
    "%s declares the same members in both halves",
    (name) => {
      const ts = declaredList(tsBody, name)
      const py = declaredList(pyBody, name)
      expect(ts, `typescript declares no readable ${name}`).toBeDefined()
      expect(py, `python declares no readable ${name}`).toBeDefined()
      // Order-sensitive on purpose for these three: `FRONT_MATTER_KEYS` is the order the front
      // matter emits its sections in, and `LANGUAGES[0]` is the language the separators default
      // from. A set comparison would let the two halves default from different languages.
      expect({ name, members: ts }).toEqual({ name, members: py })
    }
  )

  test.each(VERSION_RECORDS)(
    "%s declares the same keys per version in both halves",
    (name) => {
      const ts = declaredRecord(tsBody, name)
      const py = declaredRecord(pyBody, name)
      expect(ts, `typescript declares no readable ${name}`).toBeDefined()
      expect(py, `python declares no readable ${name}`).toBeDefined()

      const versions = [
        ...new Set([
          ...Object.keys(ts ?? {}).map(Number),
          ...Object.keys(py ?? {}).map(Number),
        ]),
      ].sort()
      expect(
        versions.length,
        `${name} declares no version at all in either half`
      ).toBeGreaterThan(0)

      // Compared **per version and per key**, so a failure names the differing key rather
      // than reporting that two records are unequal.
      const differences: string[] = []
      for (const version of versions) {
        const tsKeys = new Set(ts?.[version] ?? [])
        const pyKeys = new Set(py?.[version] ?? [])
        for (const key of tsKeys) {
          if (!pyKeys.has(key)) {
            differences.push(`${name}[${version}] "${key}": typescript only`)
          }
        }
        for (const key of pyKeys) {
          if (!tsKeys.has(key)) {
            differences.push(`${name}[${version}] "${key}": python only`)
          }
        }
      }
      expect(differences).toEqual([])
    }
  )

  test("the sentinel bodies name no declaration this guard ignores", () => {
    // The completeness half. Without it a tenth declaration could be added to both halves,
    // drift, and never be compared — which is exactly as unguarded as one this guard reads
    // and much harder to notice, because everything about it looks deliberate.
    const declared = (body: string): readonly string[] =>
      [...body.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*[:=]/gm)].map(
        (match) => match[1]
      )

    for (const [half, body] of [
      ["typescript", tsBody],
      ["python", pyBody],
    ] as const) {
      const unguarded = [...new Set(declared(body))].filter(
        (name) => !DECLARED_VERSION_NAMES.includes(name)
      )
      expect(
        unguarded,
        `${half} declares names this guard does not compare`
      ).toEqual([])
    }
  })

  test("the TypeScript sentinel block is the module's actual exports", () => {
    // Extraction is textual, so on its own it would pass against sentinels wrapping a
    // decorative comment while the module exported something else — the same hole the
    // BLOCK_TYPES check closes from the app side.
    expect(declaredScalar(tsBody, "MIN_SCHEMA_VERSION")).toBe(
      MIN_SCHEMA_VERSION
    )
    expect(declaredScalar(tsBody, "MAX_SUPPORTED_SCHEMA_VERSION")).toBe(
      MAX_SUPPORTED_SCHEMA_VERSION
    )
    expect(declaredList(tsBody, "LANGUAGES")).toEqual([...LANGUAGES])
    expect(declaredList(tsBody, "FRONT_MATTER_KEYS")).toEqual([
      ...FRONT_MATTER_KEYS,
    ])
    expect(declaredList(tsBody, "FRONT_MATTER_FORBIDDEN_BLOCK_TYPES")).toEqual([
      ...FRONT_MATTER_FORBIDDEN_BLOCK_TYPES,
    ])

    const records = {
      REQUIRED_TOP_LEVEL_KEYS,
      NUMBER_FORMAT_KEYS,
      IDENTITY_KEYS,
      REQUIRED_IDENTITY_KEYS,
    } as const
    for (const name of VERSION_RECORDS) {
      const extracted = declaredRecord(tsBody, name)
      const actual = records[name] as Record<number, readonly string[]>
      for (const version of Object.keys(actual).map(Number)) {
        expect(
          [...(extracted?.[version] ?? [])].sort(),
          `${name}[${version}]: sentinel vs export differ`
        ).toEqual([...actual[version]].sort())
      }
    }
  })
})

// ===========================================================================
// Mirror_Guard — behavioural half (Requirements 2.6, 2.11, 1.3, 9.4)
// ===========================================================================

/**
 * The one corpus directory, read across the monorepo path — **never a copy**.
 *
 * Two copies is how this guard comes to compare each half against itself: the
 * web copy drifts, the agent copy does not, both suites stay green, and the
 * disagreement they exist to catch is the one thing neither of them sees. So
 * the fixtures live once, under `agent/tests/`, and this file reaches for them.
 */
const CORPUS_ROOT = path.join(
  repoRoot,
  "agent",
  "tests",
  "fixtures",
  "definitions"
)
const CORPUS_MANIFEST = path.join(CORPUS_ROOT, "manifest.json")

/**
 * The agent-side entry point this suite spawns, and the interpreter it runs
 * under.
 *
 * **This is a real coupling and it is deliberate.** Requirement 2.6 is about two
 * *implementations* agreeing, and the only way to assert that is to run both. A
 * manifest comparison alone would let both halves drift the same way; a
 * head-to-head comparison would not. `agent/.venv` is the documented development
 * environment for the other half of this monorepo (see `agent/README.md`), and
 * the agent's own suite needs it regardless, so requiring it here adds no setup
 * that was not already required to work on this repository.
 *
 * When it is absent the tests below **fail loudly with instructions** rather
 * than skipping. A skipped mirror guard is indistinguishable from a passing one
 * in a summary line, and this is the guard whose whole job is to notice
 * something nobody is looking at.
 */
const AGENT_ROOT = path.join(repoRoot, "agent")
const AGENT_PYTHON = path.join(AGENT_ROOT, ".venv", "bin", "python")
const AGENT_CORPUS_SCRIPT = path.join(
  AGENT_ROOT,
  "tests",
  "definition_corpus.py"
)

/** Requirement 2.11 — the corpus floor. */
const MINIMUM_CORPUS_SIZE = 20

type ValidationMode = "draft" | "run"
type Verdict = "accept" | "reject"

type OffenderRecord = {
  readonly block_id: string | null
  readonly path: readonly (string | number)[]
}

type ManifestEntry = {
  readonly file: string
  readonly mode: ValidationMode
  readonly verdict: Verdict
  readonly definition_sha256: string
  readonly offenders: readonly OffenderRecord[]
}

type AgentVerdict = {
  readonly file: string
  readonly mode: ValidationMode
  readonly verdict: Verdict
  readonly definition_sha256: string
  readonly offenders: readonly OffenderRecord[]
}

/**
 * A `(blockId, path)` pair rendered as one comparable string.
 *
 * Comparison is over **sets of locations**, not lists of messages. Two
 * languages producing byte-identical prose is a coincidence to maintain rather
 * than a property worth asserting, and one location legitimately carries two
 * messages — an absent `schema_version` is both a missing required key and a
 * non-integer — so a list of messages would not even be the same length on one
 * side as the count of distinct locations.
 */
function offenderKey(
  blockId: string | null,
  fieldPath: readonly (string | number)[]
): string {
  return `${blockId ?? "<none>"} @ ${fieldPath.map((segment) => String(segment)).join(".") || "<root>"}`
}

function locationSet(offenders: readonly OffenderRecord[]): Set<string> {
  return new Set(
    offenders.map((offender) => offenderKey(offender.block_id, offender.path))
  )
}

function readManifest(): readonly ManifestEntry[] {
  expect(
    existsSync(CORPUS_MANIFEST),
    `the shared corpus manifest is missing: ${path.relative(repoRoot, CORPUS_MANIFEST)}`
  ).toBe(true)

  const raw: unknown = JSON.parse(readFileSync(CORPUS_MANIFEST, "utf8"))
  expect(raw, "manifest.json must be an object").toBeTypeOf("object")

  const { manifest_version: manifestVersion, fixtures } = raw as {
    manifest_version?: unknown
    fixtures?: unknown
  }
  expect(manifestVersion, "manifest_version").toBe(1)
  expect(
    Array.isArray(fixtures),
    "manifest.json must declare a `fixtures` array"
  ).toBe(true)

  return fixtures as readonly ManifestEntry[]
}

const manifest = readManifest()

function readFixture(file: string): unknown {
  const absolute = path.join(CORPUS_ROOT, file)
  expect(
    existsSync(absolute),
    `manifest.json declares ${file}, which is not in the corpus directory`
  ).toBe(true)
  return JSON.parse(readFileSync(absolute, "utf8"))
}

/**
 * Whether `path[index]` addresses a **block** rather than any other array
 * element.
 *
 * A block sits at exactly two kinds of position in the layout grammar
 * (Requirement 6.2): `blocks[i]`, and `blocks[i].columns[c][j]` for a row's
 * child. `columns[c]` itself is a *column*, not a block, which is why the
 * numeric-segment test alone is not enough — it would attribute a row's issue
 * to its own column array.
 */
function isBlockPosition(
  fieldPath: readonly (string | number)[],
  index: number
): boolean {
  if (typeof fieldPath[index] !== "number") return false
  if (index === 1 && fieldPath[0] === "blocks") return true
  return (
    typeof fieldPath[index - 1] === "number" &&
    fieldPath[index - 2] === "columns"
  )
}

/**
 * The `id` of the innermost block a field path passes through, or `null`.
 *
 * This is the web half's independent derivation of what the agent half
 * *tracks during its walk*. Deriving it here rather than reading it from the
 * agent's answer is what keeps the block-id comparison a real assertion: a
 * Python walk that attributed an issue to the wrong enclosing block would
 * disagree with this function rather than agreeing with itself.
 *
 * `null` for a path outside `blocks` entirely, and `null` for a block whose own
 * `id` is not a valid id — an id that failed its bound cannot identify
 * anything, so naming it would be inventing a name. That matches the agent's
 * rule exactly, and `reject-block-id-too-long.json` is the fixture that pins it.
 */
function deriveBlockId(
  definition: unknown,
  fieldPath: readonly (string | number)[]
): string | null {
  let node: unknown = definition
  let blockId: string | null = null

  for (let index = 0; index < fieldPath.length; index += 1) {
    const segment = fieldPath[index]
    if (node === null || typeof node !== "object") return blockId
    node = (node as Record<string | number, unknown>)[segment as never]

    if (
      isBlockPosition(fieldPath, index) &&
      node !== null &&
      typeof node === "object"
    ) {
      const candidate = (node as { id?: unknown }).id
      blockId =
        typeof candidate === "string" &&
        candidate.length >= 1 &&
        candidate.length <= 64
          ? candidate
          : null
    }
  }

  return blockId
}

/** The web half's verdict for one fixture, in the same shape the agent emits. */
function webVerdict(entry: ManifestEntry, definition: unknown): AgentVerdict {
  const issues: readonly FieldIssue[] = collectDefinitionIssues(definition, {
    mode: entry.mode,
  })

  const byKey = new Map<string, OffenderRecord>()
  for (const issue of issues) {
    const blockId = deriveBlockId(definition, issue.path)
    const key = offenderKey(blockId, issue.path)
    if (!byKey.has(key)) byKey.set(key, { block_id: blockId, path: issue.path })
  }

  return {
    file: entry.file,
    mode: entry.mode,
    verdict: issues.length > 0 ? "reject" : "accept",
    definition_sha256: definitionSha256(definition as never),
    offenders: [...byKey.values()],
  }
}

/**
 * The agent half's verdicts for the whole corpus, from one subprocess.
 *
 * One spawn for the whole corpus rather than one per fixture: the interpreter
 * start-up dominates, and there is nothing per-fixture about the process
 * boundary.
 */
function readAgentVerdicts(): ReadonlyMap<string, AgentVerdict> {
  const instructions =
    "The behavioural half of the mirror guard runs the agent's own validator, so it " +
    "needs the agent's development environment. From `agent/`: `uv sync` (see " +
    "agent/README.md). This test fails rather than skipping on purpose — a skipped " +
    "mirror guard reads exactly like a passing one."

  expect(
    existsSync(AGENT_PYTHON),
    `${path.relative(repoRoot, AGENT_PYTHON)} is missing. ${instructions}`
  ).toBe(true)
  expect(
    existsSync(AGENT_CORPUS_SCRIPT),
    `${path.relative(repoRoot, AGENT_CORPUS_SCRIPT)} is missing`
  ).toBe(true)

  const result = spawnSync(AGENT_PYTHON, [AGENT_CORPUS_SCRIPT], {
    cwd: AGENT_ROOT,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: path.join(AGENT_ROOT, "src") },
    maxBuffer: 32 * 1024 * 1024,
  })

  expect(
    result.status,
    `the agent corpus reader exited ${result.status}.\nstderr:\n${result.stderr}`
  ).toBe(0)

  const payload = JSON.parse(result.stdout) as {
    manifest_version: number
    fixtures: readonly AgentVerdict[]
  }
  expect(payload.manifest_version).toBe(1)

  return new Map(payload.fixtures.map((verdict) => [verdict.file, verdict]))
}

const agentVerdicts = readAgentVerdicts()

/** Every block `type` in a definition's block tree, including a row's children. */
function blockTypesIn(definition: unknown): Set<string> {
  const found = new Set<string>()

  const walk = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      if (block === null || typeof block !== "object") continue
      const { type, columns } = block as { type?: unknown; columns?: unknown }
      if (typeof type === "string") found.add(type)
      if (Array.isArray(columns)) for (const column of columns) walk(column)
    }
  }

  if (definition !== null && typeof definition === "object") {
    walk((definition as { blocks?: unknown }).blocks)
  }
  return found
}

describe("Requirement 2.11 — the shared corpus is one directory, and it is covered", () => {
  test("the corpus directory holds the manifest and nothing undeclared", () => {
    expect(existsSync(CORPUS_ROOT), CORPUS_ROOT).toBe(true)

    const onDisk = readdirSync(CORPUS_ROOT)
      .filter((name) => name.endsWith(".json") && name !== "manifest.json")
      .sort()
    const declared = manifest.map((entry) => entry.file).sort()

    // Both directions: an undeclared fixture is a file neither half checks, and a
    // declared-but-absent one is a manifest entry pointing at nothing.
    expect(declared).toEqual(onDisk)
  })

  test("the corpus meets its size floor and carries both verdicts", () => {
    expect(manifest.length).toBeGreaterThanOrEqual(MINIMUM_CORPUS_SIZE)
    expect(new Set(manifest.map((entry) => entry.verdict))).toEqual(
      new Set(["accept", "reject"])
    )
  })

  test("the corpus exercises both validation modes", () => {
    // Zero blocks is a valid draft and an invalid run (Requirement 6.8) — the one
    // rule that differs between the modes, so both must appear.
    expect(new Set(manifest.map((entry) => entry.mode))).toEqual(
      new Set(["draft", "run"])
    )
  })

  test("every declared block type appears in at least one fixture", () => {
    const covered = new Set<string>()
    for (const entry of manifest) {
      for (const type of blockTypesIn(readFixture(entry.file)))
        covered.add(type)
    }

    const missing = BLOCK_TYPES.filter((type) => !covered.has(type))
    expect(
      missing,
      "a declared block type appearing in no fixture is a type the two halves are " +
        "never compared on"
    ).toEqual([])
  })

  test("the agent half reported a verdict for every declared fixture", () => {
    expect([...agentVerdicts.keys()].sort()).toEqual(
      manifest.map((entry) => entry.file).sort()
    )
  })
})

describe("Requirement 2.6 — both validators reach the same verdict on every fixture", () => {
  for (const entry of manifest) {
    const definition = readFixture(entry.file)
    const web = webVerdict(entry, definition)
    const agent = agentVerdicts.get(entry.file)

    describe(entry.file, () => {
      test("the Template_Validator matches the manifest's verdict", () => {
        expect(
          web.verdict,
          `web offenders: ${[...locationSet(web.offenders)].join(" | ")}`
        ).toBe(entry.verdict)
      })

      test("the Template_Validator and the Block_Compiler agree on accept-or-reject", () => {
        expect(agent, `no agent verdict for ${entry.file}`).toBeDefined()
        expect(agent?.mode).toBe(entry.mode)
        expect(agent?.verdict).toBe(web.verdict)
      })

      test("both halves name the same offending block ids and field paths", () => {
        const webLocations = locationSet(web.offenders)
        const agentLocations = locationSet(agent?.offenders ?? [])
        const declaredLocations = locationSet(entry.offenders)

        // Three-way, in one assertion per direction, so a failure names every
        // differing location rather than the first one found.
        expect([...webLocations].sort()).toEqual([...declaredLocations].sort())
        expect([...agentLocations].sort()).toEqual(
          [...declaredLocations].sort()
        )
        expect([...webLocations].sort()).toEqual([...agentLocations].sort())
      })

      test("both halves compute the same definition_sha256", () => {
        // Property 11's cross-language half (Requirement 9.4): RFC 8785 canonical
        // form, SHA-256, 64 lowercase hexadecimal characters, computed
        // independently in TypeScript and in Python over the identical bytes on
        // disk. A key-ordering or escaping disagreement between the two
        // canonicalizers shows up here as a mismatch on every fixture at once.
        expect(web.definition_sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(web.definition_sha256).toBe(entry.definition_sha256)
        expect(agent?.definition_sha256).toBe(web.definition_sha256)
      })
    })
  }
})

describe("Requirement 2.7 — one pass reports every violation", () => {
  test("the six-defect fixture reports all six locations in one response", () => {
    // The fixture that kills a validator returning only its first error: an
    // undeclared top-level key, a `schema_version` above the supported maximum, an
    // undeclared block type, a `rich_text` binding a snapshot path, a row nested in
    // a row, and a duplicate id inside a row column — six independent defects, six
    // distinct locations, one response.
    const file = "reject-six-simultaneous-defects.json"
    const entry = manifest.find((candidate) => candidate.file === file)
    expect(entry, `${file} is missing from the corpus`).toBeDefined()

    const definition = readFixture(file)
    const web = webVerdict(entry as ManifestEntry, definition)

    expect(web.verdict).toBe("reject")
    expect(locationSet(web.offenders).size).toBe(6)
    expect(locationSet(agentVerdicts.get(file)?.offenders ?? []).size).toBe(6)
  })
})
