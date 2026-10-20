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
  }[];
  bands?: { lower: number; upper: number }[];
  // A design's chart look; each is present only where it leaves the default.
  lineWidth?: number;
  gridLines?: "none" | "full";
  values?: "peak" | "none";
  legend?: "top" | "bottom";
  threshold?: number;
  thresholdLabel?: string;
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
