"use client"

import { useMemo } from "react"
import { InfoIcon } from "@phosphor-icons/react"

import { FigureProvenance } from "@/components/reports/figure-provenance"
import { PAPER_CLAIM } from "@/lib/reports/paper-claim"
import { PREVIEW_DIVERGENCES } from "@/components/templates/paper-preview"

/**
 * The report as a paper-like rendering, with provenance on every figure
 * (Requirement 38).
 *
 * ## The markup is the emitter's; this file adds behaviour to the figures
 *
 * Requirement 38.1 requires the rendering to be emitted "by walking the same
 * document AST the Docx_Renderer emitted for that run" and to hold "no layout
 * definition of its own". So the HTML comes from `reports/<runId>/document.html`
 * — written by `render/html.py` during the run, from `compiled.document`, the
 * same object the `.docx` came from.
 *
 * What this component adds is the one thing the emitter cannot: an interactive
 * reveal on each figure.
 *
 * **The provenance is already in the markup.** `render/html.py` puts
 * `data-snapshot-path` and, where the value is estimated,
 * `data-estimator-label` on every figure element — and *raises* if a figure
 * carries no snapshot path, so a document that emitted at all has provenance on
 * every figure. So this component reads the attributes off the elements rather
 * than joining a separately fetched ledger by AST path.
 *
 * That is worth having deliberately: a join is a second thing that can be
 * missing, stale or keyed wrong, and Requirement 38.1 wants the figure and its
 * provenance to be one fact. They are one element.
 *
 * ## The label is the same permanent one the canvas carries
 *
 * Requirement 38.5 points at 14.2 and 14.3: the permanent preview label, outside
 * a tooltip and outside a first-run hint, and no page number or count. The
 * divergence list is imported from `paper-preview.tsx` rather than restated, so
 * the two surfaces cannot name different three things.
 *
 * What this surface must **not** say is that the HTML is what the consultant
 * will receive (Requirement 14.6) — the presigned `.pdf` is, and the label says
 * so.
 *
 * ## Table-aware figure extraction
 *
 * The prior implementation split the HTML string at each figure boundary and
 * rendered segments as sibling `<span dangerouslySetInnerHTML>` elements. When a
 * table row had multiple figure cells, the `<td>` boundaries tore across separate
 * spans — each fragment carried unclosed tags that HTML5 error recovery removed
 * from table context. This is not a jsdom quirk; it is standard parser behavior
 * in every browser.
 *
 * The fix: when a figure falls inside a `<table>`, parse the ENTIRE table as one
 * DOM block, replacing figure spans in-place with React components rendered into
 * real `<td>` elements. The table's `<tr>/<td>` ancestry is never broken because
 * the table HTML is never split into sibling spans.
 *
 * For non-table content (charts, prose), the original segment-splitting approach
 * is safe — a `<span>` boundary inside `<div>`/`<figure>`/`<p>` does not trigger
 * HTML5 error recovery since those elements nest freely.
 */

/** The class `render/html.py` marks every figure with. */
const FIGURE_CLASS = "rpt-figure"

/** Where the value came from. The emitter raises rather than omit this. */
const SNAPSHOT_PATH_ATTRIBUTE = "data-snapshot-path"

/** Present only where the value is an estimate (Requirement 38.3). */
const ESTIMATOR_ATTRIBUTE = "data-estimator-label"

type FigureData = {
  readonly formatted: string
  readonly snapshotPath: string
  readonly estimator: string | null
}

type Segment =
  | { readonly kind: "html"; readonly html: string }
  | { readonly kind: "figure"; readonly formatted: string; readonly snapshotPath: string; readonly estimator: string | null }
  | { readonly kind: "table"; readonly tableHtml: string; readonly figures: readonly FigureData[] }

/** One attribute's value off a matched element, or `null`. */
function attribute(element: string, name: string): string | null {
  const found = new RegExp(`${name}="([^"]*)"`).exec(element)

  return found === null ? null : decodeEntities(found[1] ?? "")
}

/**
 * Undo the emitter's `html.escape` on an attribute value.
 *
 * The emitter escapes with `quote=True`, so a snapshot path containing an
 * ampersand arrives as `&amp;`. Printing that verbatim in the reveal would show
 * a path that does not match the snapshot — and the reveal's whole purpose is
 * that a consultant can take the path and find the value.
 *
 * The five `html.escape` produces, and nothing else: a general entity decoder
 * here would be a second HTML parser in a file whose point is not to be one.
 */
function decodeEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
}

/** The figure-matching regex — matches the figure span element. */
const FIGURE_PATTERN = new RegExp(
  `<span[^>]*class="(?:[^"]*\\s)?${FIGURE_CLASS}(?:\\s[^"]*)?"[^>]*>([\\s\\S]*?)</span>`,
  "g"
)

/** Extract figure data from a matched element string. */
function extractFigure(element: string, content: string): FigureData {
  return {
    formatted: decodeEntities(content),
    snapshotPath: attribute(element, SNAPSHOT_PATH_ATTRIBUTE) ?? "",
    estimator: attribute(element, ESTIMATOR_ATTRIBUTE),
  }
}

/**
 * A unique placeholder that cannot appear in emitter output.
 * Used to mark figure positions within table HTML so they can be replaced
 * with React components during rendering.
 */
const FIGURE_PLACEHOLDER = "\uFFFDFIGURE\uFFFD"

/**
 * Split emitted HTML into segments, keeping tables intact.
 *
 * Tables are parsed as whole blocks with figure data extracted separately.
 * Figure placeholders within the table HTML are rendered as React components
 * in their correct DOM positions (inside real `<td>` elements).
 *
 * Non-table content uses the original per-figure splitting (safe because
 * `<span>` boundaries inside `<div>`/`<figure>`/`<p>` do not cause HTML5
 * error recovery).
 */
export function splitOnFigures(html: string): readonly Segment[] {
  // First, find all table boundaries
  const tablePattern = /<table[\s\S]*?<\/table>/gi
  const segments: Segment[] = []
  let cursor = 0

  for (const tableMatch of html.matchAll(tablePattern)) {
    const tableStart = tableMatch.index
    const tableEnd = tableStart + tableMatch[0].length

    // Process non-table content before this table using the original splitting
    if (tableStart > cursor) {
      const before = html.slice(cursor, tableStart)
      splitNonTableContent(before, segments)
    }

    // Process the table as a single block
    const tableHtml = tableMatch[0]
    const figures: FigureData[] = []

    // Replace each figure in the table with a placeholder, extracting data
    const modifiedTable = tableHtml.replace(FIGURE_PATTERN, (match, content) => {
      figures.push(extractFigure(match, content ?? ""))
      return `<span class="${FIGURE_CLASS}" data-figure-placeholder="true">${FIGURE_PLACEHOLDER}${figures.length - 1}</span>`
    })

    if (figures.length > 0) {
      segments.push({ kind: "table", tableHtml: modifiedTable, figures })
    } else {
      // Table with no figures — just pass through as HTML
      segments.push({ kind: "html", html: tableHtml })
    }

    cursor = tableEnd
  }

  // Process any remaining non-table content
  if (cursor < html.length) {
    const remaining = html.slice(cursor)
    splitNonTableContent(remaining, segments)
  }

  return segments
}

/**
 * Split non-table HTML content at figure boundaries (the original approach).
 * Safe for non-table content because `<span>` boundaries inside `<div>`,
 * `<figure>`, `<p>` etc. do not trigger HTML5 error recovery.
 */
function splitNonTableContent(html: string, segments: Segment[]): void {
  let cursor = 0
  const pattern = new RegExp(FIGURE_PATTERN.source, "g")

  for (const match of html.matchAll(pattern)) {
    const start = match.index
    if (start > cursor) {
      segments.push({ kind: "html", html: html.slice(cursor, start) })
    }

    const element = match[0]
    segments.push({
      kind: "figure",
      formatted: decodeEntities(match[1] ?? ""),
      snapshotPath: attribute(element, SNAPSHOT_PATH_ATTRIBUTE) ?? "",
      estimator: attribute(element, ESTIMATOR_ATTRIBUTE),
    })

    cursor = start + element.length
  }

  if (cursor < html.length) {
    segments.push({ kind: "html", html: html.slice(cursor) })
  }
}

/**
 * Render a table segment: parse the placeholder-bearing HTML into a real DOM
 * structure, then render each cell's content with figure components in place.
 */
