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
  // The hour-of-week grid: small rounded cells with gaps, an hour per column, and a line of
  // words under it in place of a colour scale.
  const week = Boolean(spec.week);
  const format = (v) =>
    panel.unit === "percent" ? `${Number(v.toPrecision(3))}%` : String(Number(v.toPrecision(3)));
  return {
    animation: false,
    backgroundColor: "#ffffff",
    textStyle: { fontFamily: spec.font, color: spec.ink },
    grid: {
      left: compact ? 70 : week ? 48 : 150,
      right: compact ? 10 : 24,
      top: compact ? 8 : week ? 32 : 40,
      bottom: compact ? 18 : week ? 44 : 30,
    },
    title: compact
      ? []
      : [
          {
            text: week ? panel.label : panel.label + " · " + (spec.yTitle || panel.unit),
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
        interval: week ? 5 : Math.max(0, Math.ceil(spec.categories.length / 8) - 1),
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
      show: !compact && !week,
      orient: "horizontal",
      right: 24,
      top: 4,
      itemWidth: 10,
      itemHeight: 110,
      calculable: false,
      text: [format(panel.max), format(panel.min)],
      textStyle: { fontSize: 10, color: spec.muted, fontFamily: spec.font },
      inRange: { color: [week ? "#f1f3f9" : "#f3f4f6", color] },
    },
    series: [
      {
        type: "heatmap",
        data,
        itemStyle: { borderColor: "#ffffff", borderWidth: week ? 2.5 : 1.5, borderRadius: week ? 3 : 2 },
        emphasis: { disabled: true },
        animation: false,
      },
    ],
    graphic: data.length
      ? compact ? [] : legendLine(spec, spec.legendText)
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
 * A bar list: one bar per resource in the section's ranking order, each inside a pale track
 * with the resource's name set in it, busiest darkest, and the figure past the track's end.
 */
function barListOptions(spec, compact) {
  const panel = spec.panels[0] ?? { label: "", unit: "", min: 0, max: 1 };
  const s = spec.series[0];
  const track = mixWhite(spec.accent ?? s?.color ?? "#2b3a7a", 0.95);
  return {
    animation: false,
    backgroundColor: "#ffffff",
    textStyle: { fontFamily: spec.font, color: spec.ink },
    grid: { left: 8, right: compact ? 34 : 78, top: compact ? 4 : 34, bottom: compact ? 4 : 8 },
    title: rowTitle(spec, panel, compact),
    xAxis: { type: "value", min: 0, max: panel.max, show: false },
    yAxis: {
      type: "category",
      data: spec.categories,
      inverse: true,
      position: "right",
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        show: !compact,
        margin: 12,
        align: "left",
        fontSize: 12,
        fontWeight: 600,
        color: spec.ink,
        fontFamily: spec.font,
        formatter: (_value, index) => s?.pointLabels?.[index] ?? "",
      },
    },
    series: s
      ? [
          {
            type: "bar",
            data: s.values.map((v, i) =>
              v == null ? null : { value: Number(v), itemStyle: { color: s.shades?.[i] ?? s.color } },
            ),
            barWidth: compact ? 10 : 26,
            showBackground: true,
            backgroundStyle: { color: track, borderRadius: 6 },
            itemStyle: { color: s.color, borderRadius: 6 },
            emphasis: { disabled: true },
            animation: false,
            label: {
              show: !compact,
              position: "insideLeft",
              distance: 10,
              formatter: (p) => spec.categories[p.dataIndex] ?? "",
              fontFamily: spec.mono ?? spec.font,
              fontSize: 11,
              color: spec.ink,
            },
          },
        ]
      : [],
    graphic: emptyGraphic(spec, !s || s.values.every((v) => v == null)),
  };
}

/** `hex` stepped toward white by `amount`, for a shade of the accent. */
function mixWhite(hex, amount) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return "#" + c.map((v) => Math.round(v + (255 - v) * amount).toString(16).padStart(2, "0")).join("");
}

const THRESHOLD_INK = "#c2410c";

/** A muted line of words under a chart: what its marks mean. */
function legendLine(spec, text) {
  return text
    ? [
        {
          type: "text",
          left: 8,
          bottom: 6,
          style: { text, fill: spec.muted, fontFamily: spec.font, fontSize: 10 },
        },
      ]
    : [];
}

