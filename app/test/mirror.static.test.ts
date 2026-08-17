import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { BLOCK_CONFIG, BLOCK_TYPES } from "@/lib/templates/blocks"

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
 * This is the **declaration half** of `Mirror_Guard`. The **behavioural**
 * half — the shared fixture corpus run through both the `Template_Validator`
 * and the `Block_Compiler` with matching verdicts and matching offender paths
 * (Req 2.11) — is a later task (5.2); declaration equality is necessary and not
 * sufficient, and this file asserts only the necessary half.
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
  const pattern = new RegExp(`(?:"${key}"|'${key}')\\s*:\\s*${escapedOpen}|\\b${key}\\s*:\\s*${escapedOpen}`)
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
        missing.push(
          `${typeName}: absent from agent/.../compile/definition.py`
        )
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
