import { describe, expect, test } from "vitest"

import { BLOCK_TYPES } from "@/lib/templates/blocks"
import {
  collectDefinitionIssues,
  PERIOD_KINDS,
  type FieldIssue,
} from "@/lib/templates/definition"
import {
  flattenStarterBlocks,
  referencedMetricKeys,
  selectedMetricKeys,
  STARTER_DATA_BLOCK_TYPES,
  STARTER_KEYS,
  STARTER_NARRATIVE_BLOCK_TYPES,
  STARTER_RECORD_BLOCK_TYPE,
  STARTER_TEMPLATE_COUNT,
  STARTER_TEMPLATES,
} from "@/lib/templates/starters"
import {
  canonicalDefinitionJson,
  definitionSha256,
} from "@/lib/templates/version"

/**
 * The starter-template build guard (Requirements 10.1, 10.3, 10.5, 10.8).
 *
 * Requirement 10.8 is the whole point of this file: a starter definition that
 * fails the `Template_Validator` must **fail the build**, naming that starter and
 * each failing field path, rather than being discovered by the first user whose
 * account was created with it. So these are assertions about repository
 * *content* — three values declared in `lib/templates/starters.ts` — and they run
 * in every `pnpm test`, with no database and no network.
 *
 * ## `mode: "run"`, not `"draft"`
 *
 * `collectDefinitionIssues` accepts a definition carrying zero blocks as a valid
 * draft (Requirement 6.8). A starter is not a draft: Requirement 10.3 calls it "a
 * working example that needs no edit to run", and Requirement 10.2 seeds it as
 * `version` 1 — a version a run can pin the moment the account exists. Validating
 * in draft mode would let a blockless starter ship and fail at enqueue.
 *
 * ## Every failing path, per starter, in one failure
 *
 * The validator already reports every violation in one pass, and this guard
 * preserves that: it formats the whole issue list into the assertion message
 * rather than asserting on the first issue, so one run of `pnpm test` names
 * everything that needs fixing. A guard that stopped at the first path would
 * turn a three-defect starter into three build-fix cycles, which is exactly the
 * cost Requirement 2.7 exists to avoid at save time.
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

const BLOCK_TYPE_SET = new Set<string>(BLOCK_TYPES)

describe("Requirement 10.1 — exactly three starters are declared", () => {
  test("the declared set has three entries", () => {
    expect(STARTER_TEMPLATES).toHaveLength(STARTER_TEMPLATE_COUNT)
    expect(STARTER_TEMPLATE_COUNT).toBe(3)
  })

  test("the three names are the ones the requirement names", () => {
    // Requirement 10.1 names them, so the names are asserted rather than left to
    // a reader to recognize — a renamed starter is a product change, not a tidy-up.
    expect(
      STARTER_TEMPLATES.map((starter) => starter.definition.identity.name)
    ).toEqual(["Monthly utilization", "Capacity planning", "Executive summary"])
  })

  test("the seeded starter keys are distinct and stable-looking", () => {
    // Distinct because they are the idempotency key of
    // `UNIQUE (user_id, seeded_starter_key)`: two starters sharing one key would
    // make the second silently conflict away on every account.
    expect(new Set(STARTER_KEYS).size).toBe(STARTER_TEMPLATE_COUNT)
    expect([...STARTER_KEYS]).toEqual(
      STARTER_TEMPLATES.map((starter) => starter.seededStarterKey)
    )

    for (const key of STARTER_KEYS) {
      // Lower snake case, so the persisted value cannot pick up a display
      // name's casing or spacing and then move when the label is edited.
      expect(key, `"${key}" is not a stable lower_snake_case key`).toMatch(
        /^[a-z][a-z0-9_]*$/
      )
    }
  })

  test("each template row's name and description come from its own definition", () => {
    // The seeder reads both off `identity`, so this asserts the only thing that
    // could disagree: a bound the `report_templates` CHECK constraints enforce.
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
    // The assertion this file exists for. `mode: "run"` because a starter is a
    // runnable version rather than a draft (see the module docstring), and the
    // whole issue list is formatted into the message so one failure names
    // every field path that needs fixing (Requirement 10.8).
    const issues = collectDefinitionIssues(starter.definition, {
      mode: "run",
    })

    expect(issues, describeIssues(key, issues)).toEqual([])
  })

  test("the validator would notice a broken starter", () => {
    // Non-vacuity. "Zero issues" is also what a validator that checked nothing
    // reports, so one deliberately broken copy of a real starter is run through
    // the same call and asserted to fail — naming the field that was broken.
    const broken = {
      ...STARTER_TEMPLATES[0].definition,
      design: {
        ...STARTER_TEMPLATES[0].definition.design,
        preset: "not-a-preset",
      },
    }

    const issues = collectDefinitionIssues(broken, { mode: "run" })

    expect(issues.length).toBeGreaterThan(0)
    expect(issues.map((issue) => issue.path.join("."))).toContain(
      "design.preset"
    )
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
    // Pinned, so the assertion above cannot pass by comparing against a set that
    // quietly grew `custom` back.
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
    "%s carries a data block, a narrative block and exactly one verification_record",
    (key, starter) => {
      const types = flattenStarterBlocks(starter.definition).map(
        (block) => block.type
      )

      const dataBlocks = types.filter((type) =>
        (STARTER_DATA_BLOCK_TYPES as readonly string[]).includes(type)
      )
      const narrativeBlocks = types.filter((type) =>
        (STARTER_NARRATIVE_BLOCK_TYPES as readonly string[]).includes(type)
      )
      const records = types.filter((type) => type === STARTER_RECORD_BLOCK_TYPE)

      expect(
        dataBlocks.length,
        `starter "${key}" carries no block from ${STARTER_DATA_BLOCK_TYPES.join(", ")}, ` +
          `so it emits no figure and demonstrates no provenance`
      ).toBeGreaterThan(0)

      expect(
        narrativeBlocks.length,
        `starter "${key}" carries no ${STARTER_NARRATIVE_BLOCK_TYPES.join(" or ")} block`
      ).toBeGreaterThan(0)

      // Exactly one: two `verification_record` blocks would state the same
      // collection record twice, and zero would leave the figures untraceable
      // from inside the document.
      expect(
        records.length,
        `starter "${key}" must carry exactly one ${STARTER_RECORD_BLOCK_TYPE} block`
      ).toBe(1)
    }
  )

  test.each(
    STARTER_TEMPLATES.map(
      (starter) => [starter.seededStarterKey, starter] as const
    )
  )("%s uses only declared block types", (key, starter) => {
    const undeclared = flattenStarterBlocks(starter.definition)
      .filter((block) => !BLOCK_TYPE_SET.has(block.type))
      .map((block) => `${block.id} (${block.type})`)

    expect(
      undeclared,
      `starter "${key}" carries undeclared block types`
    ).toEqual([])
  })

  test.each(
    STARTER_TEMPLATES.map(
      (starter) => [starter.seededStarterKey, starter] as const
    )
  )("%s has unique block ids, counting row children", (key, starter) => {
    // Requirement 6.7 — the validator asserts this too, and it is asserted
    // separately here because a duplicate inside a row column is the case a
    // top-level-only scan misses, and this traversal descends into columns.
    const ids = flattenStarterBlocks(starter.definition).map(
      (block) => block.id
    )
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)

    expect(duplicates, `starter "${key}" repeats a block id`).toEqual([])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("the traversal descends into row columns", () => {
    // The anchor for `flattenStarterBlocks`: a traversal that stopped at the top
    // level would make every assertion above weaker without failing any of them.
    const monthly = STARTER_TEMPLATES[0].definition
    const rows = monthly.blocks.filter((block) => block.type === "row")

    expect(rows.length).toBeGreaterThan(0)
    expect(flattenStarterBlocks(monthly).length).toBeGreaterThan(
      monthly.blocks.length
    )
  })
})

describe("Requirement 5.3 — a block references only what its definition collects", () => {
  test.each(
    STARTER_TEMPLATES.map(
      (starter) => [starter.seededStarterKey, starter] as const
    )
  )("%s references no metric absent from its own selection", (key, starter) => {
    const selected = selectedMetricKeys(starter.definition)
    const referenced = referencedMetricKeys(starter.definition)

    const missing = [...referenced].filter((pair) => !selected.has(pair))

    expect(
      missing,
      `starter "${key}" has blocks referencing (metric, statistic) pairs its ` +
        `own metric selection does not collect`
    ).toEqual([])

    // Non-vacuity: a starter whose blocks referenced nothing would satisfy the
    // containment trivially.
    expect(referenced.size, key).toBeGreaterThan(0)
  })

  test.each(
    STARTER_TEMPLATES.map(
      (starter) => [starter.seededStarterKey, starter] as const
    )
  )(
    "%s carries an estimator and a fidelity tier on every percentile entry",
    (key, starter) => {
      // Requirements 5.7, 5.8. The validator rejects a bare percentile too; this
      // states the positive form, so a starter that dropped the label fails here
      // with the entry named rather than only as a field path.
      for (const [resourceType, items] of Object.entries(
        starter.definition.metrics
      )) {
        for (const item of items) {
          if (!/^p[0-9]+$/.test(item.statistic)) continue

          const where = `starter "${key}", ${resourceType}, ${item.metric ?? item.derived} ${item.statistic}`

          expect(item.estimator, where).toBeTruthy()
          expect(item.fidelity_tier, where).toBeTruthy()
        }
      }
    }
  )
})

describe("Requirement 9.4 — each starter's canonical digest computes and is distinct", () => {
  test.each(
    STARTER_TEMPLATES.map(
      (starter) => [starter.seededStarterKey, starter] as const
    )
  )(
    "%s canonicalizes and hashes to 64 lowercase hex characters",
    (key, starter) => {
      // The seeder computes this at insert time, so a definition carrying a value
      // with no RFC 8785 canonical form would throw inside the registration
      // transaction. Asserting it here makes that a build failure instead.
      expect(
        () => canonicalDefinitionJson(starter.definition),
        key
      ).not.toThrow()

      const digest = definitionSha256(starter.definition)

      expect(digest, key).toMatch(/^[0-9a-f]{64}$/)

      // Deterministic, which is what `version` 1 pinning depends on.
      expect(definitionSha256(starter.definition), key).toBe(digest)
    }
  )

  test("the three digests are distinct", () => {
    // The assertion that says the three starters are genuinely three reports
    // rather than one renamed three times: a digest collision would mean two
    // definitions are byte-identical in canonical form, which no amount of
    // different `identity.name` could produce — the name is inside the hash.
    const digests = STARTER_TEMPLATES.map((starter) =>
      definitionSha256(starter.definition)
    )

    expect(new Set(digests).size, digests.join("\n")).toBe(
      STARTER_TEMPLATE_COUNT
    )
  })

  test("the three are distinct in more than their identity", () => {
    // Stronger, and the reason the digest check alone is not enough: three
    // definitions differing only by name would each hash differently while still
    // being one report three times. Periods, presets and block-type multisets are
    // compared instead.
    const periods = STARTER_TEMPLATES.map(
      (starter) => starter.definition.period.kind
    )
    const presets = STARTER_TEMPLATES.map(
      (starter) => starter.definition.design.preset
    )
    const shapes = STARTER_TEMPLATES.map((starter) =>
      flattenStarterBlocks(starter.definition)
        .map((block) => block.type)
        .sort()
        .join(",")
    )

    // Two starters legitimately share `last_full_month` — the monthly report and
    // the executive summary are both monthly — so periods are not required to be
    // three distinct values; presets and block shapes are.
    expect(new Set(periods).size).toBeGreaterThan(1)
    expect(new Set(presets).size).toBe(STARTER_TEMPLATE_COUNT)
    expect(new Set(shapes).size, shapes.join("\n")).toBe(STARTER_TEMPLATE_COUNT)
  })
})
