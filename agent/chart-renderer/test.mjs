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

test("one historical observation is visible and carries its supplied exact label", () => {
  const spec = {
    ...base,
    style: "stacked",
    categories: ["Jul-26"],
    series: [{ ...base.series[0], values: ["79.88"], pointLabels: ["79.88%"] }],
  };
  const options = chartOptions(spec);
  assert.equal(options.series[0].showSymbol, true);
  assert.equal(options.series[0].endLabel.show, false);
  assert.equal(options.series[0].label.formatter({ dataIndex: 0 }), "79.88%");
  assert.equal(options.grid[0].left, options.grid[0].right);
  const svg = renderSVG(spec, false, init);
  assert(svg.includes("79.88%"));
  assert(svg.includes("circle") || svg.includes("path"));
});

test("a heatmap draws one row per resource and skips the days with no value", () => {
  const spec = {
    ...base,
    type: "heatmap",
    style: "heatmap",
    series: [
      { ...base.series[0], key: "a", label: "app-web-01", values: ["30", null, "45", "30"] },
      { ...base.series[1], key: "b", label: "app-api-02", values: ["1", "2", "3", null] },
    ],
  };
  const options = chartOptions(spec);
  assert.deepEqual(options.yAxis.data, ["app-web-01", "app-api-02"]);
  assert.equal(options.series[0].type, "heatmap");
  assert.equal(options.series[0].data.length, 6);
  const svg = renderSVG(spec, false, init);
  assert.match(svg, /app-web-01/);
  new Resvg(svg).render();
});

const rows = (type, series, extra = {}) => ({
  ...base,
  type,
  style: "stacked",
  categories: ["app-web-01", "app-api-02", "batch-worker-03"],
  series,
  ...extra,
});

test("a bar list keeps the ranking's order and labels each bar with its own figure", () => {
  const spec = rows(
    "bar_list",
    [{ ...base.series[0], values: ["97.2", "71.5", null], pointLabels: ["97.2%", "71.5%", null] }],
  );
  const options = chartOptions(spec);
  assert.deepEqual(options.yAxis.data, spec.categories);
  assert.equal(options.yAxis.inverse, true);
  assert.deepEqual(options.series[0].data, [97.2, 71.5, null]);
  assert.equal(options.series[0].label.formatter({ dataIndex: 1 }), "71.5%");
  const svg = renderSVG(spec, false, init);
  assert.match(svg, /97\.2%/);
  assert(!svg.includes("NaN"));
  new Resvg(svg).render();
});

test("a bullet draws P95 behind the average, a peak tick with its figure, and the threshold", () => {
  const spec = rows(
    "bullet",
    [
      { ...base.series[0], key: "avg", label: "Average", values: ["61.4", "38.9", "12.7"] },
      { ...base.series[0], key: "p95", label: "P95 (est.)", values: ["90.1", null, "40.2"] },
      { ...base.series[0], key: "max", label: "Peak", values: ["97.2", "71.5", "44"], pointLabels: ["97.2%", "71.5%", "44.0%"] },
    ],
    { threshold: 80, thresholdLabel: "Threshold 80%" },
  );
  const options = chartOptions(spec);
  assert.deepEqual(options.series.map((s) => s.name), ["p95", "avg", "max"]);
  assert.equal(options.series[0].barGap, "-100%");
  assert.equal(options.series[0].data[1], null); // no P95 is drawn as none, not zero
  assert.deepEqual(options.series[2].markLine.data, [{ xAxis: 80 }]);
  const svg = renderSVG(spec, false, init);
  assert.match(svg, /Threshold 80%/);
  assert.match(svg, /44\.0%/);
  new Resvg(svg).render();
});

test("a fleet mix splits each row in proportion and prints the counts, not the shares", () => {
  const spec = rows(
    "mix",
    [
      { ...base.series[0], key: "general", label: "General purpose", values: ["3", "1", null], pointLabels: ["3", "1", null] },
      { ...base.series[1], key: "stopped", label: "Stopped", values: ["1", null, "2"], pointLabels: ["1", null, "2"] },
    ],
    { categories: ["EC2 instances", "RDS databases", "Virtual machines"] },
  );
  const options = chartOptions(spec);
  assert.equal(options.series[0].data[0].value, 0.75);
  assert.equal(options.series[1].data[2].value, 1);
  assert.equal(options.series[0].data[2], null);
  assert.equal(options.series[0].label.formatter({ value: 0.75, dataIndex: 0 }), "3");
  const svg = renderSVG(spec, false, init);
  assert.match(svg, /General purpose/);
  assert(!svg.includes("0.75"));
  new Resvg(svg).render();
});

test("bars end rounded and the grid recedes", () => {
  const options = chartOptions({ ...base, type: "bar", style: "columns" });
  assert.deepEqual(options.series[0].itemStyle.borderRadius, [3, 3, 0, 0]);
  assert(options.yAxis[0].splitLine.lineStyle.opacity < 1);
  const hbar = chartOptions({ ...base, type: "hbar", style: "columns" });
  assert.deepEqual(hbar.series[0].itemStyle.borderRadius, [0, 3, 3, 0]);
});
