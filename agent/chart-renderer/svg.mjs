/** Shared by the profile selector and the production SVG/PNG renderer.
 * Every numeric operation below positions marks; displayed values arrive formatted.
 */
/** One row per resource, one cell per day, one colour scale from lowest to highest. */
function heatmapOptions(spec, compact) {
  const panel = spec.panels[0] ?? { label: "", unit: "", min: 0, max: 1 };
  const rows = spec.series.map((s) => s.label);
  const data = [];
  spec.series.forEach((s, y) =>
    s.values.forEach((v, x) => {
      if (v != null) data.push([x, y, Number(v)]);
    }),
  );
  const color = spec.series[0]?.color ?? "#2f3c7e";
  const format = (v) =>
    panel.unit === "percent" ? `${Number(v.toPrecision(3))}%` : String(Number(v.toPrecision(3)));
  return {
    animation: false,
    backgroundColor: "#ffffff",
    textStyle: { fontFamily: spec.font, color: spec.ink },
    grid: {
      left: compact ? 70 : 150,
      right: compact ? 10 : 24,
      top: compact ? 8 : 40,
      bottom: compact ? 18 : 30,
    },
    title: compact
      ? []
      : [
          {
            text: panel.label + " · " + (spec.yTitle || panel.unit),
            left: 8,
            top: 3,
            textStyle: { fontFamily: spec.font, fontSize: 12, fontWeight: 500, color: spec.ink },
          },
        ],
    xAxis: {
      type: "category",
      data: spec.categories,
      axisTick: { show: false },
      axisLine: { show: false },
      splitArea: { show: false },
      axisLabel: {
        fontSize: compact ? 8 : 10,
        color: spec.muted,
        fontFamily: spec.font,
        interval: Math.max(0, Math.ceil(spec.categories.length / 8) - 1),
        formatter: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v.slice(8) + "/" + v.slice(5, 7) : v),
      },
    },
    yAxis: {
      type: "category",
      data: rows,
      inverse: true,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        fontSize: compact ? 8 : 10,
        color: spec.ink,
        fontFamily: spec.font,
        width: compact ? 62 : 140,
        overflow: "truncate",
      },
    },
    visualMap: {
      min: panel.min,
      max: panel.max === panel.min ? panel.min + 1 : panel.max,
      show: !compact,
      orient: "horizontal",
      right: 24,
      top: 4,
      itemWidth: 10,
      itemHeight: 110,
      calculable: false,
      text: [format(panel.max), format(panel.min)],
      textStyle: { fontSize: 10, color: spec.muted, fontFamily: spec.font },
      inRange: { color: ["#f3f4f6", color] },
    },
    series: [
      {
        type: "heatmap",
        data,
        itemStyle: { borderColor: "#ffffff", borderWidth: 1 },
        emphasis: { disabled: true },
        animation: false,
      },
    ],
    graphic: data.length
      ? []
      : [
          {
            type: "text",
            left: "center",
            top: "middle",
            style: { text: spec.emptyLabel, fill: spec.muted, fontFamily: spec.font, fontSize: 12 },
          },
        ],
  };
}

/**
 * Average and peak per resource: one row each, a line from the average to the peak. Both
 * dots are plotted figures and the peak carries its own formatted value.
 */
