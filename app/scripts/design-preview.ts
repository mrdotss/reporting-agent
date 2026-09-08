import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { renderPreview } from "../lib/design-preview/render"
import { PREVIEW_THEMES, themeDefaults } from "../lib/design-preview/settings"

const output = path.resolve(process.argv[2] ?? "../artifacts/design-preview")
await mkdir(output, { recursive: true })
const cases = PREVIEW_THEMES.map((preset) => ({
  name: preset as string,
  settings: themeDefaults(preset),
  variant: "default",
}))
if (process.argv.includes("--stress")) {
  for (const variant of ["long-name", "missing", "empty", "low", "overflow"])
    cases.push({ name: variant, settings: themeDefaults("corporate"), variant })
  cases.push({
    name: "tuned",
    settings: {
      ...themeDefaults("corporate"),
      accent_color: "#76558b",
      density: "relaxed",
      table_style: "bordered",
      page_size: "Letter",
      chart_font: "monospace",
      chart_style: "columns",
    },
    variant: "default",
  })
}
for (const sample of cases) {
  const preset = sample.name
  const result = await renderPreview(sample.settings, undefined, sample.variant)
  for (const [extension, content] of Object.entries({
    pdf: result.pdf,
    html: result.html,
    svg: result.svg,
    "manifest.json": JSON.stringify(result.manifest, null, 2),
  })) {
    await writeFile(path.join(output, `${preset}.${extension}`), content)
  }
  console.log(`${preset}: ${path.join(output, `${preset}.pdf`)}`)
}
