import { describe, expect, test } from "vitest"

import specs from "../../agent/tests/fixtures/theme_specs.json"

import { SPECS, THEME_LABELS } from "@/lib/builder/theme"
import { PRESET_FACES, PRESET_HEADING_FACES } from "@/lib/profiles/preview-sample"
import { DESIGN_PRESETS, type DesignPreset } from "@/lib/templates/definition"

/**
 * The canvas draws each theme from `lib/builder/theme.ts`, and the delivered document from
 * `render/themes.py`'s `THEME_SPECS`. The runtime writes `theme_specs.json` from its specs
 * (`agent/tests/test_theme_treatments.py` fails while that file is stale), and this holds
 * the app's copy to it: one set of numbers, so the page the consultant arranges is the page
 * the customer receives.
 */

type Row = (typeof specs)[keyof typeof specs]
const RUNTIME = specs as Readonly<Record<string, Row>>

test("the app and the runtime know the same themes", () => {
  expect(Object.keys(RUNTIME).sort()).toEqual([...DESIGN_PRESETS].sort())
  expect(Object.keys(SPECS).sort()).toEqual([...DESIGN_PRESETS].sort())
  expect(Object.keys(THEME_LABELS).sort()).toEqual([...DESIGN_PRESETS].sort())
})

describe.each(DESIGN_PRESETS.map((preset) => [preset] as const))("%s", (preset: DesignPreset) => {
  const runtime = RUNTIME[preset]!

  test("palette, scale and treatments match the runtime", () => {
    const { faces, ...values } = runtime
    void faces
    expect(SPECS[preset]).toEqual(values)
  })

  test("the canvas leads with the faces the document is set in", () => {
    // `signal`'s body is Liberation Sans, metric-compatible with the Arimo it was drawn in.
    expect(PRESET_FACES[preset]).toContain(`"${runtime.faces.body}"`)
    expect(PRESET_HEADING_FACES[preset]).toContain(`"${runtime.faces.heading}"`)
  })
})
