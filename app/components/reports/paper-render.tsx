"use client"

import { useMemo } from "react"
import { InfoIcon } from "@phosphor-icons/react"

import { FigureProvenance } from "@/components/reports/figure-provenance"
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
 */

/** The class `render/html.py` marks every figure with. */
const FIGURE_CLASS = "rpt-figure"

/** Where the value came from. The emitter raises rather than omit this. */
const SNAPSHOT_PATH_ATTRIBUTE = "data-snapshot-path"

/** Present only where the value is an estimate (Requirement 38.3). */
const ESTIMATOR_ATTRIBUTE = "data-estimator-label"

type Segment =
  | { readonly kind: "html"; readonly html: string }
  | {
      readonly kind: "figure"
      readonly formatted: string
      readonly snapshotPath: string
      readonly estimator: string | null
    }

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

/**
 * Split emitted HTML into markup runs and figure slots.
 *
 * A regex over one element shape rather than a DOM parse, and the trade is
 * deliberate: `DOMParser` would give a tree this component then has to walk and
 * re-serialize, which is a second rendering of the emitter's output and exactly
 * the "layout definition of its own" Requirement 38.1 forbids. Matching the
 * figure element and passing everything between matches through untouched keeps
 * this file ignorant of every other tag.
 *
 * **This is the risky part of the file**, and worth naming: it treats the
 * emitter's output as a string. The dependency is narrow — the figure element's
 * shape, nothing else about the markup — but it is real, and if the emitter
 * changes how it marks a figure this stops finding them. It does not degrade
 * silently: an unmatched rendering shows the figures as plain text with no
 * reveal, which is visibly wrong rather than subtly wrong.
 */
export function splitOnFigures(html: string): readonly Segment[] {
  // The class value is a space-separated token list, so the match requires
  // `rpt-figure` bounded by a quote or a space on both sides. `\b` is **not**
  // sufficient and the difference is not academic: `-` is a non-word character,
  // so `\brpt-figure\b` matches inside `rpt-figure-caption` and would turn a
  // caption into a figure slot with no snapshot path — which then renders as
  // "provenance unavailable" on a piece of chrome that never had any.
  const pattern = new RegExp(
    `<span[^>]*class="(?:[^"]*\\s)?${FIGURE_CLASS}(?:\\s[^"]*)?"[^>]*>([\\s\\S]*?)</span>`,
    "g"
  )

  const segments: Segment[] = []
  let cursor = 0

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
      // Requirement 38.3 — absent for an exact value, and the emitter omits the
      // attribute entirely in that case rather than writing an empty one. So
      // `null` here means "not an estimate", which is exactly what the reveal
      // needs to decide whether to show a caveat at all.
      estimator: attribute(element, ESTIMATOR_ATTRIBUTE),
    })

    cursor = start + element.length
  }

  if (cursor < html.length) {
    segments.push({ kind: "html", html: html.slice(cursor) })
  }

  return segments
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
            Reading view — an approximation of the page
          </p>

          <p className="max-w-prose text-xs text-muted-foreground">
            This approximates {PREVIEW_DIVERGENCES[0]}, {PREVIEW_DIVERGENCES[1]}{" "}
            and {PREVIEW_DIVERGENCES[2]}. The delivered result is the{" "}
            <code className="font-mono">.pdf</code> below. Hover or focus any
            figure to see where it came from.
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
              // The emitter's markup, passed through. Escaping is
              // `render/html.py`'s — see `paper-preview.tsx`'s note, which
              // applies identically here.
              dangerouslySetInnerHTML={{ __html: segment.html }}
            />
          ) : (
            <FigureProvenance
              key={index}
              formatted={segment.formatted}
              provenance={
                // Requirement 38.8 — a figure whose element carries no snapshot
                // path reveals that provenance is unavailable, with nothing
                // composed to fill the gap, and its `formatted` string is
                // presented unchanged. The emitter raises rather than produce
                // one, so reaching this means the markup was not the emitter's.
                segment.snapshotPath === ""
                  ? null
                  : {
                      snapshotPath: segment.snapshotPath,
                      estimator: segment.estimator,
                    }
              }
            />
          )
        )}
      </div>
    </div>
  )
}
