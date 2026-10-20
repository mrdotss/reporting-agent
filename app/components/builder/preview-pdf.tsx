"use client"

import { CircleNotchIcon, FilePdfIcon } from "@phosphor-icons/react"
import { useRef, useState } from "react"

import { useBuilder, useBuilderStore, useEnvironment } from "@/components/builder/context"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/**
 * Preview PDF: the draft on the page, rendered by the runtime against a connection's latest
 * completed report, opened in a new tab.
 *
 * The canvas draws sample figures; this is the real document — the Word render converted to
 * PDF, from a real snapshot, with a notice on every page that it is not a verified
 * deliverable. It sends the draft as it stands, unsaved edits included, and publishes
 * nothing.
 *
 * The tab is opened on the click itself and pointed at the PDF when it is ready, because a
 * tab opened after a minute's wait is one the browser's popup blocker closes.
 */

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "rendering"; readonly sourceId: string }
  | { readonly kind: "done"; readonly url: string; readonly period: string }
  | { readonly kind: "failed"; readonly message: string }

function periodText(start: string, end: string): string {
  return start === end ? start : `${start} to ${end}`
}

export function PreviewPdf({ templateId }: Readonly<{ templateId: string }>) {
  const store = useBuilderStore()
  const provider = useBuilder((state) => state.definition.provider)
  const { previewSources } = useEnvironment()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
  const lastPreview = useRef<string | undefined>(undefined)
  const providerName = provider === "aws" ? "AWS" : "Azure"

  const render = async (sourceId: string) => {
    const tab = window.open("", "_blank")
    if (tab !== null) {
      tab.opener = null
      tab.document.title = "Rendering preview…"
      tab.document.body.style.font = "14px system-ui, sans-serif"
      tab.document.body.style.margin = "40px"
      tab.document.body.textContent = "Rendering the preview. This tab shows the PDF when it is ready."
    }
    setPhase({ kind: "rendering", sourceId })
    try {
      const response = await fetch(`/api/report-profiles/${templateId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectedSubscriptionId: sourceId,
          definition: store.getState().definition,
          ...(lastPreview.current ? { supersedes: lastPreview.current } : {}),
        }),
      })
      const body = (await response.json()) as {
        previewId?: string
        url?: string
        periodStart?: string
        periodEnd?: string
        error?: { message?: string }
      }
      if (!response.ok || !body.url) {
        tab?.close()
        setPhase({ kind: "failed", message: body.error?.message ?? "The preview could not be rendered." })
        return
      }
      lastPreview.current = body.previewId
      if (tab !== null && !tab.closed) tab.location.href = body.url
      setPhase({ kind: "done", url: body.url, period: periodText(body.periodStart ?? "", body.periodEnd ?? "") })
    } catch {
      tab?.close()
      setPhase({ kind: "failed", message: "The server could not be reached. The draft is kept." })
    }
  }

  const rendering = phase.kind === "rendering"
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[13px] font-medium hover:bg-muted"
      >
        {rendering ? <CircleNotchIcon className="size-3.5 animate-spin" /> : <FilePdfIcon className="size-3.5" />}
        {rendering ? "Rendering…" : "Preview PDF"}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-2 p-3">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-semibold">Preview with real figures</span>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Renders this draft against a connection&rsquo;s latest completed report and opens the PDF in a
            new tab. Nothing is published, and every page says it is a preview.
          </p>
        </div>

        {previewSources.length === 0 ? (
          <p className="rounded-md bg-muted px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
            No active {providerName} connection in this project. Connect one under Connectors, run a report,
            and the preview can use it.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {previewSources.map((source) => {
              const busy = phase.kind === "rendering" && phase.sourceId === source.id
              return (
                <li key={source.id}>
                  <button
                    type="button"
                    disabled={source.period === null || rendering}
                    onClick={() => void render(source.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md border border-border px-2.5 py-2 text-left hover:border-input disabled:cursor-not-allowed",
                      source.period === null && "opacity-60"
                    )}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[13px] font-medium">{source.name}</span>
                      <span className="text-[11.5px] text-muted-foreground">
                        {source.period === null
                          ? "No completed report yet"
                          : `Latest report · ${periodText(source.period.start, source.period.end)}`}
                      </span>
                    </span>
                    {busy && <CircleNotchIcon aria-label="Rendering" className="size-4 shrink-0 animate-spin text-primary" />}
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {rendering && (
          <p role="status" className="text-xs text-muted-foreground">
            Rendering — usually a minute or two. Edits keep working meanwhile.
          </p>
        )}
        {phase.kind === "done" && (
          <p role="status" className="text-xs text-muted-foreground">
            Rendered against the report for {phase.period}.{" "}
            <a href={phase.url} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">
              Open the PDF
            </a>
            {" "}if the tab did not open. The link works for five minutes.
          </p>
        )}
        {phase.kind === "failed" && (
          <p role="alert" className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs leading-relaxed text-destructive">
            {phase.message}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