/**
 * A utilisation bullet per resource: a grey track, the estimated P95 pale along it, the
 * average dark inside that, a tick at the peak with its figure at the row's end, and the
 * threshold as a short orange mark on every row. A line of words says which is which.
 */
function bulletOptions(spec, compact) {
  const panel = spec.panels[0] ?? { label: "", unit: "", min: 0, max: 1 };
  const [avg, p95, peak] = spec.series;
  const width = compact ? 5 : 8;
  const bar = (s, z) => ({
    name: s.key,
    type: "bar",
    data: s.values.map((v) => (v == null ? null : Number(v))),
    barWidth: width,
    barGap: "-100%",
    z,
    itemStyle: { color: s.color, borderRadius: width / 2 },
    emphasis: { disabled: true },
    animation: false,
  });
  const series = [];
  if (p95) series.push({ ...bar(p95, 1), showBackground: true, backgroundStyle: { color: "#eef0f1", borderRadius: width / 2 } });
  if (avg) series.push(bar(avg, 2));
  const threshold = spec.threshold != null && panel.unit === "percent" ? spec.threshold : null;
  if (threshold != null)
    series.push({
      name: "threshold",
      type: "scatter",
      symbol: "rect",
      symbolSize: compact ? [1.5, 10] : [2, 16],
      z: 3,
      silent: true,
      itemStyle: { color: THRESHOLD_INK },
      emphasis: { disabled: true },
      animation: false,
      data: spec.categories.map((_, i) => [threshold, i]),
    });
  if (peak)
    series.push({
      name: peak.key,
      type: "scatter",
      symbol: "rect",
      symbolSize: compact ? [2, 10] : [2.5, 16],
      z: 4,
      itemStyle: { color: spec.ink },
      emphasis: { disabled: true },
      animation: false,
      data: peak.values.map((v, i) => (v == null ? null : [Number(v), i])),
    });
  return {
    animation: false,
    backgroundColor: "#ffffff",
    textStyle: { fontFamily: spec.font, color: spec.ink },
    grid: { left: compact ? 70 : 150, right: compact ? 16 : 78, top: compact ? 6 : 34, bottom: compact ? 6 : 30 },
    title: rowTitle(spec, panel, compact),
    xAxis: { type: "value", min: 0, max: panel.max, show: false },
    yAxis: [
      { ...rowAxis(spec, compact), axisLabel: { ...rowAxis(spec, compact).axisLabel, fontFamily: spec.mono ?? spec.font } },
      {
        type: "category",
        data: spec.categories,
        inverse: true,
        position: "right",
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: {
          show: !compact,
          margin: 12,
          align: "left",
          fontSize: 11,
          fontWeight: 600,
          color: spec.ink,
          fontFamily: spec.font,
          formatter: (_value, index) => peak?.pointLabels?.[index] ?? "",
        },
      },
    ],
    series,
    graphic: [
      ...emptyGraphic(spec, spec.categories.length === 0),
      ...(compact ? [] : legendLine(spec, spec.legendText)),
    ],
  };
}

/**
 * A fleet mix: per resource type, one bar of its parts side by side in proportion, then a
 * line naming each part with its count ("14 general purpose"). Widths are positions only.
 */
