import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, test } from "vitest"

import { DESIGN_PRESETS, STYLE_KEYS } from "@/lib/templates/definition"

import { emptyDraftV4 } from "./draft"
import type { DefinitionV4 } from "./model"
import { LOOK_KEYS, MARGIN_FACTORS, MARK, SPECS, TEXT_SIZE_FACTORS, pageDesign, themeLook } from "./theme"

/**
 * `design.style`, as the canvas reads it. The page the consultant arranges must take the
 * same look the runtime prints: an absent key is the theme's choice, a key the validator
 * would refuse is never drawn, and the few numbers the canvas scales by are the runtime's.
 */

function withStyle(style: Record<string, unknown>, preset = "corporate"): DefinitionV4 {
  const draft = emptyDraftV4("Look", "aws")
  return { ...draft, design: { ...draft.design, preset, style } } as DefinitionV4
}

const RUNTIME = resolve(__dirname, "../../../agent/src/reporting_agent/render")
const source = (file: string) => readFileSync(resolve(RUNTIME, file), "utf8")

describe("the theme's own look", () => {
  test.each(DESIGN_PRESETS.map((preset) => [preset] as const))("%s draws its own cover and the plain defaults", (preset) => {
    const look = themeLook(preset)
    expect(look.cover).toBe(SPECS[preset].coverStyle)
    expect(look.sectionNumbers).toBe(SPECS[preset].displayNumbers ? "display" : "inline")
    expect(look).toMatchObject({
      fonts: "theme",
      textSize: "normal",
      margins: "normal",
      chartLine: "regular",
      chartGrid: "light",
      chartValues: "last",
      chartLegend: "line_ends",
      markAtOrAbove: null,
      chartThreshold: null,
    })
  })

  test("every look field reads a style key the validator knows, and every style key has a field", () => {
    expect([...Object.values(LOOK_KEYS)].sort()).toEqual([...STYLE_KEYS].sort())
  })

  test("a design with no style draws exactly the theme", () => {
    const design = pageDesign(emptyDraftV4("Plain", "azure"))
    expect(design.look).toEqual(themeLook(design.preset))
  })
})

describe("a style over the theme", () => {
  test("each key it sets replaces the theme's, and nothing else moves", () => {
    const design = pageDesign(withStyle({ cover: "full_bleed", chart_threshold: 85, table_header: "solid" }))
    expect(design.look).toEqual({ ...themeLook("corporate"), cover: "full_bleed", chartThreshold: 85, tableHeader: "solid" })
  })

  test("a value the validator would refuse is drawn as the theme's", () => {
    const design = pageDesign(withStyle({ cover: "poster", chart_threshold: 140, mark_at_or_above: "80", fonts: 3 }))
    expect(design.look).toEqual(themeLook("corporate"))
  })

  test("a font pairing sets both faces; figures in the text face follow the body", () => {
    const plain = pageDesign(withStyle({}))
    const paired = pageDesign(withStyle({ fonts: "source", figures: "text" }))
    expect(paired.spec.headingFace).toContain('"Source Serif 4"')
    expect(paired.spec.face).toContain('"Source Sans 3"')
    expect(paired.figureFace).toBe(paired.spec.face)
    expect(plain.figureFace).toContain("Mono")
  })
})

describe("the numbers the canvas shares with the runtime", () => {
  test("text sizes and margins scale by the runtime's factors", () => {
    const docx = source("docx.py")
    expect(docx).toContain(`{"small": ${TEXT_SIZE_FACTORS.small}, "large": ${TEXT_SIZE_FACTORS.large}}`)
    expect(docx).toContain(`{"narrow": ${MARGIN_FACTORS.narrow}, "wide": ${MARGIN_FACTORS.wide}}`)
    expect(source("printcss.py")).toContain(`{"small": ${TEXT_SIZE_FACTORS.small}, "large": ${TEXT_SIZE_FACTORS.large}}`)
  })

  test("a marked figure is the runtime's colours", () => {
    const docx = source("docx.py")
    expect(docx).toContain(`MARK_FILL: Final[str] = "${MARK.fill.slice(1)}"`)
    expect(docx).toContain(`MARK_INK: Final[str] = "${MARK.ink.slice(1)}"`)
  })

  test("each pairing names the faces the runtime sets", () => {
    const themes = source("themes.py")
    for (const [fonts, heading, body] of [
      ["plex", "IBM Plex Sans", "IBM Plex Sans"],
      ["source", "Source Serif 4", "Source Sans 3"],
      ["archivo", "Archivo", "Liberation Sans"],
      ["serif", "Liberation Serif", "Liberation Serif"],
    ] as const) {
      expect(themes).toContain(`"${fonts}": ("${heading}", "${body}")`)
      const design = pageDesign(withStyle({ fonts }))
      expect(design.spec.headingFace).toContain(`"${heading}"`)
      expect(design.spec.face).toContain(`"${body}"`)
    }
  })
})
