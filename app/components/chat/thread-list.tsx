"use client"

import { useMemo, useState } from "react"
import { MagnifyingGlassIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { ChatThreadView } from "@/lib/chat/views"
import { cn } from "@/lib/utils"

/**
 * The workspace's conversations, most recently active first, grouped by when they were
 * last active. Every member sees the same list (ask-chat Req 7.1).
 */

const TIME_ZONE = "Asia/Jakarta"

function dayKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date(iso))
}

export function groupLabel(iso: string, now: Date): string {
  const today = dayKey(now.toISOString())
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000).toISOString())
  const day = dayKey(iso)
  if (day === today) return "Today"
  if (day === yesterday) return "Yesterday"
  if (now.getTime() - Date.parse(iso) < 7 * 86_400_000) return "This week"
  return "Earlier"
}

function shortTime(iso: string, now: Date): string {
  const sameDay = dayKey(iso) === dayKey(now.toISOString())
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    ...(sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" }),
  }).format(new Date(iso))
}

/** `2 sources`, `1 source`, `No sources`: what a conversation is attached to, live pulls included. */
export function sourceCount(thread: ChatThreadView): string {
  const n =
    thread.attachments.runIds.length +
    thread.attachments.connectorIds.length +
    (thread.attachments.liveIds?.length ?? 0)
  return n === 0 ? "No sources" : `${n} ${n === 1 ? "source" : "sources"}`
}

export function ThreadList({
  threads,
  activeId,
  currentUserId,
  onSelect,
  onNew,
  onDelete,
  unavailable,
  busyId = null,
  customerOf,
}: Readonly<{
  threads: readonly ChatThreadView[]
  activeId: string | null
  currentUserId: string
  onSelect: (id: string) => void
  /** Absent for a member who can only read Ask here (roles-and-ask-access Req 6). */
  onNew?: () => void
  /** Absent for a reader. Only a conversation's author is offered it at all. */
  onDelete?: (id: string) => Promise<boolean>
  unavailable: boolean
  /** The conversation being answered right now, marked with a pulse. */
  busyId?: string | null
  /** The customer a conversation is about, read from what it is attached to. */
  customerOf?: (thread: ChatThreadView) => string | null
}>) {
  const [query, setQuery] = useState("")
  const [doomed, setDoomed] = useState<ChatThreadView | null>(null)
  const [deleting, setDeleting] = useState(false)
  const now = useMemo(() => new Date(), [])

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const map = new Map<string, ChatThreadView[]>()
    for (const thread of threads) {
      if (needle && !thread.title.toLowerCase().includes(needle)) continue
      const label = groupLabel(thread.updatedAt, now)
      map.set(label, [...(map.get(label) ?? []), thread])
    }
    return [...map.entries()]
  }, [threads, query, now])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-12 items-center justify-between gap-2 px-4 pt-3 pb-2">
        <h2 className="text-section">Conversations</h2>
        {onNew ? (
          <Button variant="outline" size="sm" onClick={onNew}>
            <PlusIcon aria-hidden="true" />
            New
          </Button>
        ) : null}
      </div>

      <label className="mx-3 mb-2 flex h-9 items-center gap-2 rounded-lg border border-border bg-muted px-2.5 text-muted-foreground focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
        <MagnifyingGlassIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="sr-only">Search conversations</span>
        <input
          id="chat-thread-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations"
          className="min-w-0 flex-1 bg-transparent text-meta text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>

      <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {unavailable ? (
          <p className="px-2 py-3 text-meta text-muted-foreground">
            Conversation history can&rsquo;t be read right now. New questions still need it
            to be saved.
          </p>
        ) : groups.length === 0 ? (
          <p className="px-2 py-3 text-meta text-muted-foreground">
            {query ? "No conversation matches that." : "No conversations in this workspace yet."}
          </p>
        ) : (
          groups.map(([label, items]) => (
            <div key={label} className="flex flex-col gap-px">
              <span className="px-2 pt-3 pb-1 text-micro uppercase text-muted-foreground">
                {label}
              </span>
              {items.map((thread) => {
                const active = thread.id === activeId
                const mine = onDelete !== undefined && thread.createdBy === currentUserId
                return (
                  <div
                    key={thread.id}
                    className={cn(
                      "group/thread relative flex items-center rounded-lg transition-colors",
                      active ? "bg-muted" : "hover:bg-muted/60"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(thread.id)}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg px-2 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
                        mine && "pr-8"
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className={cn("truncate text-sm", active ? "font-semibold" : "font-medium")}>
                          {thread.title}
                        </span>
                        {thread.id === busyId ? (
                          <span
                            role="img"
                            aria-label="Answering"
                            className="size-1.5 shrink-0 animate-pulse rounded-full bg-(--status-inflight) motion-reduce:animate-none"
                          />
                        ) : null}
                      </span>
                      <span className="flex min-w-0 gap-1.5 text-xs text-muted-foreground">
                        {customerOf?.(thread) ? (
                          <>
                            <span className="truncate">{customerOf(thread)}</span>
                            <span aria-hidden="true">·</span>
                          </>
                        ) : null}
                        <span className="shrink-0">{sourceCount(thread)}</span>
                        <span aria-hidden="true">·</span>
                        <span className="shrink-0">{shortTime(thread.updatedAt, now)}</span>
                      </span>
                    </button>
                    {mine ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete ${thread.title}`}
                        onClick={() => setDoomed(thread)}
                        className="absolute right-1 text-muted-foreground opacity-0 transition-opacity group-hover/thread:opacity-100 focus-visible:opacity-100 hover:text-destructive"
                      >
                        <TrashIcon aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ))
        )}
      </nav>

      <Dialog open={doomed !== null} onOpenChange={(open) => !open && setDoomed(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this conversation?</DialogTitle>
            <DialogDescription>
              “{doomed?.title}” and its answers go for everyone who can use Ask in this
              workspace. This can&rsquo;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDoomed(null)} disabled={deleting}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={async () => {
                if (doomed === null || onDelete === undefined) return
                setDeleting(true)
                const gone = await onDelete(doomed.id)
                setDeleting(false)
                if (gone) setDoomed(null)
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