function TableSegment({
  tableHtml,
  figures,
}: Readonly<{ tableHtml: string; figures: readonly FigureData[] }>) {
  // Parse the table into a structure we can render with React
  const parsed = useMemo(() => parseTableWithPlaceholders(tableHtml, figures), [tableHtml, figures])

  return (
    <table
      {...parsed.tableAttrs}
      dangerouslySetInnerHTML={undefined}
    >
      {parsed.sections.map((section, si) => {
        const SectionTag = section.tag as "thead" | "tbody" | "tfoot"
        return (
          <SectionTag key={si}>
            {section.rows.map((row, ri) => (
              <tr key={ri} {...row.attrs}>
                {row.cells.map((cell, ci) => {
                  const CellTag = cell.tag as "th" | "td"
                  return (
                    <CellTag key={ci} {...cell.attrs}>
                      {cell.contents.map((content, idx) =>
                        content.kind === "html" ? (
                          <span key={idx} dangerouslySetInnerHTML={{ __html: content.html }} />
                        ) : (
                          <FigureProvenance
                            key={idx}
                            formatted={content.figure.formatted}
                            provenance={
                              content.figure.snapshotPath === ""
                                ? null
                                : {
                                    snapshotPath: content.figure.snapshotPath,
                                    estimator: content.figure.estimator,
                                  }
                            }
                          />
                        )
                      )}
                    </CellTag>
                  )
                })}
              </tr>
            ))}
          </SectionTag>
        )
      })}
    </table>
  )
}

// --- Table parsing types ---

type CellContent =
  | { kind: "html"; html: string }
  | { kind: "figure"; figure: FigureData }

type ParsedCell = {
  tag: "td" | "th"
  attrs: Record<string, string>
  contents: CellContent[]
}

type ParsedRow = {
  attrs: Record<string, string>
  cells: ParsedCell[]
}

type ParsedSection = {
  tag: "thead" | "tbody" | "tfoot"
  rows: ParsedRow[]
}

type ParsedTable = {
  tableAttrs: Record<string, string>
  sections: ParsedSection[]
}

/** Extract attributes from an opening tag string. */
function extractAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const attrPattern = /([a-z][a-z0-9-]*)="([^"]*)"/gi
  for (const m of tag.matchAll(attrPattern)) {
    const name = m[1]
    // Skip class for now — we'll handle it specially if needed
    if (name === "class") {
      attrs.className = m[2]
    } else {
      // Convert data-* attributes to their camelCase equivalent for React
      attrs[name] = m[2]
    }
  }
  return attrs
}

/** Parse a scope attribute value — converts data-x-y to data-x-y (React allows this). */
function parseTableWithPlaceholders(tableHtml: string, figures: readonly FigureData[]): ParsedTable {
  // Use DOMParser approach — parse the table HTML into a real DOM tree
  // and walk it to extract the structure.
  //
  // This is NOT a second layout definition: it reads the emitter's markup
  // structurally to preserve its DOM hierarchy, rather than deciding what
  // that hierarchy should be. The structure comes from the emitter; this
  // code follows it.

  const parser = typeof DOMParser !== "undefined" ? new DOMParser() : null
  if (!parser) {
    // SSR fallback — shouldn't happen for this client component
    return { tableAttrs: {}, sections: [] }
  }

  const doc = parser.parseFromString(tableHtml, "text/html")
  const table = doc.querySelector("table")
  if (!table) {
    return { tableAttrs: {}, sections: [] }
  }

  const tableAttrs = domAttrsToReact(table)
  const sections: ParsedSection[] = []

  for (const child of table.children) {
    const tag = child.tagName.toLowerCase()
    if (tag !== "thead" && tag !== "tbody" && tag !== "tfoot") continue

    const rows: ParsedRow[] = []
    for (const tr of child.querySelectorAll(":scope > tr")) {
      const attrs = domAttrsToReact(tr)
      const cells: ParsedCell[] = []

      for (const cell of tr.children) {
        const cellTag = cell.tagName.toLowerCase()
        if (cellTag !== "td" && cellTag !== "th") continue

        const cellAttrs = domAttrsToReact(cell)
        const contents = parseCellContents(cell, figures)
        cells.push({ tag: cellTag as "td" | "th", attrs: cellAttrs, contents })
      }

      rows.push({ attrs, cells })
    }

    sections.push({ tag: tag as "thead" | "tbody" | "tfoot", rows })
  }

  return { tableAttrs, sections }
}

