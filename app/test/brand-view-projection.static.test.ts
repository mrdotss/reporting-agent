import { describe, expect, test } from "vitest"

import type { Brand } from "@/lib/db/schema"
import { toBrandView } from "@/lib/db/views"

/**
 * Projection guard for `BrandView` (Requirement 22.7).
 *
 * Asserts that no secret and no presigned URL can survive the projection —
 * the repo's convention is that this guard lands with the table, not after.
 */

const FAKE_BRAND: Brand = {
  id: "brand-001",
  userId: "user-secret-id",
  name: "Acme Consulting",
  themePreset: "editorial",
  accentColor: "#1f6f78",
  logoKey: "user-secret-id/logos/acme.png",
  density: "normal",
  tableStyle: "hairline",
  pageSize: "A4",
  numberFormat: { decimal_places: 2, group_thousands: true },
  coverPage: true,
  defaultApproverNames: { author: "Alice", reviewer: "Bob" },
  confidentialityNoticeId: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T01:00:00Z"),
}

describe("BrandView projection guard", () => {
  test("the exact key set — user_id is dropped", () => {
    const view = toBrandView(FAKE_BRAND)

    expect(Object.keys(view).sort()).toEqual([
      "accentColor",
      "confidentialityNoticeId",
      "coverPage",
      "createdAt",
      "defaultApproverNames",
      "density",
      "id",
      "logoKey",
      "name",
      "numberFormat",
      "pageSize",
      "tableStyle",
      "themePreset",
      "updatedAt",
    ])
  })

  test("no secret survives the projection", () => {
    const view = toBrandView(FAKE_BRAND)
    const serialized = JSON.stringify(view)

    // user_id must not appear as a standalone value
    expect(serialized).not.toContain('"user-secret-id"')
    // No presigned URL pattern
    expect(serialized).not.toMatch(/X-Amz-Signature/)
    expect(serialized).not.toMatch(/X-Amz-Credential/)
  })

  test("user_id is not a key of the returned object", () => {
    const view = toBrandView(FAKE_BRAND)
    expect("userId" in view).toBe(false)
    expect("user_id" in view).toBe(false)
  })

  test("logo_key passes through as a key, not a presigned URL", () => {
    const view = toBrandView(FAKE_BRAND)
    expect(view.logoKey).toBe("user-secret-id/logos/acme.png")
    // It's a key, not a URL
    expect(view.logoKey).not.toMatch(/^https?:\/\//)
  })

  test("timestamps are ISO 8601 strings", () => {
    const view = toBrandView(FAKE_BRAND)
    expect(view.createdAt).toBe("2026-08-01T00:00:00.000Z")
    expect(view.updatedAt).toBe("2026-08-01T01:00:00.000Z")
  })

  test("mutation check: adding a secret field to the view is caught", () => {
    // This test is a documentation assertion. If someone adds userId to BrandView,
    // the "exact key set" test above will fail because it will gain a key.
    // This test additionally proves the projection function itself does not carry it.
    const view = toBrandView(FAKE_BRAND)
    const keys = new Set(Object.keys(view))
    expect(keys.has("userId")).toBe(false)
  })
})
