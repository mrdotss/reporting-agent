import { z } from "zod"

export const PREVIEW_THEMES = [
  "corporate",
  "editorial",
  "technical",
  "minimal",
] as const
export const previewSettingsSchema = z
  .object({
    preset: z.enum(PREVIEW_THEMES),
    accent_color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour."),
    density: z.enum(["compact", "normal", "relaxed"]),
    table_style: z.enum(["hairline", "banded", "bordered"]),
    page_size: z.enum(["A4", "Letter"]),
    chart_font: z.enum(["document", "grotesque", "monospace"]),
    chart_style: z.enum(["stacked", "columns"]),
  })
  .strict()

export type PreviewSettings = z.infer<typeof previewSettingsSchema>
export type PreviewTheme = PreviewSettings["preset"]

export const THEME_NOTES: Record<PreviewTheme, string> = {
  corporate: "Clear hierarchy. Navy ink and a restrained teal accent.",
  editorial: "Serif typography and generous reading space.",
  technical: "Compact structure, slate blue and precise figures.",
  minimal: "Charcoal ink, fine rules and quiet typography.",
}

export function themeDefaults(preset: PreviewTheme): PreviewSettings {
  return {
    preset,
    accent_color: {
      corporate: "#1f6f78",
      editorial: "#0f6470",
      technical: "#33556b",
      minimal: "#30343b",
    }[preset],
    density:
      preset === "technical"
        ? "compact"
        : preset === "editorial"
          ? "relaxed"
          : "normal",
    table_style: preset === "corporate" ? "banded" : "hairline",
    page_size: "A4",
    chart_font: "document",
    chart_style: "stacked",
  }
}
