// Node-only module. The route and local sample generator share this exact renderer.
import { spawn } from "node:child_process"
import path from "node:path"
import { init } from "echarts"
import type { PreviewSettings } from "./settings"

export type PreviewStage = "validation" | "compilation" | "chart" | "pdf"
export class PreviewRenderError extends Error {
  constructor(
    public stage: PreviewStage,
    message: string
  ) {
    super(message)
  }
}

export type ChartSpec = {
  identity: string
  data_hash: string
  width: number
  height: number
  font: string
  ink: string
  muted: string
  rule: string
  dates: string[]
  series: {
    key: string
    label: string
    unit: string
    panel: number
    color: string
    values: (string | null)[]
    formatted: (string | null)[]
    min: number
    max: number
    interval: number
  }[]
}
export type PreparedPreview = {
  html: string
  chart: ChartSpec
  manifest: Record<string, unknown>
}

// Resolve from the app working directory, also when Next bundles this module.
const appRoot = process.cwd().endsWith(`${path.sep}app`)
  ? process.cwd()
  : path.join(process.cwd(), "app")
const agentRoot = path.resolve(appRoot, "../agent")
const python = path.join(agentRoot, ".venv/bin/python")
const script = path.join(agentRoot, "dev/design_preview/preview.py")
const MAX_OUTPUT = 12 * 1024 * 1024

function runPython(
  mode: "prepare" | "pdf",
  input: unknown,
  signal?: AbortSignal
): Promise<Buffer> {
  const stage = mode === "prepare" ? "compilation" : "pdf"
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, mode], {
      cwd: agentRoot,
      env: { ...process.env, PYTHONPATH: path.join(agentRoot, "src") },
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    })
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    const fail = (message: string) => {
      if (failed) return
      failed = true
      child.kill("SIGKILL")
      reject(new PreviewRenderError(stage, message))
    }
    const timer = setTimeout(
      () =>
        fail(
          `${stage === "pdf" ? "PDF rendering" : "Sample compilation"} timed out. Try again.`
        ),
      mode === "prepare" ? 20_000 : 40_000
    )
    child.on("error", () =>
      fail(
        `The local ${stage} process could not start. Check agent/.venv and the preview setup instructions.`
      )
    )
    child.stdin.on("error", () =>
      fail(`The local ${stage} process stopped before accepting the preview.`)
    )
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT) fail("The preview exceeded its output limit.")
      else chunks.push(chunk)
    })
    // Drain stderr without exposing filesystem paths or environment details through the API.
    child.stderr.resume()
    child.on("close", (code) => {
      clearTimeout(timer)
      if (failed) return
      if (code !== 0) {
        reject(
          new PreviewRenderError(
            stage,
            stage === "pdf"
              ? "PDF rendering failed. Check the local WeasyPrint libraries and fonts."
              : "The sample could not be compiled."
          )
        )
      } else resolve(Buffer.concat(chunks))
    })
    child.stdin.end(JSON.stringify(input))
  })
}

export function renderChart(
  spec: ChartSpec,
  style: PreviewSettings["chart_style"]
): string {
  const chart = init(null, undefined, {
    renderer: "svg",
    ssr: true,
    width: spec.width,
    height: spec.height,
  })
  try {
    chart.setOption({
      animation: false,
      backgroundColor: "#ffffff",
      textStyle: { fontFamily: spec.font, color: spec.ink },
      title: spec.series.map((s) => ({
        text: s.label,
        subtext: `${s.unit} · ${s.min}–${s.max}%${s.max < 100 ? " · zoomed scale" : ""}`,
        top: s.panel === 0 ? 4 : 190,
        left: 4,
        textStyle: {
          fontSize: 14,
          fontWeight: 600,
          fontFamily: spec.font,
          color: s.color,
        },
        subtextStyle: {
          fontSize: 11,
          fontFamily: spec.font,
          color: spec.muted,
        },
        itemGap: 5,
      })),
      grid: spec.series.map((s) => ({
        left: 49,
        right: 16,
        top: s.panel === 0 ? 58 : 244,
        height: 99,
      })),
      xAxis: spec.series.map((s) => ({
        type: "category",
        gridIndex: s.panel,
        data: spec.dates.map((d) => d.slice(8) + " Aug"),
        boundaryGap: style === "columns",
        axisTick: { show: false },
        axisLine: { lineStyle: { color: spec.rule } },
        axisLabel: {
          interval: 6,
          fontSize: 11,
          color: spec.muted,
          fontFamily: spec.font,
          hideOverlap: true,
        },
      })),
      yAxis: spec.series.map((s) => ({
        type: "value",
        gridIndex: s.panel,
        min: s.min,
        max: s.max,
        interval: s.interval,
        axisLabel: {
          formatter: "{value}%",
          fontSize: 11,
          color: spec.muted,
          fontFamily: spec.font,
        },
        splitLine: { lineStyle: { color: spec.rule, type: "dashed" } },
      })),
      series: spec.series.map((s) => ({
        name: s.label,
        type: style === "columns" ? "bar" : "line",
        xAxisIndex: s.panel,
        yAxisIndex: s.panel,
        data: s.values,
        connectNulls: false,
        smooth: false,
        showSymbol: false,
        barMaxWidth: 10,
        lineStyle: {
          width: 2.4,
          color: s.color,
          type: s.panel === 1 ? "dashed" : "solid",
        },
        itemStyle: { color: s.color },
        emphasis: { disabled: true },
        animation: false,
      })),
    })
    return chart.renderToSVGString()
  } catch {
    throw new PreviewRenderError(
      "chart",
      "Chart rendering failed. The previous PDF is still available."
    )
  } finally {
    chart.dispose()
  }
}

export async function preparePreview(
  settings: PreviewSettings,
  signal?: AbortSignal,
  variant = "default"
): Promise<PreparedPreview> {
  try {
    return JSON.parse(
      (await runPython("prepare", { settings, variant }, signal)).toString()
    ) as PreparedPreview
  } catch (error) {
    if (error instanceof PreviewRenderError) throw error
    throw new PreviewRenderError(
      "compilation",
      "The compiler returned an unreadable sample."
    )
  }
}

export async function renderPreview(
  settings: PreviewSettings,
  signal?: AbortSignal,
  variant = "default"
) {
  const prepared = await preparePreview(settings, signal, variant)
  const svg = renderChart(prepared.chart, settings.chart_style)
  const html = prepared.html.replace("<!--DESIGN_PREVIEW_CHART-->", svg)
  const pdf = await runPython("pdf", { html }, signal)
  if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-")))
    throw new PreviewRenderError("pdf", "The renderer did not return a PDF.")
  return { pdf, html, svg, manifest: prepared.manifest }
}
