import { describe, expect, test } from "vitest"

import {
  FRONT_MATTER_KEYS,
  LANGUAGES,
  MAX_SUPPORTED_SCHEMA_VERSION,
  MIN_SCHEMA_VERSION,
  SEPARATOR_DEFAULTS,
  collectDefinitionIssues,
  resolveSeparators,
} from "@/lib/templates/definition"
import {
  MIGRATION_LANGUAGE,
  MIGRATION_SOURCE_VERSION,
  MIGRATION_TARGET_VERSION,
  needsSchemaVersion2Migration,
  toSchemaVersion2,
} from "@/lib/templates/migrate"
import { STARTER_TEMPLATES } from "@/lib/templates/starters"

/**
 * `lib/templates/migrate.ts` — the one-directional version-1-to-2 migration
 * (Requirement 13.12).
 *
 * ## The assertion that actually matters
 *
 * **Every shipped starter migrates into a definition the validator accepts.** The five
 * starters are stored version-1 definitions carrying `cover` blocks, so they are the corpus
 * this migration exists for, and a migrated definition the validator rejects is an unsaveable
 * draft — the consultant opens a template and cannot get out of the wizard. That case is
 * checked against `collectDefinitionIssues` itself rather than against a list of expected
 * fields, because the validator is the thing that will refuse the save.
 *
 * ## What is asserted about purity, and why not just "it returns a new object"
 *
 * The edit page resolves the draft and the latest version's definition from one read and
 * renders the template's *stored* state from the second. A migration that mutated in place
 * would edit the object the page also presents as "what is saved", so the input is deep-frozen
 * here: a write of any kind throws rather than passing unnoticed.
 */

// --- Fixtures ---------------------------------------------------------------

/** A minimal but **valid** version-1 definition carrying a `cover` block. */
function v1Definition(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema_version: 1,
    identity: { name: "Monthly utilization", report_title: "Utilization" },
    scope: {
      resource_types: ["Microsoft.Compute/virtualMachines"],
      tag_filters: [],
      resource_groups: [],
      top_n: null,
      sort: null,
    },
    period: { kind: "last_full_month" },
    metrics: {
      "Microsoft.Compute/virtualMachines": [
        { metric: "Percentage CPU", statistic: "avg" },
      ],
    },
    blocks: [
      { id: "cover", type: "cover", config: { subtitle: "July 2026" } },
      { id: "h", type: "heading", config: { level: 1, text: "Utilization" } },
    ],
    design: {
      preset: "editorian" in overrides ? "editorial" : "editorial",
      accent_color: "#1f6f78",
      density: "normal",
      table_style: "hairline",
      number_format: { decimal_places: 2, group_thousands: true },
      cover_page: true,
      logo: null,
      page_size: "A4",
    },
    ...overrides,
  }
}

