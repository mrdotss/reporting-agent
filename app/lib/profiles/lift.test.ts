import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import {
  collectDefinitionIssues,
  MAX_SUPPORTED_SCHEMA_VERSION,
} from "@/lib/templates/definition"
import { liftDefinition, openingDraft, UNMAPPED_BLOCK_TYPES } from "@/lib/profiles/lift"
import { EMPTY_DRAFT } from "@/lib/templates/draft"

/**
 * `lift.ts` against the shared v1/v2 fixture corpus (task 3.12, Requirements
 * 20.1-20.6).
 *
 * Reads the same corpus `mirror.static.test.ts` reads — `agent/tests/fixtures/
 * definitions/` — never a copy (see that file's own note on why). Only the
 * `accept` fixtures matter here: a `reject` fixture is not a definition a real
 * template ever held, so lifting it proves nothing about migration.
 *
 * `mode: "draft"`, not `"run"`, is the bar every produced draft is held to —
 * Requirement 20.5's point is that the lift produces something the wizard can
 * OPEN and continue editing, not something already complete enough to publish.
 * A lift that produced a `run`-valid draft for every fixture would be a
 * stronger and untrue claim: several fixtures have blocks this catalogue
 * cannot map at all (see `lift.ts`'s own `UNMAPPED_BLOCK_TYPES`), so their
 * lifted drafts legitimately hold `sections: []`, which fails `run` mode's
 * at-least-one-section rule and must NOT fail `draft` mode's looser one.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const repoRoot = path.resolve(appRoot, "..")
const CORPUS_ROOT = path.join(repoRoot, "agent", "tests", "fixtures", "definitions")
const CORPUS_MANIFEST = path.join(CORPUS_ROOT, "manifest.json")

type ManifestEntry = {
  readonly file: string
  readonly verdict: "accept" | "reject"
}

function acceptFixtures(): readonly { readonly name: string; readonly definition: unknown }[] {
  const manifest = JSON.parse(readFileSync(CORPUS_MANIFEST, "utf8")) as {
    readonly fixtures: readonly ManifestEntry[]
  }

  return manifest.fixtures
    .filter((entry) => entry.verdict === "accept")
    .map((entry) => ({
      name: entry.file,
      definition: JSON.parse(
        readFileSync(path.join(CORPUS_ROOT, entry.file), "utf8")
      ) as unknown,
    }))
    .filter(
      (entry) =>
        typeof entry.definition === "object" &&
        entry.definition !== null &&
        (entry.definition as { schema_version?: number }).schema_version !== 3
    )
}

describe("liftDefinition against the shared v1/v2 corpus", () => {
  const fixtures = acceptFixtures()

  test("the corpus has at least one v1 and one v2 accept fixture", () => {
    const versions = new Set(
      fixtures.map((f) => (f.definition as { schema_version: number }).schema_version)
    )
    expect(versions.has(1)).toBe(true)
    expect(versions.has(2)).toBe(true)
  })

  test.each(fixtures.map((f) => [f.name, f] as const))(
    "%s lifts to a draft-mode-valid definition",
    (_name, fixture) => {
      const { draft } = liftDefinition(fixture.definition)

      const issues = collectDefinitionIssues(draft, { mode: "draft" })

      expect(
        issues,
        `lifted draft for ${fixture.name} failed draft-mode validation: ` +
          JSON.stringify(issues)
      ).toEqual([])
    }
  )

  test("no fixture's lift throws", () => {
    for (const fixture of fixtures) {
      expect(() => liftDefinition(fixture.definition)).not.toThrow()
    }
  })

  test("every unmapped block is reported with its id and type, never silently dropped", () => {
    for (const fixture of fixtures) {
      const { unmapped } = liftDefinition(fixture.definition)
      for (const block of unmapped) {
        expect(block.id).toBeTruthy()
        expect(block.type).toBeTruthy()
      }
    }
  })

  test("the corpus exercises at least one fixture with an unmapped block", () => {
    // Without this, a bug that reported everything mapped would pass every
    // case above by having nothing left to check.
    const anyUnmapped = fixtures.some(
      (fixture) => liftDefinition(fixture.definition).unmapped.length > 0
    )
    expect(anyUnmapped).toBe(true)
  })

  test("the corpus exercises at least one fixture that maps to a real section", () => {
    const anyMapped = fixtures.some((fixture) => {
      const { draft } = liftDefinition(fixture.definition)
      return (draft.sections as readonly unknown[]).length > 0
    })
    expect(anyMapped).toBe(true)
  })
})

describe("liftDefinition — behaviour not covered by the shared corpus", () => {
  test("a cover block's subtitle lifts into front_matter.cover.subtitle", () => {
    const stored = {
      schema_version: 1,
      identity: { name: "Test" },
      scope: {
        resource_types: [],
        resource_groups: [],
        tag_filters: [],
        top_n: null,
        sort: null,
      },
      metrics: {},
      design: {},
      blocks: [
        { id: "b1", type: "cover", config: { subtitle: "Q3 Utilization" } },
      ],
    }

    const { draft } = liftDefinition(stored)

    expect(
      (draft.front_matter as { cover?: { subtitle?: string } }).cover?.subtitle
    ).toBe("Q3 Utilization")
  })

  test("every type in UNMAPPED_BLOCK_TYPES is reported unmapped, never guessed at", () => {
    for (const type of UNMAPPED_BLOCK_TYPES) {
      const block =
        type === "row"
          ? { id: "b1", type: "row" as const, columns: [] }
          : { id: "b1", type, config: {} }

      const stored = {
        schema_version: 1,
        identity: { name: "Test" },
        scope: {
          resource_types: [],
          resource_groups: [],
          tag_filters: [],
          top_n: null,
          sort: null,
        },
        metrics: {},
        design: {},
        blocks: [block],
      }

      const { unmapped, draft } = liftDefinition(stored)

      expect(unmapped, `${type} was not reported unmapped`).toHaveLength(1)
      expect(unmapped[0]!.type).toBe(type)
      expect((draft.sections as readonly unknown[]).length).toBe(0)
    }
  })

  test("a resource_table scoped to gaps_and_coverage's entry always maps, needing no resource-type intersection", () => {
    const stored = {
      schema_version: 1,
      identity: { name: "Test" },
      scope: {
        resource_types: [],
        resource_groups: [],
        tag_filters: [],
        top_n: null,
        sort: null,
      },
      metrics: {},
      design: {},
      blocks: [{ id: "b1", type: "gaps_and_coverage", config: {} }],
    }

    const { draft, unmapped } = liftDefinition(stored)

    expect(unmapped).toEqual([])
    expect((draft.sections as readonly { type: string }[])[0]?.type).toBe(
      "coverage_and_verification"
    )
  })

  test("a null or non-object stored definition lifts to an empty, still-valid draft", () => {
    for (const value of [null, undefined, 42, "not a definition", true]) {
      const { draft, unmapped } = liftDefinition(value)

      expect(unmapped).toEqual([])
      expect((draft.sections as readonly unknown[]).length).toBe(0)

      const issues = collectDefinitionIssues(draft, { mode: "draft" })
      expect(issues).toEqual([])
    }
  })

  test("section ids are unique within one lift, even across repeated calls", () => {
    const stored = {
      schema_version: 1,
      identity: { name: "Test" },
      scope: {
        resource_types: [],
        resource_groups: [],
        tag_filters: [],
        top_n: null,
        sort: null,
      },
      metrics: {},
      design: {},
      blocks: [
        { id: "b1", type: "gaps_and_coverage", config: {} },
        { id: "b2", type: "verification_record", config: {} },
      ],
    }

    const first = liftDefinition(stored)
    const second = liftDefinition(stored)

    const firstIds = (first.draft.sections as readonly { id: string }[]).map((s) => s.id)
    const secondIds = (second.draft.sections as readonly { id: string }[]).map((s) => s.id)

    expect(new Set(firstIds).size).toBe(firstIds.length)
    expect(new Set(secondIds).size).toBe(secondIds.length)
  })
})

describe("front_matter.document_control migrates to its v3 shape (task 4.1)", () => {
  function storedWithDocumentControl(
    documentControl: Record<string, unknown>
  ): Record<string, unknown> {
    return {
      schema_version: 2,
      identity: { name: "Test", language: "en" },
      scope: { resource_types: [], resource_groups: [], tag_filters: [], top_n: null, sort: null },
      metrics: {},
      design: {},
      blocks: [],
      front_matter: {
        cover: {},
        document_control: documentControl,
        toc: {},
      },
    }
  }

  test("confidentiality_notice_id moves from front_matter to the returned brand, and off the draft", () => {
    const { draft, brand } = liftDefinition(
      storedWithDocumentControl({ confidentiality_notice_id: "doc.confidentiality.default" })
    )

    expect(brand.confidentialityNoticeId).toBe("doc.confidentiality.default")
    const control = (draft.front_matter as { document_control: Record<string, unknown> })
      .document_control
    expect("confidentiality_notice_id" in control).toBe(false)
  })

  test("no confidentiality_notice_id on the source lifts to a null brand value", () => {
    const { brand } = liftDefinition(storedWithDocumentControl({}))
    expect(brand.confidentialityNoticeId).toBeNull()
  })

  test("a non-empty string distribution becomes one row carrying the text as its note", () => {
    const { draft } = liftDefinition(
      storedWithDocumentControl({ distribution: "Internal / Customer" })
    )
    const control = (draft.front_matter as { document_control: Record<string, unknown> })
      .document_control
    expect(control.distribution).toEqual([
      { recipient: "Distribution", note: "Internal / Customer" },
    ])
  })

  test("an empty or whitespace-only string distribution lifts to zero rows, not one empty row", () => {
    for (const value of ["", "   "]) {
      const { draft } = liftDefinition(storedWithDocumentControl({ distribution: value }))
      const control = (draft.front_matter as { document_control: Record<string, unknown> })
        .document_control
      expect(control.distribution).toEqual([])
    }
  })

  test("the lifted draft passes draft-mode validation with both fields present on the source", () => {
    const { draft } = liftDefinition(
      storedWithDocumentControl({
        confidentiality_notice_id: "doc.confidentiality.default",
        distribution: "Ops, Finance",
      })
    )
    expect(collectDefinitionIssues(draft, { mode: "draft" })).toEqual([])
  })
})

/**
 * `openingDraft` — the call site Requirement 20.1 always needed and never had.
 *
 * `liftDefinition` was implemented and tested by task 3.12 and called from nowhere but
 * this file, so a stored v1/v2 profile opened in the v3 wizard as its raw legacy self.
 * Step 2 then wrote `sections` into it and the validator refused it as an unrecognized
 * top-level key -- the blank-template failure reached by a different route, and the
 * reason "Enesis v2" could not be edited.
 *
 * The version guard carries the risk. Lifting reads `blocks` and always emits v3, so a
 * v3 definition handed to it would yield an empty `sections` array and silently discard
 * the profile. That is a data-loss bug rather than a validation error, which is why the
 * pass-through case is mutation-checked rather than merely asserted.
 */
