import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import type { ScopeSpec, TemplateBlock } from "@/lib/templates/definition"
import { unionScope } from "@/lib/templates/scope-union"

/**
 * The scope-union mirror, web half (Requirement 3.3).
 *
 * `lib/templates/scope-union.ts#unionScope` and
 * `agent/src/reporting_agent/compile/scope.py#union_scope` compute the same
 * union, and they have to: this half derives a run's `scope` column from the
 * pinned definition, and the agent keys its Requirement 5.4 metric narrowing off
 * the same union. Two halves that disagree about which resource types a run
 * covers produce the quietest failure in this product — a type present in one
 * and absent from the other requests no metric, its resources land in the
 * snapshot carrying nothing, and every gate passes, because a resource with no
 * figures is a resource with no *unverifiable* figures.
 *
 * Both halves assert against **one committed corpus** rather than against each
 * other. `agent/tests/fixtures/scope-union/cases.json` carries the inputs and the
 * expected unions; this file runs the TypeScript implementation over them and
 * `agent/tests/test_scope_union_mirror.py` runs the Python one. A change to
 * either half fails one of the two suites — the property a
 * regenerate-and-compare guard would not have, since two implementations
 * regenerated together drift together and agree the whole way down.
 *
 * Reading the corpus from `agent/` rather than copying it into `app/` is the same
 * decision `test/mirror.static.test.ts` makes about the block vocabulary: a
 * second copy is a third thing to keep correct.
 */

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const repoRoot = path.resolve(appRoot, "..")

const CASES_PATH = path.join(
  repoRoot,
  "agent",
  "tests",
  "fixtures",
  "scope-union",
  "cases.json"
)

type Case = {
  readonly name: string
  readonly scope: ScopeSpec
  readonly overrides: readonly ScopeSpec[]
  readonly expected: {
    readonly resource_types: readonly string[]
    readonly resource_groups: readonly string[]
    readonly tag_filters: Readonly<Record<string, string>>
  }
}

const corpus = JSON.parse(readFileSync(CASES_PATH, "utf8")) as {
  readonly cases: readonly Case[]
}

/**
 * Each override becomes one leaf block carrying it.
 *
 * The corpus describes *scopes*, not blocks, because the Python half takes a
 * list of `ScopeRules` directly while this half walks a definition. Wrapping
 * here rather than in the corpus keeps the fixture about the rule under test
 * instead of about either half's calling convention.
 */
function definitionFor(entry: Case) {
  const blocks: TemplateBlock[] = entry.overrides.map((override, index) => ({
    id: `b${index}`,
    type: "kpi_row",
    config: {},
    scope_override: override,
  }))

  return { scope: entry.scope, blocks }
}

describe("Requirement 3.3 — both halves compute one union", () => {
  test("the corpus is present and non-empty", () => {
    expect(corpus.cases.length).toBeGreaterThan(0)
  })

  test.each(corpus.cases.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      expect(unionScope(definitionFor(entry))).toEqual({
        resource_types: entry.expected.resource_types,
        resource_groups: entry.expected.resource_groups,
        tag_filters: entry.expected.tag_filters,
      })
    }
  )

  test("the corpus covers both widening directions", () => {
    // A corpus of only-widening cases would pass against an implementation that
    // always returned the empty union, and one of only-populated cases would
    // pass against an implementation that never applied the empty-wins rule.
    const expectations = corpus.cases.map((entry) => entry.expected)

    expect(expectations.some((e) => e.resource_types.length > 0)).toBe(true)
    expect(expectations.some((e) => e.resource_types.length === 0)).toBe(true)
    expect(
      expectations.some((e) => Object.keys(e.tag_filters).length > 0)
    ).toBe(true)
    expect(
      expectations.some((e) => Object.keys(e.tag_filters).length === 0)
    ).toBe(true)
  })

  test("at least one case supplies a ranking the union must drop", () => {
    // So the absence of `top_n` from every expectation is a fact about the
    // union rather than about the corpus.
    expect(
      corpus.cases.some(
        (entry) =>
          entry.scope.top_n !== null ||
          entry.overrides.some((override) => override.top_n !== null)
      )
    ).toBe(true)
  })
})
