import { describe, expect, test } from "vitest"

import { splitOnFigures } from "@/components/reports/paper-render"

/**
 * The figure split, against **real emitter output** (Requirement 38.1).
 *
 * The samples below are copied from `render/html.py`'s actual emission — run
 * through `emit_html` over a compiled fixture — rather than hand-written to the
 * shape this file expects. That distinction is the whole value of the test: a
 * hand-written sample tests that the regex matches the regex's author's idea of
 * the markup, which is always true.
 *
 * `paper-render.tsx` treats the emitter's output as a string, and that is a real
 * dependency on one element's shape. This is what catches the emitter changing
 * it.
 */

/** Emitted by `emit_html` over a `kpi_row` compiled against the VM fixture. */
const EXACT_FIGURE =
  '<span class="rpt-figure" data-snapshot-path="/resources/0/statistics/0/value" ' +
  'data-figure-path="b1:0.0.2.0" data-unit="percent">64.20%</span>'

/** The same, with the estimator attribute the emitter adds for a percentile. */
const ESTIMATED_FIGURE =
  '<span class="rpt-figure" data-snapshot-path="/resources/0/statistics/3/value" ' +
  'data-figure-path="b1:0.0.3.0" ' +
  'data-estimator-label="p95 (hourly means)" data-unit="percent">88.10%</span>'

describe("Requirement 38.1 — figures are found in the emitter's markup", () => {
  test("a document with one figure splits into markup, figure, markup", () => {
    const segments = splitOnFigures(
      `<p>CPU average ${EXACT_FIGURE} across.</p>`
    )

    expect(segments.map((segment) => segment.kind)).toEqual([
      "html",
      "figure",
      "html",
    ])
  })

  test("the formatted string is carried through unchanged", () => {
    // Requirement 38.1 — "composing no numeric string of its own". The trailing
    // percent sign is the Formatter's; a component that reformatted would make
    // the printed string differ from the one the verifier matched.
    const [figure] = splitOnFigures(EXACT_FIGURE)

    expect(figure).toMatchObject({ kind: "figure", formatted: "64.20%" })
  })

  test("the snapshot path is read off the element", () => {
    const [figure] = splitOnFigures(EXACT_FIGURE)

    expect(figure).toMatchObject({
      snapshotPath: "/resources/0/statistics/0/value",
    })
  })

  test("an exact figure carries no estimator", () => {
    // Requirement 38.3 — no caveat for a value that is not an estimate. The
    // emitter omits the attribute rather than writing an empty one, so `null`
    // here is the emitter's own signal.
    const [figure] = splitOnFigures(EXACT_FIGURE)

    expect(figure).toMatchObject({ estimator: null })
  })

  test("an estimated figure carries the label character-for-character", () => {
    // Not "p95", not "p95 (estimated)" — the ledger's own string. A percentile
    // over hourly buckets is not a p95 of the minute samples, and only the
    // collector knows which it was.
    const [figure] = splitOnFigures(ESTIMATED_FIGURE)

    expect(figure).toMatchObject({ estimator: "p95 (hourly means)" })
  })

  test("several figures in one document are all found", () => {
    const segments = splitOnFigures(
      `<p>${EXACT_FIGURE}</p><table><tr><td>${ESTIMATED_FIGURE}</td>` +
        `<td>${EXACT_FIGURE}</td></tr></table>`
    )

    // Figures outside tables are returned as kind:"figure" segments.
    // Figures inside tables are returned inside kind:"table" segments (to
    // preserve table DOM structure — see paper-render.tsx module docstring).
    const directFigures = segments.filter((s) => s.kind === "figure")
    const tableFigures = segments
      .filter((s): s is { kind: "table"; tableHtml: string; figures: readonly { formatted: string; snapshotPath: string; estimator: string | null }[] } => s.kind === "table")
      .flatMap((s) => s.figures)

    expect(directFigures.length + tableFigures.length).toBe(3)
  })

  test("figures are returned in document order", () => {
    const segments = splitOnFigures(`${ESTIMATED_FIGURE}${EXACT_FIGURE}`)
    const figures = segments.filter((segment) => segment.kind === "figure")

    // Requirement 38.6 — sequential keyboard navigation follows "the document
    // order the Html_Emitter emits", and this list is what becomes that order.
    expect(
      figures.map((figure) => ("formatted" in figure ? figure.formatted : ""))
    ).toEqual(["88.10%", "64.20%"])
  })
})

describe("markup between figures is passed through untouched", () => {
  test("surrounding markup is preserved byte for byte", () => {
    const before = '<h1 class="rpt-h1">Utilization</h1><p>'
    const after = "</p><hr />"

    const segments = splitOnFigures(`${before}${EXACT_FIGURE}${after}`)

    expect(segments[0]).toEqual({ kind: "html", html: before })
    expect(segments[2]).toEqual({ kind: "html", html: after })
  })

  test("a document with no figure is one markup segment", () => {
    // The degraded case, and it degrades *visibly*: the page renders, no reveal
    // is offered, and nothing is silently dropped.
    const html = "<p>No figures in this block.</p>"

    expect(splitOnFigures(html)).toEqual([{ kind: "html", html }])
  })

  test("a span whose class merely starts with the figure class is left alone", () => {
    // The one that kills a `\b`-bounded match: `-` is a non-word character, so
    // `\brpt-figure\b` matches inside `rpt-figure-caption`. That would turn a
    // caption into a figure slot carrying no snapshot path, and the reveal would
    // announce "provenance unavailable" over a piece of chrome that never had
    // any. The class value is a token list and the match is token-bounded.
    const html = '<span class="rpt-figure-caption">Resources</span>'

    expect(splitOnFigures(html)).toEqual([{ kind: "html", html }])
  })

  test("a figure carrying other classes alongside is still found", () => {
    // The other half of token-bounding: `class="rpt-figure rpt-emphasis"` is a
    // figure, and a match anchored to the quote would miss it.
    const html =
      '<span class="rpt-figure rpt-emphasis" data-snapshot-path="/a">1</span>'

    expect(splitOnFigures(html)[0]).toMatchObject({ kind: "figure" })
  })
})

describe("attribute values are decoded", () => {
  test("an escaped path is revealed as the path, not as its entities", () => {
    // The emitter escapes with `quote=True`. Printing `&amp;` in the reveal
    // would show a path that does not match the snapshot — and the reveal exists
    // so a consultant can take the path and find the value.
    const escaped =
      '<span class="rpt-figure" data-snapshot-path="/a&amp;b/value">1</span>'

    expect(splitOnFigures(escaped)[0]).toMatchObject({
      snapshotPath: "/a&b/value",
    })
  })
})
