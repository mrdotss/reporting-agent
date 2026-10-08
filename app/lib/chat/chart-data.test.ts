import { describe, expect, test } from "vitest"

import {
  asTrend,
  chartCsv,
  chartFactIds,
  csvName,
  niceCeil,
  resourceLabel,
  statMark,
  tickLabel,
  ticks,
  trendDays,
  valueScale,
  withResourceLabels,
} from "@/lib/chat/chart-data"
import { answerFigures } from "@/lib/chat/figures"
import type { ChatChart, ChatTrendChart } from "@/lib/chat/views"

const TREND: ChatTrendChart = {
  id: "c1",
  kind: "trend",
  title: "Daily average CPU",
  unit: "percent",
  source: "mixed",
  series: [
    {
      fact_id: "f1",
      label: "vm-a",
      source: "verified",
      points: [
        { day: "2026-08-02", value: "6.2", formatted: "6.20%" },
        { day: "2026-08-01", value: "4.1", formatted: "4.10%" },
      ],
    },
    {
      fact_id: "f2",
      label: "vm-b, live",
      source: "live",
      points: [{ day: "2026-08-03", value: "8.9", formatted: "8.90%" }],
    },
  ],
}

const SPREAD: ChatChart = {
  id: "c2",
  kind: "spread",
  title: "CPU headroom",
  unit: "percent",
  source: "verified",
  rows: [
    {
      label: "vm-a",
      source: "verified",
      stats: [
        { fact_id: "f3", statistic: "avg", value: "5.15", formatted: "5.15%" },
        { fact_id: "f4", statistic: "max", value: "27.4", formatted: "27.40%" },
      ],
    },
  ],
}

