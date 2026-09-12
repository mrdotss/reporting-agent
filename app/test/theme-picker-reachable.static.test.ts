import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

/**
 * The theme picker has a call site, and the theme is not chosen from a list of
 * words.
 *
 * ## Why this is a test and not a code review note
 *
 * This has now gone wrong twice, the same way both times, and neither time did
 * anything fail. `design-system.md` records the first: `StepDesign`,
 * `StylePresetPicker`, the thumbnail resolver and four committed page images all
 * existed and were tested for weeks while nothing imported them, because the
 * shell bound the server-resolved `thumbnails` prop to `_thumbnails`. Every
 * profile silently shipped the draft default.
 *
 * The second was narrower and quieter. `StepDesign` *declared*
 * `thumbnails: readonly ThemeThumbnail[]` in its props type and never
 * destructured it, so the server hashed four theme documents on every render to
 * produce data that reached no pixel, and the document theme — the decision that
 * determines what the customer's delivered PDF looks like — was made from a
 * `<Select>` of four capitalised words. The type checked. The tests passed. The
 * picker sat in the repository, imported by nothing, not even a test.
 *
 * A component with no call site cannot be caught by a test of that component, so
 * the assertions below are about the *wiring* rather than the rendering:
 *
 * 1. Something that is not a test imports `StylePresetPicker`.
 * 2. No `<Select>` in the wizard is labelled as the document theme.
 *
 * The `thumbnails` assertions this file used to carry are gone with the prop. The
 * picker is a list now — each theme named, with its heading face, table treatment
 * and density in words — rather than a grid of rendered page images, so there is no
 * server-resolved prop left to drop on the floor. What Requirement 13.3 actually
 * protects survives the change and is asserted below: the choice is never four bare
 * words in a dropdown, because "a dropdown of words gives the user nothing to decide
 * with". A list that describes what each theme does is not that.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function read(relative: string): string {
  return readFileSync(path.join(appRoot, relative), "utf-8")
}

describe("the theme picker is reachable (Requirement 13.3)", () => {
  test("StylePresetPicker is imported by a module that is not a test", () => {
    const stepDesign = read("components/templates/step-design.tsx")

    expect(stepDesign).toContain(
      'from "@/components/templates/style-preset-picker"'
    )
    expect(stepDesign).toContain("<StylePresetPicker")
  })

  test("every preset is offered with what it does, not only its name", () => {
    const picker = read("components/templates/style-preset-picker.tsx")

    // The descriptions are the control's content, not an accessibility afterthought:
    // they are what a reader chooses between when there is no picture to compare.
    expect(picker).toContain("THEME_DESCRIPTION")
    for (const preset of ["editorial", "corporate", "technical", "minimal"]) {
      expect(picker).toContain(`${preset}:`)
    }
  })

  test("selection is conveyed by more than a fill", () => {
    const picker = read("components/templates/style-preset-picker.tsx")

    // Requirement 13.4. A row that differed only by background would be invisible in
    // monochrome and to a reader who cannot separate the two tones.
    expect(picker).toContain('role="radio"')
    expect(picker).toContain("aria-checked")
    expect(picker).toContain("CheckCircleIcon")
  })

  test("the document theme is not offered as a select of names", () => {
    const source = read("components/templates/step-design.tsx")

    // The control that was there before: a SelectTrigger naming the theme.
    expect(source).not.toContain('aria-label="Document theme"')
    expect(source).not.toMatch(/<SelectTrigger[\s\S]{0,200}Document theme/)
  })
})
