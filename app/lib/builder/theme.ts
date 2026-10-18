import { CHART_FONT_STACKS } from "@/lib/profiles/chart-styles"
import { PRESET_FACES } from "@/lib/profiles/preview-sample"
import {
  CHART_FONTS,
  CHART_STYLES,
  DESIGN_PRESETS,
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

export type ThemeSpec = {
  readonly face: string
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
}

const SPECS: Readonly<Record<DesignPreset, Omit<ThemeSpec, "face">>> = {
  editorial: {
    accent: "#0F6470", ink: "#1A1A1A", muted: "#5A6B70", rule: "#C9D4D7", band: "#F2F6F7",
    titlePt: 26, subtitlePt: 13, headingPt: [16, 13, 11.5, 10.5], bodyPt: 11, smallPt: 9,
    lineSpacing: 1.28, headingAllCaps: false, bandedRows: true,
  },
  corporate: {
    accent: "#1F3A5F", ink: "#1C1C1C", muted: "#5B6B7C", rule: "#C8D2DC", band: "#EEF2F6",
    titlePt: 24, subtitlePt: 12, headingPt: [15, 12.5, 11, 10], bodyPt: 10.5, smallPt: 8.5,
    lineSpacing: 1.22, headingAllCaps: false, bandedRows: true,
  },
  technical: {
    accent: "#33556B", ink: "#202325", muted: "#5E6B72", rule: "#B9C4CA", band: "#EDF1F3",
    titlePt: 22, subtitlePt: 11.5, headingPt: [14, 12, 10.5, 9.5], bodyPt: 10, smallPt: 8.5,
    lineSpacing: 1.18, headingAllCaps: true, bandedRows: true,
  },
  minimal: {
    accent: "#1A1A1A", ink: "#1A1A1A", muted: "#6B6B6B", rule: "#DCDCDC", band: "#F6F6F6",
    titlePt: 23, subtitlePt: 11.5, headingPt: [14, 12, 10.5, 10], bodyPt: 10.5, smallPt: 9,
    lineSpacing: 1.3, headingAllCaps: true, bandedRows: false,
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
}

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

export type PageDesign = {
  readonly preset: DesignPreset
  readonly spec: ThemeSpec
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
  const spec: ThemeSpec = { ...SPECS[preset], accent, face: PRESET_FACES[preset] }
  const chartFont = oneOf(design.chart_font, CHART_FONTS, "document")
  const cover = (definition.front_matter.cover as { enabled?: boolean } | undefined)?.enabled !== false
  return {
    preset,
    spec,
    density: oneOf(design.density, ["compact", "normal", "relaxed"] as const, "normal"),
    tableStyle: oneOf(design.table_style, ["hairline", "banded", "bordered"] as const, "hairline"),
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
