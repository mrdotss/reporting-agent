/**
 * The declared class names the HTML emitter writes — the TypeScript mirror of
 * `agent/src/reporting_agent/render/html.py`'s `EMITTED_CLASS_NAMES`.
 *
 * Compared by `app/test/mirror.static.test.ts` so the two sides cannot drift.
 * `app/test/paper-stylesheet.static.test.ts` asserts a rule exists in
 * `globals.css` for each of these names.
 *
 * `rpt-paper` is deliberately NOT in this collection — `paper-render.tsx` emits
 * it as its own wrapper; an extra stylesheet rule is never a failure and a
 * missing one is.
 */

// --- BEGIN EMITTED_CLASS_NAMES ---
export const EMITTED_CLASS_NAMES = [
  "rpt-document",
  "rpt-block",
  "rpt-break",
  "rpt-table",
  "rpt-row",
  "rpt-notice",
  "rpt-chart",
  "rpt-chart-period",
  "rpt-series-set",
  "rpt-series",
  "rpt-point",
  "rpt-figure",
  "rpt-column",
  "rpt-layout-row",
  "rpt-toc",
  "rpt-toc-list",
  "rpt-toc-entry",
] as const
// --- END EMITTED_CLASS_NAMES ---

export type EmittedClassName = (typeof EMITTED_CLASS_NAMES)[number]
