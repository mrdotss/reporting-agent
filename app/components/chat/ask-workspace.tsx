"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { ChatsCircleIcon, NotePencilIcon, SidebarSimpleIcon } from "@phosphor-icons/react"

import { AttachDialog, MAX_LIVE } from "@/components/chat/attach-dialog"
import { Composer } from "@/components/chat/composer"
import { ContextPanel, type AttachmentKind } from "@/components/chat/context-panel"
import { Conversation } from "@/components/chat/conversation"
import { ThreadList } from "@/components/chat/thread-list"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useChatStream } from "@/hooks/useChatStream"
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
 * Three panes on a wide screen. Under `xl` the grounding panel becomes a sheet, and under
 * `lg` the conversation list does too, so the conversation itself always has the width.
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

const NO_ATTACHMENTS: ChatAttachments = { runIds: [], connectorIds: [], liveIds: [] }
const JSON_HEADERS = { "Content-Type": "application/json" }

export function suggestionsFor(runs: number, connectors: number, live = 0): string[] {
  const suggestions: string[] = []
  if (live > 0) suggestions.push("How busy was CPU on these machines over the window?")
  if (runs > 0) suggestions.push("Which VMs look over-provisioned?")
  if (runs > 1) suggestions.push("How did usage change between the attached reports?")
  if (runs > 0 || live > 0) suggestions.push("What would these VM sizes cost per month at list price?")
  if (connectors > 0) suggestions.push("What does this connector's inventory look like?")
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
  const [threads, setThreads] = useState<readonly ChatThreadView[]>(initialThreads)
  const [sources, setSources] = useState<ChatSources>(initialSources)
  const [thread, setThread] = useState<ChatThreadView | null>(initialThread)
  const [messages, setMessages] = useState<readonly ChatMessageView[]>(initialMessages)
  const [draft, setDraft] = useState<ChatAttachments>(NO_ATTACHMENTS)
  const [attachOpen, setAttachOpen] = useState(false)
  const [threadsOpen, setThreadsOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [error, setError] = useState("")
  const accepted = useRef(false)

  const onUserMessage = useCallback((message: ChatMessageView) => {
    accepted.current = true
    setMessages((previous) => [...previous, message])
  }, [])
  const { live, send } = useChatStream({ onUserMessage })

  const attachments = thread?.attachments ?? draft
  const liveIds = useMemo(() => attachments.liveIds ?? [], [attachments.liveIds])
  const attachedRuns = useMemo(
    () => sources.runs.filter((run) => attachments.runIds.includes(run.runId)),
    [sources.runs, attachments.runIds]
  )
  const attachedConnectors = useMemo(
    () => sources.connectors.filter((connector) => attachments.connectorIds.includes(connector.id)),
    [sources.connectors, attachments.connectorIds]
  )
  const attachedLive = useMemo(
    () => sources.live.filter((pull) => liveIds.includes(pull.id)),
    [sources.live, liveIds]
  )
  const gone =
    attachments.runIds.length + attachments.connectorIds.length + liveIds.length -
    attachedRuns.length -
    attachedConnectors.length -
    attachedLive.length

  function remember(next: ChatThreadView) {
    setThread(next)
    setThreads((previous) => [next, ...previous.filter((item) => item.id !== next.id)])
  }

  function showInUrl(id: string | null) {
    window.history.replaceState(null, "", id === null ? "/ask" : `/ask?t=${encodeURIComponent(id)}`)
  }

  async function openThread(id: string) {
    setThreadsOpen(false)
    setError("")
    if (id === thread?.id) return
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

  function startNew() {
    setThread(null)
    setMessages([])
    setDraft(NO_ATTACHMENTS)
    setError("")
    setThreadsOpen(false)
    showInUrl(null)
  }

  async function changeAttachments(next: ChatAttachments) {
    if (thread === null) {
      setDraft(next)
      return
    }
    setThread({ ...thread, attachments: next })
    const response = await fetch(`/api/chat/threads/${encodeURIComponent(thread.id)}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        attachments: { runIds: next.runIds, connectorIds: next.connectorIds, liveIds: next.liveIds ?? [] },
      }),
    })
    if (!response.ok) {
      setError("The attachments couldn’t be saved. Try again.")
      return
    }
    remember(((await response.json()) as { thread: ChatThreadView }).thread)
  }

  function detach(kind: AttachmentKind, id: string) {
    void changeAttachments(
      kind === "run"
        ? { ...attachments, runIds: attachments.runIds.filter((runId) => runId !== id) }
        : kind === "connector"
          ? {
              ...attachments,
              connectorIds: attachments.connectorIds.filter((connectorId) => connectorId !== id),
            }
          : { ...attachments, liveIds: liveIds.filter((liveId) => liveId !== id) }
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
      liveIds: [pull.id, ...liveIds.filter((id) => id !== pull.id)].slice(0, MAX_LIVE),
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
          attachments: { runIds: draft.runIds, connectorIds: draft.connectorIds, liveIds: draft.liveIds ?? [] },
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
      previous.map((message) => (message.id === messageId ? { ...message, proposal } : message))
    )
  }

  const attachedCount = attachedRuns.length + attachedConnectors.length + attachedLive.length
  const customers = [...new Set(attachedRuns.map((run) => run.customerName))]
  const scopeLine =
    attachedCount === 0
      ? canChat
        ? "Nothing attached — attach a verified report or live metrics to ask about it"
        : "Nothing attached"
      : [
          attachedRuns.length > 0
            ? `${attachedRuns.length} verified ${attachedRuns.length === 1 ? "report" : "reports"}`
            : null,
          attachedLive.length > 0
            ? `${attachedLive.length} live ${attachedLive.length === 1 ? "pull" : "pulls"}`
            : null,
          attachedConnectors.length > 0
            ? `${attachedConnectors.length} ${attachedConnectors.length === 1 ? "connector" : "connectors"}`
            : null,
          customers.length > 0 ? customers.join(", ") : null,
          gone > 0 ? `${gone} no longer available` : null,
        ]
          .filter(Boolean)
          .join(" · ")

  const threadList = (
    <ThreadList
      threads={threads}
      activeId={thread?.id ?? null}
      onSelect={(id) => void openThread(id)}
      onNew={canChat ? startNew : undefined}
      unavailable={historyUnavailable}
    />
  )

  const context = (
    <ContextPanel
      runs={attachedRuns}
      connectors={attachedConnectors}
      live={attachedLive}
      onAdd={canChat ? () => setAttachOpen(true) : undefined}
      onRemove={canChat ? detach : undefined}
    />
  )

  return (
    <div
      data-slot="ask-workspace"
      className="grid h-[calc(100dvh-8.5rem)] min-h-[32rem] grid-cols-1 overflow-hidden rounded-xl border border-border bg-card lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_19rem]"
    >
      <aside aria-label="Conversations" className="hidden min-h-0 flex-col border-r border-border lg:flex">
        {threadList}
      </aside>

      <section aria-labelledby="ask-title" className="flex min-h-0 min-w-0 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            onClick={() => setThreadsOpen(true)}
            aria-label="Show conversations"
          >
            <ChatsCircleIcon aria-hidden="true" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 id="ask-title" className="truncate text-section">
              {thread?.title ?? (canChat ? "New conversation" : "Conversations")}
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              <span className="sr-only">{workspaceName}: </span>
              {scopeLine}
            </p>
          </div>
          <Button variant="ghost" size="sm" className="xl:hidden" onClick={() => setContextOpen(true)}>
            <SidebarSimpleIcon aria-hidden="true" />
            <span className="hidden sm:inline">Grounded in</span>
          </Button>
          {canChat ? (
            <Button variant="outline" size="sm" onClick={startNew}>
              <NotePencilIcon aria-hidden="true" />
              New
            </Button>
          ) : null}
        </header>

        <Conversation
          threadId={thread?.id ?? null}
          messages={messages}
          live={live}
          currentUserId={currentUserId}
          canChat={canChat}
          canRequest={canRequest}
          hasAttachments={attachedCount > 0}
          suggestions={suggestionsFor(attachedRuns.length, attachedConnectors.length, attachedLive.length)}
          onAsk={(question) => void ask(question)}
          onAttach={() => setAttachOpen(true)}
          onProposalChange={changeProposal}
        />

        {error ? (
          <p role="alert" className="mx-auto w-full max-w-3xl px-5 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {canChat ? (
          <Composer
            runs={attachedRuns}
            connectors={attachedConnectors}
            live={attachedLive}
            busy={live !== null}
            onSend={ask}
            onAttach={() => setAttachOpen(true)}
            onRemove={detach}
          />
        ) : (
          <p
            data-slot="ask-read-only"
            className="border-t border-border px-4 py-3 text-center text-xs text-muted-foreground"
          >
            You can read this workspace&rsquo;s conversations. Editors, admins and the owner can
            ask.
          </p>
        )}
      </section>

      <aside aria-label="Grounded in" className="hidden min-h-0 flex-col border-l border-border xl:flex">
        {context}
      </aside>

      <Sheet open={threadsOpen} onOpenChange={(open) => setThreadsOpen(open)}>
        <SheetContent side="left" className="gap-0 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Conversations</SheetTitle>
          </SheetHeader>
          {threadList}
        </SheetContent>
      </Sheet>

      <Sheet open={contextOpen} onOpenChange={(open) => setContextOpen(open)}>
        <SheetContent side="right" className="gap-0 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Grounded in</SheetTitle>
          </SheetHeader>
          {context}
        </SheetContent>
      </Sheet>

      {canChat ? (
        <AttachDialog
          open={attachOpen}
          onOpenChange={(open) => setAttachOpen(open)}
          sources={sources}
          attachments={attachments}
          onChange={(next) => void changeAttachments(next)}
          onCollected={attachCollected}
        />
      ) : null}
    </div>
  )
}
