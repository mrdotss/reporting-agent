import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { EVENT_TYPES, isDeclaredEventType } from "@/lib/events"

/**
 * The event-vocabulary mirror guard (Requirement 40.13).
 *
 * One vocabulary, two languages: `app/lib/events.ts` and
 * `agent/src/reporting_agent/events.py` each declare the same ten event types
 * between sentinel comments (Requirement 40.7). This guard reads both files from
 * disk, pulls the quoted strings from between the sentinels, and compares the
 * two sets.
 *
 * It parses neither language. That is the point: a guard that needed a Python
 * parser and a TypeScript parser would be a third thing able to drift from the
 * two it guards. Sentinel-delimited literals reduce it to reading two files and
 * diffing two sets.
 *
 * It lives in the web suite rather than the agent suite because it ships with
 * the second of the two files — the app half — so the vocabulary cannot be added
 * to one language without the other from the moment both exist.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** The monorepo root — `agent/` is a sibling of `app/`. */
const repoRoot = path.resolve(appRoot, "..")

const TS_DECLARATION = path.join(appRoot, "lib", "events.ts")
const PY_DECLARATION = path.join(
  repoRoot,
  "agent",
  "src",
  "reporting_agent",
  "events.py"
)

const BEGIN_SENTINEL = "--- BEGIN EVENT TYPES"
const END_SENTINEL = "--- END EVENT TYPES"

/** Every single- or double-quoted string literal on a line. */
const QUOTED_STRING = /"([^"\n]*)"|'([^'\n]*)'/g

function read(absolutePath: string): string {
  expect(
    existsSync(absolutePath),
    `${path.relative(repoRoot, absolutePath)} is missing`
  ).toBe(true)
  return readFileSync(absolutePath, "utf8")
}

/**
 * The quoted strings between the two sentinels, in declaration order.
 *
 * Both sentinels must be present and ordered, and the block between them must
 * be non-empty — a guard that passes because it found nothing is the failure
 * mode this whole file exists to avoid.
 */
function declaredEventTypes(absolutePath: string): readonly string[] {
  const where = path.relative(repoRoot, absolutePath)
  const lines = read(absolutePath).split("\n")

  const begin = lines.findIndex((line) => line.includes(BEGIN_SENTINEL))
  const end = lines.findIndex((line) => line.includes(END_SENTINEL))

  expect(
    begin,
    `${where} declares no ${BEGIN_SENTINEL} sentinel`
  ).toBeGreaterThan(-1)
  expect(end, `${where} declares no ${END_SENTINEL} sentinel`).toBeGreaterThan(
    -1
  )
  expect(
    end,
    `${where} closes the sentinel block before it opens it`
  ).toBeGreaterThan(begin)

  const found: string[] = []
  for (const line of lines.slice(begin + 1, end)) {
    for (const match of line.matchAll(QUOTED_STRING)) {
      found.push(match[1] ?? match[2])
    }
  }

  expect(
    found.length,
    `${where} declares no quoted event type between its sentinels`
  ).toBeGreaterThan(0)

  return found
}

/** The ten types, as a fact about the requirement rather than about the files. */
const EXPECTED_COUNT = 10

describe("Requirements 40.7, 40.13 — the event vocabulary is mirrored", () => {
  test("the TypeScript declaration is the ten declared types", () => {
    const declared = declaredEventTypes(TS_DECLARATION)

    expect(declared).toEqual([...new Set(declared)])
    expect(declared.length).toBe(EXPECTED_COUNT)
  })

  test("the Python declaration is the ten declared types", () => {
    const declared = declaredEventTypes(PY_DECLARATION)

    expect(declared).toEqual([...new Set(declared)])
    expect(declared.length).toBe(EXPECTED_COUNT)
  })

  test("the two declared sets are equal", () => {
    // Sorted rather than order-sensitive: the requirement is that the two
    // vocabularies are the same set, and declaration order carries no meaning
    // in either language.
    expect([...declaredEventTypes(TS_DECLARATION)].sort()).toEqual(
      [...declaredEventTypes(PY_DECLARATION)].sort()
    )
  })

  test("the sentinel block is the module's actual declaration", () => {
    // Extraction is textual, so on its own it would still pass if the sentinels
    // wrapped a decorative comment and the module exported a different list.
    // Comparing the extracted strings against the imported export closes that
    // hole from the app side.
    expect([...declaredEventTypes(TS_DECLARATION)]).toEqual([...EVENT_TYPES])
  })

  test("every declared type is recognised, and an undeclared one is not", () => {
    // Requirement 40.6 — an unknown type is ignored rather than fatal, so the
    // predicate the stream hook uses has to narrow rather than throw.
    for (const type of EVENT_TYPES) expect(isDeclaredEventType(type)).toBe(true)

    for (const notAType of ["", "Done", "report_files", "tool ", 7, null]) {
      expect(isDeclaredEventType(notAType)).toBe(false)
    }
  })
})

describe("Requirement 14.11 — the emitted subset is declared, and is a subset", () => {
  /** `EMITTED_BY_FOUNDATION = frozenset({...})`, as written in `events.py`. */
  function emittedByFoundation(): readonly string[] {
    const source = read(PY_DECLARATION)
    // `[^}]*` spans newlines on its own, so no `s` flag — which the compiler
    // target would reject anyway.
    const assignment =
      /EMITTED_BY_FOUNDATION[^=]*=\s*frozenset\(\s*\{([^}]*)\}/.exec(source)

    expect(
      assignment,
      "events.py declares no EMITTED_BY_FOUNDATION"
    ).not.toBeNull()

    const found: string[] = []
    for (const match of (assignment?.[1] ?? "").matchAll(QUOTED_STRING)) {
      found.push(match[1] ?? match[2])
    }
    return found
  }

  test("the emitted set is a non-empty subset of the vocabulary", () => {
    const emitted = emittedByFoundation()
    const declared = new Set(declaredEventTypes(PY_DECLARATION))

    expect(emitted.length).toBeGreaterThan(0)
    for (const type of emitted) expect(declared.has(type)).toBe(true)
  })

  test("no document event is claimed as emitted by this spec", () => {
    // Nothing here compiles, renders or verifies a document, so a `verification`
    // or a `report_file` must be unemittable — which is also what makes the
    // ordering guarantee (no `report_file` without a passing `verification`
    // before it) impossible to violate here.
    const emitted = emittedByFoundation()

    expect(emitted).not.toContain("verification")
    expect(emitted).not.toContain("report_file")
  })

  test("the emitted set sits outside the sentinels", () => {
    // Otherwise its literals would be read as vocabulary and the mirror
    // comparison would fail for a reason that has nothing to do with drift.
    const declared = declaredEventTypes(PY_DECLARATION)

    expect(declared.length).toBe(EXPECTED_COUNT)
  })
})
