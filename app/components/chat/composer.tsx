"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowUpIcon, PaperclipIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { ModelPicker } from "@/components/chat/models-picker"
import {
  DEFAULT_CHAT_MODEL,
  isChatModelId,
  type ChatModelId,
} from "@/lib/chat/models"
import { CHAT_PROMPT_MAX } from "@/lib/chat/views"

const MODEL_KEY = "rpt.ask.model"

/**
 * Where a question is written.
 *
 * What it will be answered from is shown above the conversation (`SourceDocket`), so the
 * box holds only the question, the model and the send button. Sending is refused with
 * nothing attached — not silently disabled — because the reason is the product's rule: an
 * answer can only cite what is attached.
 *
 * Under the box, a one-line key to the three kinds of figure an answer holds. It replaces a
 * legend that used to sit in a side panel nobody scrolled to.
 */
export function Composer({
  attachedCount,
  busy,
  onSend,
  onAttach,
}: Readonly<{
  attachedCount: number
  busy: boolean
  onSend: (question: string, model: ChatModelId) => Promise<boolean>
  onAttach: () => void
}>) {
  const [draft, setDraft] = useState("")
  const [model, setModel] = useState<ChatModelId>(DEFAULT_CHAT_MODEL)
  const [notice, setNotice] = useState("")
  const input = useRef<HTMLTextAreaElement>(null)
  const nothingAttached = attachedCount === 0

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
      setNotice(
        "Choose a verified report, a scanned connector or live metrics first."
      )
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
      className="pt-2 pb-3"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 md:px-7">
        <div className="rounded-xl border border-input bg-background transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
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
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                void submit()
              }
            }}
            placeholder={
              nothingAttached
                ? "Choose at least one source to start"
                : "Ask about the attached usage — e.g. which VMs could move down a size?"
            }
            className="block [field-sizing:content] max-h-44 min-h-14 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[0.9375rem] leading-relaxed outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-2 px-2 pt-1 pb-2">
            <Button type="button" variant="ghost" size="sm" onClick={onAttach}>
              <PaperclipIcon aria-hidden="true" />
              Attach
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <ModelPicker
                value={model}
                onChange={chooseModel}
                disabled={busy}
              />
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
        </div>

        {notice ? (
          <p role="status" className="px-1 text-xs text-(--status-attention)">
            {notice}
          </p>
        ) : null}

        <FigureKey />
      </div>
    </form>
  )
}

/** The three kinds of figure an answer holds, drawn as they are drawn in an answer. */
export function FigureKey() {
  return (
    <ul
      aria-label="How figures are marked"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground"
    >
      <li className="inline-flex items-center gap-1.5">
        <span className="rounded-[4px] bg-(--status-verified-soft) px-1 font-mono text-[0.6875rem] font-medium text-(--status-verified)">
          6.2%
        </span>
        traced to a verified report or price
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span className="rounded-[4px] border border-dashed border-input bg-muted px-1 font-mono text-[0.6875rem] font-medium text-foreground">
          4.1%
        </span>
        live, not verified
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span className="font-mono text-[0.6875rem] text-foreground underline decoration-(--status-attention) decoration-dotted decoration-[1.5px] underline-offset-4">
          ~$70
        </span>
        estimate
      </li>
      <li className="ml-auto hidden sm:block">
        Enter to send · Shift+Enter for a new line
      </li>
    </ul>
  )
}
