import { CHART_ENCODINGS, type ChartEncoding } from "@/components/charts/palette"

/**
 * The chart spec, read out of the markup `render/html.py` emits (Requirement
 * 22.7).
 *
 * **Pure, and deliberately not `server-only`.** This runs in the browser, over a
 * DOM node the paper rendering already contains.
 *
 * ## Why the spec travels as markup rather than as a separate payload
 *
 * `render/html.py#chart` emits a `<figure class="rpt-chart">` carrying the chart
 * type, the encoding and the unit as attributes, with each series as a `<div
 * class="rpt-series">` of `<span class="rpt-point">` elements — and each point's
 * value is a **figure element**, carrying its own `data-snapshot-path` and its
 * `formatted` string.
 *
 * That means the data island is simultaneously the companion table's source and
 * the chart's, so the two cannot disagree about what was plotted (Requirement
 * 22.10's "expose the underlying figures as a table as each chart's text
 * alternative" is satisfied by the markup that is already there). It also means
 * every plotted point traces to a snapshot position, which is what makes an
 * in-app chart *a view of verified figures* rather than a second computation.
 *
 * ## Layout geometry from the decimal string; labels from `formatted`
 *
 * Requirement 22.7 is precise about this split: the decimal string is parsed
 * "for layout geometry only", and every **displayed value label** is taken from
 * "the `formatted` value its ledger reference resolves to".
 *
 * So {@link ChartPoint} carries both, and they are not interchangeable. `value`
 * decides where a mark sits; `formatted` is what is printed beside it. A chart
 * that printed `value.toFixed(2)` would be composing a numeric string — the one
 * thing this product forbids everywhere else, and the reason the ledger records
 * `formatted` at all.
 */

export type ChartPoint = {
  readonly x: string
  /** For geometry only. `NaN` where the string did not parse. */
  readonly value: number
  /** The ledger's own string. Printed verbatim; never recomputed. */
  readonly formatted: string
  readonly snapshotPath: string | null
}

export type ChartSeries = {
  readonly key: string
  readonly label: string
  readonly points: readonly ChartPoint[]
}

export type ChartSpec = {
  readonly chartType: string
  readonly encoding: ChartEncoding
  readonly unit: string
  readonly title: string
  readonly series: readonly ChartSeries[]
}

/**
 * Parse a `<figure class="rpt-chart">` element.
 *
 * `null` for an element that is not one, or one the emitter did not produce —
 * the caller renders nothing rather than a chart of guesses.
 *
 * ## The encoding is read, never inferred
 *
 * Requirement 22.12: "select the palette from the spec's `encoding` and never
 * from the series count". `Chart`'s own docstring in `compile/ast.py` says why —
 * the encoding is *the compiler's decision*, and "a lightness ramp over peers
 * would assert an order the data does not contain". A chart of three peers and a
 * chart of three ordered buckets have the same series count and need different
 * palettes, so the count cannot decide it.
 *
 * An unrecognized encoding falls back to `categorical` rather than throwing:
 * peers is the assumption that asserts *less*, so it is the safe one to be wrong
 * about.
 */
export function parseChartFigure(figure: Element): ChartSpec | null {
  if (!figure.classList.contains("rpt-chart")) return null

  const declared = figure.getAttribute("data-encoding")
  const encoding: ChartEncoding = (CHART_ENCODINGS as readonly string[]).includes(
    declared ?? ""
  )
    ? (declared as ChartEncoding)
    : "categorical"

  const series: ChartSeries[] = [...figure.querySelectorAll(".rpt-series")].map(
    (node) => ({
      key: node.getAttribute("data-series-key") ?? "",
      label: node.getAttribute("data-series-label") ?? "",
      points: [...node.querySelectorAll(".rpt-point")].map(readPoint),
    })
  )

  return {
    chartType: figure.getAttribute("data-chart-type") ?? "",
    encoding,
    unit: figure.getAttribute("data-unit") ?? "",
    title: figure.querySelector("figcaption")?.textContent ?? "",
    series,
  }
}

function readPoint(node: Element): ChartPoint {
  const figure = node.querySelector(".rpt-figure")
  const formatted = figure?.textContent ?? ""

  return {
    x: node.getAttribute("data-x") ?? "",
    value: geometryValue(formatted),
    formatted,
    snapshotPath: figure?.getAttribute("data-snapshot-path") ?? null,
  }
}

/**
 * A number for positioning a mark, from the printed string.
 *
 * Group separators and a trailing unit suffix are stripped before parsing —
 * `1,234.56` and `12.48%` are both printed forms this product produces, and
 * `Number("1,234.56")` is `NaN`.
 *
 * **This value is never displayed.** Requirement 22.7 confines it to "layout
 * geometry only", and the reason is that the round trip is lossy in ways that
 * matter: a decimal string carries a scale the double does not, so re-printing
 * it would quietly change a figure the verifier matched character for character.
 *
 * `NaN` for anything unparseable, which the renderer treats as a gap in the line
 * rather than as zero — a missing value plotted at the baseline is a claim the
 * data does not make.
 */
export function geometryValue(formatted: string): number {
  const cleaned = formatted.replace(/,/g, "").replace(/[^0-9.eE+-].*$/, "")

  return cleaned === "" ? Number.NaN : Number(cleaned)
}
