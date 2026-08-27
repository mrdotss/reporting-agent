import { describe, expect, test } from "vitest"

import {
  collectDefinitionIssues,
  PERIOD_KINDS,
  type FieldIssue,
} from "@/lib/templates/definition"
import {
  STARTER_DATA_SECTION_TYPES,
  STARTER_KEYS,
  STARTER_RECORD_SECTION_TYPE,
  STARTER_TEMPLATE_COUNT,
  STARTER_TEMPLATES,
  starterSections,
} from "@/lib/templates/starters"
import {
  canonicalDefinitionJson,
  definitionSha256,
} from "@/lib/templates/version"
import { AZURE_SECTIONS } from "@/lib/profiles/sections"

/**
 * The starter-profile build guard (Requirements 10.1, 10.3, 10.5, 10.8, 20.9).
 *
 * Requirement 10.8 is the whole point of this file: a starter definition that
 * fails the `Template_Validator` must **fail the build**, naming that starter
 * and each failing field path, rather than being discovered by the first user
 * whose account was created with it. So these are assertions about repository
 * *content* — three values declared in `lib/templates/starters.ts` — and they
 * run in every `pnpm test`, with no database and no network.
 *
 * ## v3, not v1 (task 3.13)
 *
 * The starters are now section-based v3 profiles. This file's assertions were
 * rewritten around `sections` rather than `blocks`/`row` — `flattenStarterBlocks`,
 * `referencedMetricKeys` and the row-traversal checks belonged to the v1/v2
 * shape and have no v3 analog: a v3 section carries no `scope_override`
 * containment to check the way a v1 block config did, and there is no row
 * nesting in a `sections` array at all.
 *
 * `mode: "run"`, not `"draft"` — `collectDefinitionIssues` accepts a
 * definition carrying zero sections as a valid draft (Requirement 6.8's v3
 * successor). A starter is not a draft.
 */

/** `starter <key>` plus every issue, one per line, for an assertion message. */
function describeIssues(key: string, issues: readonly FieldIssue[]): string {
  if (issues.length === 0) return `starter "${key}" is valid`

  const lines = issues.map(
    (issue) =>
      `  ${issue.path.length === 0 ? "<root>" : issue.path.join(".")}: ${issue.message}`
  )

  return [
    `starter "${key}" fails the Template_Validator at ${issues.length} field ` +
      `path${issues.length === 1 ? "" : "s"}:`,
    ...lines,
  ].join("\n")
}

/** The five relative kinds — Requirement 10.3 permits these and not `custom`. */
const RELATIVE_PERIOD_KINDS = PERIOD_KINDS.filter((kind) => kind !== "custom")

const CATALOGUE_KEYS = new Set(AZURE_SECTIONS.map((entry) => entry.key))

describe("Requirement 10.1 — exactly three starters are declared", () => {
  test("the declared set has three entries", () => {
    expect(STARTER_TEMPLATES).toHaveLength(STARTER_TEMPLATE_COUNT)
    expect(STARTER_TEMPLATE_COUNT).toBe(3)
  })

  test("the three names are the ones the requirement names", () => {
    expect(
      STARTER_TEMPLATES.map((starter) => starter.definition.identity.name)
    ).toEqual(["Monthly utilization", "Capacity planning", "Executive summary"])
  })

  test("the seeded starter keys are distinct and stable-looking", () => {
    expect(new Set(STARTER_KEYS).size).toBe(STARTER_TEMPLATE_COUNT)
    expect([...STARTER_KEYS]).toEqual(
      STARTER_TEMPLATES.map((starter) => starter.seededStarterKey)
    )

    for (const key of STARTER_KEYS) {
      expect(key, `"${key}" is not a stable lower_snake_case key`).toMatch(
        /^[a-z][a-z0-9_]*$/
      )
    }
  })

  test("each template row's name and description come from its own definition", () => {
    for (const { seededStarterKey, definition } of STARTER_TEMPLATES) {
      const { name, description } = definition.identity

      expect(name.length, seededStarterKey).toBeGreaterThanOrEqual(1)
      expect(name.length, seededStarterKey).toBeLessThanOrEqual(120)
      expect((description ?? "").length, seededStarterKey).toBeLessThanOrEqual(
        1000
      )
    }
  })
})

describe("Requirement 10.8 — every starter passes the Template_Validator", () => {
  test.each(
    STARTER_TEMPLATES.map(
      (starter) => [starter.seededStarterKey, starter] as const
    )
  )("%s validates in run mode with zero issues", (key, starter) => {
    const issues = collectDefinitionIssues(starter.definition, {
      mode: "run",
    })

    expect(issues, describeIssues(key, issues)).toEqual([])
  })

  test("the validator would notice a broken starter", () => {
    // Non-vacuity, over the real validator's behaviour rather than an assumed
    // one: a `sections` array containing something not shaped like a section
    // is refused, naming that path.
    const first = STARTER_TEMPLATES[0]!.definition as unknown as {
      sections: unknown[]
    }
    const broken = {
      ...first,
      sections: [...first.sections, { id: "bad" }], // no `type`
    }

    const issues = collectDefinitionIssues(broken, { mode: "run" })

    expect(issues.length).toBeGreaterThan(0)
  })

  test("every section type a starter declares exists in the shipped catalogue", () => {
    // If this fails, a starter has drifted from the catalogue it claims to
    // use — the same live-check reasoning `emit.test.ts` applies to its own
    // corpus (task 3.8's `note`).
    for (const { seededStarterKey, definition } of STARTER_TEMPLATES) {
      for (const section of starterSections(definition)) {
        expect(
          CATALOGUE_KEYS.has(section.type),
          `starter "${seededStarterKey}" section "${section.id}" declares ` +
            `type "${section.type}", which the shipped catalogue does not`
        ).toBe(true)
      }
    }
  })
})

