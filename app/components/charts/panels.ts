import type { ChartSeries } from "@/components/charts/chart-spec"

/**
 * Chart panelling: how `series` splits across stacked panels by magnitude
 * (Requirement 17.1, 17.2, task 5.1).
 *
 * `agent/src/reporting_agent/compile/ast.py#panel_groups` computes the same
 * split, at compile time, over `Figure.value`'s decimal string — that is the
 * authoritative assignment the compiler writes into `Chart.panels`, which
 * this app is expected to read once task 5.4 wires it in (`parseChartFigure`
 * reading a `data-panels` attribute the emitter would need to add).
 *
 * **This function exists for `agent/tests/test_chartstyle.py`'s mirror guard,
 * ahead of that wiring** — Requirement 17.2's "mirror the thresholds into
 * `app/components/charts/`" is about the threshold agreeing across languages
 * before either side is finished consuming it, the same discipline
 * `PANEL_SPLIT_ORDER_OF_MAGNITUDE` alone would not enforce: a constant with
 * no function around it is a number nobody has proven behaves the same way
 * twice. Task 5.4 is the point at which the app actually calls this against
 * a real chart's parsed spec instead of a compile-time decision it already
 * trusts.
 *
 * Pure, deterministic, and reads only `ChartSeries.key` and each point's
 * `value` (the parsed geometry number — see `chart-spec.ts`'s own note on why
 * that number is layout-only and never displayed; it is exactly as
 * appropriate for a grouping decision as it is inappropriate for a label).
 */

export const PANEL_SPLIT_ORDER_OF_MAGNITUDE = 10
/** Mirrors `_PANEL_SPLIT_ORDER_OF_MAGNITUDE` in `compile/ast.py`. Two series
 * whose maximum absolute values differ by this factor or more split panels. */

function seriesMaxAbs(series: ChartSeries): number {
  let max = 0
  for (const point of series.points) {
    const magnitude = Math.abs(point.value)
    if (Number.isFinite(magnitude) && magnitude > max) max = magnitude
  }
  return max
}

/**
 * Split `series` into stacked panels by magnitude — the TypeScript mirror of
 * `panel_groups` in `compile/ast.py`. See that function's own docstring for
 * the full reasoning; the two must stay behaviourally identical, which is
 * what `test_chartstyle.py`'s mirror guard exists to catch a drift in.
 */
export function panelGroups(
  series: readonly ChartSeries[]
): readonly (readonly string[])[] {
  if (series.length === 0) return []

  const withMax = series
    .map((entry) => ({ key: entry.key, max: seriesMaxAbs(entry) }))
    .sort((a, b) => b.max - a.max)

  const groups: string[][] = [[withMax[0]!.key]]
  const groupMaxima: number[] = [withMax[0]!.max]

  for (const { max, key } of withMax.slice(1)) {
    const currentMax = groupMaxima[groupMaxima.length - 1]!
    let splits = (max === 0 || currentMax === 0) && max !== currentMax
    if (!splits && currentMax !== 0) {
      splits = currentMax / max >= PANEL_SPLIT_ORDER_OF_MAGNITUDE
    }
    if (splits) {
      groups.push([key])
      groupMaxima.push(max)
    } else {
      groups[groups.length - 1]!.push(key)
    }
  }

  return groups
    .map((group, index) => ({ group, max: groupMaxima[index]! }))
    .sort((a, b) => b.max - a.max)
    .map(({ group }) => group)
}
