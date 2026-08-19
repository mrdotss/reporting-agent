"use client"

import { useMemo } from "react"

import { assignSeries, cssVar } from "@/components/charts/categorical"
import type { ChartSpec } from "@/components/charts/chart-spec"
import {
  SEQUENTIAL_STROKE_SAFE,
  type MarkerShape,
} from "@/components/charts/palette"

/**
 * A chart drawn client-side from the structured spec (Requirement 22).
 *
 * **No image and no presigned URL** (Requirement 22.7). The agent's static PNG
 * belongs in the `.docx`, where a browser is not available to draw one; in the
 * app the chart is drawn from the data, so it follows the viewer's theme and the
 * figures under it are the same figures the companion table shows.
 *
 * ## What is drawn from what
 *
 * - **Geometry** from the decimal string, parsed by `chart-spec.ts`.
 * - **Every displayed value label** from the ledger's `formatted` string,
 *   printed verbatim.
 *
 * Requirement 22.7 draws that line and it is the product invariant in miniature:
 * a chart that printed `value.toFixed(2)` beside a mark would be composing a
 * numeric string, and the string it composed would differ from the one the
 * verifier matched — a chart is the one surface where re-deriving a label looks
 * completely harmless.
 *
 * ## Nothing is distinguished by colour alone
 *
 * Requirement 22.8. Each series carries a **direct label** at the end of its
 * line, a **marker shape** at every point, and a **dash pattern** on the stroke.
 * A legend keyed only by swatch would fail a greyscale print and a deuteranopic
 * reader; the palette's measured CVD margins are the backstop, not the guarantee.
 *
 * ## The text alternative is the figures, as a table
 *
 * Requirement 22.10. The `<figure>` this renders **inside** already contains the
 * emitter's own series markup — that is where the spec was read from — so the
 * table alternative is not a second rendering of the data. This component adds
 * the drawing; the data island stays in the DOM beneath it, visually hidden and
 * available to assistive technology and to a text-only view.
 */

const WIDTH = 720
const HEIGHT = 260
const PADDING = { top: 16, right: 96, bottom: 28, left: 48 }

const PLOT_WIDTH = WIDTH - PADDING.left - PADDING.right
const PLOT_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom

/** One marker, centred on `(x, y)`. Shapes rather than sizes, so all read equally. */
function Marker({
  shape,
  x,
  y,
  token,
}: Readonly<{ shape: MarkerShape; x: number; y: number; token: string }>) {
  const fill = cssVar(token)
  const r = 3.5

  switch (shape) {
    case "square":
      return (
        <rect x={x - r} y={y - r} width={r * 2} height={r * 2} fill={fill} />
      )
    case "triangle":
      return (
        <polygon
          points={`${x},${y - r} ${x + r},${y + r} ${x - r},${y + r}`}
          fill={fill}
        />
      )
    case "diamond":
      return (
        <polygon
          points={`${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`}
          fill={fill}
        />
      )
    case "cross":
      return (
        <path
          d={`M${x - r},${y - r} L${x + r},${y + r} M${x + r},${y - r} L${x - r},${y + r}`}
          stroke={fill}
          strokeWidth={2}
        />
      )
    default:
      return <circle cx={x} cy={y} r={r} fill={fill} />
  }
}