/** Freezes every object and array reachable from `value`. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested)
  }
  return Object.freeze(value)
}

function pathsOf(definition: unknown): readonly string[] {
  return collectDefinitionIssues(definition, { mode: "run" })
    .map((issue) => issue.path.join("."))
    .sort()
}

function blockTypes(definition: Record<string, unknown>): readonly string[] {
  return (definition.blocks as { type: string }[]).map((block) => block.type)
}

// --- The four edits ---------------------------------------------------------

describe("Requirement 13.12 — the migration is exactly four edits", () => {
  test("the declared source and target versions are 1 and 2", () => {
    // Pinned as numbers rather than trusted from the names: a module migrating from 2 to 2
    // would satisfy every relative assertion below while doing nothing.
    expect(MIGRATION_SOURCE_VERSION).toBe(1)
    expect(MIGRATION_TARGET_VERSION).toBe(2)
    expect(MIGRATION_SOURCE_VERSION).toBe(MIN_SCHEMA_VERSION)
    // Migration target is explicitly 2 — not MAX — because no v2→v3 lift exists yet.
    expect(MIGRATION_TARGET_VERSION).toBeLessThanOrEqual(MAX_SUPPORTED_SCHEMA_VERSION)
  })

  test("schema_version becomes 2", () => {
    expect(toSchemaVersion2(v1Definition()).schema_version).toBe(2)
  })

  test("the cover block's config becomes front_matter.cover and the block is removed", () => {
    const migrated = toSchemaVersion2(v1Definition())

    const frontMatter = migrated.front_matter as Record<string, unknown>
    expect(frontMatter.cover).toEqual({ subtitle: "July 2026" })
    // Removed, not ignored. Requirement 13.2 rejects a `cover` block at version 2 or above,
    // and leaving it would also emit the cover twice — once from the section, once from the
    // block.
    expect(blockTypes(migrated)).toEqual(["heading"])
  })

  test("the three front_matter sections are all present", () => {
    const frontMatter = toSchemaVersion2(v1Definition()).front_matter as Record<
      string,
      unknown
    >

    // Required at version 2, and every field *inside* each is optional — so three objects,
    // two of them empty, is a complete front matter rather than a placeholder.
    expect(Object.keys(frontMatter).sort()).toEqual(
      [...FRONT_MATTER_KEYS].sort()
    )
    expect(frontMatter.document_control).toEqual({})
    expect(frontMatter.toc).toEqual({})
  })

  test("identity.language becomes en, which is the first declared language", () => {
    const migrated = toSchemaVersion2(v1Definition())

    expect((migrated.identity as Record<string, unknown>).language).toBe("en")
    // Read rather than written: `en` is `LANGUAGES[0]`, which is also the language a
    // definition declaring none resolves its separators from. Choosing anything else would
    // silently reformat every number in every existing template.
    expect(MIGRATION_LANGUAGE).toBe(LANGUAGES[0])
  })

  test("the two separators are written, and they are the pair en resolves to", () => {
    const migrated = toSchemaVersion2(v1Definition())

    const numberFormat = (migrated.design as Record<string, unknown>)
      .number_format as Record<string, unknown>
    expect(numberFormat.decimal_separator).toBe(
      SEPARATOR_DEFAULTS.en.decimal_separator
    )
    expect(numberFormat.grouping_separator).toBe(
      SEPARATOR_DEFAULTS.en.grouping_separator
    )
    // Written explicitly rather than left absent: both spellings resolve to the same pair
    // today, and only the declared one survives a later edit to `SEPARATOR_DEFAULTS`.
    expect(resolveSeparators(numberFormat, "en")).toEqual({
      decimal_separator: numberFormat.decimal_separator,
      grouping_separator: numberFormat.grouping_separator,
    })
  })

  test("the existing number_format fields survive", () => {
    const numberFormat = (
      toSchemaVersion2(v1Definition()).design as Record<string, unknown>
    ).number_format as Record<string, unknown>

    expect(numberFormat.decimal_places).toBe(2)
    expect(numberFormat.group_thousands).toBe(true)
  })

  test("everything the migration does not name is carried unchanged", () => {
    const before = v1Definition()
    const migrated = toSchemaVersion2(before)

    for (const key of ["scope", "period", "metrics"] as const) {
      expect(migrated[key]).toEqual(before[key])
    }
    expect((migrated.identity as Record<string, unknown>).report_title).toBe(
      "Utilization"
    )
  })
})

// --- The migrated definition is one the validator accepts -------------------

describe("Requirement 13.12 — a migrated definition is saveable", () => {
  test("the hand-built v1 definition validates before and after", () => {
    const before = v1Definition()

    // The control. Without it, a migration that produced a valid definition from an invalid
    // one would look like it had fixed something.
    expect(pathsOf(before)).toEqual([])
    expect(pathsOf(toSchemaVersion2(before))).toEqual([])
  })

  test.each(
    STARTER_TEMPLATES.map(
      (starter) => [starter.seededStarterKey, starter] as const
    )
  )(
    "the %s starter migrates into a definition the validator accepts",
    (_key, starter) => {
      // The corpus this migration exists for: five stored version-1 definitions carrying
      // `cover` blocks. A migrated definition the validator rejects is a template a consultant
      // can open and cannot save.
      const definition = starter.definition as unknown as Record<
        string,
        unknown
      >
      expect(definition.schema_version).toBe(1)

      const migrated = toSchemaVersion2(definition)

      expect(pathsOf(migrated)).toEqual([])
      expect(migrated.schema_version).toBe(2)
      expect(blockTypes(migrated)).not.toContain("cover")
    }
  )

  test("every starter carrying a cover block keeps its subtitle in the section", () => {
    // The half a "validates" assertion cannot see: a migration that dropped the config and
    // wrote an empty cover would validate perfectly and lose the consultant's subtitle.
    const withSubtitle = STARTER_TEMPLATES.filter((starter) =>
      (
        starter.definition as unknown as {
          blocks: { type: string; config?: Record<string, unknown> }[]
        }
      ).blocks.some(
        (block) =>
          block.type === "cover" && block.config?.subtitle !== undefined
      )
    )

    expect(withSubtitle.length).toBeGreaterThan(0)
    for (const starter of withSubtitle) {
      const definition = starter.definition as unknown as Record<
        string,
        unknown
      >
      const original = (
        definition.blocks as {
          type: string
          config?: Record<string, unknown>
        }[]
      ).find((block) => block.type === "cover")?.config?.subtitle

      const migrated = toSchemaVersion2(definition)
      const cover = (migrated.front_matter as Record<string, unknown>)
        .cover as Record<string, unknown>

      expect(cover.subtitle).toBe(original)
    }
  })
})

// --- One direction, and idempotence -----------------------------------------

describe("Requirement 13.12 — one direction, and never twice", () => {
  test("a definition already at version 2 is returned unchanged, by identity", () => {
    const already = deepFreeze(toSchemaVersion2(v1Definition()))

    // By identity, so a second pass cannot even produce an equal-but-different object — which
    // is what would let an `id` definition's declared language be overwritten with `en`.
    expect(toSchemaVersion2(already)).toBe(already)
  })

  test("a version-2 definition declaring id keeps its language and its separators", () => {
    // The case idempotence exists for. Re-running the migration over this would rewrite the
    // language to `en` and the separators to `.` and `,`, silently reformatting every number
    // in an Indonesian template.
    const indonesian = {
      ...toSchemaVersion2(v1Definition()),
    } as Record<string, unknown>
    indonesian.identity = {
      ...(indonesian.identity as Record<string, unknown>),
      language: "id",
    }
    indonesian.design = {
      ...(indonesian.design as Record<string, unknown>),
      number_format: {
        decimal_places: 2,
        group_thousands: true,
        decimal_separator: ",",
        grouping_separator: ".",
      },
    }

    const again = toSchemaVersion2(indonesian)

    expect((again.identity as Record<string, unknown>).language).toBe("id")
    expect(
      (
        (again.design as Record<string, unknown>).number_format as Record<
          string,
          unknown
        >
      ).decimal_separator
    ).toBe(",")
  })

  test("there is no downgrade", async () => {
    // Asserted as an absence, because the absence is the design: a downgrade is the one
    // operation that could make a pinned version render differently, and the agent compiles
    // version 1 for ever precisely so none is needed.
    const migrate = await import("@/lib/templates/migrate")

    expect(Object.keys(migrate).sort()).toEqual([
      "MIGRATION_LANGUAGE",
      "MIGRATION_SOURCE_VERSION",
      "MIGRATION_TARGET_VERSION",
      "needsSchemaVersion2Migration",
      "toSchemaVersion2",
    ])
  })

  test.each([
    ["a definition declaring no version", { identity: {} }],
    ["a definition whose version is a string", { schema_version: "1" }],
    ["a definition whose version is 2", { schema_version: 2 }],
    ["a definition whose version is 3", { schema_version: 3 }],
  ])("%s is left alone", (_label, definition) => {
    // Only what *says* it is version 1 is rewritten. `definition.ts`'s own
    // `resolveSchemaVersion` coerces an unusable version to 1, which is right for a validator
    // reporting the rest of a definition's problems and wrong for a rewriter: it would migrate
    // something nobody has established is a v1 definition.
    expect(needsSchemaVersion2Migration(definition)).toBe(false)
    expect(toSchemaVersion2(definition)).toBe(definition)
  })

  test("a version-1 definition is recognised as needing the migration", () => {
    expect(needsSchemaVersion2Migration(v1Definition())).toBe(true)
  })

  test.each([
    ["null", null],
    ["a string", "not a definition"],
    ["an array", [1, 2, 3]],
    ["undefined", undefined],
  ])("%s is returned unchanged rather than throwing", (_label, value) => {
    // This module does not validate; `collectDefinitionIssues` does, immediately afterwards. A
    // migration that threw on a malformed row would replace a list of field paths a consultant
    // can act on with a stack trace.
    expect(toSchemaVersion2(value)).toBe(value)
    expect(needsSchemaVersion2Migration(value)).toBe(false)
  })
})

// --- Purity -----------------------------------------------------------------

describe("Requirement 13.12 — pure, and it takes no store", () => {
  test("the input is not mutated, even when deep-frozen", () => {
    const before = deepFreeze(v1Definition())

    const migrated = toSchemaVersion2(before)

    // A frozen input turns any write into a `TypeError`, so this passing means no write was
    // attempted rather than that the result happened to differ.
    expect(migrated).not.toBe(before)
    expect(before.schema_version).toBe(1)
    expect(blockTypes(before)).toEqual(["cover", "heading"])
    expect(before.front_matter).toBeUndefined()
  })

  test("two calls on one input produce equal output", () => {
    const before = deepFreeze(v1Definition())

    expect(toSchemaVersion2(before)).toEqual(toSchemaVersion2(before))
  })

  test("a v1 definition that already carries a front_matter keeps its own values", () => {
    // Not a shape the validator admits — `front_matter` is undeclared at v1 — but reachable
    // from a hand-edited row, and the merge order is the statement: what the definition
    // already says wins over what the cover block would have supplied.
    const odd = v1Definition({
      front_matter: {
        cover: { subtitle: "hand written" },
        toc: { enabled: false },
      },
    })

    const migrated = toSchemaVersion2(odd)
    const frontMatter = migrated.front_matter as Record<string, unknown>

    expect((frontMatter.cover as Record<string, unknown>).subtitle).toBe(
      "hand written"
    )
    expect(frontMatter.toc).toEqual({ enabled: false })
  })
})

// --- A cover nested in a row ------------------------------------------------

describe("Requirement 13.2, 13.12 — a cover inside a row is migrated too", () => {
  /** A valid v1 definition whose `cover` block sits inside a `row`'s first column. */
  function v1WithNestedCover(): Record<string, unknown> {
    return v1Definition({
      blocks: [
        {
          id: "r",
          type: "row",
          columns: [
            [{ id: "c", type: "cover", config: { subtitle: "nested" } }],
            [{ id: "h", type: "heading", config: { level: 1, text: "x" } }],
          ],
        },
      ],
    })
  }

  test("the nested shape is valid at version 1, so it is reachable", () => {
    // The anchor. If the validator refused this at v1 there would be no stored row shaped like
    // it and nothing to migrate — the case would be hypothetical rather than a hole.
    expect(pathsOf(v1WithNestedCover())).toEqual([])
  })

  test("the nested cover's config reaches front_matter.cover", () => {
    const migrated = toSchemaVersion2(v1WithNestedCover())

    expect((migrated.front_matter as Record<string, unknown>).cover).toEqual({
      subtitle: "nested",
    })
  })

  test("the nested cover is removed and the row's other children survive", () => {
    const migrated = toSchemaVersion2(v1WithNestedCover())

    const row = (migrated.blocks as Record<string, unknown>[])[0]
    const columns = row.columns as { type: string }[][]
    expect(columns[0]).toEqual([])
    expect(columns[1].map((block) => block.type)).toEqual(["heading"])
  })

  test("the migrated definition validates, which a top-level-only migration fails", () => {
    // The failure this case was written from: a migration that filtered only the top level
    // produced `blocks.0.columns.0.0.type` here — a template a consultant can open and cannot
    // save. The shipped starters put their covers at the top level, so the corpus test above
    // passed while this was broken.
    expect(pathsOf(toSchemaVersion2(v1WithNestedCover()))).toEqual([])
  })

  test("a row carrying no cover is untouched", () => {
    const noCover = v1Definition({
      blocks: [
        {
          id: "r",
          type: "row",
          columns: [
            [{ id: "h", type: "heading", config: { level: 1, text: "x" } }],
            [{ id: "p", type: "rich_text", config: { text: "prose" } }],
          ],
        },
      ],
    })

    const migrated = toSchemaVersion2(noCover)

    expect(migrated.blocks).toEqual(noCover.blocks)
    // And with no cover block anywhere, the section is present and empty rather than absent.
    expect((migrated.front_matter as Record<string, unknown>).cover).toEqual({})
    expect(pathsOf(migrated)).toEqual([])
  })
})
