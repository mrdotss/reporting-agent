import { CHART_FONT_STACKS } from "@/lib/profiles/chart-styles"
import { PRESET_FACES, PRESET_HEADING_FACES } from "@/lib/profiles/preview-sample"
import {
  CHART_FONTS,
  CHART_STYLES,
  DESIGN_PRESETS,
  STYLE_CALLOUTS,
  STYLE_CHART_GRIDS,
  STYLE_CHART_LEGENDS,
  STYLE_CHART_LINES,
  STYLE_CHART_PALETTES,
  STYLE_CHART_VALUES,
  STYLE_COVERS,
  STYLE_FIGURES,
  STYLE_FONTS,
  STYLE_HEADING_COLORS,
  STYLE_KEYS,
  STYLE_MARGINS,
  STYLE_RUNNING_HEADERS,
  STYLE_SECTION_NUMBERS,
  STYLE_TABLE_HEADERS,
  STYLE_TEXT_SIZES,
  STYLE_THRESHOLD_MAX,
  STYLE_THRESHOLD_MIN,
  type ChartFont,
  type ChartStyle,
  type Density,
  type DesignPreset,
  type PageSize,
  type TableStyle,
} from "@/lib/templates/definition"

import type { DefinitionV4 } from "./model"

/**
 * The page the canvas draws, from the draft's design — each preset's face, palette and type
 * scale as `render/themes.py`'s `THEME_SPECS` declares them, in points, so the canvas and
 * the Word document use one set of numbers.
 */

export type CoverStyle = "band" | "full_bleed" | "summary"
export type HeadingRule = "rule" | "double" | "line" | "none"

export type ThemeSpec = {
  /** The body face, as a browser stack. */
  readonly face: string
  /** The heading and cover face. */
  readonly headingFace: string
  readonly accent: string
  readonly ink: string
  readonly muted: string
  readonly rule: string
  readonly band: string
  readonly titlePt: number
  readonly subtitlePt: number
  readonly headingPt: readonly [number, number, number, number]
  readonly bodyPt: number
  readonly smallPt: number
  readonly lineSpacing: number
  readonly headingAllCaps: boolean
  readonly bandedRows: boolean
  /** `render/themes.py`'s treatments, which the Word file and the reading copy both follow. */
  readonly coverStyle: CoverStyle
  readonly headingRule: HeadingRule
  readonly displayNumbers: boolean
}

type SpecValues = Omit<ThemeSpec, "face" | "headingFace">

const FIRST_FOUR = { coverStyle: "band", headingRule: "rule", displayNumbers: false } as const

/** `Callout Attention`'s rule and tint, the same in every theme (`ATTENTION_RULE`, `ATTENTION_TINT`). */
export const ATTENTION = { rule: "#B45309", tint: "#FDF4E7" } as const

