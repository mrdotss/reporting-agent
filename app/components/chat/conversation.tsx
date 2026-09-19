"use client"

import { useEffect, useRef, useState } from "react"
import {
  BrainIcon,
  CaretDownIcon,
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  PaperclipIcon,
  SparkleIcon,
  WarningIcon,
} from "@phosphor-icons/react"

import { MessageText } from "@/components/chat/message-text"
import { ProposalCard } from "@/components/chat/proposal-card"
import { Button } from "@/components/ui/button"
import type { LiveTurn } from "@/hooks/useChatStream"
import {
  answerPlainText,
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

export function Conversation({
  threadId,
  messages,
  live,
  currentUserId,
  canRequest,
  hasAttachments,
  suggestions,
  onAsk,
  onAttach,
  onProposalChange,
  canChat = true,
}: Readonly<{
  threadId: string | null
  messages: readonly ChatMessageView[]
  live: LiveTurn | null
  currentUserId: string
  canRequest: boolean
  /** False for a member who can only read Ask here (roles-and-ask-access Req 6). */
  canChat?: boolean
  hasAttachments: boolean
  suggestions: readonly string[]
  onAsk: (question: string) => void
  onAttach: () => void
  onProposalChange: (messageId: string, proposal: ChatProposal) => void
}>) {
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" })
  }, [messages.length, live?.text, live?.steps.length])

  const empty = messages.length === 0 && live === null

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite" aria-busy={live !== null}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
        {empty ? (
          <EmptyConversation
            canChat={canChat}
            hasAttachments={hasAttachments}
            suggestions={suggestions}
            onAsk={onAsk}
            onAttach={onAttach}
          />
        ) : null}

        {messages.map((message) =>
          message.role === "user" ? (
            <UserBubble
              key={message.id}
              text={message.text}
              byYou={message.authorId === currentUserId}
              time={TIME.format(new Date(message.createdAt))}
            />
          ) : (
            <AssistantMessage key={message.id} message={message}>
              {message.proposal !== undefined && threadId !== null ? (
                <ProposalCard
                  threadId={threadId}
                  messageId={message.id}
                  proposal={message.proposal}
                  canRequest={canRequest}
                  onChange={(proposal) => onProposalChange(message.id, proposal)}
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
        !(messages.at(-1)?.role === "user" && messages.at(-1)?.text === live.question) ? (
          <UserBubble text={live.question} byYou time="now" />
        ) : null}

        {live !== null ? (
          <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3">
            <Avatar />
            <div className="flex min-w-0 flex-col gap-2.5">
              {live.intent ? <Intent text={live.intent} /> : null}
              <Steps steps={live.steps} working />
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
                <p className="text-sm text-muted-foreground">Starting…</p>
              ) : null}
            </div>
          </div>
        ) : null}

        <div ref={end} />
      </div>
    </div>
  )
}

