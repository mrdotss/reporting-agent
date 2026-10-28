export type ReportChartSpec = {
  style: string;
  type: string;
  width: number;
  height: number;
  font: string;
  ink: string;
  muted: string;
  rule: string;
  emptyLabel: string;
  xTitle?: string;
  yTitle?: string;
  categories: string[];
  panels: {
    label: string;
    unit: string;
    zoomed?: boolean;
    min: number;
    max: number;
  }[];
  series: {
    key: string;
    label: string;
    last: string;
    panel: number;
    color: string;
    dashed: boolean;
    values: (string | null)[];
    pointLabels?: (string | null)[];
    // A bar list's colour per bar, busiest darkest.
    shades?: string[];
  }[];
  bands?: { lower: number; upper: number }[];
  // A design's chart look; each is present only where it leaves the default.
  lineWidth?: number;
  gridLines?: "none" | "full";
  values?: "peak" | "none";
  legend?: "top" | "bottom";
  threshold?: number;
  thresholdLabel?: string;
  // Small multiples: panels per row.
  columns?: number;
  // An annotated line's incident markers, each on a category it plots.
  markers?: { x: string; label: string }[];
  // The theme's figure face, for resource names; the accent, for drawn marks.
  mono?: string;
  accent?: string;
  // A line of words under the chart saying what its marks mean.
  legendText?: string;
  // The hour-of-week grid: rounded cells with gaps and no colour scale.
  week?: boolean;
  // KPI tiles: a title and subtitle, and one tile per figure.
  title?: string;
  subtitle?: string;
  tiles?: {
    label: string;
    value: string;
    resource: string;
    change: { text: string; direction: "up" | "down" | "flat"; ink: string } | null;
    note: string;
    spark: string[];
  }[];
};
export function renderSVG(
  spec: ReportChartSpec,
  compact: boolean,
  init: (
    dom: null,
    theme: null,
    options: { renderer: "svg"; ssr: true; width: number; height: number },
  ) => {
    setOption(options: object): void;
    renderToSVGString(): string;
    dispose(): void;
  },
): string;
export function chartOptions(spec: ReportChartSpec, compact?: boolean): object;