export const SPECS: Readonly<Record<DesignPreset, SpecValues>> = {
  editorial: {
    accent: "#0F6470", ink: "#1A1A1A", muted: "#5A6B70", rule: "#C9D4D7", band: "#F2F6F7",
    titlePt: 26, subtitlePt: 13, headingPt: [16, 13, 11.5, 10.5], bodyPt: 11, smallPt: 9,
    lineSpacing: 1.28, headingAllCaps: false, bandedRows: true, ...FIRST_FOUR,
  },
  corporate: {
    accent: "#1F3A5F", ink: "#1C1C1C", muted: "#5B6B7C", rule: "#C8D2DC", band: "#EEF2F6",
    titlePt: 24, subtitlePt: 12, headingPt: [15, 12.5, 11, 10], bodyPt: 10.5, smallPt: 8.5,
    lineSpacing: 1.22, headingAllCaps: false, bandedRows: true, ...FIRST_FOUR,
  },
  technical: {
    accent: "#33556B", ink: "#202325", muted: "#5E6B72", rule: "#B9C4CA", band: "#EDF1F3",
    titlePt: 22, subtitlePt: 11.5, headingPt: [14, 12, 10.5, 9.5], bodyPt: 10, smallPt: 8.5,
    lineSpacing: 1.18, headingAllCaps: true, bandedRows: true, ...FIRST_FOUR,
  },
  minimal: {
    accent: "#1A1A1A", ink: "#1A1A1A", muted: "#6B6B6B", rule: "#DCDCDC", band: "#F6F6F6",
    titlePt: 23, subtitlePt: 11.5, headingPt: [14, 12, 10.5, 10], bodyPt: 10.5, smallPt: 9,
    lineSpacing: 1.3, headingAllCaps: true, bandedRows: false, ...FIRST_FOUR,
  },
  ledger: {
    accent: "#245C45", ink: "#1C1C1C", muted: "#5C6660", rule: "#CFD6D2", band: "#F1F5F2",
    titlePt: 24, subtitlePt: 12, headingPt: [15, 12.5, 11, 10], bodyPt: 10, smallPt: 8.5,
    lineSpacing: 1.3, headingAllCaps: false, bandedRows: false,
    coverStyle: "band", headingRule: "double", displayNumbers: false,
  },
  signal: {
    accent: "#A3401F", ink: "#1C1C1C", muted: "#6B625E", rule: "#DDD3CF", band: "#F7EFEC",
    titlePt: 26, subtitlePt: 12.5, headingPt: [18, 14, 12, 10.5], bodyPt: 10.5, smallPt: 9,
    lineSpacing: 1.32, headingAllCaps: false, bandedRows: true,
    coverStyle: "full_bleed", headingRule: "none", displayNumbers: true,
  },
  brief: {
    accent: "#3D4F8F", ink: "#1F2128", muted: "#5F6270", rule: "#D3D6E0", band: "#F1F2F7",
    titlePt: 20, subtitlePt: 11, headingPt: [13, 11.5, 10.5, 9.5], bodyPt: 10, smallPt: 8.5,
    lineSpacing: 1.22, headingAllCaps: false, bandedRows: false,
    coverStyle: "summary", headingRule: "line", displayNumbers: false,
  },
}

/** A theme's own accent — what choosing the theme sets, before any accent is picked. */
export function themeAccent(preset: DesignPreset): string {
  return SPECS[preset].accent
}

export const THEME_LABELS: Readonly<Record<DesignPreset, { name: string; note: string }>> = {
  editorial: { name: "Editorial", note: "Serif reading face, a long-form review" },
  corporate: { name: "Corporate", note: "Plain sans, navy accent, board-pack ready" },
  technical: { name: "Technical", note: "Compact, tracked caps, for engineers" },
  minimal: { name: "Minimal", note: "Black and white, hairline rules, no bands" },
  ledger: { name: "Ledger", note: "Reads like a statement: mono figures, double rules" },
  signal: { name: "Signal", note: "Full-bleed cover, big section numbers, for executives" },
  brief: { name: "Brief", note: "A title strip on page one, compact serif headings" },
}

/** The themes the preset builder added, shown as new in the pickers. */
export const NEW_THEMES: ReadonlySet<DesignPreset> = new Set(["ledger", "signal", "brief"])

/** Points to CSS pixels at 96 dpi: the canvas draws the page at its printed size. */
export const PT = 96 / 72

/** Width x height in CSS pixels. */
export const PAGE_PX: Readonly<Record<PageSize, { width: number; height: number }>> = {
  A4: { width: 794, height: 1123 },
  Letter: { width: 816, height: 1056 },
}

export const DENSITY_SCALE: Readonly<Record<Density, number>> = {
  compact: 0.85,
  normal: 1,
  relaxed: 1.15,
}

/**
 * `design.style` resolved against the theme: every key the preset leaves unset reads as the
 * theme's own choice, which is what the runtime does with an absent key.
 */
export type Look = {
  readonly headingColor: (typeof STYLE_HEADING_COLORS)[number]
  readonly fonts: (typeof STYLE_FONTS)[number]
  readonly textSize: (typeof STYLE_TEXT_SIZES)[number]
  readonly figures: (typeof STYLE_FIGURES)[number]
  readonly tableHeader: (typeof STYLE_TABLE_HEADERS)[number]
  readonly markAtOrAbove: number | null
  readonly chartPalette: (typeof STYLE_CHART_PALETTES)[number]
  readonly chartLine: (typeof STYLE_CHART_LINES)[number]
  readonly chartGrid: (typeof STYLE_CHART_GRIDS)[number]
  readonly chartValues: (typeof STYLE_CHART_VALUES)[number]
  readonly chartLegend: (typeof STYLE_CHART_LEGENDS)[number]
  readonly chartThreshold: number | null
  readonly cover: (typeof STYLE_COVERS)[number]
  readonly sectionNumbers: (typeof STYLE_SECTION_NUMBERS)[number]
  readonly margins: (typeof STYLE_MARGINS)[number]
  readonly runningHeader: (typeof STYLE_RUNNING_HEADERS)[number]
  readonly callout: (typeof STYLE_CALLOUTS)[number]
}