export function ThemedChart({
  spec,
  theme = "light",
}: Readonly<{
  spec: ChartSpec
  /**
   * Which stroke-safe ramp to draw a sequential chart from.
   *
   * Only the sequential encoding needs it: `SEQUENTIAL_STROKE_SAFE` differs by
   * theme because the ramp is reversed in `globals.css`, so the steps that clear
   * 3:1 against the surface are at opposite ends. The categorical tokens are
   * defined for both themes under the same names, so a categorical chart needs
   * no branch at all.
   */
  theme?: "light" | "dark"
}>) {
  const styles = useMemo(
    () => assignSeries(spec.series.map((series) => series.key)),
    [spec.series]
  )

  const plotted = spec.series.filter((series) => series.points.length > 0)

  // Requirement 3.7's shape, applied to a chart: an empty result is stated
  // rather than drawn as an empty grid, which reads as a chart that failed.
  //
  // Defensive, and worded not to guess *why*. A chart figure reaching here has a
  // spec but no plottable point, and this component cannot tell an empty scope
  // from absent data — the compiler makes that distinction upstream and emits a
  // notice table instead of a chart, with its own text for each case. Claiming
  // one of them here would be the same false statement the compiler was fixed to
  // stop making.
  if (plotted.length === 0) {
    return (
      <p data-slot="chart-empty" className="text-sm text-muted-foreground">
        This chart carries no plottable values.
      </p>
    )
  }

  const values = plotted
    .flatMap((series) => series.points.map((point) => point.value))
    .filter((value) => Number.isFinite(value))

  const max = values.length === 0 ? 1 : Math.max(...values)
  const min = values.length === 0 ? 0 : Math.min(0, Math.min(...values))
  const span = max - min || 1

  const longest = Math.max(...plotted.map((series) => series.points.length))

  const xFor = (index: number) =>
    PADDING.left + (longest <= 1 ? 0 : (index / (longest - 1)) * PLOT_WIDTH)

  const yFor = (value: number) =>
    PADDING.top + PLOT_HEIGHT - ((value - min) / span) * PLOT_HEIGHT

  const sequentialTokens = SEQUENTIAL_STROKE_SAFE[theme]

  return (
    <svg
      data-slot="themed-chart"
      data-encoding={spec.encoding}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      // The figures beneath this SVG are the accessible alternative
      // (Requirement 22.10), so the drawing itself is decorative to a reader.
      role="img"
      aria-label={`${spec.title}. The figures are listed in the table below.`}
      className="w-full"
    >
      {/* A baseline, in a border token rather than `--destructive` (Req 22.13). */}
      <line
        x1={PADDING.left}
        y1={yFor(min)}
        x2={PADDING.left + PLOT_WIDTH}
        y2={yFor(min)}
        stroke="var(--border)"
        strokeWidth={1}
      />

      {plotted.map((series, seriesIndex) => {
        // Requirement 22.12 — the palette follows the **encoding**, never the
        // series count. A sequential chart plots one ordered quantity, so its
        // series walk the ramp; a categorical chart's series are peers and take
        // the hash-assigned slot that keeps a resource one colour report-wide.
        const style = styles.get(series.key)
        const token =
          spec.encoding === "sequential"
            ? (sequentialTokens[
                Math.min(seriesIndex, sequentialTokens.length - 1)
              ] ?? sequentialTokens[0]!)
            : (style?.token ?? "--cat-other")

        const finite = series.points
          .map((point, index) => ({ point, index }))
          .filter(({ point }) => Number.isFinite(point.value))

        // A gap rather than a zero: an unparseable value plotted at the baseline
        // is a claim the data does not make.
        const path = finite
          .map(
            ({ point, index }, position) =>
              `${position === 0 ? "M" : "L"}${xFor(index)},${yFor(point.value)}`
          )
          .join(" ")

        const last = finite.at(-1)

        return (
          <g key={series.key} data-series-key={series.key}>
            <path
              d={path}
              fill="none"
              stroke={cssVar(token)}
              strokeWidth={2}
              // Requirement 22.8 — a second channel on the stroke itself.
              strokeDasharray={style?.dash === "0" ? undefined : style?.dash}
            />

            {finite.map(({ point, index }) => (
              <Marker
                key={`${series.key}-${index}`}
                shape={style?.marker ?? "circle"}
                x={xFor(index)}
                y={yFor(point.value)}
                token={token}
              />
            ))}

            {/*
              The direct label (Requirement 22.8), at the end of the line rather
              than in a legend — a legend makes the reader match a swatch to a
              name, which is the matching a colour-blind reader cannot do.
            */}
            {last === undefined ? null : (
              <text
                x={xFor(last.index) + 8}
                y={yFor(last.point.value) + 4}
                fill={cssVar(token)}
                className="text-[11px]"
              >
                {series.label}
              </text>
            )}
          </g>
        )
      })}

      {/*
        Value labels on the extremes only. Every point labelled is unreadable at
        this width, and the two a reader actually looks for are the peak and the
        trough — both printed from `formatted`, never from `value`.
      */}
      {plotted.map((series) => {
        const finite = series.points
          .map((point, index) => ({ point, index }))
          .filter(({ point }) => Number.isFinite(point.value))

        if (finite.length === 0) return null

        const peak = finite.reduce((held, candidate) =>
          candidate.point.value > held.point.value ? candidate : held
        )

        return (
          <text
            key={`${series.key}-peak`}
            data-slot="value-label"
            x={xFor(peak.index)}
            y={yFor(peak.point.value) - 8}
            textAnchor="middle"
            className="fill-foreground font-mono text-[10px] tabular-nums"
          >
            {/* Requirement 22.7 — the ledger's string, verbatim. */}
            {peak.point.formatted}
          </text>
        )
      })}
    </svg>
  )
}
