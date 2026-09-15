"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { ArrowRightIcon, FilePlusIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ChatProposal } from "@/lib/chat/views"
import type { TemplateView } from "@/lib/db/views"

/**
 * A report the assistant proposed, waiting for a person (ask-chat Req 6).
 *
 * Nothing was requested when this card appears. Requesting goes through the same enqueue
 * as the Reports form — the preset chosen here decides the period, scope and document —
 * and a teammate without edit access sees the proposal but not the button.
 */
export function ProposalCard({
  threadId,
  messageId,
  proposal,
  canRequest,
  onChange,
}: Readonly<{
  threadId: string
  messageId: string
  proposal: ChatProposal
  canRequest: boolean
  onChange: (proposal: ChatProposal) => void
}>) {
  const [presets, setPresets] = useState<TemplateView[] | null>(null)
  const [templateId, setTemplateId] = useState("")
  const [revision, setRevision] = useState("1.0")
  const [note, setNote] = useState("Requested from Ask")
  const [author, setAuthor] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const endpoint = `/api/chat/threads/${encodeURIComponent(threadId)}/proposals/${encodeURIComponent(messageId)}`
  const open = proposal.state === "open"

  useEffect(() => {
    if (!open || !canRequest) return
    let cancelled = false
    fetch(endpoint)
      .then((response) => (response.ok ? response.json() : Promise.reject(response)))
      .then((body: { presets: TemplateView[] }) => {
        if (cancelled) return
        setPresets(body.presets)
        setTemplateId((current) => current || body.presets[0]?.id || "")
      })
      .catch(() => {
        if (!cancelled) setPresets([])
      })
    return () => {
      cancelled = true
    }
  }, [endpoint, open, canRequest])

  const selected = presets?.find((preset) => preset.id === templateId)
  const needsFrontMatter = (selected?.schemaVersion ?? 1) >= 2
  const presetFieldId = `proposal-preset-${messageId}`

  async function act(body: Record<string, unknown>) {
    setBusy(true)
    setError("")
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const result = (await response.json().catch(() => null)) as
        | { proposal?: ChatProposal; error?: { message?: string } }
        | null
      if (!response.ok || result?.proposal === undefined) {
        setError(result?.error?.message ?? "That didn’t go through. Try again.")
        return
      }
      onChange(result.proposal)
    } catch {
      setError("That didn’t go through. Check your connection.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-label="Proposed report"
      className="flex flex-col gap-3 rounded-xl border border-border bg-muted/40 p-3.5"
    >
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <FilePlusIcon aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Request a report for {proposal.customerName}?</p>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">{proposal.connectorLabel}</span> · the preset&rsquo;s
            period rule decides the window
          </p>
        </div>
      </div>

      {proposal.state === "requested" ? (
        <p className="flex items-center gap-2 text-sm text-(--status-inflight)">
          Requested.
          {proposal.runId ? (
            <Link
              href={`/reports/${encodeURIComponent(proposal.runId)}`}
              className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
            >
              Watch the run <ArrowRightIcon aria-hidden="true" className="size-3.5" />
            </Link>
          ) : null}
        </p>
      ) : proposal.state === "dismissed" ? (
        <p className="text-sm text-muted-foreground">Dismissed. Nothing was requested.</p>
      ) : !canRequest ? (
        <p className="text-sm text-muted-foreground">
          Someone with edit access in this workspace can request it.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={presetFieldId} className="text-xs font-medium">
              Preset
            </label>
            {presets === null ? (
              <p className="text-xs text-muted-foreground">Loading presets…</p>
            ) : presets.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No runnable preset for this connector&rsquo;s source yet.{" "}
                <Link href="/report-profiles" className="text-primary underline-offset-4 hover:underline">
                  Open Presets
                </Link>
              </p>
            ) : (
              <Select
                value={templateId}
                onValueChange={(value) => {
                  if (value) setTemplateId(value)
                }}
              >
                <SelectTrigger id={presetFieldId} className="w-full bg-card">
                  {/* A function child: the value is an id, and the trigger shows the name. */}
                  <SelectValue>
                    {(value) => {
                      const preset = presets.find((entry) => entry.id === value)
                      return preset ? `${preset.name} · v${preset.currentVersion}` : ""
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {presets.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.name} · v{preset.currentVersion}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {needsFrontMatter ? (
            <fieldset className="grid gap-2 sm:grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)]">
              <legend className="mb-1.5 text-xs font-medium">Document control row</legend>
              <SmallField id={`proposal-revision-${messageId}`} label="Revision" value={revision} onChange={setRevision} />
              <SmallField id={`proposal-note-${messageId}`} label="Note" value={note} onChange={setNote} />
              <SmallField id={`proposal-author-${messageId}`} label="Author" value={author} onChange={setAuthor} />
            </fieldset>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy || !selected || (needsFrontMatter && !author.trim())}
              onClick={() =>
                void act({
                  action: "request",
                  templateId,
                  ...(needsFrontMatter
                    ? { revisionHistoryRow: { revision, note, author } }
                    : {}),
                })
              }
            >
              {busy ? "Requesting…" : "Request report"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act({ action: "dismiss" })}>
              Dismiss
            </Button>
          </div>
        </>
      )}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}

function SmallField({
  id,
  label,
  value,
  onChange,
}: Readonly<{ id: string; label: string; value: string; onChange: (value: string) => void }>) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-[0.6875rem] text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 min-w-0 rounded-lg border border-input bg-card px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
      />
    </div>
  )
}
