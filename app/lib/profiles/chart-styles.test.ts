import { describe, expect, it } from "vitest"

import {
  CHART_FONT_STACKS,
  CHART_STYLE_NOTES,
  chartPreviewPaths,
} from "@/lib/profiles/chart-styles"
import { CHART_FONTS, CHART_STYLES } from "@/lib/templates/definition"

/**
 * The wizard's Appearance step, below the view.
 *
 * These previews are a **promise about a picture drawn somewhere else**: the delivered
 * chart comes from matplotlib on the runtime, from the figure ledger, and this module only
 * draws a shape so a consultant can pick one. That makes the interesting properties the
 * ones about the promise holding — every style has a card, every card draws something, and
 * the face the preview is set in is the face the agent will actually use — rather than
 * anything about the coordinates themselves.
 */

/** The real August series the step ships, trimmed — enough points to have a shape. */
const MAX = [22.4, 11.2, 10.8, 2.1, 10.4, 23.2, 7.9, 9.9, 27.3, 11.3, 7.8, 9.89]
const AVG = [0.19, 0.17, 0.17, 0.18, 0.2, 0.16, 0.18, 0.19, 0.19, 0.17, 0.18, 0.19]

/** Every y in a preview, whatever kind of geometry carried it. */
function verticals(style: (typeof CHART_STYLES)[number]): number[] {
  const paths = chartPreviewPaths(style, MAX, AVG)
  const found: number[] = []
  for (const line of paths.lines) {
    for (const pair of line.points.split(" ")) {
      found.push(Number(pair.split(",")[1]))
    }
  }
  for (const bar of paths.bars ?? []) {
    found.push(bar.y, bar.y + bar.height)
  }
  if (paths.dot) found.push(paths.dot.y)
  for (const label of paths.labels) found.push(label.y)
  return found
}

describe("the six style cards", () => {
  it("gives every style a consultant can choose a note to read", () => {
    // A style in the validator with no note here renders a card with an undefined blurb —
    // which looks like a bug in the data rather than a missing sentence.
    expect(Object.keys(CHART_STYLE_NOTES).sort()).toEqual([...CHART_STYLES].sort())
    for (const style of CHART_STYLES) {
      const note = CHART_STYLE_NOTES[style]
      expect(note.blurb.length, style).toBeGreaterThan(20)
      expect(note.height, style).toMatch(/^\d+(\.\d+)? in$/)
    }
  })

  it("says exactly one style carries a bitmap, because exactly one does", () => {
    // The notes icon the step shows is a claim about the emitted SVG: the gradient fill is
    // an image ramp clipped to the curve, and every other shape is pure vector. A wrong
    // flag here is a print-quality promise the renderer does not keep.
    const raster = CHART_STYLES.filter((style) => CHART_STYLE_NOTES[style].raster)
    expect(raster).toEqual(["soft_area"])
  })

  it("draws something for every style", () => {
    for (const style of CHART_STYLES) {
      const paths = chartPreviewPaths(style, MAX, AVG)
      const drawn =
        paths.lines.length + (paths.bars?.length ?? 0) + (paths.fill ? 1 : 0)
      expect(drawn, `${style} draws an empty card`).toBeGreaterThan(0)
    }
  })

  it("keeps every mark inside the box it is drawn in", () => {
    // The headroom the function's own doc comment claims. A line touching the top of its
    // frame reads as clipped, and six cards only compare if they share the margin.
    for (const style of CHART_STYLES) {
      const ys = verticals(style)
      expect(ys.length, style).toBeGreaterThan(0)
      expect(Math.min(...ys), `${style} draws above its box`).toBeGreaterThanOrEqual(0)
      expect(Math.max(...ys), `${style} draws below its box`).toBeLessThanOrEqual(78)
    }
  })

  it("plots both series wherever the style claims to show two", () => {
    // `stacked` and `range_band` are sold on showing Max against Avg. A single-series
    // preview under either label is the card describing a different chart than it draws.
    for (const style of ["stacked", "range_band"] as const) {
      const paths = chartPreviewPaths(style, MAX, AVG)
      expect(paths.lines.length, style).toBe(2)
    }
    // And the band is a closed shape rather than two open strokes, or it shades nothing.
    const band = chartPreviewPaths("range_band", MAX, AVG)
    expect(band.fill).toBeDefined()
    expect(band.fill!.split(" ").length).toBe(MAX.length + AVG.length)
  })

  it("is pure — same arguments, same geometry, arguments untouched", () => {
    const max = [...MAX]
    const avg = [...AVG]
    const first = chartPreviewPaths("soft_area", max, avg)
    const second = chartPreviewPaths("soft_area", max, avg)
    expect(second).toEqual(first)
    expect(max).toEqual(MAX)
    expect(avg).toEqual(AVG)
  })
})

describe("the three faces", () => {
  it("gives every face a stack", () => {
    expect(Object.keys(CHART_FONT_STACKS).sort()).toEqual([...CHART_FONTS].sort())
  })

  it("leads each stack with the family the runtime will actually draw in", () => {
    // The preview's whole job is to show what the delivered chart will look like. The agent
    // resolves `grotesque` to DejaVu Sans and `monospace` to DejaVu Sans Mono — both
    // families the runtime image carries — and `document` to the preset's own body face,
    // which is Liberation Serif. A stack leading with anything else previews a face the
    // report will not be set in, and nothing else in either half would notice.
    expect(CHART_FONT_STACKS.grotesque.startsWith('"DejaVu Sans"')).toBe(true)
    expect(CHART_FONT_STACKS.monospace.startsWith('"DejaVu Sans Mono"')).toBe(true)
    expect(CHART_FONT_STACKS.document.startsWith('"Liberation Serif"')).toBe(true)
  })

  it("falls back to a generic family, so a face the browser lacks still renders", () => {
    // The image carries these families; a consultant's laptop need not. Every stack ends in
    // a CSS generic so the card is never left to the browser's default.
    for (const font of CHART_FONTS) {
      expect(CHART_FONT_STACKS[font], font).toMatch(/(serif|sans-serif|monospace)$/)
    }
  })
})
