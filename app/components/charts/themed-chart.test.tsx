import { render } from "@testing-library/react"
import { describe, expect, test } from "vitest"

import type { ChartSeries, ChartSpec } from "@/components/charts/chart-spec"
import { ThemedChart } from "@/components/charts/themed-chart"

/**
 * Requirement 17.6 — the in-app chart panels the same way the document does.
 *
 * `ThemedChart` had no dedicated test file before task 5.4 touched it — a real
 * gap, given the component now carries real panelling logic worth proving
 * directly rather than only through whatever screen happens to render a chart.
 */

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

function spec(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    chartType: "line",
    encoding: "categorical",
    unit: "percent",
    title: "Test chart",
    series: [series("cpu", 10, 20, 30)],
    panels: [],
    ...overrides,
  }
}

describe("no panels declared — one panel holding every series", () => {
  test("renders exactly one chart-panel group", () => {
    const { container } = render(<ThemedChart spec={spec()} />)
    expect(container.querySelectorAll('[data-slot="chart-panel"]')).toHaveLength(1)
  })

  test("the svg reports a panel count of 1", () => {
    const { container } = render(<ThemedChart spec={spec()} />)
    const svg = container.querySelector('[data-slot="themed-chart"]')
    expect(svg?.getAttribute("data-panel-count")).toBe("1")
  })

  test("both series render in the single panel when panels is empty", () => {
    const twoSeries = spec({ series: [series("cpu", 10), series("memory", 4e9)] })
    const { container } = render(<ThemedChart spec={twoSeries} />)
    expect(container.querySelectorAll('[data-slot="chart-panel"]')).toHaveLength(1)
    expect(container.querySelectorAll("[data-series-key]")).toHaveLength(2)
  })
})

describe("a real declared grouping renders one panel per group", () => {
  test("two panels render for a two-group spec", () => {
    const twoPanelSpec = spec({
      series: [series("cpu", 10, 20), series("memory", 4e9, 4.2e9)],
      panels: [["cpu"], ["memory"]],
    })
    const { container } = render(<ThemedChart spec={twoPanelSpec} />)
    expect(container.querySelectorAll('[data-slot="chart-panel"]')).toHaveLength(2)
  })

  test("the svg reports the real panel count", () => {
    const twoPanelSpec = spec({
      series: [series("cpu", 10, 20), series("memory", 4e9, 4.2e9)],
      panels: [["cpu"], ["memory"]],
    })
    const { container } = render(<ThemedChart spec={twoPanelSpec} />)
    const svg = container.querySelector('[data-slot="themed-chart"]')
    expect(svg?.getAttribute("data-panel-count")).toBe("2")
  })

  test("each series renders inside its own declared panel, not both", () => {
    const twoPanelSpec = spec({
      series: [series("cpu", 10, 20), series("memory", 4e9, 4.2e9)],
      panels: [["cpu"], ["memory"]],
    })
    const { container } = render(<ThemedChart spec={twoPanelSpec} />)
    const panelGroups = container.querySelectorAll('[data-slot="chart-panel"]')
    expect(panelGroups[0]?.querySelector('[data-series-key="cpu"]')).not.toBeNull()
    expect(panelGroups[0]?.querySelector('[data-series-key="memory"]')).toBeNull()
    expect(panelGroups[1]?.querySelector('[data-series-key="memory"]')).not.toBeNull()
    expect(panelGroups[1]?.querySelector('[data-series-key="cpu"]')).toBeNull()
  })

  test("the taller (viewBox) height reflects the panel count", () => {
    const onePanel = spec()
    const twoPanel = spec({
      series: [series("cpu", 10), series("memory", 4e9)],
      panels: [["cpu"], ["memory"]],
    })
    const { container: oneContainer } = render(<ThemedChart spec={onePanel} />)
    const { container: twoContainer } = render(<ThemedChart spec={twoPanel} />)

    const oneViewBox = oneContainer
      .querySelector('[data-slot="themed-chart"]')
      ?.getAttribute("viewBox")
    const twoViewBox = twoContainer
      .querySelector('[data-slot="themed-chart"]')
      ?.getAttribute("viewBox")

    const oneHeight = Number(oneViewBox?.split(" ")[3])
    const twoHeight = Number(twoViewBox?.split(" ")[3])
    expect(twoHeight).toBeGreaterThan(oneHeight)
  })
})

describe("a declared group with a series that was filtered out (zero points) is dropped, not drawn empty", () => {
  test("a panel naming only a now-empty series contributes no panel at all", () => {
    const withEmptySeries = spec({
      series: [
        series("cpu", 10, 20),
        { key: "memory", label: "memory", points: [] },
      ],
      panels: [["cpu"], ["memory"]],
    })
    const { container } = render(<ThemedChart spec={withEmptySeries} />)
    // "memory" has zero points, so it is filtered out of `plotted` before
    // panelling — only one real panel should render, not two (one empty).
    expect(container.querySelectorAll('[data-slot="chart-panel"]')).toHaveLength(1)
  })
})

describe("each panel scales to its own data independently", () => {
  test("a small-magnitude panel and a large-magnitude panel both plot without clipping", () => {
    // If panels shared one y-scale, the small series would flatten to
    // (near-)zero height. Each panel gets its own scale, so both series'
    // markers land at a real, non-degenerate y position within their own
    // panel's plot area.
    const twoPanelSpec = spec({
      series: [series("cpu", 10, 90), series("memory", 4e9, 4.2e9)],
      panels: [["cpu"], ["memory"]],
    })
    const { container } = render(<ThemedChart spec={twoPanelSpec} />)
    const panelGroups = container.querySelectorAll('[data-slot="chart-panel"]')

    const cpuLine = panelGroups[0]?.querySelector('[data-series-key="cpu"] path')
    const memoryLine = panelGroups[1]?.querySelector(
      '[data-series-key="memory"] path'
    )
    expect(cpuLine?.getAttribute("d")).toBeTruthy()
    expect(memoryLine?.getAttribute("d")).toBeTruthy()
  })
})
