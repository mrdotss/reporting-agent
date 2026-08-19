import { describe, expect, test } from "vitest"

import { DESIGN_PRESETS } from "@/lib/templates/definition"
import {
  THUMBNAIL_PUBLIC_PREFIX,
  themeThumbnails,
} from "@/lib/templates/theme-thumbnails"

/**
 * The thumbnail availability check (Requirements 13.2, 13.8).
 *
 * The assertion that matters is the last one: **the committed images are current
 * evidence of the committed themes**. It reads the same two files the agent's own
 * `test_thumbnails.py` reads, from the other half, so a theme regenerated on one
 * side without the other fails on both.
 *
 * The rest is shape: four entries always, in the declared order, with the card
 * surviving an unavailable image — because Requirement 13.8 keeps the card and
 * Requirement 13.3 forbids collapsing the grid into a name-only control, and a
 * filter that dropped an entry would violate both at once.
 */

describe("Requirement 13.8 — four cards, always", () => {
  test("one entry per declared preset, in the declared order", () => {
    expect(themeThumbnails().map((entry) => entry.preset)).toEqual([
      ...DESIGN_PRESETS,
    ])
  })

  test("an unavailable image drops the src, never the entry", () => {
    // Expressed as an invariant over whatever the repository currently holds
    // rather than by deleting a file: every entry is present regardless of
    // whether its image resolved, which is the property the picker relies on.
    for (const entry of themeThumbnails()) {
      expect(DESIGN_PRESETS).toContain(entry.preset)
      expect(
        entry.src === null || entry.src.startsWith(THUMBNAIL_PUBLIC_PREFIX)
      ).toBe(true)
    }
  })

  test("a resolved entry carries no unavailability reason, and the reverse", () => {
    for (const entry of themeThumbnails()) {
      expect(entry.src === null).toBe(entry.unavailableReason !== null)
    }
  })
})

describe("Requirement 13.2 — the images are current evidence", () => {
  test("every preset's page image resolves against the shipped theme", () => {
    // The whole point of the sidecar. A theme edited without regenerating its
    // thumbnail fails here, and the message says which one and what to run.
    const stale = themeThumbnails().filter((entry) => entry.src === null)

    expect(
      stale.map((entry) => `${entry.preset} (${entry.unavailableReason})`)
    ).toEqual([])
  })
})
