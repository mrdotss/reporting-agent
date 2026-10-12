"use client"

import { useState } from "react"
import Link from "next/link"
import { CheckCircleIcon, DownloadSimpleIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useMediaQuery } from "@/hooks/use-media-query"
import type { ActionItemView } from "@/lib/action-register/store"
import { cn } from "@/lib/utils"

/**
 * The Action register: one customer's items, or every customer's.
 *
 * ## One screen, not three stacked cards
 *
 * The status groups are tabs with their counts, so the page shows one list at a time. Rows
 * are one line each, and owner, status and note are edited in one panel for the selected
 * row (a sheet on a narrow screen) rather than in controls repeated down every row, which is
 * what made the old page scroll. Several rows can be given an owner, or accepted, at once.
 *
 * Resolved is never set here: the next verified report sets it when it checks a finding
 * clear.
 *
 * ## State
 *
 * The items come from the server on every customer switch, so the list keeps only what this
 * browser saved since, laid over them, never a copy of the props it started with.
 */

type Tab = "act" | "new" | "wont" | "done"
type OwnerFilter = "any" | "none" | "customer" | "msp"

const PAGE_SIZE = 25

const KIND: Readonly<Record<string, string>> = {
  housekeeping: "Housekeeping",
  backup: "Backup",
  rightsizing: "Rightsizing",
  advisor: "Advisor",
}
const STATUS: Readonly<Record<ActionItemView["status"], string>> = {
  open: "Open",
  accepted: "Accepted",
  wont_do: "Won't do",
  resolved: "Resolved",
}
const OWNER: Readonly<Record<string, string>> = { none: "No owner", customer: "Customer", msp: "MSP" }
const OWNER_FILTER: Readonly<Record<OwnerFilter, string>> = {
  any: "Any owner",
  none: "No owner",
  customer: "Customer",
  msp: "MSP",
}
const STATUS_DOT: Readonly<Record<ActionItemView["status"], string>> = {
  open: "bg-(--status-inflight)",
  accepted: "bg-primary",
  wont_do: "bg-muted-foreground",
  resolved: "bg-(--status-verified)",
}

const shortMonth = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })
const longMonth = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
const asDate = (period: string) => new Date(`${period.slice(0, 7)}-01T00:00:00Z`)

const isNew = (item: ActionItemView, newMonth: string) => item.firstSeenPeriod.startsWith(newMonth)
const isActive = (item: ActionItemView) => item.status === "open" || item.status === "accepted"

function inTab(item: ActionItemView, tab: Tab, newMonth: string): boolean {
  if (tab === "act") return isActive(item)
  if (tab === "new") return isActive(item) && isNew(item, newMonth)
  if (tab === "wont") return item.status === "wont_do"
  return item.status === "resolved"
}

/** The items as CSV, one row each, in the order given. */
export function actionsCsv(items: readonly ActionItemView[]): string {
  const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)
  const rows = items.map((item) =>
    [
      item.customer,
      item.connector,
      KIND[item.kind] ?? item.kind,
      item.title,
      item.owner === null ? "" : OWNER[item.owner],
      STATUS[item.status],
      item.firstSeenPeriod.slice(0, 7),
      item.note ?? "",
    ]
      .map(cell)
      .join(",")
  )
  return ["Customer,Connector,Kind,Finding,Owner,Status,First seen,Note", ...rows].join("\n") + "\n"
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