function mixOptions(spec, compact) {
  const panel = spec.panels[0] ?? { label: "", unit: "", min: 0, max: 1 };
  const top = compact ? 4 : 30;
  const rowHeight = compact ? 30 : 64;
  const barHeight = compact ? 10 : 22;
  const left = 8;
  const width = spec.width - 16;
  const graphic = compact ? [] : [...rowTitle(spec, panel, compact).map((t) => ({ type: "text", left: t.left, top: t.top, style: { text: t.text, fill: spec.ink, fontFamily: spec.font, fontSize: 12, fontWeight: 500 } }))];
  const rich = {
    n: { fontWeight: 700, fontSize: 11, fontFamily: spec.font, color: spec.ink },
    t: { fontSize: 11, fontFamily: spec.font, color: spec.muted },
    g: { width: 6 },
    w: { width: 22 },
  };
  spec.series.forEach((s, j) => {
    rich[`c${j}`] = { width: 8, height: 8, backgroundColor: s.color, borderRadius: 2 };
  });
  spec.categories.forEach((category, i) => {
    const y = top + i * rowHeight + (spec.categories.length > 1 && !compact ? 16 : 0);
    if (spec.categories.length > 1 && !compact)
      graphic.push({ type: "text", left, top: y - 16, style: { text: category, fill: spec.muted, fontFamily: spec.font, fontSize: 10 } });
    const parts = spec.series.map((s, j) => ({ j, s, v: s.values[i] == null ? 0 : Number(s.values[i]) })).filter((p) => p.v > 0);
    const total = parts.reduce((sum, p) => sum + p.v, 0);
    const gap = 2;
    let x = left;
    const usable = width - gap * Math.max(0, parts.length - 1);
    parts.forEach((p, k) => {
      const w = total ? (usable * p.v) / total : 0;
      graphic.push({
        type: "rect",
        shape: { x, y, width: Math.max(w, 1), height: barHeight, r: [k === 0 ? 6 : 0, k === parts.length - 1 ? 6 : 0, k === parts.length - 1 ? 6 : 0, k === 0 ? 6 : 0] },
        style: { fill: p.s.color },
      });
      x += w + gap;
    });
    if (!compact && parts.length)
      graphic.push({
        type: "text",
        left,
        top: y + barHeight + 10,
        style: {
          text: parts.map((p) => `{c${p.j}|}{g|}{n|${p.s.pointLabels?.[i] ?? ""}}{g|}{t|${p.s.label}}`).join("{w|}"),
          rich,
          fontFamily: spec.font,
          fontSize: 11,
        },
      });
  });
  if (!spec.series.length) graphic.push(...emptyGraphic(spec, true));
  return { animation: false, backgroundColor: "#ffffff", textStyle: { fontFamily: spec.font, color: spec.ink }, graphic };
}

/**
 * Small multiples: one card per resource in a grid, every panel on the one shared scale, so a
 * taller shape is a busier resource. Each card names its resource, prints its peak's own
 * figure and, on a percentage scale, draws the threshold dashed. A resource measured on one
 * day draws a dot, since a line needs two.
 */
function multiplesOptions(spec, compact) {
  const panel = spec.panels[0] ?? { label: "", unit: "", min: 0, max: 1 };
  const columns = Math.max(1, spec.columns ?? 4);
  const top = compact ? 4 : 30;
  const gapX = compact ? 6 : 12;
  const gapY = compact ? 6 : 12;
  const pad = compact ? 4 : 10;
  const head = compact ? 0 : 20;
  const cellW = (spec.width - 16 - gapX * (columns - 1)) / columns;
  const rows = Math.max(1, Math.ceil(spec.series.length / columns));
  const cellH = (spec.height - top - 8 - gapY * (rows - 1)) / rows;
  const threshold = spec.threshold != null && panel.unit === "percent" ? spec.threshold : null;
  const grid = [], xAxis = [], yAxis = [], series = [], graphic = [];
  const title = compact ? [] : [rowTitle(spec, panel, compact)[0]];
  spec.series.forEach((s, i) => {
    const left = 8 + (i % columns) * (cellW + gapX);
    const y = top + Math.floor(i / columns) * (cellH + gapY);
    graphic.push({
      type: "rect",
      z: -1,
      shape: { x: left, y, width: cellW, height: cellH, r: compact ? 4 : 8 },
      style: { fill: "#ffffff", stroke: "#e6eaee", lineWidth: 1 },
    });
    grid.push({ left: left + pad, top: y + pad + head, width: cellW - pad * 2, height: cellH - pad * 2 - head });
    const single = s.values.filter((v) => v != null).length === 1;
    xAxis.push({ type: "category", gridIndex: i, data: spec.categories, show: false, boundaryGap: single });
    yAxis.push({ type: "value", gridIndex: i, min: 0, max: panel.max, show: false, splitLine: { show: false } });
    let peak = -1;
    s.values.forEach((v, j) => {
      if (v != null && (peak < 0 || Number(v) > Number(s.values[peak]))) peak = j;
    });
    series.push({
      name: s.key, type: "line", xAxisIndex: i, yAxisIndex: i, data: s.values, connectNulls: false,
      smooth: false, showSymbol: single, symbol: "circle", symbolSize: compact ? 4 : 6, animation: false,
      emphasis: { disabled: true },
      lineStyle: { width: compact ? 1.2 : 1.6, color: s.color }, itemStyle: { color: s.color },
      areaStyle: { color: s.color, opacity: 0.1 },
      ...(threshold != null && !compact
        ? {
            markLine: {
              silent: true, symbol: "none", animation: false, label: { show: false },
              lineStyle: { color: "#e8b4a0", type: "dashed", width: 1 },
              data: [{ yAxis: threshold }],
            },
          }
        : {}),
    });
    if (!compact) {
      title.push({
        text: s.label, left: left + pad, top: y + pad - 1,
        textStyle: { fontFamily: spec.mono ?? spec.font, fontSize: 10, color: spec.ink, width: cellW - pad * 2 - 54, overflow: "truncate" },
      });
      if (peak >= 0)
        title.push({
          text: s.pointLabels?.[peak] ?? "", left: left + cellW - pad, top: y + pad - 1, textAlign: "right",
          textStyle: { fontFamily: spec.font, fontSize: 10, fontWeight: 600, color: spec.muted },
        });
    }
  });
  return {
    animation: false,
    backgroundColor: "#ffffff",
    textStyle: { fontFamily: spec.font, color: spec.ink },
    title, grid, xAxis, yAxis, series,
    graphic: [...graphic, ...emptyGraphic(spec, spec.series.length === 0)],
  };
}

