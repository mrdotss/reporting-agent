import { describe, expect, test } from "vitest"

import { geometryValue, parseChartFigure } from "@/components/charts/chart-spec"

/**
 * Reading the chart spec out of the emitter's markup (Requirements 22.7, 22.12).
 *
 * The fixture below is the shape `render/html.py#chart` emits. The two
 * assertions that matter are the split between `value` and `formatted` — the
 * first is geometry, the second is what gets printed — and that the encoding is
 * **read**, never inferred from the series count.
 */

function figureFrom(html: string): Element {
  const host = document.createElement("div")
  host.innerHTML = html
  return host.firstElementChild!
}

const CHART = figureFrom(
  '<figure class="rpt-chart" data-chart-type="timeseries" data-encoding="categorical" ' +
    'data-unit="percent" data-path="b1:0">' +
    "<figcaption>CPU over the window</figcaption>" +
    '<div class="rpt-series-set">' +
    '<div class="rpt-series" data-series-key="web-01" data-series-label="web-01">' +
    '<span class="rpt-point" data-x="2026-07-01">' +
    '<span class="rpt-figure" data-snapshot-path="/resources/0/statistics/0/value">64.20%</span>' +
    "</span>" +
    '<span class="rpt-point" data-x="2026-07-02">' +
    '<span class="rpt-figure" data-snapshot-path="/resources/0/statistics/1/value">1,234.56</span>' +
    "</span>" +
    "</div></div></figure>"
)

describe("Requirement 22.7 — geometry and label are different fields", () => {
  test("value is parsed for layout and formatted is the ledger's string", () => {
    const spec = parseChartFigure(CHART)!
    const [first] = spec.series[0]!.points

    expect(first!.value).toBe(64.2)
    // The printed string keeps its unit suffix and its scale. A chart that drew
    // its label from `value` would print `64.2` and lose the trailing zero the
    // verifier matched.
    expect(first!.formatted).toBe("64.20%")
  })

  test("a grouped decimal parses for geometry and prints ungrouped nowhere", () => {
    const spec = parseChartFigure(CHART)!
    const [, second] = spec.series[0]!.points

    expect(second!.value).toBe(1234.56)
    expect(second!.formatted).toBe("1,234.56")
  })

  test("every point carries its snapshot path", () => {
    // What makes an in-app chart a view of verified figures rather than a second
    // computation: each plotted point traces to a snapshot position.
    const spec = parseChartFigure(CHART)!

    for (const point of spec.series[0]!.points) {
      expect(point.snapshotPath).toMatch(/^\/resources\//)
    }
  })
})

describe("Requirement 22.12 — the encoding is read, never inferred", () => {
  test("the declared encoding is used", () => {
    expect(parseChartFigure(CHART)!.encoding).toBe("categorical")
  })

  test("a sequential chart with one series is still sequential", () => {
    // The case that kills inference-from-count. One series could be either, and
    // a lightness ramp over peers asserts an order the data does not contain.
    const sequential = figureFrom(
      '<figure class="rpt-chart" data-encoding="sequential" data-unit="percent">' +
        "<figcaption>Distribution</figcaption>" +
        '<div class="rpt-series" data-series-key="bucket" data-series-label="b">' +
        '<span class="rpt-point" data-x="0"><span class="rpt-figure">1</span></span>' +
        "</div></figure>"
    )

    expect(parseChartFigure(sequential)!.encoding).toBe("sequential")
  })

  test("an unrecognized encoding falls back to categorical", () => {
    // Peers is the assumption that asserts less, so it is the safe one to be
    // wrong about.
    const odd = figureFrom(
      '<figure class="rpt-chart" data-encoding="diverging"></figure>'
    )

    expect(parseChartFigure(odd)!.encoding).toBe("categorical")
  })
})

describe("parsing refuses what it did not produce", () => {
  test("an element that is not a chart figure is null", () => {
    expect(parseChartFigure(figureFrom("<div>not a chart</div>"))).toBeNull()
  })
})

describe("geometryValue", () => {
  test.each([
    ["64.20%", 64.2],
    ["1,234.56", 1234.56],
    ["48211993 bytes", 48211993],
    ["-3.5", -3.5],
    ["0.00", 0],
  ])("%s parses to %s", (formatted, expected) => {
    expect(geometryValue(formatted)).toBe(expected)
  })

  test("an unparseable string is NaN, not zero", () => {
    // A missing value plotted at the baseline is a claim the data does not make,
    // so the renderer needs to be able to tell "absent" from "zero".
    expect(geometryValue("—")).toBeNaN()
    expect(geometryValue("")).toBeNaN()
  })
})
