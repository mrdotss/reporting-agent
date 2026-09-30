import { describe, expect, test, vi } from "vitest"

vi.mock("@/lib/aws/s3", () => ({ getSnapshotJson: vi.fn() }))

import { parseGlance } from "@/lib/delivery/glance"

describe("parseGlance", () => {
  test("reads the runtime's glance.json", () => {
    expect(
      parseGlance({
        schema_version: 1,
        decisions_title: "Decisions for you",
        figures: [{ key: "resources", label: "Resources", value: "58" }],
        decisions: ["Review the resources listed under Housekeeping."],
      })
    ).toEqual({
      decisionsTitle: "Decisions for you",
      figures: [{ label: "Resources", value: "58" }],
      decisions: ["Review the resources listed under Housekeeping."],
    })
  })

  test("anything else is no glance, never a guess", () => {
    expect(parseGlance(null)).toBeNull()
    expect(parseGlance({ figures: "58" })).toBeNull()
    expect(parseGlance({ decisions_title: "", figures: [], decisions: [] })).toBeNull()
  })
})
