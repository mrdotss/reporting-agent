"use client"

import { useRef, useState } from "react"
import { ArrowUpIcon, FileTextIcon, PaperclipIcon, PlugsIcon, XIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import type { AttachableConnector, AttachableRun } from "@/lib/chat/sources"
import { CHAT_PROMPT_MAX } from "@/lib/chat/views"

/**
 * Where a question is written, beside what it will be answered from.
 *
 * Sending is refused with nothing attached — not silently disabled — because the reason
 * is the product's rule: an answer can only cite what is attached.
 */
export function Composer({
  runs,
  connectors,
  busy,
  onSend,
  onAttach,
  onRemove,
}: Readonly<{
  runs: readonly AttachableRun[]
  connectors: readonly AttachableConnector[]
  busy: boolean
  onSend: (question: string) => Promise<boolean>
  onAttach: () => void
  onRemove: (kind: "run" | "connector", id: string) => void
}>) {
  const [draft, setDraft] = useState("")
  const [notice, setNotice] = useState("")
  const input = useRef<HTMLTextAreaElement>(null)
  const nothingAttached = runs.length === 0 && connectors.length === 0

  async function submit() {
    const question = draft.trim()
    if (!question || busy) return
    if (nothingAttached) {
      setNotice("Attach a verified report or a scanned connector first.")
      return
    }
    setNotice("")
    setDraft("")
    const sent = await onSend(question)
    if (!sent) setDraft(question)
    input.current?.focus()
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      className="mx-auto w-full max-w-3xl px-4 pt-2 pb-4"
    >
      <div className="rounded-2xl border border-input bg-card shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
        {nothingAttached ? null : (
          <ul aria-label="Attached" className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
            {runs.map((run) => (
              <Chip
                key={run.runId}
                icon={<FileTextIcon className="size-3.5 text-primary" />}
                label={run.customerName}
                detail={run.periodLabel}
                onRemove={() => onRemove("run", run.runId)}
              />
            ))}
            {connectors.map((connector) => (
              <Chip
                key={connector.id}
                icon={<PlugsIcon className="size-3.5 text-primary" />}
                label={connector.label}
                detail="live"
                onRemove={() => onRemove("connector", connector.id)}
              />
            ))}
          </ul>
        )}

        <label htmlFor="chat-prompt" className="sr-only">
          Ask about the attached usage
        </label>
        <textarea
          id="chat-prompt"
          ref={input}
          value={draft}
          maxLength={CHAT_PROMPT_MAX}
          rows={1}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder={
            nothingAttached
              ? "Attach a report to start asking…"
              : "Ask about the attached usage — e.g. which VMs could move down a size?"
          }
          className="block max-h-44 min-h-12 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[0.9375rem] leading-relaxed outline-none [field-sizing:content] placeholder:text-muted-foreground"
        />

        <div className="flex items-center gap-2 px-2 pt-1 pb-2">
          <Button type="button" variant="ghost" size="sm" onClick={onAttach}>
            <PaperclipIcon aria-hidden="true" />
            Attach
          </Button>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> for a new line
          </span>
          <Button
            type="submit"
            size="icon-sm"
            className="ml-auto"
            disabled={busy || draft.trim().length === 0}
            aria-label="Send question"
          >
            <ArrowUpIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
      {notice ? (
        <p role="status" className="mt-1.5 px-1 text-xs text-(--status-attention)">
          {notice}
        </p>
      ) : null}
    </form>
  )
}

function Chip({
  icon,
  label,
  detail,
  onRemove,
}: Readonly<{ icon: React.ReactNode; label: string; detail: string; onRemove: () => void }>) {
  return (
    <li className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg bg-primary/[0.06] pr-1 pl-2 text-xs ring-1 ring-primary/15 ring-inset">
      <span aria-hidden="true">{icon}</span>
      <span className="truncate font-medium">{label}</span>
      <span className="shrink-0 font-mono text-muted-foreground">{detail}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Detach ${label}`}
        className="grid size-5 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        <XIcon aria-hidden="true" className="size-3" />
      </button>
    </li>
  )
}