async function patchItem(
  item: ActionItemView,
  change: { owner: ActionItemView["owner"]; status: Exclude<ActionItemView["status"], "resolved">; note: string | null }
): Promise<{ item?: ActionItemView; error?: string }> {
  try {
    const response = await fetch(`/api/actions/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    })
    const body = (await response.json().catch(() => ({}))) as { item?: ActionItemView; error?: { message?: string } }
    if (!response.ok || body.item === undefined) return { error: body.error?.message ?? "The change could not be saved." }
    return { item: body.item }
  } catch {
    return { error: "The change could not be saved. Check your connection and try again." }
  }
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: Readonly<{ label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void }>) {
  return (
    <div role="group" aria-label={label} className="flex gap-0.5 rounded-lg border border-input bg-background p-0.5">
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            "h-8 flex-1 rounded-md px-2 text-meta transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
            value === option ? "bg-foreground font-medium text-background" : "hover:bg-muted"
          )}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

/** The selected item: where it was found, and its owner, status and note. */
function ActionDetail({
  item,
  canEdit,
  onSaved,
}: Readonly<{ item: ActionItemView; canEdit: boolean; onSaved: (item: ActionItemView) => void }>) {
  const [owner, setOwner] = useState<string>(item.owner ?? "none")
  const [status, setStatus] = useState<string>(item.status === "resolved" ? "open" : item.status)
  const [note, setNote] = useState(item.note ?? "")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const dirty = owner !== (item.owner ?? "none") || status !== item.status || note !== (item.note ?? "")
  const needsNote = status === "wont_do" && note.trim() === ""

  async function save() {
    setBusy(true)
    setMessage(null)
    const result = await patchItem(item, {
      owner: owner === "none" ? null : (owner as "customer" | "msp"),
      status: status as "open" | "accepted" | "wont_do",
      note: note.trim() || null,
    })
    setBusy(false)
    if (result.item === undefined) {
      setMessage({ ok: false, text: result.error ?? "The change could not be saved." })
      return
    }
    setMessage({ ok: true, text: "Saved" })
    onSaved(result.item)
  }

  function discard() {
    setOwner(item.owner ?? "none")
    setStatus(item.status === "resolved" ? "open" : item.status)
    setNote(item.note ?? "")
    setMessage(null)
  }

  return (
    <div data-slot="action-detail" className="flex flex-col">
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 border-b border-border/60 px-4 py-3 text-meta md:px-5">
        <dt className="text-muted-foreground">Customer</dt>
        <dd>{item.customer}</dd>
        <dt className="text-muted-foreground">Connector</dt>
        <dd className="font-mono text-xs leading-5 break-all">{item.connector}</dd>
        <dt className="text-muted-foreground">First found</dt>
        <dd>{longMonth.format(asDate(item.firstSeenPeriod))}</dd>
        <dt className="text-muted-foreground">Last found in</dt>
        <dd>
          <Link href={`/reports/${item.lastSeenRunId}`} className="underline underline-offset-3">
            this report
          </Link>
        </dd>
      </dl>

      {item.status === "resolved" ? (
        <p className="m-4 flex gap-2 rounded-lg bg-(--status-verified-soft) px-3 py-2.5 text-meta text-(--status-verified) md:mx-5">
          <CheckCircleIcon aria-hidden="true" weight="fill" className="mt-0.5 size-4 shrink-0" />
          <span>
            Resolved by{" "}
            {item.resolvedRunId === null ? (
              "a verified report"
            ) : (
              <Link href={`/reports/${item.resolvedRunId}`} className="underline underline-offset-3">
                this report
              </Link>
            )}
            . It reopens by itself if a later report finds it again.
          </span>
        </p>
      ) : canEdit ? (
        <div className="flex flex-col gap-3.5 px-4 py-4 md:px-5">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">Owner</span>
            <Segmented
              label="Owner"
              value={owner}
              options={[
                ["none", "No owner"],
                ["customer", "Customer"],
                ["msp", "MSP"],
              ]}
              onChange={setOwner}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">Status</span>
            <Segmented
              label="Status"
              value={status}
              options={[
                ["open", "Open"],
                ["accepted", "Accepted"],
                ["wont_do", "Won't do"],
              ]}
              onChange={setStatus}
            />
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">
              Note{" "}
              <span className="font-normal text-muted-foreground">
                {status === "wont_do" ? "(required for Won’t do)" : "(optional)"}
              </span>
            </span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="What was agreed, and by whom"
              className="resize-y rounded-lg border border-input bg-background px-2.5 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            />
          </label>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" disabled={!dirty || needsNote || busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={!dirty || busy} onClick={discard}>
              Discard
            </Button>
            {message === null ? null : (
              <span
                aria-live="polite"
                className={cn("ml-auto text-xs", message.ok ? "text-(--status-verified)" : "text-destructive")}
              >
                {message.text}
              </span>
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Resolved is never set by hand. The next verified report resolves the item when it checks the finding clear.
          </p>
        </div>
      ) : (
        <p className="px-4 py-4 text-meta text-muted-foreground md:px-5">
          {STATUS[item.status]} · {item.owner === null ? "No owner" : OWNER[item.owner]}
          {item.note ? ` · ${item.note}` : ""}
        </p>
      )}
    </div>
  )
}

function DetailHeading({ item }: Readonly<{ item: ActionItemView }>) {
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="rounded-md bg-muted px-1.5 py-0.5 text-foreground">{KIND[item.kind] ?? item.kind}</span>
      <span className="flex items-center gap-1.5">
        <i aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_DOT[item.status])} />
        {STATUS[item.status]}
      </span>
    </span>
  )
}

export function ActionList({
  items,
  canEdit,
  showCustomer = false,
  newMonth,
  fileLabel = "actions",
}: Readonly<{
  items: readonly ActionItemView[]
  canEdit: boolean
  /** "All customers": name each item's customer, and count by customer. */
  showCustomer?: boolean
  /** `YYYY-MM`, the month being closed: items first found in it are new. */
  newMonth: string
  /** The CSV's file name, before the date. */
  fileLabel?: string
}>) {
  const wide = useMediaQuery("(min-width: 64rem)")
  const [saved, setSaved] = useState<Readonly<Record<string, ActionItemView>>>({})
  const [tab, setTab] = useState<Tab>("act")
  const [customer, setCustomer] = useState<string | null>(null)
  const [kind, setKind] = useState("all")
  const [owner, setOwner] = useState<OwnerFilter>("any")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkMessage, setBulkMessage] = useState<string | null>(null)

  const current = items.map((item) => saved[item.id] ?? item)
  const keep = (item: ActionItemView) => setSaved((all) => ({ ...all, [item.id]: item }))

  if (current.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card px-4 py-6 text-meta text-muted-foreground">
        No actions yet. They appear after {showCustomer ? "a customer’s" : "this customer’s"} next verified
        report: stopped machines, missing backups, rightsizing and Advisor recommendations.
      </p>
    )
  }

  const scoped = current.filter((item) => customer === null || item.customer === customer)
  const needle = query.trim().toLowerCase()
  const shown = scoped.filter(
    (item) =>
      inTab(item, tab, newMonth) &&
      (kind === "all" || item.kind === kind) &&
      (owner === "any" || (owner === "none" ? item.owner === null : item.owner === owner)) &&
      (needle === "" ||
        [item.title, item.connector, item.customer, item.note ?? ""].some((text) => text.toLowerCase().includes(needle)))
  )
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  const at = Math.min(page, pages - 1)
  const pageItems = shown.slice(at * PAGE_SIZE, at * PAGE_SIZE + PAGE_SIZE)
  const selected =
    current.find((item) => item.id === selectedId) ?? (wide && selectedId === null ? pageItems[0] : undefined)
  const kinds = Object.keys(KIND).filter((key) => current.some((item) => item.kind === key))

  const tabs: { key: Tab; label: string; sub: string; warn?: boolean }[] = [
    {
      key: "act",
      label: "To act on",
      sub: `${scoped.filter((item) => isActive(item) && item.owner === null).length} without an owner`,
      warn: true,
    },
    { key: "new", label: "New this month", sub: `First found in ${longMonth.format(asDate(newMonth))}` },
    { key: "wont", label: "Won’t do", sub: "Turned down, with a reason" },
    { key: "done", label: "Resolved", sub: "Checked clear by a report" },
  ]

  const byCustomer = showCustomer
    ? [...new Set(current.map((item) => item.customer))].map((name) => {
        const mine = current.filter((item) => item.customer === name)
        return {
          name,
          act: mine.filter(isActive).length,
          wont: mine.filter((item) => item.status === "wont_do").length,
          done: mine.filter((item) => item.status === "resolved").length,
        }
      })
    : []
  const most = Math.max(1, ...byCustomer.map((row) => row.act + row.wont + row.done))

  const groups = showCustomer
    ? [...new Set(pageItems.map((item) => item.customer))].map((name) => ({
        name,
        items: pageItems.filter((item) => item.customer === name),
      }))
    : [{ name: "", items: pageItems }]

  const reset = () => {
    setPage(0)
    setChecked(new Set())
    setBulkMessage(null)
  }

  function select(item: ActionItemView) {
    setSelectedId(item.id)
    if (!wide) setSheetOpen(true)
  }

  async function bulk(change: { owner?: "customer" | "msp"; status?: "accepted" }) {
    setBulkBusy(true)
    setBulkMessage(null)
    let failed = 0
    for (const id of checked) {
      const item = current.find((entry) => entry.id === id)
      if (item === undefined || item.status === "resolved") continue
      const result = await patchItem(item, {
        owner: change.owner ?? item.owner,
        status: change.status ?? item.status,
        note: item.note,
      })
      if (result.item === undefined) failed += 1
      else keep(result.item)
    }
    setBulkBusy(false)
    setChecked(new Set())
    setBulkMessage(failed === 0 ? null : `${failed} could not be saved. Open each to see why.`)
  }

  const gridColumns = showCustomer
    ? "md:grid-cols-[2.25rem_minmax(0,2.6fr)_minmax(0,1fr)_7.5rem_7rem_5.5rem]"
    : "md:grid-cols-[2.25rem_minmax(0,1fr)_7.5rem_7rem_5.5rem]"

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3.5 xl:flex-row">
        <div
          role="tablist"
          aria-label="Status"
          className="grid flex-[3] grid-cols-2 overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-4"
        >
          {tabs.map((entry) => {
            const count = scoped.filter((item) => inTab(item, entry.key, newMonth)).length
            return (
              <button
                key={entry.key}
                type="button"
                role="tab"
                aria-selected={tab === entry.key}
                onClick={() => {
                  setTab(entry.key)
                  reset()
                }}
                className={cn(
                  "flex flex-col gap-1 border-b-2 border-transparent px-4 pt-3 pb-2.5 text-left outline-none not-last:border-r not-last:border-r-border/60 hover:bg-muted/60 focus-visible:bg-muted",
                  tab === entry.key && "border-b-primary bg-muted"
                )}
              >
                <span className="text-xs text-muted-foreground">{entry.label}</span>
                <span className="font-mono text-figure tabular-nums">{count}</span>
                <span
                  className={cn(
                    "truncate text-xs",
                    entry.warn ? "text-(--status-attention)" : "text-muted-foreground"
                  )}
                >
                  {entry.sub}
                </span>
              </button>
            )
          })}
        </div>

        {byCustomer.length === 0 ? null : (
          <section
            aria-label="By customer"
            className="flex flex-[2] flex-col gap-2.5 rounded-xl border border-border bg-card px-4 py-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
              <span>By customer</span>
              <span className="flex gap-3">
                <span className="flex items-center gap-1.5">
                  <i aria-hidden="true" className="size-2 rounded-[2px] bg-(--status-inflight)" />
                  To act on
                </span>
                <span className="flex items-center gap-1.5">
                  <i aria-hidden="true" className="size-2 rounded-[2px] bg-muted-foreground" />
                  Won&rsquo;t do
                </span>
                <span className="flex items-center gap-1.5">
                  <i aria-hidden="true" className="size-2 rounded-[2px] bg-(--status-verified)" />
                  Resolved
                </span>
              </span>
            </div>
            <ul className="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
              {byCustomer.map((row) => (
                <li key={row.name}>
                  <button
                    type="button"
                    aria-pressed={customer === row.name}
                    onClick={() => {
                      setCustomer(customer === row.name ? null : row.name)
                      reset()
                    }}
                    className={cn(
                      "grid w-full grid-cols-[minmax(0,7rem)_minmax(0,1fr)_4.5rem] items-center gap-3 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:bg-muted",
                      customer === row.name && "bg-muted"
                    )}
                  >
                    <span className="truncate text-meta font-medium">{row.name}</span>
                    <span className="block h-2 rounded-[3px] bg-muted">
                      <span
                        className="flex h-full gap-0.5 overflow-hidden rounded-[3px]"
                        style={{ width: `${Math.max(6, Math.round(((row.act + row.wont + row.done) / most) * 100))}%` }}
                      >
                        <span className="bg-(--status-inflight)" style={{ flex: row.act }} />
                        <span className="bg-muted-foreground" style={{ flex: row.wont }} />
                        <span className="bg-(--status-verified)" style={{ flex: row.done }} />
                      </span>
                    </span>
                    <span className="text-right font-mono text-xs text-muted-foreground tabular-nums">
                      <span className="text-foreground">{row.act}</span> · {row.act + row.wont + row.done}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {checked.size > 0 ? (
        <div
          role="toolbar"
          aria-label="Selected actions"
          className="flex flex-wrap items-center gap-2 rounded-xl bg-foreground py-1.5 pr-2 pl-4 text-background"
        >
          <span className="mr-1 text-meta font-semibold">{checked.size} selected</span>
          <span className="text-xs opacity-75">Owner</span>
          {(["customer", "msp"] as const).map((value) => (
            <button
              key={value}
              type="button"
              disabled={bulkBusy}
              onClick={() => void bulk({ owner: value })}
              className="h-7 rounded-md border border-background/30 px-2.5 text-xs font-medium hover:bg-background/10 disabled:opacity-50"
            >
              {OWNER[value]}
            </button>
          ))}
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-background/25" />
          <button
            type="button"
            disabled={bulkBusy}
            onClick={() => void bulk({ status: "accepted" })}
            className="h-7 rounded-md border border-background/30 px-2.5 text-xs font-medium hover:bg-background/10 disabled:opacity-50"
          >
            Mark accepted
          </button>
          <button
            type="button"
            onClick={() => setChecked(new Set())}
            className="ml-auto h-7 rounded-md px-2.5 text-xs opacity-80 hover:opacity-100"
          >
            {bulkBusy ? "Saving…" : "Clear"}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-8 min-w-0 flex-[1_1_14rem] items-center gap-2 rounded-lg border border-input bg-background px-2.5 sm:max-w-80">
            <MagnifyingGlassIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(0)
              }}
              aria-label="Search actions"
              placeholder="Search findings, resources, notes"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>
          <div role="group" aria-label="Kind" className="flex flex-wrap gap-1.5">
            {["all", ...kinds].map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => {
                  setKind(value)
                  reset()
                }}
                className={cn(
                  "h-7 rounded-full border px-3 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
                  kind === value
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-card hover:border-input"
                )}
              >
                {value === "all" ? "All kinds" : KIND[value]}
              </button>
            ))}
          </div>
          <Select
            value={owner}
            onValueChange={(value) => {
              if (value) setOwner(value as OwnerFilter)
              reset()
            }}
          >
            <SelectTrigger size="sm" className="w-32" aria-label="Owner filter">
              <SelectValue>{(value) => OWNER_FILTER[value as OwnerFilter] ?? ""}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(OWNER_FILTER).map(([value, label]) => (
                <SelectItem key={value} value={value} label={label}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {customer === null ? null : (
            <button
              type="button"
              onClick={() => {
                setCustomer(null)
                reset()
              }}
              className="flex h-7 items-center gap-1 rounded-full bg-muted px-2.5 text-xs hover:bg-accent"
            >
              {customer}
              <XIcon aria-label="Show every customer" className="size-3" />
            </button>
          )}
          <span className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">
              {shown.length} of {scoped.filter((item) => inTab(item, tab, newMonth)).length}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={shown.length === 0}
              onClick={() =>
                download(`${fileLabel}-${new Date().toISOString().slice(0, 10)}.csv`, actionsCsv(shown))
              }
            >
              <DownloadSimpleIcon aria-hidden="true" />
              Export CSV
            </Button>
          </span>
        </div>
      )}
      {bulkMessage === null ? null : (
        <p aria-live="polite" className="text-xs text-destructive">
          {bulkMessage}
        </p>
      )}

      <div className="flex items-start gap-4">
        <section
          aria-label="Action list"
          className="min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-card"
        >
          <div role="table" aria-label="Actions">
            <div
              role="row"
              className={cn(
                "hidden h-9 items-center gap-x-3 bg-muted/60 pr-3 text-xs text-muted-foreground md:grid",
                gridColumns
              )}
            >
              <span role="columnheader">
                <span className="sr-only">Select</span>
              </span>
              <span role="columnheader">Finding</span>
              {showCustomer ? <span role="columnheader">Customer</span> : null}
              <span role="columnheader">Owner</span>
              <span role="columnheader">Status</span>
              <span role="columnheader" className="text-right">
                First seen
              </span>
            </div>

            {shown.length === 0 ? (
              <p className="border-t border-border/60 px-4 py-8 text-meta text-muted-foreground">
                Nothing matches. Try another tab or clear the filters.
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.name || "items"} role="rowgroup">
                  {showCustomer ? (
                    <div
                      role="row"
                      className="flex h-8 items-center gap-2 border-t border-border/60 pr-4 pl-4 text-xs md:pl-12"
                    >
                      <span role="rowheader" className="font-semibold">
                        {group.name}
                      </span>
                      <span className="text-muted-foreground">
                        {group.items[0]?.connector}
                      </span>
                    </div>
                  ) : null}
                  {group.items.map((item) => {
                    const on = selected?.id === item.id
                    return (
                      <div
                        key={item.id}
                        role="row"
                        data-status={item.status}
                        aria-selected={on}
                        className={cn(
                          "relative grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-border/60 py-2 pr-3 hover:bg-muted/40",
                          gridColumns,
                          on && "bg-muted hover:bg-muted"
                        )}
                      >
                        <span role="cell" className="relative z-10 grid place-items-center">
                          {canEdit && item.status !== "resolved" ? (
                            <Checkbox
                              checked={checked.has(item.id)}
                              onCheckedChange={(value) =>
                                setChecked((all) => {
                                  const next = new Set(all)
                                  if (value) next.add(item.id)
                                  else next.delete(item.id)
                                  return next
                                })
                              }
                              aria-label={`Select ${item.title}`}
                            />
                          ) : null}
                        </span>
                        <span role="cell" className="flex min-w-0 flex-col gap-0.5">
                          <button
                            type="button"
                            onClick={() => select(item)}
                            className="truncate text-left text-sm font-medium outline-none after:absolute after:inset-0 hover:underline hover:underline-offset-3 focus-visible:after:ring-3 focus-visible:after:ring-ring/30"
                          >
                            {item.title}
                          </button>
                          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="shrink-0 rounded-md bg-muted px-1.5 leading-[18px] text-foreground">
                              {KIND[item.kind] ?? item.kind}
                            </span>
                            <span className="truncate">{item.connector}</span>
                            <span className="shrink-0 md:hidden">· {STATUS[item.status]}</span>
                            {isNew(item, newMonth) && isActive(item) ? (
                              <span className="shrink-0 rounded-md bg-(--status-inflight-soft) px-1.5 leading-[18px] font-medium text-(--status-inflight)">
                                New
                              </span>
                            ) : null}
                          </span>
                        </span>
                        {showCustomer ? (
                          <span role="cell" className="hidden truncate text-meta md:block">
                            {item.customer}
                          </span>
                        ) : null}
                        <span role="cell">
                          <span
                            className={cn(
                              "inline-flex h-[22px] items-center rounded-md px-2 text-xs whitespace-nowrap",
                              item.owner === null
                                ? "border border-dashed border-(--status-attention) text-(--status-attention)"
                                : "bg-muted"
                            )}
                          >
                            {item.owner === null ? "Unassigned" : OWNER[item.owner]}
                          </span>
                        </span>
                        <span role="cell" className="hidden items-center gap-1.5 text-meta md:flex">
                          <i aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[item.status])} />
                          {STATUS[item.status]}
                        </span>
                        <span
                          role="cell"
                          className="hidden text-right font-mono text-xs text-muted-foreground tabular-nums md:block"
                        >
                          {shortMonth.format(asDate(item.firstSeenPeriod))}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>
          {shown.length <= PAGE_SIZE ? null : (
            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
              <span className="tabular-nums">
                Rows {at * PAGE_SIZE + 1}–{at * PAGE_SIZE + pageItems.length} of {shown.length}
              </span>
              <span className="flex gap-1.5">
                <Button type="button" size="sm" variant="outline" disabled={at === 0} onClick={() => setPage(at - 1)}>
                  Previous
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={at >= pages - 1}
                  onClick={() => setPage(at + 1)}
                >
                  Next
                </Button>
              </span>
            </footer>
          )}
        </section>

        {wide && selected !== undefined ? (
          <aside
            aria-label="Selected action"
            className="sticky top-4 flex w-[22rem] shrink-0 flex-col rounded-xl border border-border bg-card"
          >
            <div className="flex flex-col gap-2 border-b border-border/60 px-4 pt-4 pb-3 md:px-5">
              <DetailHeading item={selected} />
              <h2 className="text-section break-words">{selected.title}</h2>
            </div>
            <ActionDetail key={selected.id} item={selected} canEdit={canEdit} onSaved={keep} />
          </aside>
        ) : null}
      </div>

      {!wide && selected !== undefined ? (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="bottom" className="max-h-[88dvh] overflow-y-auto rounded-t-2xl">
            <SheetHeader className="gap-2 pr-12">
              <DetailHeading item={selected} />
              <SheetTitle className="text-section break-words">{selected.title}</SheetTitle>
              <SheetDescription className="sr-only">Owner, status and note for this action.</SheetDescription>
            </SheetHeader>
            <ActionDetail key={selected.id} item={selected} canEdit={canEdit} onSaved={keep} />
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  )
}
