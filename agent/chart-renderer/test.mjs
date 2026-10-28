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

test("a bar list keeps the ranking's order, names each bar inside its track and prints its own figure", () => {
  const spec = rows(
    "bar_list",
    [{ ...base.series[0], values: ["97.2", "71.5", null], pointLabels: ["97.2%", "71.5%", null], shades: ["#111111", "#222222", "#333333"] }],
  );
  const options = chartOptions(spec);
  assert.deepEqual(options.yAxis.data, spec.categories);
  assert.equal(options.yAxis.inverse, true);
  assert.deepEqual(options.series[0].data.map((d) => d && d.value), [97.2, 71.5, null]);
  assert.equal(options.series[0].data[1].itemStyle.color, "#222222"); // a step paler down the ranking
  assert.equal(options.series[0].label.formatter({ dataIndex: 1 }), "app-api-02");
  assert.equal(options.yAxis.axisLabel.formatter("app-api-02", 1), "71.5%");
  assert.equal(options.series[0].showBackground, true);
  const svg = renderSVG(spec, false, init);
  assert.match(svg, /97\.2%/);
  assert.match(svg, /app-web-01/);
  assert(!svg.includes("NaN"));
  new Resvg(svg).render();
});

test("a bullet draws P95 behind the average, a peak tick, the threshold on every row, and says which is which", () => {
  const spec = rows(
    "bullet",
    [
      { ...base.series[0], key: "avg", label: "Average", values: ["61.4", "38.9", "12.7"] },
      { ...base.series[0], key: "p95", label: "P95 (est.)", values: ["90.1", null, "40.2"] },
      { ...base.series[0], key: "max", label: "Peak", values: ["97.2", "71.5", "44"], pointLabels: ["97.2%", "71.5%", "44.0%"] },
    ],
    { threshold: 80, thresholdLabel: "Threshold", legendText: "Dark = average · orange = 80% line" },
  );
  const options = chartOptions(spec);
  assert.deepEqual(options.series.map((s) => s.name), ["p95", "avg", "threshold", "max"]);
  assert.equal(options.series[0].barGap, "-100%");
  assert.equal(options.series[0].data[1], null); // no P95 is drawn as none, not zero
  assert.deepEqual(options.series[2].data, [[80, 0], [80, 1], [80, 2]]);
  assert.equal(options.yAxis[1].axisLabel.formatter("", 2), "44.0%");
  const svg = renderSVG(spec, false, init);
  assert.match(svg, /orange = 80% line/);
  assert.match(svg, /44\.0%/);
  new Resvg(svg).render();
});

test("a fleet mix splits each row in proportion and prints the counts, not the shares", () => {
  const spec = rows(
    "mix",
    [
      { ...base.series[0], key: "general", label: "general purpose", values: ["3", "1", null], pointLabels: ["3", "1", null] },
      { ...base.series[1], key: "stopped", label: "stopped", values: ["1", null, "2"], pointLabels: ["1", null, "2"] },
    ],
    { categories: ["EC2 instances", "RDS databases", "Virtual machines"] },
  );
  const options = chartOptions(spec);
  const parts = options.graphic.filter((g) => g.type === "rect");
  assert.equal(parts.length, 4); // two parts, one, one: a part holding none is left out
  assert.equal(Math.round(parts[0].shape.width / parts[1].shape.width), 3);
  const svg = renderSVG(spec, false, init);
  assert.match(svg, /general purpose/);
  assert.match(svg, /EC2 instances/);
  assert(!svg.includes("0.75"));
  new Resvg(svg).render();
});

test("KPI tiles print each figure and its change as given, and draw a sparkline from the days", () => {
  const spec = {
    ...base,
    type: "tiles",
    style: "tiles",
    height: 172,
    accent: "#2b3a7a",
    title: "Key figures",
    subtitle: "change since the previous report",
    tiles: [
      { label: "Peak CPU", value: "88.00%", resource: "web-01", change: { text: "4.20 pts", direction: "up", ink: "#7a4a0c" }, note: "", spark: ["10", "30", "20"] },
      { label: "Average CPU", value: "41.00%", resource: "web-01", change: null, note: "No earlier report", spark: [] },
    ],
  };
  const options = chartOptions(spec);
  const lines = options.graphic.filter((g) => g.type === "polyline");
  assert.equal(lines.length, 1); // a tile with no days draws no line
  assert.equal(lines[0].shape.points.length, 3);
  assert.equal(options.graphic.filter((g) => g.type === "polygon").length, 1); // the one change's mark
  const svg = renderSVG(spec, false, init);
  for (const text of ["88.00%", "4.20 pts", "No earlier report", "web-01", "Peak CPU"]) assert(svg.includes(text), text);
  assert(!svg.includes("NaN"));
  new Resvg(svg).render();
});

test("bars end rounded and the grid recedes", () => {
  const options = chartOptions({ ...base, type: "bar", style: "columns" });
  assert.deepEqual(options.series[0].itemStyle.borderRadius, [3, 3, 0, 0]);
  assert(options.yAxis[0].splitLine.lineStyle.opacity < 1);
  const hbar = chartOptions({ ...base, type: "hbar", style: "columns" });
  assert.deepEqual(hbar.series[0].itemStyle.borderRadius, [0, 3, 3, 0]);
});

test("small multiples draw one panel per resource on one shared scale, each with its peak", () => {
  const spec = {
    ...base,
    type: "multiples",
    style: "multiples",
    height: 232,
    columns: 4,
    series: ["web-01", "api-02", "batch-01", "worker-03", "cache-01"].map((name, i) => ({
      ...base.series[0],
      key: name,
      label: name,
      values: ["10", String(20 + i * 10), null, "15"],
      pointLabels: ["10%", `${20 + i * 10}%`, null, "15%"],
    })),
  };
  const options = chartOptions(spec);
  assert.equal(options.grid.length, 5);
  assert(options.yAxis.every((axis) => axis.max === 100));
  assert.equal(options.grid[4].top > options.grid[0].top, true); // the fifth wraps to a second row
  const svg = renderSVG(spec, false, init);
  assert.match(svg, /cache-01/);
  assert.match(svg, /60%/);
  new Resvg(svg).render();
});

test("an annotated line marks the incidents on their days beside the threshold", () => {
  const spec = {
    ...base,
    type: "annotated",
    style: "stacked",
    categories: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
    threshold: 80,
    thresholdLabel: "Threshold",
    markers: [{ x: "2026-09-03", label: "INC-1042 disk full" }, { x: "2026-10-01", label: "outside" }],
  };
  const options = chartOptions(spec);
  const lines = options.series[0].markLine.data;
  assert.deepEqual(lines.map((d) => d.xAxis ?? `y${d.yAxis}`), ["y80", "2026-09-03"]);
  const svg = renderSVG(spec, false, init);
  assert.match(svg, /INC-1042 disk full/);
  assert.match(svg, /Threshold/);
  assert(!svg.includes("outside"));
  new Resvg(svg).render();
});
