"use client"

import { ArrowRightIcon, CircleNotchIcon, SparkleIcon } from "@phosphor-icons/react"
import { useState } from "react"

import { ASK_REQUEST_MAX_LENGTH, applyAsk, askBlock, type AskChange, type AskValues } from "@/components/builder/ask"
import { useBuilder, useBuilderStore, useEnvironment } from "@/components/builder/context"
import type { BlockRef } from "@/lib/builder/store"

/**
 * Ask on the selected block: a wish in words, answered as a before and after of the block's
 * own settings, to apply or discard.
 *
 * Applying replaces the draft with the answer in one edit, so one undo takes it back. The
 * answer only ever sets what the inspector could set by hand (`components/builder/ask.ts`),
 * and what it could not do is listed rather than guessed at.
 */

type Answer = {
  readonly set: AskValues
  readonly changes: readonly AskChange[]
  readonly summary: string
  readonly notApplied: readonly string[]
}

type State =
  | { readonly kind: "idle" }
  | { readonly kind: "asking" }
  | { readonly kind: "answered"; readonly answer: Answer }
  | { readonly kind: "failed"; readonly message: string }

export function AskPanel({ sectionId, ref_ }: Readonly<{ sectionId: string; ref_: BlockRef }>) {
  const store = useBuilderStore()
  const { catalog } = useEnvironment()
  const definition = useBuilder((state) => state.definition)
  const edit = useBuilder((state) => state.edit)
  const [request, setRequest] = useState("")
  const [state, setState] = useState<State>({ kind: "idle" })
  const block = askBlock(definition, sectionId, ref_)
  if (block === null || block.fields.length === 0) return null

  const ask = async () => {
    const wish = request.trim()
    if (wish === "" || state.kind === "asking") return
    setState({ kind: "asking" })
    try {
      const response = await fetch("/api/report-profiles/ask-block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ definition: store.getState().definition, sectionId, ref: ref_, request: wish }),
      })
      const body = (await response.json()) as Partial<Answer> & { error?: { message?: string } }
      if (!response.ok || body.set === undefined) {
        setState({ kind: "failed", message: body.error?.message ?? "Ask could not answer just now. Nothing was changed." })
        return
      }
      setState({
        kind: "answered",
        answer: { set: body.set, changes: body.changes ?? [], summary: body.summary ?? "", notApplied: body.notApplied ?? [] },
      })
    } catch {
      setState({ kind: "failed", message: "The server could not be reached. Nothing was changed." })
    }
  }

  const apply = (answer: Answer) => {
    const next = applyAsk(store.getState().definition, catalog, sectionId, ref_, answer.set)
    edit(() => next)
    setRequest("")
    setState({ kind: "idle" })
  }

  const reach = block.fields
    .map((field) => field.label.replace(/ \((English|Indonesian)\)$/, ""))
    .filter((label, index, all) => all.indexOf(label) === index)

  return (
    <section aria-label="Ask about this block" data-slot="ask-block" className="flex flex-col gap-2 rounded-xl border border-border bg-card p-2.5">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void ask()
        }}
        className="flex items-center gap-1.5"
      >
        <SparkleIcon aria-hidden weight="fill" className="size-4 shrink-0 text-primary" />
        <input
          aria-label="Ask for a change to this block"
          placeholder="Ask for a change to this block"
          maxLength={ASK_REQUEST_MAX_LENGTH}
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          disabled={request.trim() === "" || state.kind === "asking"}
          className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-2.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {state.kind === "asking" ? <CircleNotchIcon aria-hidden className="size-3.5 animate-spin" /> : null}
          Ask
        </button>
      </form>

      {state.kind === "idle" && (
        <p className="text-[11.5px] leading-snug text-muted-foreground">It can change: {reach.join(", ")}.</p>
      )}
      {state.kind === "asking" && <p role="status" className="text-[12.5px] text-muted-foreground">Asking…</p>}
      {state.kind === "failed" && (
        <p role="alert" className="text-[12.5px] text-[var(--status-failed)]">
          {state.message}
        </p>
      )}
      {state.kind === "answered" && (
        <div className="flex flex-col gap-2">
          {state.answer.summary !== "" && state.answer.changes.length > 0 && (
            <p className="text-[12.5px] leading-snug">{state.answer.summary}</p>
          )}
          {state.answer.changes.length === 0 ? (
            <p role="status" className="text-[12.5px] text-muted-foreground">
              Nothing to change on this block.
            </p>
          ) : (
            <ul aria-label="Before and after" className="flex flex-col gap-1">
              {state.answer.changes.map((change) => (
                <li key={change.key} className="flex flex-col gap-0.5 rounded-lg bg-muted px-2 py-1.5">
                  <span className="text-[11px] font-medium text-muted-foreground">{change.label}</span>
                  <span className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                    <span className="text-muted-foreground line-through decoration-1">{change.before}</span>
                    <ArrowRightIcon aria-label="becomes" className="size-3 shrink-0 text-muted-foreground" />
                    <span className="font-medium">{change.after}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {state.answer.notApplied.length > 0 && (
            <div className="rounded-lg bg-[var(--status-attention-soft)] px-2 py-1.5 text-[12px] leading-snug">
              <span className="font-medium text-[var(--status-attention)]">Not changed</span>
              <ul className="mt-0.5 list-disc pl-4">
                {state.answer.notApplied.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex gap-1.5">
            {state.answer.changes.length > 0 && (
              <button
                type="button"
                onClick={() => apply(state.answer)}
                className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90"
              >
                Apply
              </button>
            )}
            <button
              type="button"
              onClick={() => setState({ kind: "idle" })}
              className="inline-flex h-7 items-center rounded-md border border-border px-2.5 text-[12.5px] font-medium hover:bg-muted"
            >
              {state.answer.changes.length > 0 ? "Discard" : "Close"}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
