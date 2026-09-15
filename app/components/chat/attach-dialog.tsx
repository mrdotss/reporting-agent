"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
import { MagnifyingGlassIcon, SealCheckIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ChatSources } from "@/lib/chat/sources"
import type { ChatAttachments } from "@/lib/chat/views"

/**
 * Choose what a conversation can read (ask-chat Req 2).
 *
 * Only verified reports are offered — the sources route lists nothing else — and a
 * connector with no complete scan is shown but cannot be ticked, with a link to scan it,
 * so the reason is on screen rather than implied by an absence.
 */

export const MAX_RUNS = 6
export const MAX_CONNECTORS = 4

export function AttachDialog({
  open,
  onOpenChange,
  sources,
  attachments,
  onChange,
}: Readonly<{
  open: boolean
  onOpenChange: (open: boolean) => void
  sources: ChatSources
  attachments: ChatAttachments
  onChange: (next: ChatAttachments) => void
}>) {
  const [query, setQuery] = useState("")
  const needle = query.trim().toLowerCase()

  const runGroups = useMemo(() => {
    const groups = new Map<string, ChatSources["runs"][number][]>()
    for (const run of sources.runs) {
      const haystack = `${run.customerName} ${run.periodLabel} ${run.presetName ?? ""}`.toLowerCase()
      if (needle && !haystack.includes(needle)) continue
      groups.set(run.periodLabel, [...(groups.get(run.periodLabel) ?? []), run])
    }
    return [...groups.entries()]
  }, [sources.runs, needle])

  const connectors = sources.connectors.filter((connector) =>
    needle
      ? `${connector.label} ${connector.customerName ?? ""}`.toLowerCase().includes(needle)
      : true
  )

  const toggleRun = (id: string, checked: boolean) =>
    onChange({
      ...attachments,
      runIds: checked
        ? [...attachments.runIds, id].slice(0, MAX_RUNS)
        : attachments.runIds.filter((runId) => runId !== id),
    })

  const toggleConnector = (id: string, checked: boolean) =>
    onChange({
      ...attachments,
      connectorIds: checked
        ? [...attachments.connectorIds, id].slice(0, MAX_CONNECTORS)
        : attachments.connectorIds.filter((connectorId) => connectorId !== id),
    })

  const runsFull = attachments.runIds.length >= MAX_RUNS
  const connectorsFull = attachments.connectorIds.length >= MAX_CONNECTORS

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80dvh] flex-col gap-3 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Attach usage</DialogTitle>
          <DialogDescription>
            Answers cite only what is attached. Reports must be verified; connectors use
            their latest scan.
          </DialogDescription>
        </DialogHeader>

        <label className="flex h-9 items-center gap-2 rounded-lg border border-input bg-muted px-2.5 text-muted-foreground focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
          <MagnifyingGlassIcon aria-hidden="true" className="size-4" />
          <span className="sr-only">Search reports and connectors</span>
          <input
            id="chat-attach-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search customer, period or connector"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>

        <Tabs defaultValue="reports" className="flex min-h-0 flex-1 flex-col gap-2">
          <TabsList>
            <TabsTrigger value="reports">
              Reports <span className="font-mono text-xs text-muted-foreground">{attachments.runIds.length}/{MAX_RUNS}</span>
            </TabsTrigger>
            <TabsTrigger value="connectors">
              Connectors <span className="font-mono text-xs text-muted-foreground">{attachments.connectorIds.length}/{MAX_CONNECTORS}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="reports" className="min-h-0 flex-1 overflow-y-auto">
            {runGroups.length === 0 ? (
              <p className="px-1 py-6 text-center text-meta text-muted-foreground">
                {sources.runs.length === 0
                  ? "No verified report in this workspace yet."
                  : "No report matches that."}
              </p>
            ) : (
              runGroups.map(([period, runs]) => (
                <div key={period} className="flex flex-col">
                  <span className="px-2 pt-3 pb-1 text-micro uppercase text-muted-foreground">{period}</span>
                  {runs.map((run) => {
                    const checked = attachments.runIds.includes(run.runId)
                    const id = `attach-run-${run.runId}`
                    return (
                      <label
                        key={run.runId}
                        htmlFor={id}
                        className="grid cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted has-disabled:cursor-not-allowed has-disabled:opacity-60"
                      >
                        <Checkbox
                          id={id}
                          checked={checked}
                          disabled={!checked && runsFull}
                          onCheckedChange={(value) => toggleRun(run.runId, value === true)}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{run.customerName}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {run.presetName ?? "No preset"} · {run.figureCount} figures · {run.connectorLabel}
                          </span>
                        </span>
                        <span className="inline-flex items-center gap-1 text-xs text-(--status-verified)">
                          <SealCheckIcon aria-hidden="true" className="size-3.5" />
                          Verified
                        </span>
                      </label>
                    )
                  })}
                </div>
              ))
            )}
          </TabsContent>

          <TabsContent value="connectors" className="min-h-0 flex-1 overflow-y-auto">
            {connectors.length === 0 ? (
              <p className="px-1 py-6 text-center text-meta text-muted-foreground">
                {sources.connectors.length === 0
                  ? "No connector in this workspace yet."
                  : "No connector matches that."}
              </p>
            ) : (
              connectors.map((connector) => {
                const checked = attachments.connectorIds.includes(connector.id)
                const id = `attach-connector-${connector.id}`
                const scanned = connector.scan !== null
                return (
                  <div
                    key={connector.id}
                    className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted"
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      disabled={!scanned || (!checked && connectorsFull)}
                      onCheckedChange={(value) => toggleConnector(connector.id, value === true)}
                    />
                    <label htmlFor={id} className="min-w-0 cursor-pointer">
                      <span className="block truncate font-mono text-sm font-medium">{connector.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {connector.customerName ?? "No customer"}
                        {scanned ? ` · scanned ${connector.scan?.collectedAt.slice(0, 10)}` : ""}
                      </span>
                    </label>
                    {scanned ? (
                      <span className="text-xs text-muted-foreground">Latest scan</span>
                    ) : (
                      <Link
                        href={`/subscriptions?c=${encodeURIComponent(connector.id)}`}
                        className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                      >
                        Scan first
                      </Link>
                    )}
                  </div>
                )
              })
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <p className="mr-auto self-center text-xs text-muted-foreground">
            {attachments.runIds.length + attachments.connectorIds.length} attached
          </p>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
