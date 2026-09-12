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
 * 2. `StepDesign` destructures `thumbnails` rather than only declaring it.
 * 3. No `<Select>` in the wizard is labelled as the document theme.
 *
 * Requirement 13.3 is the rule these defend: "not names in a select — a theme is
 * a visual decision, and a dropdown of words gives the user nothing to decide
 * with".
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

  test("StepDesign destructures `thumbnails`, it does not only declare it", () => {
    const source = read("components/templates/step-design.tsx")

    // The parameter list, up to the type annotation that follows it.
    const params = source.slice(
      source.indexOf("export function StepDesign({"),
      source.indexOf("}: Readonly<{")
    )

    expect(params).not.toHaveLength(0)
    expect(params).toContain("thumbnails")
  })

  test("`thumbnails` reaches the picker rather than stopping at the prop", () => {
    const source = read("components/templates/step-design.tsx")

    const picker = source.slice(source.indexOf("<StylePresetPicker"))
    expect(picker.slice(0, picker.indexOf("/>"))).toContain(
      "thumbnails={thumbnails}"
    )
  })

  test("the document theme is not offered as a select of names", () => {
    const source = read("components/templates/step-design.tsx")

    // The control that was there before: a SelectTrigger naming the theme.
    expect(source).not.toContain('aria-label="Document theme"')
    expect(source).not.toMatch(/<SelectTrigger[\s\S]{0,200}Document theme/)
  })
})