function dumbbellOptions(spec, compact) {
  const panel = spec.panels[0] ?? { label: "", unit: "", min: 0, max: 1 };
  const [low, high] = spec.series;
  const rows = spec.categories;
  const joined = rows.flatMap((_, i) =>
    low?.values[i] != null && high?.values[i] != null ? [i] : [],
  );
  const tick = (v) =>
    panel.unit === "percent" ? `${Number(v.toPrecision(6))}%` : String(Number(v.toPrecision(6)));
  const dot = (s, size, labelled) => ({
    name: s.key,
    type: "scatter",
    symbolSize: size,
    z: 3,
    animation: false,
    itemStyle: { color: s.color },
    emphasis: { disabled: true },
    data: s.values.map((v, i) => (v == null ? null : [Number(v), i])),
    label: {
      show: labelled && !compact,
      position: "right",
      distance: 6,
      formatter: (p) => s.pointLabels?.[p.dataIndex] ?? "",
      fontFamily: spec.font,
      fontSize: 10,
      color: spec.ink,
    },
  });
  return {
    animation: false,
    backgroundColor: "#ffffff",
    textStyle: { fontFamily: spec.font, color: spec.ink },
    grid: { left: compact ? 70 : 150, right: compact ? 16 : 70, top: compact ? 8 : 40, bottom: compact ? 14 : 28 },
    title: compact
      ? []
      : [
          {
            text: panel.label + " · " + (spec.yTitle || panel.unit),
            left: 8,
            top: 3,
            textStyle: { fontFamily: spec.font, fontSize: 12, fontWeight: 500, color: spec.ink },
          },
        ],
    ...(compact || !low || !high
      ? {}
      : {
          legend: {
            top: 4,
            right: 8,
            icon: "circle",
            itemWidth: 8,
            itemHeight: 8,
            textStyle: { fontFamily: spec.font, fontSize: 11, color: spec.ink },
            data: [low.key, high.key],
            formatter: (name) => spec.series.find((s) => s.key === name)?.label ?? name,
          },
        }),
    xAxis: {
      type: "value",
      min: panel.min,
      max: panel.max,
      interval: (panel.max - panel.min) / 4,
      axisLabel: { fontSize: compact ? 8 : 10, color: spec.muted, fontFamily: spec.font, formatter: tick },
      splitLine: { show: spec.gridLines !== "none", lineStyle: { color: spec.rule, opacity: GRID_OPACITY } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "category",
      data: rows,
      inverse: true,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { fontSize: compact ? 8 : 10, color: spec.ink, fontFamily: spec.font, width: compact ? 62 : 140, overflow: "truncate" },
    },
    series:
      low && high
        ? [
            {
              type: "custom",
              silent: true,
              z: 1,
              animation: false,
              data: joined,
              renderItem: (params, api) => {
                const i = joined[params.dataIndex];
                const a = api.coord([Number(low.values[i]), i]);
                const b = api.coord([Number(high.values[i]), i]);
                return {
                  type: "line",
                  shape: { x1: a[0], y1: a[1], x2: b[0], y2: b[1] },
                  style: { stroke: low.color, lineWidth: compact ? 1.5 : 2.2 },
                };
              },
            },
            dot(low, compact ? 6 : 8, false),
            dot(high, compact ? 7 : 9, true),
          ]
        : [],
    graphic: rows.length
      ? []
      : [
          {
            type: "text",
            left: "center",
            top: "middle",
            style: { text: spec.emptyLabel, fill: spec.muted, fontFamily: spec.font, fontSize: 12 },
          },
        ],
  };
}

/** The title every row chart carries, top left, as the other charts set theirs. */
function rowTitle(spec, panel, compact) {
  return compact
    ? []
    : [
        {
          text: panel.label,
          left: 8,
          top: 3,
          textStyle: { fontFamily: spec.font, fontSize: 12, fontWeight: 500, color: spec.ink },
        },
      ];
}

function emptyGraphic(spec, empty) {
  return empty
    ? [
        {
          type: "text",
          left: "center",
          top: "middle",
          style: { text: spec.emptyLabel, fill: spec.muted, fontFamily: spec.font, fontSize: 12 },
        },
      ]
    : [];
}

const rowAxis = (spec, compact) => ({
  type: "category",
  data: spec.categories,
  inverse: true,
  axisTick: { show: false },
  axisLine: { show: false },
  axisLabel: {
    fontSize: compact ? 8 : 11,
    color: spec.ink,
    fontFamily: spec.font,
    width: compact ? 62 : 150,
    overflow: "truncate",
  },
});

/**
 * A bar list: one labelled bar per resource in the section's ranking order, on a pale track,
 * the figure at the bar's end.
 */
function barListOptions(spec, compact) {
  const panel = spec.panels[0] ?? { label: "", unit: "", min: 0, max: 1 };
  const s = spec.series[0];
  return {
    animation: false,
    backgroundColor: "#ffffff",
    textStyle: { fontFamily: spec.font, color: spec.ink },
    grid: { left: compact ? 70 : 170, right: compact ? 30 : 76, top: compact ? 6 : 34, bottom: compact ? 6 : 12 },
    title: rowTitle(spec, panel, compact),
    xAxis: { type: "value", min: 0, max: panel.max, show: false },
    yAxis: rowAxis(spec, compact),
    series: s
      ? [
          {
            type: "bar",
            data: s.values.map((v) => (v == null ? null : Number(v))),
            barWidth: compact ? 7 : 12,
            showBackground: true,
            backgroundStyle: { color: "#F1F2F4", borderRadius: 6 },
            itemStyle: { color: s.color, borderRadius: [0, 6, 6, 0] },
            emphasis: { disabled: true },
            animation: false,
            label: {
              show: !compact,
              position: "right",
              distance: 8,
              formatter: (p) => s.pointLabels?.[p.dataIndex] ?? "",
              fontFamily: spec.font,
              fontSize: 11,
              fontWeight: 600,
              color: spec.ink,
            },
          },
        ]
      : [],
    graphic: emptyGraphic(spec, !s || s.values.every((v) => v == null)),
  };
}

/**
 * A utilisation bullet per resource: the estimated P95 as a pale bar, the average as a dark
 * bar inside it, a tick at the peak with its figure, and the design's threshold as a line.
 */
function bulletOptions(spec, compact) {
  const panel = spec.panels[0] ?? { label: "", unit: "", min: 0, max: 1 };
  const [avg, p95, peak] = spec.series;
  const tick = (v) =>
    panel.unit === "percent" ? `${Number(v.toPrecision(6))}%` : String(Number(v.toPrecision(6)));
  const bar = (s, width, z) => ({
    name: s.key,
    type: "bar",
    data: s.values.map((v) => (v == null ? null : Number(v))),
    barWidth: width,
    barGap: "-100%",
    z,
    itemStyle: { color: s.color, borderRadius: [0, 3, 3, 0] },
    emphasis: { disabled: true },
    animation: false,
  });
  const series = [];
  if (p95) series.push(bar(p95, compact ? 9 : 16, 1));
  if (avg) series.push(bar(avg, compact ? 4 : 6, 2));
  if (peak)
    series.push({
      name: peak.key,
      type: "scatter",
      symbol: "rect",
      symbolSize: compact ? [2, 12] : [3, 22],
      z: 3,
      itemStyle: { color: spec.ink },
      emphasis: { disabled: true },
      animation: false,
      data: peak.values.map((v, i) => (v == null ? null : [Number(v), i])),
      label: {
        show: !compact,
        position: "right",
        distance: 6,
        formatter: (p) => peak.pointLabels?.[p.dataIndex] ?? "",
        fontFamily: spec.font,
        fontSize: 10,
        fontWeight: 600,
        color: spec.ink,
      },
      ...(spec.threshold != null && panel.unit === "percent" && !compact
        ? {
            markLine: {
              silent: true,
              symbol: "none",
              animation: false,
              data: [{ xAxis: spec.threshold }],
              lineStyle: { type: "dashed", color: "#B45309", width: 1.2 },
              label: {
                formatter: () => spec.thresholdLabel ?? "",
                position: "end",
                color: "#9A4507",
                fontFamily: spec.font,
                fontSize: 10,
              },
            },
          }
        : {}),
    });
  return {
    animation: false,
    backgroundColor: "#ffffff",
    textStyle: { fontFamily: spec.font, color: spec.ink },
    grid: { left: compact ? 70 : 170, right: compact ? 16 : 70, top: compact ? 8 : 48, bottom: compact ? 14 : 30 },
    title: rowTitle(spec, panel, compact),
    ...(compact
      ? {}
      : {
          legend: {
            top: 24,
            left: 8,
            icon: "roundRect",
            itemGap: 16,
            itemWidth: 12,
            itemHeight: 6,
            textStyle: { fontFamily: spec.font, fontSize: 10, color: spec.muted },
            data: spec.series.map((s) => s.key),
            formatter: (name) => spec.series.find((s) => s.key === name)?.label ?? name,
          },
        }),
    xAxis: {
      type: "value",
      min: 0,
      max: panel.max,
      interval: panel.max / 4,
      axisLabel: { fontSize: compact ? 8 : 10, color: spec.muted, fontFamily: spec.font, formatter: tick },
      splitLine: { show: true, lineStyle: { color: spec.rule, opacity: GRID_OPACITY } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: rowAxis(spec, compact),
    series,
    graphic: emptyGraphic(spec, spec.categories.length === 0),
  };
}

/**
 * A fleet mix: one bar per resource type, its parts side by side in proportion, each part
 * labelled with its count. Widths are positions only — each part's share of its row.
 */
function mixOptions(spec, compact) {
  const panel = spec.panels[0] ?? { label: "", unit: "", min: 0, max: 1 };
  const totals = spec.categories.map((_, i) =>
    spec.series.reduce((sum, s) => sum + (s.values[i] == null ? 0 : Number(s.values[i])), 0),
  );
  const last = spec.categories.map((_, i) => {
    let at = -1;
    spec.series.forEach((s, j) => {
      if (s.values[i] != null) at = j;
    });
    return at;
  });
  const first = spec.categories.map((_, i) => spec.series.findIndex((s) => s.values[i] != null));
  return {
    animation: false,
    backgroundColor: "#ffffff",
    textStyle: { fontFamily: spec.font, color: spec.ink },
    grid: { left: compact ? 60 : 130, right: compact ? 8 : 20, top: compact ? 6 : 34, bottom: compact ? 6 : 34 },
    title: rowTitle(spec, panel, compact),
    ...(compact
      ? {}
      : {
          legend: {
            bottom: 4,
            left: 8,
            icon: "roundRect",
            itemGap: 16,
            itemWidth: 12,
            itemHeight: 8,
            textStyle: { fontFamily: spec.font, fontSize: 10, color: spec.ink },
            data: spec.series.map((s) => s.key),
            formatter: (name) => spec.series.find((s) => s.key === name)?.label ?? name,
          },
        }),
    xAxis: { type: "value", min: 0, max: 1, show: false },
    yAxis: rowAxis(spec, compact),
    series: spec.series.map((s, j) => ({
      name: s.key,
      type: "bar",
      stack: "mix",
      barWidth: compact ? 12 : 24,
      data: s.values.map((v, i) =>
        v == null || !totals[i]
          ? null
          : {
              value: Number(v) / totals[i],
              itemStyle: {
                color: s.color,
                borderRadius: [first[i] === j ? 5 : 0, last[i] === j ? 5 : 0, last[i] === j ? 5 : 0, first[i] === j ? 5 : 0],
              },
            },
      ),
      itemStyle: { color: s.color, borderColor: "#ffffff", borderWidth: 1 },
      emphasis: { disabled: true },
      animation: false,
      label: {
        show: !compact,
        position: "inside",
        formatter: (p) => (p.value >= 0.06 ? s.pointLabels?.[p.dataIndex] ?? "" : ""),
        fontFamily: spec.font,
        fontSize: 11,
        fontWeight: 600,
        color: s.key === "other" ? spec.ink : "#ffffff",
      },
    })),
    graphic: emptyGraphic(spec, spec.series.length === 0),
  };
}

/** The shared look (C9): grid lines recede behind the data, bars end rounded. Tabular figures
 * need no feature switch, which resvg would not apply: every face a chart is set in (DejaVu,
 * Liberation Sans, IBM Plex, Source Sans and Serif) draws its digits at one width. */
const GRID_OPACITY = 0.55;
const BAR_RADIUS = 3;

/** The legend band a design asks for above or below the plot, inside `spec.height`. */
const LEGEND_SPACE = 24;

export function chartOptions(spec, compact = false) {
  if (spec.type === "heatmap") return heatmapOptions(spec, compact);
  if (spec.type === "dumbbell") return dumbbellOptions(spec, compact);
  if (spec.type === "bar_list") return barListOptions(spec, compact);
  if (spec.type === "bullet") return bulletOptions(spec, compact);
  if (spec.type === "mix") return mixOptions(spec, compact);
  const bare = spec.style === "sparkline";
  // A design's look. Every one is absent at its default, so a spec without them draws
  // exactly the chart it always drew: names and last values at the line ends, a light grid.
  const legend = compact ? undefined : spec.legend;
  const labelValues = spec.values === undefined || spec.values === "last";
  const legendTop = legend === "top" ? LEGEND_SPACE : 0;
  const panelHeight = (spec.height - (legend ? LEGEND_SPACE : 0)) / spec.panels.length;
  const grid = spec.panels.map((p, i) => ({
    left: compact ? 12 : 150,
    right: compact ? (bare ? 55 : 12) : !legend ? 150 : labelValues ? 70 : 24,
    top: i * panelHeight + (compact ? 9 : 36) + legendTop,
    height: panelHeight - (compact ? 18 : bare ? 50 : 79),
  }));
  const series = [];
  const axis = (p, index, category) =>
    category
      ? {
          type: "category",
          name: compact ? "" : spec.xTitle || "",
          nameLocation: "middle",
          nameGap: 25,
          gridIndex: index,
          data: spec.categories,
          boundaryGap: spec.type === "bar" || spec.style === "columns",
          show: !bare && !compact,
          axisTick: { show: false },
          axisLine: { show: false },
          ...(spec.gridLines === "full"
            ? { splitLine: { show: true, lineStyle: { color: spec.rule, opacity: GRID_OPACITY } } }
            : {}),
          axisLabel: {
            fontSize: 11,
            color: spec.muted,
            fontFamily: spec.font,
            hideOverlap: true,
            interval: Math.max(0, Math.ceil(spec.categories.length / 6) - 1),
            formatter: (v) =>
              /^\d{4}-\d{2}-\d{2}$/.test(v)
                ? v.slice(8) + "/" + v.slice(5, 7)
                : v,
          },
        }
      : {
          type: "value",
          gridIndex: index,
          min: p.min,
          max: p.max,
          show: !bare && !compact,
          interval: (p.max - p.min) / 4,
          splitNumber: 4,
          axisLabel: {
            fontSize: 11,
            color: spec.muted,
            fontFamily: spec.font,
            formatter: (v) =>
              p.unit === "percent"
                ? `${Number(v.toPrecision(6))}%`
                : String(Number(v.toPrecision(6))),
          },
          splitLine: { show: !bare && spec.gridLines !== "none", lineStyle: { color: spec.rule, opacity: GRID_OPACITY } },
          axisLine: { show: false },
          axisTick: { show: false },
        };
  const firstInPanel = new Set();
  for (const s of spec.series) {
    const bars =
      spec.type === "bar" || spec.type === "hbar" || spec.style === "columns";
    const panel = spec.panels[s.panel];
    const leads = !firstInPanel.has(s.panel);
    firstInPanel.add(s.panel);
    // A threshold is drawn once per percentage panel it falls inside, and named in words.
    const threshold =
      !compact && leads && spec.threshold != null && panel?.unit === "percent" &&
      spec.threshold >= panel.min && spec.threshold <= panel.max
        ? {
            markLine: {
              silent: true,
              symbol: "none",
              animation: false,
              data: [{ yAxis: spec.threshold }],
              lineStyle: { type: "dashed", color: "#B45309", width: 1.2 },
              label: {
                formatter: () => spec.thresholdLabel ?? "",
                position: "insideStartTop",
                color: "#9A4507",
                fontFamily: spec.font,
                fontSize: 10,
              },
            },
          }
        : {};
    // The peak: the series' highest plotted value, labelled with its own formatted figure.
    let peak = -1;
    if (spec.values === "peak" && !compact && !bars)
      s.values.forEach((v, i) => {
        if (v != null && (peak < 0 || Number(v) > Number(s.values[peak]))) peak = i;
      });
    const peakMark =
      peak >= 0
        ? {
            markPoint: {
              symbol: "circle",
              symbolSize: 7,
              silent: true,
              animation: false,
              itemStyle: { color: "#ffffff", borderColor: s.color, borderWidth: 1.6 },
              data: [{ coord: [peak, Number(s.values[peak])] }],
              label: {
                show: true,
                position: "top",
                formatter: () => s.pointLabels?.[peak] ?? "",
                fontFamily: spec.font,
                fontSize: 10,
                fontWeight: 600,
                color: spec.ink,
              },
            },
          }
        : {};
    const area =
      ["soft_area", "flat_area"].includes(spec.style) || spec.type === "area";
    series.push({
      name: s.key,
      type: bars ? "bar" : "line",
      xAxisIndex: s.panel,
      yAxisIndex: s.panel,
      data:
        !compact &&
        s.pointLabels &&
        s.values.filter((v) => v != null).length <= 6
          ? s.values.map((value, index) =>
              value == null
                ? null
                : {
                    value,
                    label: {
                      align:
                        index === 0
                          ? "left"
                          : index === s.values.length - 1
                            ? "right"
                            : "center",
                    },
                  },
            )
          : s.values,
      connectNulls: false,
      smooth: false,
      showSymbol: !compact && s.values.filter((v) => v != null).length <= 6,
      symbolSize: 7,
      label: {
        show:
          !compact && !bare && s.values.filter((v) => v != null).length <= 6,
        position: "top",
        formatter: (params) => s.pointLabels?.[params.dataIndex] ?? "",
        fontFamily: spec.font,
        color: spec.ink,
        fontSize: 11,
      },
      animation: false,
      barMaxWidth: 22,
      lineStyle: {
        width: compact ? 2 : (spec.lineWidth ?? 2.3),
        color: s.color,
        type: s.dashed ? "dashed" : "solid",
      },
      ...threshold,
      ...peakMark,
      // Rounded at the bar's free end only, so a bar still stands on its axis.
      itemStyle: bars
        ? { color: s.color, borderRadius: spec.type === "hbar" ? [0, BAR_RADIUS, BAR_RADIUS, 0] : [BAR_RADIUS, BAR_RADIUS, 0, 0] }
        : { color: s.color },
      emphasis: { disabled: true },
      ...(area && !bars
        ? {
            areaStyle: {
              opacity: 1,
              color:
                spec.style === "soft_area"
                  ? {
                      type: "linear",
                      x: 0,
                      y: 0,
                      x2: 0,
                      y2: 1,
                      colorStops: [
                        { offset: 0, color: s.color + "55" },
                        { offset: 1, color: s.color + "00" },
                      ],
                    }
                  : s.color + "25",
            },
          }
        : {}),
      ...(!bars && (!compact || bare)
        ? {
            endLabel: {
              show:
                (compact ||
                  bare ||
                  !s.pointLabels ||
                  s.values.filter((v) => v != null).length > 6) &&
                (!legend || labelValues),
              formatter: () =>
                !legend
                  ? labelValues
                    ? s.label + "\n" + s.last
                    : s.label
                  : s.last,
              fontSize: compact ? 8 : 10,
              fontFamily: spec.font,
              color: spec.ink,
              width: compact ? 50 : 135,
              overflow: "break",
            },
            labelLayout: { moveOverlap: "shiftY" },
          }
        : {}),
    });
  }
  // Shade only compiler-declared avg/max pairs. Both original lines remain present.
  if (spec.style === "range_band")
    for (const pair of spec.bands ?? []) {
      const lower = spec.series[pair.lower],
        upper = spec.series[pair.upper];
      let segment = [];
      const polygons = [];
      const flush = () => {
        if (segment.length > 1) polygons.push(segment);
        segment = [];
      };
      for (let i = 0; i < spec.categories.length; i++) {
        if (lower.values[i] == null || upper.values[i] == null) {
          flush();
          continue;
        }
        segment.push(i);
      }
      flush();
      for (const indexes of polygons)
        series.unshift({
          type: "custom",
          xAxisIndex: upper.panel,
          yAxisIndex: upper.panel,
          data: [0],
          silent: true,
          z: 0,
          animation: false,
          renderItem: (_params, api) => ({
            type: "polygon",
            shape: {
              points: [
                ...indexes.map((i) => api.coord([i, Number(upper.values[i])])),
                ...indexes
                  .toReversed()
                  .map((i) => api.coord([i, Number(lower.values[i])])),
              ],
            },
            style: { fill: upper.color, opacity: 0.16 },
          }),
        });
    }
  return {
    animation: false,
    backgroundColor: "#ffffff",
    textStyle: { fontFamily: spec.font, color: spec.ink },
    grid,
    title: compact
      ? []
      : spec.panels.map((p, i) => ({
          text:
            p.label +
            (bare
              ? ""
              : " · " +
                (spec.yTitle || p.unit) +
                (p.zoomed ? " (zoomed axis)" : "")),
          top: i * panelHeight + 3 + legendTop,
          left: 8,
          textStyle: {
            fontFamily: spec.font,
            fontSize: 12,
            fontWeight: 500,
            color: spec.ink,
          },
          subtextStyle: {
            fontFamily: spec.font,
            fontSize: 10,
            color: spec.muted,
          },
          itemGap: 3,
        })),
    xAxis: spec.panels.map((p, i) => axis(p, i, spec.type !== "hbar")),
    yAxis: spec.panels.map((p, i) => axis(p, i, spec.type === "hbar")),
    ...(legend
      ? {
          legend: {
            [legend === "top" ? "top" : "bottom"]: 2,
            left: 8,
            icon: "roundRect",
            itemWidth: 14,
            itemHeight: 4,
            textStyle: { fontFamily: spec.font, fontSize: 11, color: spec.ink },
            data: spec.series.map((s) => s.key),
            formatter: (name) => spec.series.find((s) => s.key === name)?.label ?? name,
          },
        }
      : {}),
    series,
    graphic: spec.series.length
      ? []
      : [
          {
            type: "text",
            left: "center",
            top: "middle",
            style: {
              text: spec.emptyLabel,
              fill: spec.muted,
              fontFamily: spec.font,
              fontSize: 12,
            },
          },
        ],
  };
}
export function renderSVG(spec, compact, init) {
  const chart = init(null, null, {
    renderer: "svg",
    ssr: true,
    width: spec.width,
    height: spec.height,
  });
  try {
    chart.setOption(chartOptions(spec, compact));
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}
