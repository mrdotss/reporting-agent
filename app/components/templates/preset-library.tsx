"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { MagnifyingGlassIcon, RowsIcon, SquaresFourIcon } from "@phosphor-icons/react"

import {
  SOURCE_SHORT_NAMES,
  type SourceKind,
} from "@/components/subscriptions/provider-mark"
import { NewPresetChooser } from "@/components/templates/new-preset-doors"
import { PresetCard } from "@/components/templates/preset-card"
import { hasPendingWork, isEmptyPreset, SOURCE_DOT_CLASS } from "@/components/templates/preset-status"
import { ProfileTable } from "@/components/templates/profile-table"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { TemplateView } from "@/lib/db/views"
import { messageText } from "@/lib/messages/catalog"
import { cn } from "@/lib/utils"

/**
 * The presets page's list: search, one row of filters, and the presets as cards or as
 * the table (Presets page option 1 on the research canvas).
 *
 * ## Cards by default, the table one click away
 *
 * The table replaced cards once, because every card weighed the same and a long tail of
 * abandoned drafts drowned the real presets. These cards answer that differently: each
 * shows a sketch of its pages and a state pill that makes an empty preset or a pending
 * edit look like one, and "Edits pending" and "Empty" are filters of their own. The
 * table stays as List for anyone with many presets, and the choice is remembered per
 * browser.
 *
 * ## Deleting, and the refusal that is not an error
 *
 * `DELETE /api/report-profiles/[id]` answers `204`, or `409` with `error.code` `TEMPLATE_PINNED`
 * when a run pinned one of the profile's versions. That refusal is a **fact
 * about the account**, not a failure of the request: reports exist, and they
 * stay replayable against the exact definition they were rendered from. So the
 * dialog states it in those terms rather than as an error, and leaves the
 * profile alone.
 *
 * The confirm does not ask the consultant to type the name. The action is
 * reversible in the only sense that matters — a profile with runs cannot be
 * deleted at all, and one without runs has produced nothing to lose.
 */

type Filter = "all" | SourceKind | "pending" | "empty"
type View = "cards" | "list"

const VIEW_KEY = "presets.view"

/** Why a preset that already made reports stays, and what still works. */
export const PINNED_REASON =
  "This preset has already been used to make reports, so it is kept: every report " +
  "stays tied to the exact preset version it was built from, and deleting the " +
  "preset would break re-checking those reports. You can still rename it or edit it."

function matches(template: TemplateView, filter: Filter): boolean {
  if (filter === "all") return true
  if (filter === "pending") return hasPendingWork(template)
  if (filter === "empty") return isEmptyPreset(template)
  return template.provider === filter
}

