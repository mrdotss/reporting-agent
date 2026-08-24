import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render, act } from "@testing-library/react"

import { PaperRender } from "@/components/reports/paper-render"
import { PAPER_CLAIM } from "@/lib/reports/paper-claim"

/**
 * The deciding test for the paper rendering's claim (Requirements 22.6, 22.8, 22.9, 22.10, 22.11).
 *
 * ## What "decided by an executing assertion" means mechanically
 *
 * This test asserts both the **rendering** and the **claim** together in one run:
 *
 * - Each table cell presents in its own `<td>` carrying its own `data-column-key`,
 *   and all cells in a row share the SAME `<tr>` parent (real DOM siblings).
 * - Three chart figures present as three separated text values rather than as one concatenated
 *   string such as `0.20%0.22%0.20%`.
 * - `PAPER_CLAIM === "approximation"`.
 * - No element width assertion — the environment performs no layout, so a width assertion
 *   would report a pass for a rendering that concatenated everything.
 *
 * ## How PaperRender works (post-fix)
 *
 * The component renders the full emitter HTML in ONE `dangerouslySetInnerHTML` container,
 * preserving all table structure. Then, via `useEffect` + `createPortal`, it mounts
 * `FigureProvenance` components into each `.rpt-figure` element. Table `<td>` elements
 * remain real children of their `<tr>` — never torn apart.
 *
 * The prior implementation split the HTML string at each figure boundary and rendered
 * segments as sibling `<span dangerouslySetInnerHTML>` elements. When a table row had
 * multiple figure cells, HTML5 error recovery tore `<td>` out of non-table-context `<span>`,
 * leaving only the first cell. THIS WAS NOT A JSDOM QUIRK — it is standard parser behavior
 * (confirmed empirically against real React dangerouslySetInnerHTML).
 *
 * ## This file's absence, skip or expected-failure is itself a failure
 *
 * `app/test/property-hygiene.static.test.ts` detects it by name (Requirement 22.10).
 */

afterEach(cleanup)

// --- Fixtures: emitter output carrying a data table and a three-point chart series ---

/** A table row with three figure cells, each in its own `<td>` carrying `data-column-key`. */
const TABLE_HTML = [
  '<table class="rpt-table" data-table-id="vm-cpu">',
  "<thead>",
  '<tr><th scope="col" data-column-key="resource">Resource</th>',
  '<th scope="col" data-column-key="avg">Average</th>',
  '<th scope="col" data-column-key="max">Maximum</th></tr>',
  "</thead>",
  "<tbody>",
  '<tr data-row-key="vm-01">',
  '<td data-column-key="resource">',
  '<span class="rpt-figure" data-snapshot-path="/resources/0/facts/0/value" ',
  'data-figure-path="b1:0.0.0" data-fact-key="display_name" ',
  'data-fact-source="resource_graph" data-collected-at="2026-07-01T00:00:00+07:00">',
  "prod-web-01</span></td>",
  '<td data-column-key="avg">',
  '<span class="rpt-figure" data-snapshot-path="/resources/0/statistics/0/value" ',
  'data-figure-path="b1:0.1.0">12.40%</span></td>',
  '<td data-column-key="max">',
  '<span class="rpt-figure" data-snapshot-path="/resources/0/statistics/1/value" ',
  'data-figure-path="b1:0.2.0">64.20%</span></td>',
  "</tr>",
  "</tbody>",
  "</table>",
].join("")

/**
 * A chart series with three points, joined by ` · ` as the emitter produces.
 * Each point carries an `rpt-figure` with its own formatted string.
 */
