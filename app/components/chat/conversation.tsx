"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  BookOpenTextIcon,
  BrainIcon,
  CaretDownIcon,
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  WarningIcon,
} from "@phosphor-icons/react"

import { FigureLedger } from "@/components/chat/figure-ledger"
import { FigureTraceProvider } from "@/components/chat/figure-trace"
import { MessageText } from "@/components/chat/message-text"
import { ProposalCard } from "@/components/chat/proposal-card"
import { Button } from "@/components/ui/button"
import type { LiveTurn } from "@/hooks/useChatStream"
import {
  answerFigures,
  estimateCount,
  figureNumbers,
  tallyFigures,
} from "@/lib/chat/figures"
import { chatModelLabel } from "@/lib/chat/models"
import { cn } from "@/lib/utils"
import {
  answerPlainText,
  type ChatKnowledgeSource,
  type ChatMessageView,
  type ChatProposal,
  type ChatStep,
} from "@/lib/chat/views"

/**
 * The conversation: questions, and answers with their steps, figures and proposals.
 */

const TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta",
  hour: "2-digit",
  minute: "2-digit",
})

/** The figure open in the trace panel: which answer, and which of its figures. */
export type FigureSelection = {
  readonly messageId: string
  readonly factId: string
}

export function Conversation({
  threadId,
  messages,
  live,
  currentUserId,
  canRequest,
  emptyState,
  selectedFigure,
  onSelectFigure,
  onProposalChange,
}: Readonly<{
  threadId: string | null
  messages: readonly ChatMessageView[]
  live: LiveTurn | null
  currentUserId: string
  canRequest: boolean
  /** Shown while nothing has been asked: where a new question picks its sources. */
  emptyState: React.ReactNode
  selectedFigure: FigureSelection | null
  /** Choosing the open figure again closes it, so the same call serves both. */
  onSelectFigure: (selection: FigureSelection | null) => void
  onProposalChange: (messageId: string, proposal: ChatProposal) => void
}>) {
  const end = useRef<HTMLDivElement>(null)
  const fresh = useFreshAnswer(messages, live)

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" })
  }, [messages.length, live?.text, live?.steps.length])

  const empty = messages.length === 0 && live === null

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      aria-live="polite"
      aria-busy={live !== null}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 md:px-7">
        {empty ? emptyState : null}

        {messages.map((message) =>
          message.role === "user" ? (
            <Question
              key={message.id}
              text={message.text}
              byYou={message.authorId === currentUserId}
              time={TIME.format(new Date(message.createdAt))}
            />
          ) : (
            <AssistantMessage
              key={message.id}
              message={message}
              fresh={message.id === fresh}
              selectedFactId={
                selectedFigure?.messageId === message.id
                  ? selectedFigure.factId
                  : null
              }
              onSelectFigure={(factId) =>
                onSelectFigure(
                  selectedFigure?.messageId === message.id &&
                    selectedFigure.factId === factId
                    ? null
                    : { messageId: message.id, factId }
                )
              }
            >
              {message.proposal !== undefined && threadId !== null ? (
                <ProposalCard
                  threadId={threadId}
                  messageId={message.id}
                  proposal={message.proposal}
                  canRequest={canRequest}
                  onChange={(proposal) =>
                    onProposalChange(message.id, proposal)
                  }
                />
              ) : null}
            </AssistantMessage>
          )
        )}

        {/*
          The question shows at once. When the route accepts it, the stored message joins
          `messages` and this placeholder steps aside for it.
        */}
        {live !== null &&
        !(
          messages.at(-1)?.role === "user" &&
          messages.at(-1)?.text === live.question
        ) ? (
          <Question text={live.question} byYou time="now" />
        ) : null}

        {live !== null ? (
          <article
            aria-label="Answer, in progress"
            className="flex min-w-0 flex-col gap-3"
          >
            <AnswerHeader />
            {live.intent ? <Intent text={live.intent} typing={!live.text} /> : null}
            <Steps steps={live.steps} working={!live.text} />
            {live.thinking ? (
              <Thinking
                text={live.thinking}
                since={live.thinkingSince}
                thoughtSeconds={live.text ? live.thoughtSeconds : undefined}
              />
            ) : null}
            {live.text ? (
              <MessageText text={live.text} citations={{}} streaming />
            ) : live.steps.length === 0 && !live.intent ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <span aria-hidden="true" className="size-2 rounded-full bg-primary ask-pulse" />
                <span className="ask-shimmer">Starting…</span>
              </p>
            ) : null}
          </article>
        ) : null}

        <div ref={end} />
      </div>
    </div>
  )
}