export function PresetLibrary({
  templates,
  customers,
  showCustomer = false,
}: Readonly<{
  templates: readonly TemplateView[]
  /** Customer names by project id, for the customer column and the card's customer line. */
  customers?: ReadonlyMap<string, string>
  /** False inside one customer, and for a team with one customer. */
  showCustomer?: boolean
}>) {
  const router = useRouter()
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [view, setView] = useState<View>("cards")
  const [pending, startTransition] = useTransition()

  /** The profile the confirm dialog is about, or `null` when it is closed. */
  const [target, setTarget] = useState<TemplateView | null>(null)
  /** A refusal from the server, shown in place of the confirm. */
  const [refusal, setRefusal] = useState<string | null>(null)

  // The last view is a per-browser convenience; without storage the cards stand.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_KEY)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring a stored preference after hydration
      if (saved === "cards" || saved === "list") setView(saved)
    } catch {
      // Storage unavailable: keep the default.
    }
  }, [])

  function chooseView(next: View) {
    setView(next)
    try {
      window.localStorage.setItem(VIEW_KEY, next)
    } catch {
      // Storage unavailable: the choice still applies to this page.
    }
  }

  const filters = useMemo(() => {
    const providers = new Map<SourceKind, number>()
    for (const template of templates) {
      providers.set(template.provider, (providers.get(template.provider) ?? 0) + 1)
    }
    const all: { value: Filter; label: string; count: number }[] = [
      { value: "all", label: messageText("ui.presets.filter_all", "en") ?? "", count: templates.length },
    ]
    // One source's chip would only repeat "All".
    if (providers.size > 1) {
      for (const [kind, count] of providers) all.push({ value: kind, label: SOURCE_SHORT_NAMES[kind], count })
    }
    all.push(
      {
        value: "pending",
        label: messageText("ui.presets.filter_pending", "en") ?? "",
        count: templates.filter(hasPendingWork).length,
      },
      {
        value: "empty",
        label: messageText("ui.presets.filter_empty", "en") ?? "",
        count: templates.filter(isEmptyPreset).length,
      }
    )
    return all
  }, [templates])

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return templates
      .filter((t) => matches(t, filter))
      .filter(
        (t) =>
          needle === "" ||
          t.name.toLowerCase().includes(needle) ||
          t.description.toLowerCase().includes(needle)
      )
  }, [templates, query, filter])

  function askDelete(template: TemplateView) {
    setRefusal(null)
    setTarget(template)
  }

  async function confirmDelete(template: TemplateView) {
    const response = await fetch(`/api/report-profiles/${template.id}`, {
      method: "DELETE",
    })

    if (response.status === 204) {
      setTarget(null)
      startTransition(() => router.refresh())
      return
    }

    // Errors arrive as `{ error: { message, code } }` (lib/api/response.ts). A pinned
    // preset gets its reason in plain words; anything else is reported as the
    // server's own message rather than as a guess at what went wrong.
    const body = await response.json().catch(() => null)
    const error = body?.error
    if (error?.code === "TEMPLATE_PINNED") {
      setRefusal(PINNED_REASON)
    } else {
      setRefusal(
        typeof error?.message === "string"
          ? error.message
          : `The profile could not be deleted (${response.status}).`
      )
    }
  }

  const trimmed = query.trim()

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <MagnifyingGlassIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`${messageText("ui.presets.search", "en")}…`}
            aria-label={messageText("ui.presets.search", "en")}
            className="pl-9"
          />
        </div>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label={messageText("ui.presets.filter_label", "en")}>
          {filters.map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={filter === option.value ? "secondary" : "ghost"}
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.value === "aws" || option.value === "azure" || option.value === "onprem" ? (
                <span aria-hidden="true" className={cn("size-2 rounded-full", SOURCE_DOT_CLASS[option.value])} />
              ) : null}
              {option.label}{" "}
              <span className="font-mono tabular-nums opacity-65">{option.count}</span>
            </Button>
          ))}
        </div>

        <div className="ms-auto flex items-center gap-3">
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {messageText("ui.presets.shown", "en", { shown: rows.length, total: templates.length })}
          </p>
          <div
            role="group"
            aria-label={messageText("ui.presets.view_label", "en")}
            className="flex rounded-lg bg-muted p-[3px]"
          >
            {(
              [
                ["cards", SquaresFourIcon, messageText("ui.presets.view_cards", "en")],
                ["list", RowsIcon, messageText("ui.presets.view_list", "en")],
              ] as const
            ).map(([value, Glyph, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                onClick={() => chooseView(value)}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none",
                  view === value
                    ? "bg-card font-semibold shadow-[0_1px_2px_rgb(0_0_0/0.08)]"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Glyph aria-hidden="true" className="size-4" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-14 text-center">
          <p className="font-heading text-sm font-medium">
            {trimmed === ""
              ? messageText("ui.presets.none_in_filter", "en")
              : messageText("ui.presets.none_match", "en", { query: trimmed })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{messageText("ui.presets.none_hint", "en")}</p>
        </div>
      ) : view === "cards" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
          {rows.map((template) => (
            <PresetCard
              key={template.id}
              template={template}
              customer={
                showCustomer
                  ? ((template.projectId ? customers?.get(template.projectId) : undefined) ??
                    messageText("ui.presets.no_customer", "en"))
                  : undefined
              }
              onDelete={askDelete}
            />
          ))}
          {trimmed === "" && filter === "all" ? <NewPresetChooser variant="card" /> : null}
        </div>
      ) : (
        <ProfileTable rows={rows} customers={customers} showCustomer={showCustomer} onDelete={askDelete} />
      )}

      {/* Delete confirmation, or the server's refusal in its place */}
      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTarget(null)
            setRefusal(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {refusal === null
                ? `Delete “${target?.name}”?`
                : `“${target?.name}” cannot be deleted`}
            </DialogTitle>
            <DialogDescription>
              {refusal ??
                "The profile stops being offered for new runs. Versions no run " +
                  "pinned are removed with it."}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setTarget(null)
                setRefusal(null)
              }}
            >
              {refusal === null ? "Cancel" : "Close"}
            </Button>
            {refusal === null ? (
              <Button
                variant="destructive"
                disabled={pending}
                onClick={() => {
                  if (target !== null) void confirmDelete(target)
                }}
              >
                Delete profile
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
