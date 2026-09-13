"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { MagnifyingGlassIcon } from "@phosphor-icons/react/ssr"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { messageText } from "@/lib/messages/catalog"

/**
 * The run table's toolbar, and its pager (task 2.2).
 *
 * ## The filters are in the URL, not in this component's state
 *
 * They have to be read on the server — the query pages and filters in SQL — so
 * the URL is the one place both halves can see them. It also makes a filtered
 * view shareable and survivable across a reload, which a `useState` filter is
 * not.
 *
 * The search box keeps local state only so typing feels immediate; it commits on
 * a debounce, and re-syncs from the URL whenever that changes underneath it (the
 * back button, or a status chip that resets the page).
 *
 * ## Why the pager is a separate export
 *
 * It used to render directly under the toolbar, which put "Previous / 1 of 5 / Next"
 * *above* the rows it pages through — so the first thing under the filters was a
 * control for content the reader had not reached yet. A pager belongs after the thing
 * it pages.
 *
 * Both halves read and write the same query string, which is the actual shared state,
 * so splitting them duplicates no state at all.
 */

/**
 * The chip keys, and only the keys.
 *
 * Which statuses each one means is the page's business — it is what queries by
 * them — and a second list here would be a second definition of "in flight" that
 * could disagree with the one the count came from.
 */
const GROUP_KEYS = ["all", "completed", "failed", "running"] as const

type GroupKey = (typeof GROUP_KEYS)[number]

/** Writing one or more query parameters, preserving the rest. */
function usePushQuery() {
  const router = useRouter()
  const params = useSearchParams()

  return useCallback(
    (next: Readonly<Record<string, string | null>>) => {
      const query = new URLSearchParams(params.toString())
      for (const [key, value] of Object.entries(next)) {
        if (value === null || value === "") query.delete(key)
        else query.set(key, value)
      }
      router.push(`/reports?${query.toString()}`, { scroll: false })
    },
    [params, router]
  )
}

export function RunFilters({
  total,
  shown,
  offset,
  counts,
}: Readonly<{
  total: number
  shown: number
  offset: number
  /** Per-group totals, so a chip can say how much it would show. */
  counts: Readonly<Record<GroupKey, number>>
}>) {
  const params = useSearchParams()
  const push = usePushQuery()

  const urlSearch = params.get("q") ?? ""
  const group = (params.get("status") ?? "all") as GroupKey
  const [draft, setDraft] = useState(urlSearch)

  // The URL is the source of truth; this only leads it between keystrokes.
  useEffect(() => setDraft(urlSearch), [urlSearch])

  useEffect(() => {
    if (draft === urlSearch) return
    const timer = setTimeout(
      // Any change to the filter set returns to the first page: staying on page
      // three of a narrower result is how a filter appears to have found nothing.
      () => push({ q: draft, page: null }),
      250
    )
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, urlSearch])

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/*
        A segmented control rather than a row of chips: the four are one question —
        which runs — with exactly one answer at a time. Still toggle buttons with
        `aria-pressed`, because each one filters the list rather than switching panels.
      */}
      <div
        className="inline-flex gap-0.5 rounded-[9px] bg-muted p-[3px]"
        role="group"
        aria-label={messageText("ui.run_table.filter_label", "en") ?? undefined}
      >
        {GROUP_KEYS.map((key) => (
          <Button
            key={key}
            size="sm"
            variant="ghost"
            aria-pressed={group === key}
            onClick={() =>
              push({ status: key === "all" ? null : key, page: null })
            }
            className="h-7.5 gap-1.5 rounded-md px-2.5 text-meta font-medium text-muted-foreground hover:bg-transparent hover:text-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.05)]"
          >
            {messageText(`ui.run_table.status_${key}`, "en")}{" "}
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {counts[key]}
            </span>
          </Button>
        ))}
      </div>

      <div className="relative ms-auto w-full sm:w-64">
        <MagnifyingGlassIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={
            messageText("ui.run_table.search_placeholder", "en") ?? undefined
          }
          aria-label={messageText("ui.run_table.search_label", "en") ?? undefined}
          className="pl-9"
        />
      </div>

      <p aria-live="polite" className="sr-only">
        {shown === 0
          ? messageText("ui.run_table.none_shown", "en")
          : `${offset + 1}–${offset + shown} / ${total}`}
      </p>
    </div>
  )
}

/** Previous / Next, under the rows they page through. */
export function RunPagination({
  total,
  offset,
  pageSize,
}: Readonly<{ total: number; offset: number; pageSize: number }>) {
  const push = usePushQuery()

  const page = Math.floor(offset / pageSize) + 1
  const pages = Math.max(1, Math.ceil(total / pageSize))

  if (pages <= 1) return null

  return (
    <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
      <Button
        size="sm"
        variant="outline"
        disabled={page <= 1}
        onClick={() => push({ page: page <= 2 ? null : String(page - 1) })}
      >
        {messageText("ui.run_table.previous", "en")}
      </Button>

      <span className="font-mono text-xs text-muted-foreground tabular-nums">
        {page} / {pages}
      </span>

      <Button
        size="sm"
        variant="outline"
        disabled={page >= pages}
        onClick={() => push({ page: String(page + 1) })}
      >
        {messageText("ui.run_table.next", "en")}
      </Button>
    </div>
  )
}