describe("chart data", () => {
  test("chartFactIds names the facts each kind draws", () => {
    expect(chartFactIds(TREND)).toEqual(["f1", "f2"])
    expect(chartFactIds(SPREAD)).toEqual(["f3", "f4"])
    expect(
      chartFactIds({
        id: "c",
        kind: "stats",
        title: "",
        source: "verified",
        tiles: [
          {
            fact_id: "f9",
            label: "x",
            formatted: "1",
            source: "verified",
            points: [],
          },
        ],
      })
    ).toEqual(["f9"])
  })

  test("a legacy daily chart becomes a trend with no fact behind its line", () => {
    const trend = asTrend({
      id: "c",
      kind: "daily",
      title: "t",
      unit: "percent",
      source: "live",
      series_label: "vm",
      points: [{ day: "2026-08-01", value: "1", formatted: "1.00%" }],
    })
    expect(trend?.series).toEqual([
      {
        fact_id: "",
        label: "vm",
        source: "live",
        points: [{ day: "2026-08-01", value: "1", formatted: "1.00%" }],
      },
    ])
    expect(
      chartFactIds({
        id: "c",
        kind: "daily",
        title: "",
        unit: "",
        source: "verified",
        series_label: "",
        points: [],
      })
    ).toEqual([])
  })

  test("trend days are every series' days, in order", () => {
    expect(trendDays(TREND)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"])
  })

  test("the scale tops out at a round number", () => {
    expect(niceCeil(12.4)).toBe(20)
    expect(niceCeil(31.7)).toBe(50)
    expect(niceCeil(0)).toBe(1)
    expect(niceCeil(230)).toBe(250)
    expect(ticks(20)).toEqual([0, 5, 10, 15, 20])
    expect(tickLabel(5, "percent")).toBe("5%")
    expect(tickLabel(2500000, "bytes")).toBe("2.5M")
  })

  test("statistics map to marks", () => {
    expect(statMark("avg")).toBe("hollow")
    expect(statMark("p95")).toBe("filled")
    expect(statMark("max")).toBe("tick")
    expect(statMark("sum")).toBe("diamond")
  })

  test("the CSV carries the runtime's decimals and says which column is live", () => {
    expect(chartCsv(TREND)).toBe(
      'day,"vm-a (%, verified)","vm-b, live (%, live)"\n2026-08-01,4.1,\n2026-08-02,6.2,\n2026-08-03,,8.9\n'
    )
    expect(chartCsv(SPREAD)).toBe(
      "machine,statistic,value (%),source\nvm-a,avg,5.15,verified\nvm-a,max,27.4,verified\n"
    )
    expect(csvName("Daily average CPU — August")).toBe(
      "daily-average-cpu-august.csv"
    )
    expect(csvName("")).toBe("chart.csv")
  })
})

describe("figures that appear only in a chart", () => {
  test("are numbered after the text's, in the order the charts draw them", () => {
    const figures = answerFigures(
      "vm-a ran at ⟦fig:f3⟧5.15%⟦/fig⟧.",
      {
        f1: { fact_id: "f1", source: "report", label: "a", formatted: "1.00%" },
        f3: { fact_id: "f3", source: "report", label: "b", formatted: "5.15%" },
        f4: {
          fact_id: "f4",
          source: "report",
          label: "c",
          formatted: "27.40%",
        },
      },
      [SPREAD, TREND]
    )
    expect(figures.map((f) => [f.number, f.factId, f.text])).toEqual([
      [1, "f3", "5.15%"],
      [2, "f4", "27.40%"],
      [3, "f1", "1.00%"],
      [4, "f2", ""],
    ])
  })
})

describe("valueScale", () => {
  test("bytes whose figures read in GiB get a GiB axis with round marks", () => {
    const scale = valueScale("bytes", 211029208, ["0.19 GiB", "0.20 GiB"])
    expect(scale.top).toBeCloseTo(0.2 * 2 ** 30)
    expect(ticks(scale.top).map(scale.label)).toEqual([
      "0 GiB",
      "0.05 GiB",
      "0.1 GiB",
      "0.15 GiB",
      "0.2 GiB",
    ])
  })

  test("bytes stored before points read in GiB still get a binary unit, not 250M", () => {
    const scale = valueScale("bytes", 211029208, ["211,029,208.0 bytes"])
    expect(scale.top).toBe(250 * 2 ** 20)
    expect(scale.label(scale.top)).toBe("250 MiB")
  })

  test("percent and plain units keep their scale", () => {
    expect(valueScale("percent", 72).top).toBe(100)
    expect(valueScale("percent", 12.4).label(20)).toBe("20%")
    expect(valueScale("count", 230).top).toBe(250)
  })
})

describe("resourceLabel", () => {
  test("an ARN or an Azure id reads as the resource's own name", () => {
    expect(
      resourceLabel(
        "arn:aws:rds:ap-southeast-1:123456789012:db:da-rds-postgres · FreeableMemory · avg"
      )
    ).toBe("da-rds-postgres · FreeableMemory · avg")
    expect(
      resourceLabel("arn:aws:ec2:ap-southeast-1:123456789012:instance/i-0abc")
    ).toBe("i-0abc")
    expect(
      resourceLabel(
        "/subscriptions/s/resourceGroups/g/providers/Microsoft.Compute/virtualMachines/vm-01 · Percentage CPU"
      )
    ).toBe("vm-01 · Percentage CPU")
    expect(resourceLabel("cpn-app · Percentage CPU · avg")).toBe(
      "cpn-app · Percentage CPU · avg"
    )
  })

  test("a stored daily chart's series label is shortened, its figures untouched", () => {
    const daily: ChatChart = {
      id: "c2",
      kind: "daily",
      title: "Daily average freeable memory",
      unit: "bytes",
      source: "verified",
      series_label:
        "arn:aws:rds:ap-southeast-1:123456789012:db:da-rds-postgres · FreeableMemory · avg",
      points: [
        { day: "2026-09-15", value: "204010946.0", formatted: "0.19 GiB" },
      ],
    }
    const short = withResourceLabels(daily)
    expect(short.kind === "daily" && short.series_label).toBe(
      "da-rds-postgres · FreeableMemory · avg"
    )
    expect(short.kind === "daily" && short.points).toEqual(daily.points)
  })
})
