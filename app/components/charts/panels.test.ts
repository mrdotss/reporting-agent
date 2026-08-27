import { describe, expect, test } from "vitest"

import type { ChartSeries } from "@/components/charts/chart-spec"
import { PANEL_SPLIT_ORDER_OF_MAGNITUDE, panelGroups } from "@/components/charts/panels"

/** Mirrors `agent/tests/test_panel_groups.py`'s cases exactly, so a behavioral
 * drift between the two languages' `panel_groups` shows up as a failure on
 * whichever side changed rather than only in the cross-language mirror
 * guard's own, coarser equality check. */

function series(key: string, ...values: number[]): ChartSeries {
  return {
    key,
    label: key,
    points: values.map((value, index) => ({
      x: `x${index}`,
      value,
      formatted: String(value),
      snapshotPath: null,
    })),
  }
}

describe("panelGroups", () => {
  test("empty series array returns no panels", () => {
    expect(panelGroups([])).toEqual([])
  })

  test("a single series is one panel", () => {
    expect(panelGroups([series("cpu", 10, 20, 30)])).toEqual([["cpu"]])
  })

  test("series within one order of magnitude share a panel", () => {
    const result = panelGroups([series("a", 90), series("b", 15)])
    expect(result).toHaveLength(1)
    expect(new Set(result[0])).toEqual(new Set(["a", "b"]))
  })

  test("series ten times apart split into separate panels", () => {
    const result = panelGroups([series("small", 1), series("big", 10)])
    expect(result).toHaveLength(2)
  })

  test("panels are ordered by descending maximum", () => {
    const result = panelGroups([series("small", 1), series("big", 1000)])
    expect(result[0]).toEqual(["big"])
    expect(result[1]).toEqual(["small"])
  })

  test("three series at three scales produce three panels in order", () => {
    const result = panelGroups([
      series("hundreds", 500),
      series("units", 5),
      series("tens_of_thousands", 50000),
    ])
    expect(result).toEqual([["tens_of_thousands"], ["hundreds"], ["units"]])
  })

  test("negative values group by absolute magnitude", () => {
    const result = panelGroups([series("positive", 95), series("negative", -90)])
    expect(result).toHaveLength(1)
    expect(new Set(result[0])).toEqual(new Set(["positive", "negative"]))
  })

  test("a series with no points has zero magnitude and groups rather than errors", () => {
    const empty = series("empty")
    const result = panelGroups([series("cpu", 50), empty])
    expect(result.reduce((n, g) => n + g.length, 0)).toBe(2)
    expect(new Set(result.flat())).toEqual(new Set(["cpu", "empty"]))
  })

  test("two all-zero series share one panel rather than each splitting", () => {
    const result = panelGroups([series("zero-a", 0, 0), series("zero-b", 0)])
    expect(result).toHaveLength(1)
    expect(new Set(result[0])).toEqual(new Set(["zero-a", "zero-b"]))
  })

  test("a zero series beside a nonzero one does not crash on the ratio", () => {
    const result = panelGroups([series("nonzero", 42), series("zero", 0)])
    expect(result.reduce((n, g) => n + g.length, 0)).toBe(2)
  })

  test("exactly at the order-of-magnitude threshold still splits", () => {
    const result = panelGroups([series("big", 100), series("small", 10)])
    expect(result).toHaveLength(2)
  })

  test("just under the threshold stays together", () => {
    const result = panelGroups([series("big", 99), series("small", 10)])
    expect(result).toHaveLength(1)
  })

  test("the threshold constant is 10", () => {
    expect(PANEL_SPLIT_ORDER_OF_MAGNITUDE).toBe(10)
  })
})