/** A question: who asked and when, then the words, set in the well like an input's own. */
function Question({
  text,
  byYou,
  time,
}: Readonly<{ text: string; byYou: boolean; time: string }>) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">
        {byYou ? "You asked" : "A teammate asked"} · {time}
      </span>
      <p className="max-w-[62ch] rounded-lg bg-muted px-4 py-3 text-[0.9375rem] leading-relaxed font-medium whitespace-pre-wrap">
        {text}
      </p>
    </div>
  )
}

/** The label that sets an answer apart from the question above it, with how it was made. */
function AnswerHeader({
  model,
  thoughtSeconds,
}: Readonly<{ model?: string; thoughtSeconds?: number }>) {
  const label = chatModelLabel(model)
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="text-micro text-primary uppercase">Answer</span>
      {label ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{label}</span>
        </>
      ) : null}
      {thoughtSeconds !== undefined ? (
        <>
          <span aria-hidden="true">·</span>
          <span>Thought for {formatSeconds(thoughtSeconds)}</span>
        </>
      ) : null}
    </div>
  )
}

function AssistantMessage({
  message,
  fresh,
  selectedFactId,
  onSelectFigure,
  children,
}: Readonly<{
  message: ChatMessageView
  /** Just replaced the live answer: its figures pop in and its charts draw once. */
  fresh: boolean
  selectedFactId: string | null
  onSelectFigure: (factId: string) => void
  children: React.ReactNode
}>) {
  const [copied, setCopied] = useState(false)
  const figures = useMemo(
    () => answerFigures(message.text, message.citations, message.charts),
    [message.text, message.citations, message.charts]
  )
  const trace = useMemo(
    () => ({
      numbers: figureNumbers(figures),
      selectedId: selectedFactId,
      onSelect: onSelectFigure,
    }),
    [figures, selectedFactId, onSelectFigure]
  )
  const tally = useMemo(
    () => tallyFigures(figures, estimateCount(message.text)),
    [figures, message.text]
  )
  const answered = !message.failed && !message.refused

  return (
    <article
      aria-label="Answer"
      data-fresh={fresh || undefined}
      className={cn(
        "flex min-w-0 flex-col gap-3.5",
        fresh &&
          "[&_[data-slot=answer-chart]_svg]:animate-[ask-reveal_1.6s_cubic-bezier(0.4,0,0.2,1)_both] [&_[data-slot=figure-chip]]:animate-[ask-pop_0.35s_cubic-bezier(0.2,0.8,0.2,1.2)_both]"
      )}
    >
      <AnswerHeader
        model={answered ? message.model : undefined}
        thoughtSeconds={answered ? message.thoughtSeconds : undefined}
      />
      {message.intent ? <Intent text={message.intent} /> : null}
      {message.steps.length > 0 ? (
        <Steps steps={message.steps.map((step) => ({ ...step, done: true }))} />
      ) : null}

      {message.failed ? (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <WarningIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {message.text}
        </p>
      ) : (
        <FigureTraceProvider value={trace}>
          <MessageText
            text={message.text}
            citations={message.citations}
            charts={message.charts}
          />
        </FigureTraceProvider>
      )}

      {message.unavailableRuns ? (
        <Note>
          {message.unavailableRuns === 1
            ? "One attached report"
            : `${message.unavailableRuns} attached reports`}{" "}
          couldn&rsquo;t be read — no longer verified, or changed since. The
          answer doesn&rsquo;t use{" "}
          {message.unavailableRuns === 1 ? "it" : "them"}.
        </Note>
      ) : null}
      {message.knowledge ? (
        <KnowledgeSources sources={message.knowledge} />
      ) : null}

      {message.pricesUnavailable ? (
        <Note>
          Some list prices couldn&rsquo;t be looked up, so costs for those sizes
          aren&rsquo;t included.
        </Note>
      ) : null}

      {answered ? (
        <FigureLedger
          figures={figures}
          tally={tally}
          selectedId={selectedFactId}
          onSelect={onSelectFigure}
        />
      ) : null}

      {children}

      {answered ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{TIME.format(new Date(message.createdAt))}</span>
          {figures.length === 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>No figures cited</span>
            </>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-muted-foreground"
            aria-label={copied ? "Copied" : "Copy answer"}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(answerPlainText(message.text))
                .then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
            }}
          >
            {copied ? (
              <CheckIcon aria-hidden="true" />
            ) : (
              <CopyIcon aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : null}
    </article>
  )
}

/**
 * What the answer is doing, one line per step.
 *
 * While the answer is being made each step rises in with a spinner, its label
 * shimmering, and ticks to a check when it is done. Once the answer starts streaming the
 * list folds to one line, "N steps", so the answer has the room; it opens again on a
 * click. A stored answer shows the folded line from the start.
 */
function Steps({
  steps,
  working = false,
}: Readonly<{
  steps: readonly (ChatStep & { readonly done: boolean })[]
  working?: boolean
}>) {
  if (steps.length === 0) return null
  const finished = steps.every((step) => step.done)
  const running = working && !finished
  return (
    <details open={working} className="group rounded-xl border border-border bg-card">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 text-xs text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden">
        {running ? (
          <CircleNotchIcon
            aria-hidden="true"
            className="size-3.5 animate-spin text-primary motion-reduce:animate-none"
          />
        ) : (
          <CheckIcon
            aria-hidden="true"
            weight="bold"
            className="size-3.5 text-(--status-verified)"
          />
        )}
        {running
          ? `Working · ${steps.filter((step) => step.done).length} of ${steps.length} done`
          : `${steps.length} ${steps.length === 1 ? "step" : "steps"}`}
        <CaretDownIcon
          aria-hidden="true"
          className="ml-auto size-3.5 transition-transform group-open:rotate-180"
        />
      </summary>
      <ol className="flex flex-col gap-1.5 px-3 pb-3">
        {steps.map((step, index) => (
          <li
            key={`${step.name}-${index}`}
            className={
              working
                ? "ask-rise flex items-start gap-2.5 text-xs"
                : "flex items-start gap-2.5 text-xs"
            }
          >
            <span aria-hidden="true" className="mt-px grid size-4 shrink-0 place-items-center">
              {step.done ? (
                <span className={working ? "ask-pop grid size-4 place-items-center rounded-full bg-(--status-verified-soft)" : "grid size-4 place-items-center rounded-full bg-(--status-verified-soft)"}>
                  <CheckIcon weight="bold" className="size-2.5 text-(--status-verified)" />
                </span>
              ) : (
                <CircleNotchIcon className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
              )}
            </span>
            <span className="min-w-0 leading-relaxed">
              <span
                className={
                  step.done || !working
                    ? "font-medium text-foreground"
                    : "ask-shimmer font-medium"
                }
              >
                {step.label}
              </span>
              {step.status ? (
                <span className="text-muted-foreground"> · {step.status}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </details>
  )
}

/**
 * The id of the stored answer that has just replaced the live one, for a few seconds.
 *
 * A conversation opened later, or an answer already on the page, is never fresh: only
 * the turn from "being made" to "made" plays the arrival.
 */
function useFreshAnswer(
  messages: readonly ChatMessageView[],
  live: LiveTurn | null
): string | null {
  const [fresh, setFresh] = useState<string | null>(null)
  const wasLive = useRef(false)

  useEffect(() => {
    if (live !== null) {
      wasLive.current = true
      return
    }
    if (!wasLive.current) return
    wasLive.current = false
    const last = messages.at(-1)
    if (last?.role !== "assistant") return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marking the answer that just arrived
    setFresh(last.id)
    const timer = setTimeout(() => setFresh(null), 4000)
    return () => clearTimeout(timer)
  }, [live, messages])

  return fresh
}

/**
 * The provider guidance an answer drew on: each documentation page as a link to it, and a
 * skill with no page read by name. Guidance, not figures — the green chips remain the only
 * numbers the answer proves.
 */
function KnowledgeSources({
  sources,
}: Readonly<{ sources: readonly ChatKnowledgeSource[] }>) {
  return (
    <div
      data-slot="knowledge-sources"
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground"
    >
      <span className="inline-flex items-center gap-1 font-medium">
        <BookOpenTextIcon
          aria-hidden="true"
          className="size-3.5 translate-y-0.5"
        />
        Guidance from
      </span>
      {sources.map((source, index) => (
        <span key={`${source.skill}-${index}`} className="min-w-0">
          {source.url ? (
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground"
            >
              {source.title}
            </a>
          ) : (
            <span>{source.title}</span>
          )}
          <span className="ml-1 tracking-wide uppercase">
            {source.provider === "aws" ? "AWS" : "Azure"}
          </span>
          {index < sources.length - 1 ? (
            <span aria-hidden="true"> ·</span>
          ) : null}
        </span>
      ))}
    </div>
  )
}

/**
 * What the assistant set out to do, in its own words, ahead of the answer. While the
 * answer is still being worked out the line ends in a caret, as if being typed.
 */
function Intent({ text, typing = false }: Readonly<{ text: string; typing?: boolean }>) {
  return (
    <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
      {text}
      {typing ? <span aria-hidden="true" className="ask-caret" /> : null}
    </p>
  )
}

function formatSeconds(seconds: number): string {
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/**
 * The answer model's reasoning while it works. Open and ticking until the answer starts,
 * then folded to "Thought for Ns". The runtime has already masked every number in it, and
 * the note says so: the checked figures are the ones in the answer.
 */
function Thinking({
  text,
  since,
  thoughtSeconds,
}: Readonly<{
  text: string
  since: number | undefined
  thoughtSeconds: number | undefined
}>) {
  const done = thoughtSeconds !== undefined
  const [now, setNow] = useState(() => Date.now())
  const notes = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    if (done) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [done])

  useEffect(() => {
    const element = notes.current
    if (element && !done) element.scrollTop = element.scrollHeight
  }, [text, done])

  const elapsed = done
    ? thoughtSeconds
    : since === undefined
      ? 0
      : Math.max(0, Math.round((now - since) / 1000))

  return (
    <details open={!done} className="group rounded-xl border border-border">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 text-xs text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden">
        <BrainIcon
          aria-hidden="true"
          className={
            done
              ? "size-3.5"
              : "size-3.5 animate-pulse text-(--status-inflight) motion-reduce:animate-none"
          }
        />
        {done ? (
          `Thought for ${formatSeconds(elapsed)}`
        ) : (
          <>
            <span className="ask-shimmer">Thinking…</span>
            <span className="font-mono tabular-nums">{formatSeconds(elapsed)}</span>
          </>
        )}
        <CaretDownIcon
          aria-hidden="true"
          className="ml-auto size-3.5 transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-1.5 px-3 pb-2.5">
        <p
          ref={notes}
          className="max-h-40 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground"
        >
          {text}
        </p>
        <p className="text-[0.6875rem] text-muted-foreground">
          Working notes. Numbers are hidden here; the answer shows the checked
          figures.
        </p>
      </div>
    </details>
  )
}

function Note({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-(--status-attention-soft) px-3 py-2 text-xs leading-relaxed text-(--status-attention)">
      <WarningIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  )
}