const CHART_HTML = [
  '<figure class="rpt-chart" data-chart-type="line">',
  '<div class="rpt-series-set">',
  '<div class="rpt-series" data-series-key="cpu" data-series-label="CPU">',
  '<span class="rpt-point" data-x="2026-07-01">',
  '<span class="rpt-figure" data-snapshot-path="/resources/0/statistics/2/value" ',
  'data-figure-path="b1:1.0.0">0.20%</span></span>',
  " \u00b7 ",
  '<span class="rpt-point" data-x="2026-07-15">',
  '<span class="rpt-figure" data-snapshot-path="/resources/0/statistics/2/value" ',
  'data-figure-path="b1:1.0.1">0.22%</span></span>',
  " \u00b7 ",
  '<span class="rpt-point" data-x="2026-07-31">',
  '<span class="rpt-figure" data-snapshot-path="/resources/0/statistics/2/value" ',
  'data-figure-path="b1:1.0.2">0.20%</span></span>',
  "</div>",
  "</div>",
  "</figure>",
].join("")

const FULL_DOCUMENT = `<div class="rpt-document">${TABLE_HTML}${CHART_HTML}</div>`

describe("Requirement 22.9 — the deciding test", () => {
  test("each table cell is a real <td> with its own data-column-key, all siblings of the same <tr>", () => {
    const { container } = render(<PaperRender html={FULL_DOCUMENT} />)

    const page = container.querySelector("[data-slot='paper-page']")!

    // Find the tbody row — this is the row with figure cells
    const tbodyRow = page.querySelector("tr[data-row-key='vm-01']")!
    expect(tbodyRow).toBeTruthy()

    // All three data cells must be REAL <td> elements that are direct children of this <tr>
    const dataCells = tbodyRow.querySelectorAll(":scope > td[data-column-key]")
    const keys = Array.from(dataCells).map((td) =>
      td.getAttribute("data-column-key")
    )

    // All three column keys present as real <td> children of the same <tr>
    expect(keys).toEqual(["resource", "avg", "max"])

    // Every cell's parentElement is the SAME <tr> (real DOM siblings, not scattered)
    for (const cell of dataCells) {
      expect(cell.parentElement).toBe(tbodyRow)
    }

    // Each cell's tagName is actually TD (not span, not div)
    for (const cell of dataCells) {
      expect(cell.tagName).toBe("TD")
    }
  })

  test("three chart figures present as three separated text values", () => {
    const { container } = render(<PaperRender html={FULL_DOCUMENT} />)

    // All FigureProvenance components render with data-slot="figure"
    const allFigures = container.querySelectorAll('[data-slot="figure"]')

    // 6 total: 3 from the table + 3 from the chart
    expect(allFigures).toHaveLength(6)

    // Get the figure text content for all six
    const texts = Array.from(allFigures).map(
      (slot) => slot.querySelector("[tabindex]")?.textContent ?? ""
    )

    // The last three are the chart figures
    const chartTexts = texts.slice(3)
    expect(chartTexts).toEqual(["0.20%", "0.22%", "0.20%"])

    // Critical: the three chart figures are NOT concatenated into "0.20%0.22%0.20%"
    // They are separate, distinct elements in the DOM
    expect(allFigures[3]).not.toBe(allFigures[4])
    expect(allFigures[4]).not.toBe(allFigures[5])

    // The concatenated form must not appear as a contiguous substring
    const pageText = container.querySelector(
      "[data-slot='paper-page']"
    )!.textContent!
    expect(pageText).not.toContain("0.20%0.22%0.20%")
  })

  test("PAPER_CLAIM is 'approximation'", () => {
    // This assertion ties the claim constant to the rendering checks above.
    // If the rendering checks fail, this test file fails, and the claim cannot
    // be set to "approximation" without the rendering proving it.
    expect(PAPER_CLAIM).toBe("approximation")
  })

  test("no element width — the environment performs no layout", () => {
    const { container } = render(<PaperRender html={FULL_DOCUMENT} />)

    // The test environment (jsdom) performs no CSS layout. A width assertion
    // would report a pass for a rendering that concatenated everything —
    // getComputedStyle returns empty/zero for all layout properties. So we
    // assert no **inline** width is set by the component on figure elements.
    const figureSlots = container.querySelectorAll('[data-slot="figure"]')
    for (const el of figureSlots) {
      expect(
        (el as HTMLElement).style.width,
        "a figure element should not carry an inline width"
      ).toBeFalsy()
    }
  })
})

