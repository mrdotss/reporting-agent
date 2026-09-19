"use client"

import { useEffect, useRef, useState } from "react"
import {
  ArrowUpIcon,
  FileTextIcon,
  LightningIcon,
  PaperclipIcon,
  PlugsIcon,
  XIcon,
} from "@phosphor-icons/react"

import type { AttachmentKind } from "@/components/chat/context-panel"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CHAT_MODELS, DEFAULT_CHAT_MODEL, isChatModelId, type ChatModelId } from "@/lib/chat/models"
import type { AttachableConnector, AttachableLive, AttachableRun } from "@/lib/chat/sources"
import { CHAT_PROMPT_MAX } from "@/lib/chat/views"

const MODEL_KEY = "rpt.ask.model"

/**
 * Where a question is written, beside what it will be answered from.
 *
 * Sending is refused with nothing attached — not silently disabled — because the reason
 * is the product's rule: an answer can only cite what is attached.
 */
export function Composer({
  runs,
  connectors,
  live,
  busy,
  onSend,
  onAttach,
  onRemove,
}: Readonly<{
  runs: readonly AttachableRun[]
  connectors: readonly AttachableConnector[]
  live: readonly AttachableLive[]
  busy: boolean
  onSend: (question: string, model: ChatModelId) => Promise<boolean>
  onAttach: () => void
  onRemove: (kind: AttachmentKind, id: string) => void
}>) {
  const [draft, setDraft] = useState("")
  const [model, setModel] = useState<ChatModelId>(DEFAULT_CHAT_MODEL)
  const [notice, setNotice] = useState("")
  const input = useRef<HTMLTextAreaElement>(null)
  const nothingAttached = runs.length === 0 && connectors.length === 0 && live.length === 0

  // The last pick is a per-browser convenience; without storage the default simply stands.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(MODEL_KEY)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring a stored preference after hydration
      if (isChatModelId(saved)) setModel(saved)
    } catch {
      // Storage unavailable: keep the default.
    }
  }, [])

  function chooseModel(value: ChatModelId) {
    setModel(value)
    try {
      window.localStorage.setItem(MODEL_KEY, value)
    } catch {
      // Storage unavailable: the pick still applies to this page.
    }
  }

  async function submit() {
    const question = draft.trim()
    if (!question || busy) return
    if (nothingAttached) {
      setNotice("Attach a verified report, a scanned connector or live metrics first.")
      return
    }
    setNotice("")
    setDraft("")
    const sent = await onSend(question, model)
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
            {live.map((pull) => (
              <Chip
                key={pull.id}
                icon={<LightningIcon className="size-3.5 text-muted-foreground" />}
                label={pull.resourceNames.join(", ")}
                detail={`live · ${pull.windowLabel}`}
                onRemove={() => onRemove("live", pull.id)}
              />
            ))}
            {connectors.map((connector) => (
              <Chip
                key={connector.id}
                icon={<PlugsIcon className="size-3.5 text-primary" />}
                label={connector.label}
                detail="inventory"
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
              ? "Attach a report or live metrics to start asking…"
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
          <Select value={model} onValueChange={(value) => isChatModelId(value) && chooseModel(value)}>
            <SelectTrigger
              size="sm"
              aria-label="Model"
              className="ml-auto h-8 border-transparent bg-transparent px-2 text-xs text-muted-foreground hover:bg-muted"
            >
              <SelectValue>{(value) => CHAT_MODELS.find((entry) => entry.id === value)?.label ?? ""}</SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              {CHAT_MODELS.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  <span className="flex flex-col gap-0.5">
                    <span>{entry.label}</span>
                    <span className="text-xs font-normal text-muted-foreground">{entry.detail}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="submit"
            size="icon-sm"
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