describe("Requirement 10.3 — every period is relative, never custom", () => {
  test.each(
    STARTER_TEMPLATES.map(
      (starter) => [starter.seededStarterKey, starter] as const
    )
  )("%s declares a relative period", (key, starter) => {
    const { kind } = starter.definition.period

    expect(
      RELATIVE_PERIOD_KINDS,
      `starter "${key}" must carry one of the five relative period kinds so ` +
        `it runs unedited in a later month; it declares "${kind}"`
    ).toContain(kind)
    expect(kind, key).not.toBe("custom")
  })

  test("the relative set is the five the requirement lists", () => {
    expect([...RELATIVE_PERIOD_KINDS]).toEqual([
      "last_24h",
      "last_7d",
      "last_30d",
      "last_full_month",
      "mtd",
    ])
  })
})

describe("Requirement 10.5 — every starter demonstrates the provenance chain", () => {
  test.each(
    STARTER_TEMPLATES.map(
      (starter) => [starter.seededStarterKey, starter] as const
    )
  )(
    "%s carries a data section and exactly one coverage_and_verification section",
    (key, starter) => {
      const types = starterSections(starter.definition).map(
        (section) => section.type
      )

      const dataSections = types.filter((type) =>
        (STARTER_DATA_SECTION_TYPES as readonly string[]).includes(type)
      )
      const records = types.filter(
        (type) => type === STARTER_RECORD_SECTION_TYPE
      )

      expect(
        dataSections.length,
        `starter "${key}" carries no section from ` +
          `${STARTER_DATA_SECTION_TYPES.join(", ")}, so it emits no figure ` +
          `and demonstrates no provenance`
      ).toBeGreaterThan(0)

      // Exactly one: two coverage_and_verification sections would state the
      // same collection record twice, and the catalogue's own `position:
      // "always"` rule (Requirement 8.4) means it is never authored twice in
      // a real profile either — this asserts the starter follows that rule.
      expect(
        records.length,
        `starter "${key}" must carry exactly one ${STARTER_RECORD_SECTION_TYPE} section`
      ).toBe(1)
    }
  )

  test.each(
    STARTER_TEMPLATES.map(
      (starter) => [starter.seededStarterKey, starter] as const
    )
  )("%s has unique section ids", (key, starter) => {
    const ids = starterSections(starter.definition).map(
      (section) => section.id
    )
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)

    expect(duplicates, `starter "${key}" repeats a section id`).toEqual([])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test.each(
    STARTER_TEMPLATES.map(
      (starter) => [starter.seededStarterKey, starter] as const
    )
  )("%s does not repeat a non-repeatable section type", (key, starter) => {
    const types = starterSections(starter.definition).map(
      (section) => section.type
    )
    const nonRepeatable = new Set(
      AZURE_SECTIONS.filter((entry) => !entry.repeatable).map(
        (entry) => entry.key
      )
    )

    const seen = new Set<string>()
    const repeated: string[] = []
    for (const type of types) {
      if (nonRepeatable.has(type)) {
        if (seen.has(type)) repeated.push(type)
        seen.add(type)
      }
    }

    expect(repeated, `starter "${key}" repeats a non-repeatable section type`).toEqual([])
  })
})

describe("each starter's canonical digest computes and is distinct", () => {
  test.each(
    STARTER_TEMPLATES.map(
      (starter) => [starter.seededStarterKey, starter] as const
    )
  )(
    "%s canonicalizes and hashes to 64 lowercase hex characters",
    (key, starter) => {
      expect(
        () => canonicalDefinitionJson(starter.definition),
        key
      ).not.toThrow()

      const digest = definitionSha256(starter.definition)

      expect(digest, key).toMatch(/^[0-9a-f]{64}$/)
      expect(definitionSha256(starter.definition), key).toBe(digest)
    }
  )

  test("the three digests are distinct", () => {
    const digests = STARTER_TEMPLATES.map((starter) =>
      definitionSha256(starter.definition)
    )

    expect(new Set(digests).size, digests.join("\n")).toBe(
      STARTER_TEMPLATE_COUNT
    )
  })

  test("the three are distinct in more than their identity", () => {
    const periods = STARTER_TEMPLATES.map(
      (starter) => starter.definition.period.kind
    )
    const presets = STARTER_TEMPLATES.map(
      (starter) => starter.definition.design.preset
    )
    const shapes = STARTER_TEMPLATES.map((starter) =>
      starterSections(starter.definition)
        .map((section) => section.type)
        .sort()
        .join(",")
    )

    // Two starters legitimately share `last_full_month` — the monthly report
    // and the executive summary are both monthly — so periods are not
    // required to be three distinct values; presets and section-type shapes
    // are.
    expect(new Set(periods).size).toBeGreaterThan(1)
    expect(new Set(presets).size).toBe(STARTER_TEMPLATE_COUNT)
    expect(new Set(shapes).size, shapes.join("\n")).toBe(STARTER_TEMPLATE_COUNT)
  })
})