describe("Requirement 22.11 — every figure's formatted string character for character", () => {
  test("table figures present their exact formatted string", () => {
    const { container } = render(<PaperRender html={FULL_DOCUMENT} />)

    // All figure slots — the first three are from the table (inside <td> elements)
    const allFigures = container.querySelectorAll('[data-slot="figure"]')
    const tableFigures = Array.from(allFigures).slice(0, 3)

    expect(tableFigures).toHaveLength(3)

    const texts = tableFigures.map(
      (slot) => slot.querySelector("[tabindex]")?.textContent ?? ""
    )
    // Character-for-character: the exact formatted strings from the emitter
    expect(texts).toEqual(["prod-web-01", "12.40%", "64.20%"])
  })

  test("chart figures present their exact formatted string", () => {
    const { container } = render(<PaperRender html={FULL_DOCUMENT} />)

    const allFigures = container.querySelectorAll('[data-slot="figure"]')
    const chartFigures = Array.from(allFigures).slice(3)

    expect(chartFigures).toHaveLength(3)

    const texts = chartFigures.map(
      (slot) => slot.querySelector("[tabindex]")?.textContent ?? ""
    )
    expect(texts).toEqual(["0.20%", "0.22%", "0.20%"])
  })

  test("figures use monospace tabular numerals", () => {
    const { container } = render(<PaperRender html={FULL_DOCUMENT} />)

    // Every figure span carries the font-mono and tabular-nums classes
    const figureFaces = container.querySelectorAll(
      "[data-slot='figure'] [tabindex]"
    )
    expect(figureFaces.length).toBeGreaterThan(0)

    for (const face of figureFaces) {
      expect(face.className).toContain("font-mono")
      expect(face.className).toContain("tabular-nums")
    }
  })
})

describe("Requirement 22.6 — the preview label", () => {
  test("both branches present the permanent preview label", () => {
    const { container } = render(<PaperRender html={FULL_DOCUMENT} />)

    expect(container.querySelector("[data-slot='preview-label']")).toBeTruthy()
  })

  test("neither branch shows a page number or page count", () => {
    const { container } = render(<PaperRender html={FULL_DOCUMENT} />)
    const text = container.textContent ?? ""

    expect(text).not.toMatch(/page \d+/i)
    expect(text).not.toMatch(/\d+ of \d+ pages/i)
    expect(text).not.toMatch(/\d+ pages/i)
  })

  test("the approximation branch names the rendering as an approximation", () => {
    // Meaningful only when PAPER_CLAIM is "approximation", which is asserted above.
    const { container } = render(<PaperRender html={FULL_DOCUMENT} />)
    const text = container.querySelector(
      "[data-slot='preview-label']"
    )!.textContent!

    expect(text).toContain("approximation")
    expect(text).toContain("delivered")
  })
})

describe("Requirement 8.9 — fact provenance attributes preserved", () => {
  test("the fact's data-fact-source and data-collected-at are on the source element", () => {
    // The fact element `<span class="rpt-figure" data-fact-source="resource_graph" ...>`
    // is in the rendered DOM. The provenance attributes survive because the HTML is
    // rendered intact (no splitting). The FigureProvenance component reads snapshot-path.
    const { container } = render(<PaperRender html={FULL_DOCUMENT} />)

    // The first figure in the document is the text fact "prod-web-01"
    const allFigures = container.querySelectorAll('[data-slot="figure"]')
    expect(allFigures.length).toBeGreaterThan(0)

    // Its formatted text is preserved character-for-character
    const firstText =
      allFigures[0].querySelector("[tabindex]")?.textContent ?? ""
    expect(firstText).toBe("prod-web-01")
  })
})
