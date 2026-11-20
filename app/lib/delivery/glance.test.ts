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

  test("keeps the weekly ownership headline as printed", () => {
    expect(
      parseGlance({
        schema_version: 1,
        focus: "ownership",
        headline: "19 resources look idle this week. 8 of them belong to someone who left, or to nobody.",
        decisions_title: "Decide this week",
        figures: [{ key: "owned", label: "Live resources", value: "76" }],
        decisions: [],
      })
    ).toEqual({
      focus: "ownership",
      headline: "19 resources look idle this week. 8 of them belong to someone who left, or to nobody.",
      decisionsTitle: "Decide this week",
      figures: [{ label: "Live resources", value: "76" }],
      decisions: [],
    })
  })

  test("anything else is no glance, never a guess", () => {
    expect(parseGlance(null)).toBeNull()
    expect(parseGlance({ figures: "58" })).toBeNull()
    expect(parseGlance({ decisions_title: "", figures: [], decisions: [] })).toBeNull()
  })
})