/** The shared look (C9): grid lines recede behind the data, bars end rounded. Tabular figures
 * need no feature switch, which resvg would not apply: every face a chart is set in (DejaVu,
 * Liberation Sans, IBM Plex, Source Sans and Serif) draws its digits at one width. */
const GRID_OPACITY = 0.55;
const BAR_RADIUS = 3;

/**
 * An annotated line's marked days: a thin vertical rule at each, named by the author's own
 * words. Merged with the threshold's line when both are on the first series.
 */
function markerLines(spec, thresholdLine) {
  return {
    markLine: {
      silent: true,
      symbol: "none",
      animation: false,
      data: [
        ...(thresholdLine
          ? [{ ...thresholdLine.data[0], lineStyle: thresholdLine.lineStyle, label: thresholdLine.label }]
          : []),
        ...spec.markers
          .filter((m) => spec.categories.includes(m.x))
          .map((m) => ({
            xAxis: m.x,
            lineStyle: { type: "dashed", color: THRESHOLD_INK, opacity: 0.7, width: 1 },
            label: { formatter: () => m.label, position: "insideEndTop", rotate: 0, color: THRESHOLD_INK, fontFamily: spec.font, fontSize: 10, backgroundColor: "#ffffff", padding: [1, 3] },
          })),
      ],
    },
    // An orange dot where each marked day meets the highest line, so the eye lands on it.
    markPoint: {
      symbol: "circle",
      symbolSize: 8,
      silent: true,
      animation: false,
      label: { show: false },
      itemStyle: { color: THRESHOLD_INK, borderColor: "#ffffff", borderWidth: 1.5 },
      data: spec.markers
        .filter((m) => spec.categories.includes(m.x))
        .flatMap((m) => {
          const i = spec.categories.indexOf(m.x);
          const top = Math.max(...spec.series.filter((s) => s.panel === 0).map((s) => (s.values[i] == null ? -Infinity : Number(s.values[i]))));
          return Number.isFinite(top) ? [{ coord: [i, top] }] : [];
        }),
    },
  };
}

/**
 * KPI tiles: one card per figure with its name, the figure, the change since the previous
 * report beside a mark for its direction, the resource holding it, and its days as a
 * sparkline. Every number printed arrives formatted; the sparkline's values only place points.
 */
