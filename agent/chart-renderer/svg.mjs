/** Shared by the profile selector and the production SVG/PNG renderer.
 * Every numeric operation below positions marks; displayed values arrive formatted.
 */
export function chartOptions(spec, compact = false) {
  const bare = spec.style === "sparkline";
  const panelHeight = spec.height / spec.panels.length;
  const grid = spec.panels.map((p, i) => ({
    left: compact ? 12 : 150,
    right: compact ? (bare ? 55 : 12) : 150,
    top: i * panelHeight + (compact ? 9 : 36),
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
          splitLine: { show: !bare, lineStyle: { color: spec.rule } },
          axisLine: { show: false },
          axisTick: { show: false },
        };
  for (const s of spec.series) {
    const bars =
      spec.type === "bar" || spec.type === "hbar" || spec.style === "columns";
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
        width: compact ? 2 : 2.3,
        color: s.color,
        type: s.dashed ? "dashed" : "solid",
      },
      itemStyle: { color: s.color },
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
                compact ||
                bare ||
                !s.pointLabels ||
                s.values.filter((v) => v != null).length > 6,
              formatter: () => s.label + "\n" + s.last,
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
          top: i * panelHeight + 3,
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
