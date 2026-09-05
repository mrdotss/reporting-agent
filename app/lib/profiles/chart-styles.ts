import type { ChartFont, ChartStyle } from "@/lib/templates/definition"

/**
 * What each chart style is for, and what its SVG output costs — the copy and the
 * geometry the wizard's preview cards are built from.
 *
 * Pure and view-free so it can be tested without rendering: `chartPreviewPaths` takes two
 * series and returns coordinates, and a test can assert the shape of what it returns
 * rather than scraping an SVG string out of a DOM.
 *
 * **These previews are not the delivered chart.** The real one is drawn by matplotlib on
 * the runtime, from the figure ledger. This module draws a picture of a *shape* so a
 * consultant can choose one, and it never touches a figure.
 */

export type ChartStyleNote = {
  /** One sentence on what the style is for — not what it looks like. */
  readonly blurb: string
  /** Whether the SVG carries a bitmap. Only the gradient does. */
  readonly raster: boolean
  /** Roughly how much page height one chart costs, for comparing at a glance. */
  readonly height: string
}

export const CHART_STYLE_NOTES: Readonly<Record<ChartStyle, ChartStyleNote>> = {
  stacked: {
    blurb:
      "Maximum over Average, each on its own scale. The only shape that keeps a 0.19% average legible beside a 27% peak.",
    raster: false,
    height: "3.3 in",
  },
  soft_area: {
    blurb:
      "One metric under a gradient, with rounded joins. The only style whose fill is a bitmap inside the SVG.",
    raster: true,
    height: "2.1 in",
  },
  flat_area: {
    blurb:
      "The same shape with a flat tint instead of a gradient. Reads almost identically in print and stays fully vector.",
    raster: false,
    height: "2.1 in",
  },
  range_band: {
    blurb:
      "Maximum as the line, the span down to Average shaded behind it. One panel, and the spread is the point.",
    raster: false,
    height: "2.4 in",
  },
  columns: {
    blurb:
      "One bar per day. A missing day reads as a gap rather than a straight line between two points.",
    raster: false,
    height: "2.2 in",
  },
  sparkline: {
    blurb:
      "No axes — one row per resource with its last value. Shape only; exact figures stay in the table.",
    raster: false,
    height: "0.9 in",
  },
}

/**
 * The font stack each choice previews as, in the browser.
 *
 * The delivered chart is set in the family the **runtime** resolves — see
 * `render/chartstyle.py::chart_font_face`. These stacks name the same families first so a
 * preview and a delivered chart agree wherever the viewer happens to have them, and fall
 * back to a generic of the same class where they do not.
 */
export const CHART_FONT_STACKS: Readonly<Record<ChartFont, string>> = {
  document: '"Liberation Serif", "Times New Roman", Times, serif',
  grotesque: '"DejaVu Sans", "Helvetica Neue", Arial, sans-serif',
  monospace: '"DejaVu Sans Mono", ui-monospace, "Courier New", monospace',
}

const WIDTH = 236
const HEIGHT = 78

export type PreviewLine = {
  readonly points: string
  readonly width: number
  readonly dashed?: boolean
  readonly rounded?: boolean
  readonly opacity?: number
}

export type PreviewPaths = {
  readonly rules: readonly number[]
  readonly lines: readonly PreviewLine[]
  readonly fill?: string
  readonly bars?: readonly {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }[]
  readonly dot?: { readonly x: number; readonly y: number }
  readonly labels: readonly {
    readonly text: string
    readonly x: number
    readonly y: number
    readonly size: number
    readonly muted: boolean
  }[]
}

function polyline(
  values: readonly number[],
  { top, height, offsetY = 0, width = WIDTH }: {
    top: number
    height: number
    offsetY?: number
    width?: number
  }
): string {
  const last = values.length - 1
  return values
    .map((value, index) => {
      const x = (index * width) / last
      const y = offsetY + height - (value / top) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(" ")
}

/**
 * The geometry one preview card draws, for a style and a pair of series.
 *
 * `headroom` above the peak rather than a tight fit: a line that touches the top of its
 * own box reads as clipped, and every style shares the margin so six cards compare.
 */
export function chartPreviewPaths(
  style: ChartStyle,
  max: readonly number[],
  avg: readonly number[]
): PreviewPaths {
  const peak = Math.max(...max) * 1.25
  const lastMax = max[max.length - 1] ?? 0

  if (style === "stacked") {
    return {
      rules: [6, 40, 56, 78],
      lines: [
        { points: polyline(max, { top: peak, height: 40 }), width: 1.6 },
        {
          points: polyline(avg, {
            top: Math.max(...avg) * 1.25,
            height: 24,
            offsetY: 54,
          }),
          width: 1.4,
          dashed: true,
          opacity: 0.62,
        },
      ],
      labels: [],
    }
  }

  if (style === "columns") {
    const slot = WIDTH / max.length
    return {
      rules: [14, 46, 78],
      lines: [],
      bars: max.map((value, index) => {
        const barHeight = (value / peak) * 64
        return {
          x: index * slot + 1.2,
          y: 10 + 64 - barHeight,
          width: slot - 2.4,
          height: barHeight,
        }
      }),
      labels: [],
    }
  }

  if (style === "sparkline") {
    return {
      rules: [],
      lines: [
        {
          points: polyline(max, { top: peak, height: 18, offsetY: 12, width: 150 }),
          width: 1.5,
        },
        {
          points: polyline(avg, {
            top: Math.max(...avg) * 1.25,
            height: 18,
            offsetY: 46,
            width: 150,
          }),
          width: 1.5,
          opacity: 0.6,
        },
      ],
      labels: [
        { text: "Max", x: 160, y: 21, size: 8, muted: true },
        { text: "9.89%", x: 160, y: 30, size: 9, muted: false },
        { text: "Avg", x: 160, y: 55, size: 8, muted: true },
        { text: "0.19%", x: 160, y: 64, size: 9, muted: false },
      ],
    }
  }

  // The three single-panel styles share one line and differ only in what sits under it.
  const line = polyline(max, { top: peak, height: 64, offsetY: 10 })
  const base: PreviewPaths = {
    rules: [14, 46, 78],
    lines: [{ points: line, width: 1.9, rounded: true }],
    dot: { x: WIDTH, y: 10 + 64 - (lastMax / peak) * 64 },
    labels: [],
  }

  if (style === "range_band") {
    const below = polyline(avg, { top: peak, height: 64, offsetY: 10 })
    return {
      ...base,
      // A closed polygon: the maximum forward, the average back.
      fill: `${line} ${below.split(" ").reverse().join(" ")}`,
      lines: [
        { points: line, width: 1.7 },
        { points: below, width: 1.1, opacity: 0.5 },
      ],
      dot: undefined,
    }
  }

  return { ...base, fill: `0,74 ${line} ${WIDTH},74` }
}