/** Convert a DOM element's attributes to a React-compatible props object. */
function domAttrsToReact(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const attr of el.attributes) {
    if (attr.name === "class") {
      attrs.className = attr.value
    } else if (attr.name === "scope") {
      attrs.scope = attr.value
    } else {
      // data-* attributes pass through as-is in React
      attrs[attr.name] = attr.value
    }
  }
  return attrs
}

/** Parse a cell's content, finding figure placeholders and returning mixed content. */
function parseCellContents(cell: Element, figures: readonly FigureData[]): CellContent[] {
  const contents: CellContent[] = []
  const placeholderPattern = new RegExp(
    `\uFFFDFIGURE\uFFFD(\\d+)`,
    "g"
  )

  // Get the cell's innerHTML and split on figure placeholders
  const cellHtml = cell.innerHTML

  // Check if there are any placeholders
  const matches = [...cellHtml.matchAll(placeholderPattern)]

  if (matches.length === 0) {
    // No figures — render the whole cell as HTML
    if (cellHtml.trim()) {
      contents.push({ kind: "html", html: cellHtml })
    }
    return contents
  }

  let cursor = 0
  for (const match of matches) {
    const start = match.index

    // Find the enclosing placeholder span
    // The placeholder is inside: <span class="rpt-figure" data-figure-placeholder="true">\0FIGURE\0N</span>
    // We need to find the opening tag before the placeholder text
    const beforePlaceholder = cellHtml.lastIndexOf("<span", start)
    const afterPlaceholder = cellHtml.indexOf("</span>", start) + "</span>".length

    if (beforePlaceholder > cursor) {
      const htmlBefore = cellHtml.slice(cursor, beforePlaceholder)
      if (htmlBefore.trim()) {
        contents.push({ kind: "html", html: htmlBefore })
      }
    }

    const figureIndex = parseInt(match[1], 10)
    if (figureIndex < figures.length) {
      contents.push({ kind: "figure", figure: figures[figureIndex] })
    }

    cursor = afterPlaceholder
  }

  if (cursor < cellHtml.length) {
    const remaining = cellHtml.slice(cursor)
    if (remaining.trim()) {
      contents.push({ kind: "html", html: remaining })
    }
  }

  return contents
}

export function PaperRender({
  html,
}: Readonly<{
  /** `reports/<runId>/document.html`, emitted during the run. */
  html: string
}>) {
  const segments = useMemo(() => splitOnFigures(html), [html])

  return (
    <div data-slot="paper-render" className="flex flex-col gap-2">
      <div
        data-slot="preview-label"
        className="sticky top-0 z-10 flex items-start gap-2 rounded-lg border border-border bg-background/95 px-3 py-2 backdrop-blur"
      >
        <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />

        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium">
            {PAPER_CLAIM === "approximation"
              ? "Reading view — an approximation of the delivered page"
              : "Reading view — a text extract"}
          </p>

          <p className="max-w-prose text-xs text-muted-foreground">
            {PAPER_CLAIM === "approximation" ? (
              <>
                This approximates {PREVIEW_DIVERGENCES[0]},{" "}
                {PREVIEW_DIVERGENCES[1]} and {PREVIEW_DIVERGENCES[2]}. The
                delivered result is the{" "}
                <code className="font-mono">.pdf</code> below. Hover or focus
                any figure to see where it came from.
              </>
            ) : (
              <>
                The delivered result is the{" "}
                <code className="font-mono">.pdf</code> below. Hover or focus
                any figure to see where it came from.
              </>
            )}
          </p>
        </div>
      </div>

      <div
        data-slot="paper-page"
        className="rpt-paper mx-auto w-full max-w-[52rem] rounded-xl border border-border bg-white px-10 py-12 text-black shadow-sm"
      >
        {segments.map((segment, index) =>
          segment.kind === "html" ? (
            <span
              key={index}
              dangerouslySetInnerHTML={{ __html: segment.html }}
            />
          ) : segment.kind === "figure" ? (
            <FigureProvenance
              key={index}
              formatted={segment.formatted}
              provenance={
                segment.snapshotPath === ""
                  ? null
                  : {
                      snapshotPath: segment.snapshotPath,
                      estimator: segment.estimator,
                    }
              }
            />
          ) : (
            <TableSegment
              key={index}
              tableHtml={segment.tableHtml}
              figures={segment.figures}
            />
          )
        )}
      </div>
    </div>
  )
}