function EmptyConversation({
  canChat,
  hasAttachments,
  suggestions,
  onAsk,
  onAttach,
}: Readonly<{
  canChat: boolean
  hasAttachments: boolean
  suggestions: readonly string[]
  onAsk: (question: string) => void
  onAttach: () => void
}>) {
  if (!canChat) {
    return (
      <div className="flex flex-col items-center gap-3 pt-10 text-center">
        <span className="grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
          <SparkleIcon aria-hidden="true" className="size-5" />
        </span>
        <h2 className="text-lg font-semibold tracking-tight text-balance">
          Read this workspace&rsquo;s conversations
        </h2>
        <p className="max-w-[46ch] text-meta text-muted-foreground">
          Open a conversation to read its answers and the figures they cite. Editors,
          admins and the owner can ask new questions.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-3 pt-10 text-center">
      <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
        <SparkleIcon aria-hidden="true" className="size-5" />
      </span>
      <h2 className="text-lg font-semibold tracking-tight text-balance">
        Ask about a customer&rsquo;s usage
      </h2>
      <p className="max-w-[46ch] text-meta text-muted-foreground">
        Answers cite figures from verified reports and saved scans. Anything the data
        doesn&rsquo;t state — like a cost at list price — is marked as an estimate.
      </p>
      {hasAttachments ? (
        <ul className="mt-2 flex flex-wrap justify-center gap-1.5">
          {suggestions.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                onClick={() => onAsk(suggestion)}
                className="rounded-full border border-input bg-card px-3 py-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
              >
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Button className="mt-2" onClick={onAttach}>
          <PaperclipIcon aria-hidden="true" />
          Attach a report
        </Button>
      )}
    </div>
  )
}

function UserBubble({ text, byYou, time }: Readonly<{ text: string; byYou: boolean; time: string }>) {
  return (
    <div className="flex flex-col items-end gap-1">
      <p className="max-w-[80%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap">
        {text}
      </p>
      <span className="px-1 text-xs text-muted-foreground">
        {byYou ? "You" : "Teammate"} · {time}
      </span>
    </div>
  )
}

function Avatar() {
  return (
    <span aria-hidden="true" className="grid size-7 place-items-center rounded-lg bg-primary/10 text-primary">
      <SparkleIcon className="size-3.5" />
    </span>
  )
}

function AssistantMessage({
  message,
  children,
}: Readonly<{ message: ChatMessageView; children: React.ReactNode }>) {
  const [copied, setCopied] = useState(false)
  const facts = Object.keys(message.citations).length

  return (
    <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3">
      <Avatar />
      <div className="flex min-w-0 flex-col gap-2.5">
        {message.intent ? <Intent text={message.intent} /> : null}
        {message.steps.length > 0 ? <Steps steps={message.steps.map((step) => ({ ...step, done: true }))} /> : null}

        {message.failed ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <WarningIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {message.text}
          </p>
        ) : (
          <MessageText text={message.text} citations={message.citations} charts={message.charts} />
        )}

        {message.unavailableRuns ? (
          <Note>
            {message.unavailableRuns === 1 ? "One attached report" : `${message.unavailableRuns} attached reports`}{" "}
            couldn&rsquo;t be read — no longer verified, or changed since. The answer doesn&rsquo;t use{" "}
            {message.unavailableRuns === 1 ? "it" : "them"}.
          </Note>
        ) : null}
        {message.pricesUnavailable ? (
          <Note>Some list prices couldn&rsquo;t be looked up, so costs for those sizes aren&rsquo;t included.</Note>
        ) : null}

        {children}

        {message.failed || message.refused ? null : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {message.thoughtSeconds !== undefined ? (
              <>
                <span>Thought for {formatSeconds(message.thoughtSeconds)}</span>
                <span aria-hidden="true">·</span>
              </>
            ) : null}
            <span>{facts === 0 ? "No figures cited" : `${facts} ${facts === 1 ? "figure" : "figures"} cited`}</span>
            <span aria-hidden="true">·</span>
            <span>{TIME.format(new Date(message.createdAt))}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto"
              aria-label={copied ? "Copied" : "Copy answer"}
              onClick={() => {
                void navigator.clipboard?.writeText(answerPlainText(message.text)).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }}
            >
              {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function Steps({
  steps,
  working = false,
}: Readonly<{ steps: readonly (ChatStep & { readonly done: boolean })[]; working?: boolean }>) {
  if (steps.length === 0) return null
  const finished = steps.every((step) => step.done)
  return (
    <details open={working} className="group rounded-xl border border-border">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 text-xs text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden">
        {working && !finished ? (
          <CircleNotchIcon aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
        ) : (
          <CheckIcon aria-hidden="true" className="size-3.5 text-(--status-verified)" />
        )}
        {working && !finished ? (steps[steps.length - 1]?.status || "Working…") : `${steps.length} ${steps.length === 1 ? "step" : "steps"}`}
        <CaretDownIcon aria-hidden="true" className="ml-auto size-3.5 transition-transform group-open:rotate-180" />
      </summary>
      <ol className="flex flex-col gap-1 px-3 pb-2.5 pl-8">
        {steps.map((step, index) => (
          <li key={`${step.name}-${index}`} className="relative text-xs text-muted-foreground">
            <span
              aria-hidden="true"
              className={
                step.done
                  ? "absolute top-1.5 -left-4 size-1.5 rounded-full bg-(--status-verified)"
                  : "absolute top-1 -left-4 size-2 animate-pulse rounded-full bg-(--status-inflight) motion-reduce:animate-none"
              }
            />
            <span className="font-medium text-foreground">{step.label}</span>
            {step.status ? ` — ${step.status}` : ""}
          </li>
        ))}
      </ol>
    </details>
  )
}

/** What the assistant set out to do, in its own words, ahead of the answer. */
function Intent({ text }: Readonly<{ text: string }>) {
  return <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">{text}</p>
}

function formatSeconds(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
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
}: Readonly<{ text: string; since: number | undefined; thoughtSeconds: number | undefined }>) {
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

  const elapsed = done ? thoughtSeconds : since === undefined ? 0 : Math.max(0, Math.round((now - since) / 1000))

  return (
    <details open={!done} className="group rounded-xl border border-border">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 text-xs text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden">
        <BrainIcon
          aria-hidden="true"
          className={done ? "size-3.5" : "size-3.5 animate-pulse text-(--status-inflight) motion-reduce:animate-none"}
        />
        {done ? `Thought for ${formatSeconds(elapsed)}` : `Thinking… ${formatSeconds(elapsed)}`}
        <CaretDownIcon aria-hidden="true" className="ml-auto size-3.5 transition-transform group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-1.5 px-3 pb-2.5">
        <p
          ref={notes}
          className="max-h-40 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground"
        >
          {text}
        </p>
        <p className="text-[0.6875rem] text-muted-foreground">
          Working notes. Numbers are hidden here; the answer shows the checked figures.
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
