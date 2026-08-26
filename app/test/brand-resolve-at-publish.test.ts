/**
 * Task 2.3 — the Brand is resolved into the version at PUBLISH, not dereferenced at render.
 *
 * ## Why this file was rewritten
 *
 * Its first version asserted `definitionSha256(x) === definitionSha256(x)` — the same object
 * hashed twice — under the name "the version's design cannot be changed by editing the Brand
 * after save", with a comment claiming to simulate a Brand edit while touching no Brand. That
 * is `f(x) === f(x)`, true because hashing is deterministic, and it would have passed
 * unchanged if resolve-at-publish were replaced by the runtime `brand_id` dereference it
 * exists to forbid. A test whose name asserts a property it does not exercise is worse than
 * no test: it makes a reviewer scanning the file believe the property is guarded.
 *
 * ## What is tested here, and why at this seam
 *
 * `resolveDesignFromBrand` is where the frozen-at-publish guarantee lives. The publish path
 * around it (`publishTemplateVersion` → `store.insertVersion`) is only reachable with a real
 * Postgres — this repo's store tests are integration tests that skip without a database — so
 * a test driving the whole path would not run in ordinary development. This one runs
 * everywhere and fails for the reason the code can actually break.
 *
 * The regression it catches: someone replaces the resolve with a `brand_id` reference, so
 * `definition.design` no longer carries the Brand's values and the renderer has to look them
 * up. Requirement 2.7 then breaks silently — a Brand edit starts changing a report a customer
 * already signed.
 */

import { describe, expect, test } from "vitest"

import { resolveDesignFromBrand } from "@/lib/actions/templates"
import type { Brand } from "@/lib/db/schema"

function brand(overrides: Partial<Brand> = {}): Brand {
  return {
    id: "brand-0001",
    userId: "user-0001",
    name: "Helios",
    themePreset: "editorial",
    accentColor: "#1f6f78",
    logoKey: "brands/brand-0001/logo.png",
    density: "normal",
    tableStyle: "hairline",
    pageSize: "A4",
    numberFormat: { decimal_places: 2, group_thousands: true },
    coverPage: true,
    defaultApproverNames: {},
    confidentialityNoticeId: "doc.notice.confidential",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as Brand
}

/** A definition whose own `design` is deliberately wrong, so a no-op resolve is visible. */
const INPUT = {
  schema_version: 2,
  identity: { name: "Marketing Riset", language: "en" },
  design: {
    preset: "minimal",
    accent_color: "#000000",
    density: "compact",
    table_style: "bordered",
    number_format: { decimal_places: 0, group_thousands: false },
    cover_page: false,
    logo: null,
    page_size: "Letter",
  },
  blocks: [],
}

function designOf(resolved: unknown): Record<string, unknown> {
  return (resolved as { design: Record<string, unknown> }).design
}

describe("resolveDesignFromBrand — the frozen-at-publish mechanism", () => {
  test("the Brand's values are written INLINE into definition.design", () => {
    // The assertion the old file never made. Every field comes from the Brand, not from the
    // definition that arrived — so the stored version carries the design rather than pointing
    // at it. A resolve that returned the definition untouched fails here.
    const resolved = resolveDesignFromBrand(INPUT, brand())

    expect(designOf(resolved)).toEqual({
      preset: "editorial",
      accent_color: "#1f6f78",
      density: "normal",
      table_style: "hairline",
      number_format: { decimal_places: 2, group_thousands: true },
      cover_page: true,
      logo: "brands/brand-0001/logo.png",
      page_size: "A4",
    })
  })

  test("the incoming definition's own design is overwritten, not merged", () => {
    // `INPUT.design` is deliberately the opposite of the Brand on every field. A merge would
    // leave some of the author's values in place, which would make a version's appearance
    // depend on what happened to be in the draft — the drift Phase 1 exists to end.
    const resolved = resolveDesignFromBrand(INPUT, brand())
    const design = designOf(resolved)

    expect(design.preset).not.toBe(INPUT.design.preset)
    expect(design.page_size).not.toBe(INPUT.design.page_size)
    expect(design.cover_page).not.toBe(INPUT.design.cover_page)
  })

  test("the result carries NO reference key the renderer could dereference", () => {
    // This is the one that catches a runtime dereference directly. A self-contained version
    // holds no field naming the Brand: if `brand_id` appears, something downstream can look
    // the Brand up at render time, and a Brand edit reaches a version already saved.
    //
    // Asserted on reference KEYS, not on the id string. `logo` is legitimately
    // `brands/<id>/logo.png` — an object-storage path that happens to embed the id, which is
    // not a dereference: the renderer reads it as an opaque key. An earlier draft of this test
    // asserted the id appeared nowhere in the payload and failed on exactly that, which is the
    // test being wrong rather than the code.
    const resolved = resolveDesignFromBrand(INPUT, brand()) as Record<string, unknown>

    expect(Object.keys(resolved)).not.toContain("brand_id")
    expect(Object.keys(resolved)).not.toContain("brandId")
    expect(Object.keys(designOf(resolved))).not.toContain("brand_id")
    expect(JSON.stringify(resolved)).not.toContain('"brand_id"')
    expect(JSON.stringify(resolved)).not.toContain('"brandId"')
  })

  test("everything other than design is carried through untouched", () => {
    const resolved = resolveDesignFromBrand(INPUT, brand()) as typeof INPUT

    expect(resolved.schema_version).toBe(INPUT.schema_version)
    expect(resolved.identity).toEqual(INPUT.identity)
    expect(resolved.blocks).toEqual(INPUT.blocks)
  })

  test("a later Brand edit cannot reach a definition already resolved", () => {
    // Requirement 2.7, as an assertion rather than a restatement. Resolve once with Brand A —
    // that is the "saved version". Then the Brand changes. The already-resolved definition
    // must be unaffected, AND a fresh resolve must pick the new values up: together those two
    // facts are what "frozen at publish, applies to the next report" means.
    const saved = resolveDesignFromBrand(INPUT, brand())
    const savedDesign = { ...designOf(saved) }

    const edited = brand({ accentColor: "#ff0000", pageSize: "Letter", coverPage: false })

    expect(designOf(saved)).toEqual(savedDesign)
    expect(designOf(saved).accent_color).toBe("#1f6f78")

    const republished = resolveDesignFromBrand(INPUT, edited)
    expect(designOf(republished).accent_color).toBe("#ff0000")
    expect(designOf(republished).page_size).toBe("Letter")
  })

  test("a non-object definition is returned unchanged rather than throwing", () => {
    // Total over its input: the validator upstream rejects these, but this function must not
    // be the thing that raises on one.
    for (const value of [null, undefined, 42, "definition", true]) {
      expect(resolveDesignFromBrand(value, brand())).toBe(value)
    }
  })
})
