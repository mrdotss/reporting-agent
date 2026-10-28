"use client"

import { CircleNotchIcon } from "@phosphor-icons/react"
import { useState } from "react"
import { toast } from "sonner"

import { useBuilder, useEnvironment } from "@/components/builder/context"
import { Segmented } from "@/components/builder/left/theme-panel"
import type { CanvasData } from "@/lib/builder/sample"

/**
 * Sample or Real: what the canvas draws its figures from.
 *
 * Real reads a connection's latest completed report, the same connections Preview PDF
 * offers, and draws its resources and figures on the page, marked as not a deliverable.
 * Nothing is saved: the choice lasts for this session, and the preset is the same either
 * way. Preview PDF stays the way to see the document the runtime would print.
 */

type Figures = "sample" | "real"

export function FiguresSwitch() {
  const { templateId, previewSources } = useEnvironment()
  const canvasData = useBuilder((state) => state.canvasData)
  const setCanvasData = useBuilder((state) => state.setCanvasData)
  const ready = previewSources.filter((source) => source.period !== null)
  const [sourceId, setSourceId] = useState<string | null>(ready[0]?.id ?? null)
  const [loading, setLoading] = useState(false)

  const load = async (id: string) => {
    setLoading(true)
    try {
      const response = await fetch(`/api/report-profiles/${templateId}/canvas-data?connection=${encodeURIComponent(id)}`)
      const body = (await response.json()) as CanvasData & { error?: { message?: string } }
      if (!response.ok || body.kind !== "real") {
        toast.error(body.error?.message ?? "That report's figures could not be read. The page keeps the sample.")
        return
      }
      setCanvasData(body)
    } catch {
      toast.error("The server could not be reached. The page keeps the sample.")
    } finally {
      setLoading(false)
    }
  }

  const choose = (figures: Figures) => {
    if (figures === "sample") return setCanvasData(null)
    if (sourceId !== null) void load(sourceId)
  }

  if (ready.length === 0) {
    return (
      <span
        className="shrink-0 text-xs whitespace-nowrap text-muted-foreground"
        title="Real figures need a completed report on a connection of this provider."
      >
        Sample figures
      </span>
    )
  }

  return (
    <div className="ml-auto flex shrink-0 items-center gap-2" data-slot="figures-switch">
      {loading && <CircleNotchIcon aria-label="Loading figures" className="size-3.5 animate-spin text-muted-foreground" />}
      <div className="w-36">
        <Segmented<Figures>
          label="Figures"
          value={canvasData === null ? "sample" : "real"}
          options={[
            { value: "sample", label: "Sample" },
            { value: "real", label: "Real" },
          ]}
          onChange={choose}
        />
      </div>
      {ready.length > 1 && (
        <select
          aria-label="Report to draw from"
          value={sourceId ?? ""}
          onChange={(event) => {
            setSourceId(event.target.value)
            if (canvasData !== null) void load(event.target.value)
          }}
          className="h-8 max-w-48 rounded-md border border-input bg-background px-2 text-[12.5px]"
        >
          {ready.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
