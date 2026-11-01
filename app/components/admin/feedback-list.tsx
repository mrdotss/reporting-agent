"use client"

import { useId, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { FEEDBACK_KIND_LABEL, type FeedbackKind } from "@/lib/feedback/input"
import type { FeedbackView } from "@/lib/feedback/views"
import { cn } from "@/lib/utils"

/**
 * The Feedback inbox on the Admin page: every Send feedback message, newest first.
 *
 * It opens on the messages nobody has marked done. Each row leads with what was said;
 * who said it, from where and when is the quieter line under it, and how its email went
 * sits at the row's end with a way to send it again when it failed. Like the Ask list, a
 * row shows what the route saved rather than what was asked for.
 */

const WHEN = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Jakarta",
})

const FILTERS = [
  { key: "open", label: "Open" },
  { key: "done", label: "Done" },
  { key: "all", label: "All" },
] as const

type Filter = (typeof FILTERS)[number]["key"]

const KIND_TONE: Record<FeedbackKind, string> = {
  idea: "bg-primary/10 text-primary",
  problem: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  question: "bg-muted text-foreground",
  praise: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
}

const LONG = 280

export function FeedbackList({
  items: initialItems,
  truncated,
}: Readonly<{
  items: readonly FeedbackView[]
  /** The server cut the list at its limit, newest first. */
  truncated: boolean
}>) {
  const [items, setItems] = useState(initialItems)
  const [filter, setFilter] = useState<Filter>("open")
  const [busy, setBusy] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const listId = useId()

  const counts = useMemo(
    () => ({
      open: items.filter((item) => item.resolvedAt === null).length,
      done: items.filter((item) => item.resolvedAt !== null).length,
      all: items.length,
    }),
    [items]
  )
  const shown = items.filter((item) =>
    filter === "all" ? true : filter === "open" ? item.resolvedAt === null : item.resolvedAt !== null
  )

  async function act(item: FeedbackView, action: "done" | "reopen" | "resend") {
    setBusy(item.id)
    setFailure(null)
    try {
      const response = await fetch(
        action === "resend" ? `/api/admin/feedback/${item.id}/resend` : `/api/admin/feedback/${item.id}`,
        action === "resend"
          ? { method: "POST" }
          : {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ done: action === "done" }),
            }
      )
      if (!response.ok) throw new Error(`status ${response.status}`)
      const saved = ((await response.json()) as { feedback: FeedbackView }).feedback
      setItems((current) => current.map((row) => (row.id === item.id ? saved : row)))
    } catch {
      setFailure({
        id: item.id,
        message:
          action === "resend"
            ? "The email wasn’t sent again. Try again."
            : action === "done"
              ? "It wasn’t marked done. Try again."
              : "It wasn’t opened again. Try again.",
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby={`${listId}-title`} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id={`${listId}-title`} className="text-section">
            Messages
          </h2>
          <p className="text-meta text-muted-foreground">
            <span className="font-mono tabular-nums text-foreground">{counts.open}</span> open of{" "}
            <span className="font-mono tabular-nums">{counts.all}</span>
            {truncated ? " · newest messages shown" : ""}
          </p>
        </div>

        <div role="group" aria-label="Show" className="inline-flex gap-0.5 rounded-[9px] bg-muted p-[3px]">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={cn(
                "inline-flex h-7.5 items-center gap-1.5 rounded-md px-3 text-meta font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/30",
                filter === key
                  ? "bg-card text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.05)]"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
              <span className="font-mono text-xs text-muted-foreground tabular-nums">{counts[key]}</span>
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="border-y border-border py-6 text-sm text-muted-foreground">
          {items.length === 0
            ? "No feedback yet. Members send it from Send feedback in the sidebar."
            : filter === "open"
              ? "Nothing open. Every message is marked done."
              : "Nothing here."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border border-y border-border">
          {shown.map((item) => {
            const long = item.message.length > LONG
            const open = expanded.has(item.id)
            return (
              <li
                key={item.id}
                data-slot="feedback-row"
                className={cn(
                  "flex flex-wrap items-start gap-x-6 gap-y-2 py-4",
                  item.resolvedAt !== null && "opacity-70"
                )}
              >
                <div className="flex min-w-0 flex-1 basis-96 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", KIND_TONE[item.kind])}>
                      {FEEDBACK_KIND_LABEL[item.kind]}
                    </span>
                    <span className="text-xs text-muted-foreground">{WHEN.format(new Date(item.createdAt))}</span>
                  </div>
                  <p className={cn("text-sm whitespace-pre-wrap break-words", long && !open && "line-clamp-4")}>
                    {item.message}
                  </p>
                  {long ? (
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current)
                          if (open) next.delete(item.id)
                          else next.add(item.id)
                          return next
                        })
                      }
                      className="self-start text-xs font-medium text-primary underline-offset-3 hover:underline"
                    >
                      {open ? "Show less" : "Show all"}
                    </button>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {item.canReply ? (
                      <a href={`mailto:${item.userEmail}`} className="text-foreground underline-offset-3 hover:underline">
                        {item.userEmail}
                      </a>
                    ) : (
                      <span>
                        {item.userEmail} <span className="text-muted-foreground">(no reply wanted)</span>
                      </span>
                    )}
                    {item.workspaceName ? (
                      <>
                        <span aria-hidden="true"> · </span>
                        {item.workspaceName}
                        {item.role ? ` (${item.role})` : ""}
                      </>
                    ) : null}
                    {item.pagePath ? (
                      <>
                        <span aria-hidden="true"> · </span>
                        <span className="font-mono break-all">{item.pagePath}</span>
                      </>
                    ) : null}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <EmailStatus item={item} busy={busy === item.id} onResend={() => void act(item, "resend")} />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy === item.id}
                    onClick={() => void act(item, item.resolvedAt === null ? "done" : "reopen")}
                  >
                    {item.resolvedAt === null ? "Mark done" : "Reopen"}
                  </Button>
                </div>

                {failure?.id === item.id ? (
                  <p role="alert" className="basis-full text-xs text-destructive">
                    {failure.message}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function EmailStatus({
  item,
  busy,
  onResend,
}: Readonly<{ item: FeedbackView; busy: boolean; onResend: () => void }>) {
  if (item.emailStatus === "sent") {
    return <span className="text-xs text-muted-foreground">Emailed</span>
  }
  return (
    <span className="flex max-w-56 flex-col items-end gap-0.5 text-right">
      <span className="flex items-center gap-2 text-xs">
        <span className={item.emailStatus === "failed" ? "font-medium text-destructive" : "text-muted-foreground"}>
          {item.emailStatus === "failed" ? "Email failed" : "Not emailed yet"}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={onResend}
          className="font-medium text-primary underline-offset-3 hover:underline disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send again"}
        </button>
      </span>
      {item.emailError ? <span className="text-[11px] text-muted-foreground">{item.emailError}</span> : null}
    </span>
  )
}