/** The `design.style` key each `Look` field reads. */
export const LOOK_KEYS: Readonly<Record<keyof Look, (typeof STYLE_KEYS)[number]>> = {
  headingColor: "heading_color",
  fonts: "fonts",
  textSize: "text_size",
  figures: "figures",
  tableHeader: "table_header",
  markAtOrAbove: "mark_at_or_above",
  chartPalette: "chart_palette",
  chartLine: "chart_line",
  chartGrid: "chart_grid",
  chartValues: "chart_values",
  chartLegend: "chart_legend",
  chartThreshold: "chart_threshold",
  cover: "cover",
  sectionNumbers: "section_numbers",
  margins: "margins",
  runningHeader: "running_header",
  callout: "callout",
}

/** What a theme does where the preset's style says nothing — the values the runtime keeps. */
export function themeLook(preset: DesignPreset): Look {
  const spec = SPECS[preset]
  return {
    headingColor: "accent",
    fonts: "theme",
    textSize: "normal",
    figures: "mono",
    tableHeader: "rule",
    markAtOrAbove: null,
    chartPalette: "standard",
    chartLine: "regular",
    chartGrid: "light",
    chartValues: "last",
    chartLegend: "line_ends",
    chartThreshold: null,
    cover: spec.coverStyle,
    sectionNumbers: spec.displayNumbers ? "display" : "inline",
    margins: "normal",
    runningHeader: "section",
    callout: "rule",
  }
}

const PAIRING_FACES: Readonly<Record<Exclude<(typeof STYLE_FONTS)[number], "theme">, readonly [string, string]>> = {
  plex: ['var(--font-plex-sans), "IBM Plex Sans", Arial, sans-serif', 'var(--font-plex-sans), "IBM Plex Sans", Arial, sans-serif'],
  source: ['var(--font-source-serif), "Source Serif 4", Georgia, serif', 'var(--font-source-sans), "Source Sans 3", Arial, sans-serif'],
  archivo: ['var(--font-archivo), "Archivo", Arial, sans-serif', '"Liberation Sans", Arimo, Arial, sans-serif'],
  serif: ['"Liberation Serif", "Times New Roman", Times, serif', '"Liberation Serif", "Times New Roman", Times, serif'],
}

const MONO_FACES: Readonly<Record<DesignPreset, string>> = {
  editorial: '"DejaVu Sans Mono", Menlo, monospace',
  corporate: '"DejaVu Sans Mono", Menlo, monospace',
  technical: '"DejaVu Sans Mono", Menlo, monospace',
  minimal: '"DejaVu Sans Mono", Menlo, monospace',
  ledger: 'var(--font-plex-mono), "IBM Plex Mono", monospace',
  signal: 'var(--font-plex-mono), "IBM Plex Mono", monospace',
  brief: 'var(--font-plex-mono), "IBM Plex Mono", monospace',
}

function lookOf(preset: DesignPreset, raw: unknown): Look {
  const base = themeLook(preset)
  if (raw === null || typeof raw !== "object") return base
  const style = raw as Record<string, unknown>
  const pick = <K extends keyof Look>(key: K, allowed: readonly string[]): Look[K] => {
    const value = style[LOOK_KEYS[key]]
    return (typeof value === "string" && allowed.includes(value) ? value : base[key]) as Look[K]
  }
  const threshold = (key: "markAtOrAbove" | "chartThreshold"): number | null => {
    const value = style[LOOK_KEYS[key]]
    return typeof value === "number" && Number.isInteger(value) && value >= STYLE_THRESHOLD_MIN && value <= STYLE_THRESHOLD_MAX
      ? value
      : base[key]
  }
  return {
    headingColor: pick("headingColor", STYLE_HEADING_COLORS),
    fonts: pick("fonts", STYLE_FONTS),
    textSize: pick("textSize", STYLE_TEXT_SIZES),
    figures: pick("figures", STYLE_FIGURES),
    tableHeader: pick("tableHeader", STYLE_TABLE_HEADERS),
    markAtOrAbove: threshold("markAtOrAbove"),
    chartPalette: pick("chartPalette", STYLE_CHART_PALETTES),
    chartLine: pick("chartLine", STYLE_CHART_LINES),
    chartGrid: pick("chartGrid", STYLE_CHART_GRIDS),
    chartValues: pick("chartValues", STYLE_CHART_VALUES),
    chartLegend: pick("chartLegend", STYLE_CHART_LEGENDS),
    chartThreshold: threshold("chartThreshold"),
    cover: pick("cover", STYLE_COVERS),
    sectionNumbers: pick("sectionNumbers", STYLE_SECTION_NUMBERS),
    margins: pick("margins", STYLE_MARGINS),
    runningHeader: pick("runningHeader", STYLE_RUNNING_HEADERS),
    callout: pick("callout", STYLE_CALLOUTS),
  }
}

