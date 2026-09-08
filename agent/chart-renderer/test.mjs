import { init } from "echarts";
import test from "node:test";
import assert from "node:assert/strict";
import { chartOptions, renderSVG } from "./svg.mjs";
import { Resvg } from "@resvg/resvg-js";
const base = {
  type: "line",
  width: 720,
  height: 250,
  font: "Liberation Sans",
  ink: "#222222",
  muted: "#666666",
  rule: "#dddddd",
  emptyLabel: "No observations",
  categories: ["a", "b", "c", "d"],
  panels: [{ label: "CPU", unit: "percent", min: 0, max: 100 }],
  series: [
    {
      key: "max",
      label: "Max",
      last: "30.00%",
      panel: 0,
      color: "#167583",
      dashed: false,
      values: ["30", null, "45", "30"],
    },
    {
      key: "avg",
      label: "Avg",
      last: "2.00%",
      panel: 0,
      color: "#678e94",
      dashed: true,
      values: ["1", null, "3", "2"],
    },
  ],
  bands: [{ lower: 1, upper: 0 }],
};
for (const style of [
  "stacked",
  "soft_area",
  "flat_area",
  "range_band",
  "columns",
  "sparkline",
])
  test(style + " exports vector and raster from identical SVG", () => {
    const spec = { ...base, style };
    const svg = renderSVG(spec, false, init);
    assert(svg.startsWith("<svg"));
    assert(!svg.includes("<image"));
    assert(!svg.includes("NaN"));
    assert(
      new Resvg(svg)
        .render()
        .asPng()
        .subarray(0, 4)
        .equals(Buffer.from([137, 80, 78, 71])),
    );
    const options = chartOptions(spec);
    assert.equal(options.animation, false);
    for (const series of options.series.filter((s) => s.type !== "custom")) {
      assert.equal(series.data[1], null);
      assert.equal(series.connectNulls, false);
      assert.equal(series.smooth, false);
    }
    if (style === "range_band")
      assert.equal(options.series.filter((s) => s.type === "custom").length, 1);
    if (style === "soft_area") assert(svg.includes("linearGradient"));
  });
