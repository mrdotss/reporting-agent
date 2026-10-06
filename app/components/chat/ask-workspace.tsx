"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import {
  ChatsCircleIcon,
  CheckIcon,
  LinkSimpleIcon,
  PlusIcon,
} from "@phosphor-icons/react"

import { AttachDialog, MAX_LIVE } from "@/components/chat/attach-dialog"
import { Composer } from "@/components/chat/composer"
import {
  Conversation,
  type FigureSelection,
} from "@/components/chat/conversation"
import { NewQuestion } from "@/components/chat/new-question"
import {
  SourceDocket,
  type AttachmentKind,
} from "@/components/chat/source-docket"
import { ThreadList } from "@/components/chat/thread-list"
import { TracePanel } from "@/components/chat/trace-panel"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useMediaQuery } from "@/hooks/use-media-query"
import { useChatStream } from "@/hooks/useChatStream"
import {
  addTallies,
  answerFigures,
  estimateCount,
  tallyFigures,
  type FigureTally,
} from "@/lib/chat/figures"
import type { AttachableLive, ChatSources } from "@/lib/chat/sources"
import type {
  ChatAttachments,
  ChatMessageView,
  ChatProposal,
  ChatThreadView,
} from "@/lib/chat/views"

/**
 * The Ask page (ask-chat): conversations, the conversation, and what it is grounded in.
 *
 * Three panes on a wide screen: the conversations, the conversation, and the trace of one
 * figure. What the conversation rests on is not a pane — it is a row of chips under the title.
 * Under `2xl` the trace opens as a sheet on a figure's selection (from the bottom on a phone),
 * and under `lg` the conversation list becomes a sheet too, so the conversation itself always
 * has the width.
 *
 * A conversation is created on its first question, not when "New" is pressed, so the
 * workspace's list never fills with empty threads. The URL follows the open conversation
 * (`?t=`) without a navigation, so it can be copied and sent to a teammate.
 *
 * The sources are state, not props: a live metrics pull collected in the attach dialog
 * joins them and is attached at once, without reloading the page.
 *
 * A member who can only read Ask here (`canChat` false — a Viewer in a platform admin's
 * workspace, roles-and-ask-access Req 6) gets the same panes without anything that changes
 * a conversation: no New, no composer, no attaching or detaching. The routes refuse those
 * writes regardless; this is so the page never offers one.
 */

const NO_ATTACHMENTS: ChatAttachments = {
  runIds: [],
  connectorIds: [],
  liveIds: [],
}
const JSON_HEADERS = { "Content-Type": "application/json" }

export function suggestionsFor(
  runs: number,
  connectors: number,
  live = 0
): string[] {
  const suggestions: string[] = []
  if (live > 0)
    suggestions.push("How busy was CPU on these machines over the window?")
  if (runs > 0) suggestions.push("Which VMs look over-provisioned?")
  if (runs > 1)
    suggestions.push("How did usage change between the attached reports?")
  if (runs > 0 || live > 0)
    suggestions.push("What would these VM sizes cost per month at list price?")
  if (connectors > 0)
    suggestions.push("What does this connector's inventory look like?")
  return suggestions.slice(0, 3)
}