/** Text sizes the runtime scales every style by (`docx._TEXT_SIZE_FACTORS`). */
export const TEXT_SIZE_FACTORS: Readonly<Record<Look["textSize"], number>> = { small: 0.92, normal: 1, large: 1.08 }
/** Page margins against the theme's (`docx._MARGIN_FACTORS`). */
export const MARGIN_FACTORS: Readonly<Record<Look["margins"], number>> = { narrow: 0.7, normal: 1, wide: 1.3 }
/** A marked cell, the same in every theme (`docx.MARK_FILL`, `docx.MARK_INK`). */
export const MARK = { fill: "#FDF1E2", ink: "#9A4507" } as const

/** `RRGGBB` mixed toward white by `amount` — the runtime's tints. */
export function tint(hex: string, amount: number): string {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  return "#" + channels.map((c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, "0")).join("")
}

export type PageDesign = {
  readonly preset: DesignPreset
  readonly spec: ThemeSpec
  /** `design.style` resolved against the theme. */
  readonly look: Look
  /** The face figures are set in. */
  readonly figureFace: string
  readonly density: Density
  readonly tableStyle: TableStyle
  readonly pageSize: PageSize
  readonly chartStyle: ChartStyle
  readonly chartFont: ChartFont
  readonly chartFace: string
  readonly cover: boolean
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

export function pageDesign(definition: DefinitionV4): PageDesign {
  const design = definition.design
  const preset = oneOf(design.preset, DESIGN_PRESETS, "editorial")
  const accent =
    typeof design.accent_color === "string" && /^#[0-9a-fA-F]{6}$/.test(design.accent_color)
      ? design.accent_color
      : SPECS[preset].accent
  const look = lookOf(preset, (design as Record<string, unknown>).style)
  const pairing = look.fonts === "theme" ? null : PAIRING_FACES[look.fonts]
  const spec: ThemeSpec = {
    ...SPECS[preset],
    accent,
    face: pairing?.[1] ?? PRESET_FACES[preset],
    headingFace: pairing?.[0] ?? PRESET_HEADING_FACES[preset],
  }
  const chartFont = oneOf(design.chart_font, CHART_FONTS, "document")
  const cover = (definition.front_matter.cover as { enabled?: boolean } | undefined)?.enabled !== false
  return {
    preset,
    spec,
    look,
    figureFace: look.figures === "text" ? spec.face : MONO_FACES[preset],
    density: oneOf(design.density, ["compact", "normal", "relaxed"] as const, "normal"),
    tableStyle: oneOf(design.table_style, ["hairline", "banded", "bordered", "open"] as const, "hairline"),
    pageSize: oneOf(design.page_size, ["A4", "Letter"] as const, "A4"),
    chartStyle: oneOf(design.chart_style, CHART_STYLES, "stacked"),
    chartFont,
    chartFace: chartFont === "document" ? spec.face : CHART_FONT_STACKS[chartFont],
    cover,
  }
}

/** The accents the Theme panel offers; any hex can still be typed. */
export const ACCENT_SWATCHES = [
  { hex: "#0F6470", label: "Teal" },
  { hex: "#1F3A5F", label: "Navy" },
  { hex: "#2F3C7E", label: "Indigo" },
  { hex: "#33556B", label: "Slate" },
  { hex: "#245C45", label: "Forest" },
  { hex: "#A3401F", label: "Rust" },
  { hex: "#1A1A1A", label: "Ink" },
] as const
