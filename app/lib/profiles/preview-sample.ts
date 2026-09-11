import type { DesignPreset } from "@/lib/templates/definition"

/**
 * The fixed sample every in-browser preview draws, and the faces it draws in.
 *
 * ## Why a sample at all
 *
 * A profile has no data until a run collects some, and the wizard is where a profile is
 * authored — so every preview drawn during authoring is necessarily drawn over something
 * that is not this profile's figures. The choice is between a sample that is declared as
 * one and a blank rectangle, and a blank rectangle tells a consultant nothing about the
 * theme they just picked.
 *
 * **Nothing here ever reaches a document.** The compiler takes figures from the ledger
 * and from nowhere else; these numbers exist to give a page shape while a consultant
 * chooses a colour. Every surface that renders them states that in visible text — see
 * `components/templates/document-preview.tsx`.
 *
 * ## Real numbers, not smooth ones
 *
 * The series is a real machine's August CPU, 31 daily points. The spread — a 27.3% peak
 * against a 0.19% average — is what makes the case for the stacked default; a smooth
 * invented curve showed six chart styles that all looked equally reasonable, which is
 * the one thing a style picker must not do.
 */

export const SAMPLE_MAX = [
  18.9, 10.6, 11.1, 5.2, 11.0, 9.7, 21.6, 8.4, 10.3, 10.2, 27.3, 11.8, 9.5,
  10.3, 10.2, 9.4, 10.2, 11.1, 13.4, 13.3, 13.9, 14.6, 7.4, 10.2, 12.8, 13.9,
  14.0, 24.5, 10.7, 8.9, 9.9,
] as const

export const SAMPLE_AVG = [
  0.19, 0.17, 0.17, 0.17, 0.18, 0.18, 0.2, 0.17, 0.16, 0.17, 0.18, 0.18, 0.19,
  0.19, 0.19, 0.18, 0.17, 0.17, 0.17, 0.18, 0.18, 0.17, 0.16, 0.17, 0.17, 0.17,
  0.18, 0.22, 0.18, 0.18, 0.19,
] as const

/**
 * The rows the sample table prints.
 *
 * Deliberately awkward figures. Round ones (50%, 4.0 GiB) read as placeholders and stop
 * a consultant judging whether the column widths hold — which is most of what they are
 * looking at.
 */
export const SAMPLE_ROWS = [
  { resource: "vm-app-prod-02", average: "12.48%", peak: "27.31%", memory: "3.21 GiB" },
  { resource: "vm-mcp-prod-01", average: "8.06%", peak: "19.74%", memory: "2.84 GiB" },
  { resource: "vm-sql-prod-01", average: "31.92%", peak: "68.15%", memory: "7.06 GiB" },
] as const

/** The three figures the sample KPI row carries, with their labels. */
export const SAMPLE_KPIS = [
  { label: "Virtual machines", value: "23" },
  { label: "Average CPU", value: "12.48%" },
  { label: "Available memory", value: "3.21 GiB" },
] as const

/**
 * The face each theme sets its body text in, as a browser stack.
 *
 * Declared once because two surfaces need it — step 5's chart cards and the document
 * preview beside them — and a preview drawn in a different face from the one next to it
 * is a preview of nothing. The stacks lead with the face the **runtime** carries, so what
 * a browser draws is what LibreOffice will.
 */
export const PRESET_FACES: Readonly<Record<DesignPreset, string>> = {
  editorial: '"Liberation Serif", "Times New Roman", Times, serif',
  technical: '"DejaVu Sans", "Helvetica Neue", Arial, sans-serif',
  corporate: '"Liberation Sans", Arial, Helvetica, sans-serif',
  minimal: '"Liberation Sans", Arial, Helvetica, sans-serif',
}
