"use client"

import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  CaretLeftIcon,
  CheckCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { useBuilder, useBuilderStore, useHistory, useIssues } from "@/components/builder/context"
import { Segmented } from "@/components/builder/left/theme-panel"
import { PreviewPdf } from "@/components/builder/preview-pdf"
import type { SaveState } from "@/components/builder/use-autosave"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { BuilderIssue } from "@/lib/builder/issues"
import { cn } from "@/lib/utils"

/**
 * Name, save state and the version that is live; edit or preview; undo; a real-figures PDF
 * of the draft; what is left to fix; publish.
 *
 * Publishing refuses while anything is left to fix and opens the list instead — each entry
 * goes to the section, block or panel that fixes it.
 */

function savedLabel(state: SaveState): string {
  if (state.kind === "saving") return "Saving…"
  if (state.kind === "saved") return "Draft · saved"
  if (state.kind === "failed") return "Not saved"
  return "Draft"
}

export function TopBar({
  templateId,
  latestVersion,
  save,
  saveState,
  revisionRef,
}: Readonly<{
  templateId: string
  latestVersion: number | null
  save: () => Promise<boolean>
  saveState: SaveState
  revisionRef: React.RefObject<number>
}>) {
  const router = useRouter()
  const store = useBuilderStore()
  const name = useBuilder((state) => state.definition.identity.name)
  const provider = useBuilder((state) => state.definition.provider)
  const mode = useBuilder((state) => state.mode)
  const setMode = useBuilder((state) => state.setMode)
  const select = useBuilder((state) => state.select)
  const setLeftTab = useBuilder((state) => state.setLeftTab)
  const { canUndo, canRedo, undo, redo } = useHistory()
  const issues = useIssues()
  const [open, setOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [live, setLive] = useState(latestVersion)

  const go = (issue: BuilderIssue) => {
    setOpen(false)
    setMode("edit")
    if ("tab" in issue.target) setLeftTab(issue.target.tab)
    else {
      setLeftTab("outline")
      select(issue.target.selection)
    }
  }

  const publish = async () => {
    if (issues.length > 0) {
      setOpen(true)
      return
    }
    setPublishing(true)
    try {
      if (!(await save())) {
        toast.error("Save the draft before publishing — it did not save.")
        return
      }
      const response = await fetch(`/api/report-profiles/${templateId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ definition: store.getState().definition, expectedRevision: revisionRef.current }),
      })
      const body = (await response.json()) as {
        version?: { version: number }
        created?: boolean
        draftRevision?: number
        error?: { message?: string; fields?: { path: string; message: string }[] }
      }
      if (!response.ok || !body.version) {
        const field = body.error?.fields?.[0]
        toast.error(body.error?.message ?? "The version could not be published.", {
          description: field ? `${field.path}: ${field.message}` : undefined,
        })
        return
      }
      if (body.draftRevision !== undefined) revisionRef.current = body.draftRevision
      setLive(body.version.version)
      toast.success(
        body.created ? `Published v${body.version.version}` : `Nothing changed since v${body.version.version}`
      )
      router.refresh()
    } catch {
      toast.error("The server could not be reached. The draft is kept.")
    } finally {
      setPublishing(false)
    }
  }

  return (
    <header className="flex min-h-[52px] flex-wrap items-center gap-2.5 border-b border-border bg-background px-3">
      <Link
        href="/report-profiles"
        aria-label="Back to presets"
        className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <CaretLeftIcon className="size-4" />
      </Link>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-semibold">{name || "Untitled preset"}</span>
        <span className="rounded bg-muted px-1.5 text-[11px] font-medium text-muted-foreground uppercase">
          {provider === "aws" ? "AWS" : "Azure"}
        </span>
        <span
          role="status"
          title={saveState.kind === "failed" ? saveState.message : undefined}
          className={cn(
            "inline-flex h-5 items-center rounded px-1.5 text-[11.5px] font-medium",
            saveState.kind === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"
          )}
        >
          {savedLabel(saveState)}
        </span>
        <span className="hidden text-xs whitespace-nowrap text-muted-foreground sm:inline">
          {live === null ? "Not published yet" : `v${live} is live`}
        </span>
      </div>

      <div className="mx-auto w-40">
        <Segmented
          label="Mode"
          value={mode}
          options={[
            { value: "edit", label: "Edit" },
            { value: "preview", label: "Preview" },
          ]}
          onChange={setMode}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <button type="button" aria-label="Undo" title="Undo (⌘Z)" disabled={!canUndo} onClick={() => undo()} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-35">
          <ArrowCounterClockwiseIcon className="size-4" />
        </button>
        <button type="button" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={() => redo()} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-35">
          <ArrowClockwiseIcon className="size-4" />
        </button>
        <PreviewPdf templateId={templateId} />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium",
              issues.length > 0
                ? "bg-[var(--status-attention-soft,#f6ecd6)] text-[var(--status-attention,#7e5104)]"
                : "text-muted-foreground"
            )}
          >
            {issues.length > 0 ? <WarningIcon className="size-3.5" /> : <CheckCircleIcon className="size-3.5" />}
            {issues.length > 0 ? `${issues.length} to fix` : "Ready"}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 gap-2 p-2">
            {issues.length === 0 ? (
              <p className="p-2 text-[13px] text-muted-foreground">Nothing to fix. This preset can be published.</p>
            ) : (
              <ul className="flex max-h-80 flex-col gap-0.5 overflow-auto">
                {issues.map((issue, index) => (
                  <li key={`${issue.path.join(".")}-${index}`}>
                    <button type="button" onClick={() => go(issue)} className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-muted">
                      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{issue.label}</span>
                      <span className="text-[13px] leading-snug">{issue.message}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </PopoverContent>
        </Popover>
        <button
          type="button"
          onClick={() => void publish()}
          disabled={publishing}
          className="inline-flex h-8 items-center rounded-md border border-primary bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {publishing ? "Publishing…" : `Publish v${(live ?? 0) + 1}`}
        </button>
      </div>
    </header>
  )
}