function tilesOptions(spec, compact) {
  const tiles = spec.tiles ?? [];
  const gap = compact ? 6 : 10;
  const top = compact ? 4 : 32;
  const slots = 4;
  const width = (spec.width - 16 - gap * (slots - 1)) / slots;
  const height = spec.height - top - 8;
  const pad = compact ? 8 : 12;
  const graphic = [];
  if (!compact) {
    graphic.push({
      type: "text",
      left: 8,
      top: 6,
      style: {
        text: `{a|${spec.title}}` + (spec.subtitle ? `{b|\u00a0\u00a0\u00b7\u00a0\u00a0${spec.subtitle}}` : ""),
        rich: {
          a: { fontFamily: spec.font, fontSize: 12, fontWeight: 500, color: spec.ink },
          b: { fontFamily: spec.font, fontSize: 11, color: spec.muted },
        },
      },
    });
  }
  tiles.forEach((tile, i) => {
    const x = 8 + i * (width + gap);
    const inner = width - pad * 2;
    graphic.push({
      type: "rect",
      shape: { x, y: top, width, height, r: 8 },
      style: { fill: "#ffffff", stroke: spec.rule, lineWidth: 1 },
    });
    const text = (value, y, size, fill, weight = 400, left = x + pad, limit = inner) => ({
      type: "text",
      left,
      top: top + y,
      style: { text: value, fill, fontFamily: spec.font, fontSize: size, fontWeight: weight, width: limit, overflow: "truncate" },
    });
    graphic.push(text(tile.label, pad, compact ? 8 : 11, spec.muted));
    graphic.push(text(tile.value, pad + (compact ? 12 : 17), compact ? 15 : 24, spec.ink, 600));
    const changeY = top + pad + (compact ? 32 : 50);
    if (tile.change) {
      let left = x + pad;
      if (tile.change.direction !== "flat") {
        const s = compact ? 6 : 8;
        const y = changeY + (compact ? 1 : 2);
        graphic.push({
          type: "polygon",
          shape: {
            points:
              tile.change.direction === "up"
                ? [[left, y + s], [left + s, y + s], [left + s / 2, y]]
                : [[left, y], [left + s, y], [left + s / 2, y + s]],
          },
          style: { fill: tile.change.ink },
        });
        left += s + 4;
      }
      graphic.push(text(tile.change.text, changeY - top, compact ? 8 : 11, tile.change.ink, 600, left, inner - (left - x - pad)));
    } else if (tile.note) {
      graphic.push(text(tile.note, changeY - top, compact ? 8 : 11, spec.muted));
    }
    graphic.push(text(tile.resource, changeY - top + (compact ? 11 : 16), compact ? 7 : 10, spec.muted));
    const values = tile.spark.map(Number);
    if (values.length > 1) {
      // Never stretched past half the figure's size: a month that barely moved draws flat.
      const high = Math.max(...values);
      const low = Math.min(Math.min(...values), high - Math.abs(high) * 0.5);
      const span = high - low || 1;
      const bottom = top + height - pad;
      const rise = compact ? 14 : 24;
      graphic.push({
        type: "polyline",
        shape: {
          points: values.map((v, j) => [
            x + pad + (inner * j) / (values.length - 1),
            bottom - ((v - low) / span) * rise,
          ]),
        },
        style: { stroke: spec.accent, lineWidth: compact ? 1.2 : 1.8, fill: null, lineJoin: "round" },
      });
    }
  });
  if (!tiles.length) graphic.push(...emptyGraphic(spec, true));
  return {
    animation: false,
    backgroundColor: "#ffffff",
    textStyle: { fontFamily: spec.font, color: spec.ink },
    graphic,
  };
}

/** The legend band a design asks for above or below the plot, inside `spec.height`. */
const LEGEND_SPACE = 24;

export function chartOptions(spec, compact = false) {
  if (spec.type === "heatmap") return heatmapOptions(spec, compact);
  if (spec.type === "dumbbell") return dumbbellOptions(spec, compact);
  if (spec.type === "bar_list") return barListOptions(spec, compact);
  if (spec.type === "bullet") return bulletOptions(spec, compact);
  if (spec.type === "mix") return mixOptions(spec, compact);
  if (spec.type === "multiples") return multiplesOptions(spec, compact);
  if (spec.type === "tiles") return tilesOptions(spec, compact);
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
              lineStyle: { type: "dashed", color: spec.type === "annotated" ? THRESHOLD_INK : "#B45309", width: 1.2 },
              label: {
                formatter: () => spec.thresholdLabel ?? "",
                position: spec.type === "annotated" ? "insideEndTop" : "insideStartTop",
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
      ...(leads && s.panel === 0 && !compact && spec.markers?.length ? markerLines(spec, threshold.markLine) : {}),
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
