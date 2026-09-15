"use client"

import { useMemo, useState } from "react"
import { MagnifyingGlassIcon, NotePencilIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
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

export function ThreadList({
  threads,
  activeId,
  onSelect,
  onNew,
  unavailable,
}: Readonly<{
  threads: readonly ChatThreadView[]
  activeId: string | null
  onSelect: (id: string) => void
  /** Absent for a member who can only read Ask here (roles-and-ask-access Req 6). */
  onNew?: () => void
  unavailable: boolean
}>) {
  const [query, setQuery] = useState("")
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
      <div className="flex min-h-11 items-center justify-between gap-2 px-3 pt-3 pb-2">
        <span className="text-micro uppercase text-muted-foreground">Conversations</span>
        {onNew ? (
          <Button variant="ghost" size="icon-sm" onClick={onNew} aria-label="New conversation">
            <NotePencilIcon aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      <label className="mx-3 mb-2 flex h-8 items-center gap-2 rounded-lg border border-border bg-muted px-2.5 text-muted-foreground focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
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

      <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
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
                return (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => onSelect(thread.id)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/30",
                      active
                        ? "bg-primary/[0.07] shadow-[inset_2px_0_0_var(--primary)]"
                        : "hover:bg-muted"
                    )}
                  >
                    <span className="truncate text-sm font-medium">{thread.title}</span>
                    <span className="flex gap-1.5 truncate text-xs text-muted-foreground">
                      <span>
                        {thread.attachments.runIds.length + thread.attachments.connectorIds.length}{" "}
                        attached
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{shortTime(thread.updatedAt, now)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          ))
        )}
      </nav>
    </div>
  )
}