describe("openingDraft decides whether to lift, and never lifts twice", () => {
  const V1_STORED = {
    schema_version: 1,
    identity: { name: "Enesis v2" },
    scope: {
      resource_types: [],
      resource_groups: [],
      tag_filters: [],
      top_n: null,
      sort: null,
    },
    metrics: {},
    design: {},
    blocks: [{ id: "b1", type: "resource_table", config: {} }],
  }

  test("a stored v1 definition is lifted to a draft the wizard can validate", () => {
    const { definition, lifted } = openingDraft(V1_STORED)

    expect(definition["schema_version"]).toBe(MAX_SUPPORTED_SCHEMA_VERSION)
    expect(definition).toHaveProperty("sections")
    expect(lifted).not.toBeNull()
    // Draft mode is the bar the wizard actually applies on open.
    expect(collectDefinitionIssues(definition, { mode: "draft" })).toEqual([])
  })

  test("the lifted result still carries what it could not map", () => {
    // Requirement 20: content that does not map is REPORTED, never silently dropped.
    // The caller needs the result to say so, so the helper must not swallow it.
    const { lifted } = openingDraft({
      ...V1_STORED,
      blocks: [{ id: "b1", type: "comparison_delta", config: {} }],
    })

    expect(lifted?.unmapped).toBeDefined()
  })

  test("an already-v3 definition is returned untouched, and not re-lifted", () => {
    const v3 = openingDraft(V1_STORED).definition

    const reopened = openingDraft(v3)

    expect(reopened.lifted).toBeNull()
    // Identity, not equality: the guard returns the very object it was handed.
    expect(reopened.definition).toBe(v3)
  })

  test("a v3 profile's sections survive being opened, and lifting one would erase them", () => {
    // The damage the guard prevents, shown rather than asserted in the abstract.
    // `EMPTY_DRAFT` is a real v3 draft carrying the always-present appendix, so it has
    // sections to lose. `liftDefinition` reads `blocks` -- which v3 does not have -- so
    // lifting it yields an empty `sections` array: a profile silently emptied rather
    // than a validation error anybody would see.
    const v3 = EMPTY_DRAFT("Enesis v2") as unknown as Record<string, unknown>
    const before = (v3["sections"] as unknown[]).length
    expect(before).toBeGreaterThan(0)

    expect((openingDraft(v3).definition["sections"] as unknown[]).length).toBe(before)
    expect((liftDefinition(v3).draft["sections"] as unknown[]).length).toBe(0)
  })

  test("a v2 definition is lifted, not passed through", () => {
    const { definition, lifted } = openingDraft({ ...V1_STORED, schema_version: 2 })

    expect(lifted).not.toBeNull()
    expect(definition["schema_version"]).toBe(MAX_SUPPORTED_SCHEMA_VERSION)
  })
})