export function AskWorkspace({
  workspaceName,
  currentUserId,
  threads: initialThreads,
  sources: initialSources,
  initialThread,
  initialMessages,
  canChat,
  canRequest,
  historyUnavailable,
}: Readonly<{
  workspaceName: string
  currentUserId: string
  threads: readonly ChatThreadView[]
  sources: ChatSources
  initialThread: ChatThreadView | null
  initialMessages: readonly ChatMessageView[]
  /** Whether this member may ask here, rather than only read (roles-and-ask-access Req 6). */
  canChat: boolean
  canRequest: boolean
  historyUnavailable: boolean
}>) {
  const [threads, setThreads] =
    useState<readonly ChatThreadView[]>(initialThreads)
  const [sources, setSources] = useState<ChatSources>(initialSources)
  const [thread, setThread] = useState<ChatThreadView | null>(initialThread)
  const [messages, setMessages] =
    useState<readonly ChatMessageView[]>(initialMessages)
  const [draft, setDraft] = useState<ChatAttachments>(NO_ATTACHMENTS)
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachTab, setAttachTab] = useState<"reports" | "connectors" | "live">(
    "reports"
  )
  const [threadsOpen, setThreadsOpen] = useState(false)
  const [selected, setSelected] = useState<FigureSelection | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)
  const [error, setError] = useState("")
  const wide = useMediaQuery("(min-width: 96rem)")
  const phone = useMediaQuery("(max-width: 47.99rem)")
  const accepted = useRef(false)

  const onUserMessage = useCallback((message: ChatMessageView) => {
    accepted.current = true
    setMessages((previous) => [...previous, message])
  }, [])
  const { live, send } = useChatStream({ onUserMessage })

  const attachments = thread?.attachments ?? draft
  const liveIds = useMemo(
    () => attachments.liveIds ?? [],
    [attachments.liveIds]
  )
  const attachedRuns = useMemo(
    () => sources.runs.filter((run) => attachments.runIds.includes(run.runId)),
    [sources.runs, attachments.runIds]
  )
  const attachedConnectors = useMemo(
    () =>
      sources.connectors.filter((connector) =>
        attachments.connectorIds.includes(connector.id)
      ),
    [sources.connectors, attachments.connectorIds]
  )
  const attachedLive = useMemo(
    () => sources.live.filter((pull) => liveIds.includes(pull.id)),
    [sources.live, liveIds]
  )
  const gone =
    attachments.runIds.length +
    attachments.connectorIds.length +
    liveIds.length -
    attachedRuns.length -
    attachedConnectors.length -
    attachedLive.length

  function remember(next: ChatThreadView) {
    setThread(next)
    setThreads((previous) => [
      next,
      ...previous.filter((item) => item.id !== next.id),
    ])
  }

  function showInUrl(id: string | null) {
    window.history.replaceState(
      null,
      "",
      id === null ? "/ask" : `/ask?t=${encodeURIComponent(id)}`
    )
  }

  async function openThread(id: string) {
    setThreadsOpen(false)
    setError("")
    if (id === thread?.id) return
    setSelected(null)
    const response = await fetch(`/api/chat/threads/${encodeURIComponent(id)}`)
    if (!response.ok) {
      setError("That conversation couldn’t be opened.")
      return
    }
    const body = (await response.json()) as {
      thread: ChatThreadView
      messages: ChatMessageView[]
    }
    setThread(body.thread)
    setMessages(body.messages)
    showInUrl(body.thread.id)
  }

  /** Delete a conversation the signed-in person started. `true` when it is gone. */
  async function removeThread(id: string): Promise<boolean> {
    setError("")
    const response = await fetch(
      `/api/chat/threads/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
      }
    )
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string }
      } | null
      setError(body?.error?.message ?? "That conversation couldn’t be deleted.")
      return false
    }
    setThreads((previous) =>
      previous.filter((candidate) => candidate.id !== id)
    )
    if (thread?.id === id) startNew()
    return true
  }

  function startNew() {
    setThread(null)
    setMessages([])
    setDraft(NO_ATTACHMENTS)
    setError("")
    setSelected(null)
    setThreadsOpen(false)
    showInUrl(null)
  }

  async function changeAttachments(next: ChatAttachments) {
    if (thread === null) {
      setDraft(next)
      return
    }
    setThread({ ...thread, attachments: next })
    const response = await fetch(
      `/api/chat/threads/${encodeURIComponent(thread.id)}`,
      {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          attachments: {
            runIds: next.runIds,
            connectorIds: next.connectorIds,
            liveIds: next.liveIds ?? [],
          },
        }),
      }
    )
    if (!response.ok) {
      setError("The attachments couldn’t be saved. Try again.")
      return
    }
    remember(((await response.json()) as { thread: ChatThreadView }).thread)
  }

  function detach(kind: AttachmentKind, id: string) {
    void changeAttachments(
      kind === "run"
        ? {
            ...attachments,
            runIds: attachments.runIds.filter((runId) => runId !== id),
          }
        : kind === "connector"
          ? {
              ...attachments,
              connectorIds: attachments.connectorIds.filter(
                (connectorId) => connectorId !== id
              ),
            }
          : {
              ...attachments,
              liveIds: liveIds.filter((liveId) => liveId !== id),
            }
    )
  }

  function attachCollected(pull: AttachableLive) {
    setSources((current) => ({
      ...current,
      live: [
        { ...pull, ownerId: pull.ownerId || currentUserId },
        ...current.live.filter((entry) => entry.id !== pull.id),
      ],
    }))
    void changeAttachments({
      ...attachments,
      liveIds: [pull.id, ...liveIds.filter((id) => id !== pull.id)].slice(
        0,
        MAX_LIVE
      ),
    })
  }

  async function ask(question: string, model?: string): Promise<boolean> {
    setError("")
    let current = thread
    if (current === null) {
      const response = await fetch("/api/chat/threads", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          attachments: {
            runIds: draft.runIds,
            connectorIds: draft.connectorIds,
            liveIds: draft.liveIds ?? [],
          },
        }),
      })
      if (!response.ok) {
        setError("The conversation couldn’t be started. Try again.")
        return false
      }
      current = ((await response.json()) as { thread: ChatThreadView }).thread
      remember(current)
      showInUrl(current.id)
    }

    accepted.current = false
    const result = await send(current.id, question, model)
    if (result.ok) {
      setMessages((previous) => [
        ...previous.filter((message) => message.id !== result.message.id),
        result.message,
      ])
      remember(result.thread)
      return true
    }
    if (result.error) setError(result.error)
    // A question the route stored stays in the conversation; the composer must not offer
    // it again as an unsent draft.
    return accepted.current
  }

  function changeProposal(messageId: string, proposal: ChatProposal) {
    setMessages((previous) =>
      previous.map((message) =>
        message.id === messageId ? { ...message, proposal } : message
      )
    )
  }

  const attachedCount =
    attachedRuns.length + attachedConnectors.length + attachedLive.length
  const hasConversation = messages.length > 0 || live !== null
  const showTrace = hasConversation && thread !== null

  const customerOf = useCallback(
    (candidate: ChatThreadView): string | null => {
      const names = [
        ...sources.runs
          .filter((run) => candidate.attachments.runIds.includes(run.runId))
          .map((run) => run.customerName),
        ...sources.connectors
          .filter((connector) =>
            candidate.attachments.connectorIds.includes(connector.id)
          )
          .map((connector) => connector.customerName),
      ].filter((name): name is string => Boolean(name))
      const unique = [...new Set(names)]
      return unique.length === 0
        ? null
        : unique.length === 1
          ? unique[0]!
          : `${unique[0]} +${unique.length - 1}`
    },
    [sources]
  )

  const traceRuns = useMemo(
    () =>
      sources.runs.map((run) => ({
        runId: run.runId,
        digest: run.digest,
        verifiedAt: run.verifiedAt,
      })),
    [sources.runs]
  )

  // What the open figure is, and what every answer in the conversation holds.
  const { tracedFigure, totals } = useMemo(() => {
    let total: FigureTally = { traced: 0, live: 0, unsourced: 0, estimates: 0 }
    let open: {
      number: number
      text: string
      citation: ChatMessageView["citations"][string] | undefined
    } | null = null
    for (const message of messages) {
      if (message.role !== "assistant" || message.failed || message.refused)
        continue
      const figures = answerFigures(message.text, message.citations)
      total = addTallies(
        total,
        tallyFigures(figures, estimateCount(message.text))
      )
      if (selected?.messageId === message.id) {
        const figure = figures.find(
          (candidate) => candidate.factId === selected.factId
        )
        if (figure)
          open = {
            number: figure.number,
            text: figure.text,
            citation: figure.citation,
          }
      }
    }
    return { tracedFigure: open, totals: total }
  }, [messages, selected])

  const questions = messages.filter((message) => message.role === "user").length
  const startedBy =
    thread === null
      ? null
      : thread.createdBy === currentUserId
        ? "you"
        : "a teammate"
  const started =
    thread === null
      ? null
      : new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Jakarta",
          day: "numeric",
          month: "short",
        }).format(new Date(thread.createdAt))

  function openDialog(tab: "reports" | "connectors" | "live" = "reports") {
    setAttachTab(tab)
    setAttachOpen(true)
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 1500)
    } catch {
      setError("The link couldn’t be copied.")
    }
  }

  const threadList = (
    <ThreadList
      threads={threads}
      activeId={thread?.id ?? null}
      onSelect={(id) => void openThread(id)}
      currentUserId={currentUserId}
      onNew={canChat ? startNew : undefined}
      onDelete={canChat ? removeThread : undefined}
      unavailable={historyUnavailable}
      busyId={live !== null ? (thread?.id ?? null) : null}
      customerOf={customerOf}
    />
  )

  const tracePanel = (
    <TracePanel
      figure={tracedFigure}
      runs={traceRuns}
      totals={totals}
      onClose={() => setSelected(null)}
    />
  )

  return (
    <div
      data-slot="ask-workspace"
      className={
        "grid h-[calc(100dvh-8.5rem)] min-h-[32rem] grid-cols-1 overflow-hidden rounded-xl border border-border bg-card lg:grid-cols-[16rem_minmax(0,1fr)] " +
        (showTrace ? "2xl:grid-cols-[16rem_minmax(0,1fr)_19rem]" : "")
      }
    >
      <aside
        aria-label="Conversations"
        className="hidden min-h-0 flex-col border-r border-border lg:flex"
      >
        {threadList}
      </aside>

      <section
        aria-labelledby="ask-title"
        className="flex min-h-0 min-w-0 flex-col"
      >
        <header className="border-b border-border pt-3 pb-3 md:pt-4">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 md:px-7">
            <div className="flex items-start gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                className="-ml-2 lg:hidden"
                onClick={() => setThreadsOpen(true)}
                aria-label="Show conversations"
              >
                <ChatsCircleIcon aria-hidden="true" />
              </Button>
              <div className="min-w-0 flex-1">
                <h1
                  id="ask-title"
                  className="truncate text-xl font-semibold tracking-tight"
                >
                  {thread?.title ??
                    (canChat ? "New question" : "Conversations")}
                </h1>
                <p className="truncate text-meta text-muted-foreground">
                  <span className="sr-only">{workspaceName}: </span>
                  {thread === null
                    ? canChat
                      ? "Not asked yet"
                      : "Nothing open"
                    : `Started by ${startedBy} · ${started} · ${questions} ${questions === 1 ? "question" : "questions"}`}
                </p>
              </div>
              {thread !== null ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void copyLink()}
                  aria-label={
                    linkCopied
                      ? "Link copied"
                      : "Copy link to this conversation"
                  }
                >
                  {linkCopied ? (
                    <CheckIcon aria-hidden="true" />
                  ) : (
                    <LinkSimpleIcon aria-hidden="true" />
                  )}
                </Button>
              ) : null}
              {canChat ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="lg:hidden"
                  onClick={startNew}
                  aria-label="New question"
                >
                  <PlusIcon aria-hidden="true" />
                </Button>
              ) : null}
            </div>

            {hasConversation || thread !== null ? (
              <div>
                <SourceDocket
                  runs={attachedRuns}
                  connectors={attachedConnectors}
                  live={attachedLive}
                  unavailable={gone}
                  onAdd={canChat ? () => openDialog() : undefined}
                  onRemove={canChat ? detach : undefined}
                />
              </div>
            ) : null}
          </div>
        </header>

        <Conversation
          threadId={thread?.id ?? null}
          messages={messages}
          live={live}
          currentUserId={currentUserId}
          canRequest={canRequest}
          selectedFigure={selected}
          onSelectFigure={setSelected}
          onProposalChange={changeProposal}
          emptyState={
            <NewQuestion
              canChat={canChat}
              sources={sources}
              attachments={attachments}
              onChange={(next) => void changeAttachments(next)}
              onOpenDialog={openDialog}
              suggestions={suggestionsFor(
                attachedRuns.length,
                attachedConnectors.length,
                attachedLive.length
              )}
              onAsk={(question) => void ask(question)}
            />
          }
        />

        {error ? (
          <p
            role="alert"
            className="mx-auto w-full max-w-3xl px-4 pb-1 text-xs text-destructive md:px-7"
          >
            {error}
          </p>
        ) : null}

        {canChat ? (
          <Composer
            attachedCount={attachedCount}
            busy={live !== null}
            onSend={ask}
            onAttach={() => openDialog()}
          />
        ) : (
          <p
            data-slot="ask-read-only"
            className="border-t border-border px-4 py-3 text-center text-xs text-muted-foreground"
          >
            You can read this workspace&rsquo;s conversations. Editors, admins
            and the owner can ask.
          </p>
        )}
      </section>

      {showTrace ? (
        <aside
          aria-label="Figure trace"
          className="hidden min-h-0 flex-col border-l border-border bg-muted/30 2xl:flex"
        >
          {tracePanel}
        </aside>
      ) : null}

      <Sheet open={threadsOpen} onOpenChange={(open) => setThreadsOpen(open)}>
        <SheetContent side="left" className="gap-0 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Conversations</SheetTitle>
          </SheetHeader>
          {threadList}
        </SheetContent>
      </Sheet>

      <Sheet
        open={!wide && selected !== null && tracedFigure !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <SheetContent
          side={phone ? "bottom" : "right"}
          showCloseButton={false}
          className={
            phone ? "max-h-[85dvh] gap-0 rounded-t-2xl p-0" : "gap-0 p-0"
          }
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Figure trace</SheetTitle>
          </SheetHeader>
          {tracePanel}
        </SheetContent>
      </Sheet>

      {canChat ? (
        <AttachDialog
          open={attachOpen}
          onOpenChange={(open) => setAttachOpen(open)}
          initialTab={attachTab}
          sources={sources}
          attachments={attachments}
          onChange={(next) => void changeAttachments(next)}
          onCollected={attachCollected}
        />
      ) : null}
    </div>
  )
}
