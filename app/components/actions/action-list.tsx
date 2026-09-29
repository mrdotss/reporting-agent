"use client"

import { useState } from "react"
import Link from "next/link"
import { CheckCircleIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ActionItemView } from "@/lib/action-register/store"

/**
 * One customer's Action register: what to act on, what was turned down, and what the
 * reports have proved resolved. Owner, status and note are set here; Resolved is not —
 * the next verified report sets it when it checks a finding clear.
 */

const KIND: Readonly<Record<string, string>> = {
  housekeeping: "Housekeeping",
  backup: "Backup",
  rightsizing: "Rightsizing",
  advisor: "Advisor",
}
const STATUS: Readonly<Record<string, string>> = { open: "Open", accepted: "Accepted", wont_do: "Won't do" }
const OWNER: Readonly<Record<string, string>> = { none: "No owner", customer: "Customer", msp: "MSP" }
const month = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })
const since = (period: string) => month.format(new Date(`${period}T00:00:00Z`))

function Row({ item, canEdit, onSaved }: Readonly<{ item: ActionItemView; canEdit: boolean; onSaved: (item: ActionItemView) => void }>) {
  const [owner, setOwner] = useState<string>(item.owner ?? "none")
  const [status, setStatus] = useState<string>(item.status === "resolved" ? "open" : item.status)
  const [note, setNote] = useState(item.note ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = owner !== (item.owner ?? "none") || status !== item.status || note !== (item.note ?? "")

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/actions/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: owner === "none" ? null : owner, status, note: note.trim() || null }),
      })
      const body = (await response.json().catch(() => ({}))) as { item?: ActionItemView; error?: { message?: string } }
      if (!response.ok || body.item === undefined) {
        setError(body.error?.message ?? "The change could not be saved.")
        return
      }
      onSaved(body.item)
    } catch {
      setError("The change could not be saved. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <li data-status={item.status} className="flex flex-col gap-2 border-t border-border/60 px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium break-words">{item.title}</p>
          <p className="text-xs text-muted-foreground">
            <span className="rounded-md bg-muted px-1.5 py-0.5">{KIND[item.kind] ?? item.kind}</span> · {item.connector} ·
            First seen {since(item.firstSeenPeriod)}
          </p>
        </div>
        {item.status === "resolved" ? (
          <span className="flex items-center gap-1.5 text-xs text-(--status-verified)">
            <CheckCircleIcon aria-hidden="true" weight="fill" className="size-4" />
            Resolved
            {item.resolvedRunId === null ? null : (
              <Link href={`/reports/${item.resolvedRunId}`} className="underline underline-offset-3">
                by this report
              </Link>
            )}
          </span>
        ) : null}
      </div>

      {item.status === "resolved" ? null : canEdit ? (
        <div className="flex flex-wrap items-end gap-2">
          <Select value={owner} onValueChange={(value) => value && setOwner(value)}>
            <SelectTrigger className="w-36" aria-label="Owner">
              <SelectValue>{(value) => OWNER[String(value)] ?? ""}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(OWNER).map(([value, label]) => (
                <SelectItem key={value} value={value} label={label}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(value) => value && setStatus(value)}>
            <SelectTrigger className="w-36" aria-label="Status">
              <SelectValue>{(value) => STATUS[String(value)] ?? ""}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(STATUS).map(([value, label]) => (
                <SelectItem key={value} value={value} label={label}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input
            aria-label="Note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={1000}
            placeholder={status === "wont_do" ? "Why it won't be done (required)" : "Note (optional)"}
            className="h-8 min-w-48 flex-1 rounded-md border border-input bg-background px-2.5 text-sm"
          />
          <Button type="button" size="sm" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {STATUS[item.status]} · {item.owner === null ? "No owner" : OWNER[item.owner]}
          {item.note ? ` · ${item.note}` : ""}
        </p>
      )}
      {error === null ? null : (
        <p aria-live="polite" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  )
}

export function ActionList({ items, canEdit }: Readonly<{ items: readonly ActionItemView[]; canEdit: boolean }>) {
  const [current, setCurrent] = useState(items)
  const groups: { key: string; title: string; hint: string; items: ActionItemView[] }[] = [
    {
      key: "act",
      title: "To act on",
      hint: "Open and accepted items. The next verified report resolves any it checks clear.",
      items: current.filter((item) => item.status === "open" || item.status === "accepted"),
    },
    { key: "wont", title: "Won't do", hint: "Turned down, with the reason.", items: current.filter((item) => item.status === "wont_do") },
    { key: "done", title: "Resolved", hint: "Checked clear by a verified report.", items: current.filter((item) => item.status === "resolved") },
  ]

  if (current.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card px-4 py-6 text-meta text-muted-foreground">
        No actions yet. They appear after this customer&rsquo;s next verified report: stopped machines, missing backups,
        rightsizing and Advisor recommendations.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) =>
        group.items.length === 0 ? null : (
          <section key={group.key} aria-labelledby={`actions-${group.key}`} className="rounded-xl border border-border bg-card">
            <div className="flex items-baseline justify-between gap-3 p-4 pb-3">
              <div className="flex flex-col gap-0.5">
                <h2 id={`actions-${group.key}`} className="text-section">
                  {group.title}
                </h2>
                <p className="text-meta text-muted-foreground">{group.hint}</p>
              </div>
              <span className="font-mono text-meta tabular-nums text-muted-foreground">{group.items.length}</span>
            </div>
            <ul className="border-t border-border/60">
              {group.items.map((item) => (
                <Row
                  key={item.id}
                  item={item}
                  canEdit={canEdit}
                  onSaved={(saved) => setCurrent((all) => all.map((entry) => (entry.id === saved.id ? saved : entry)))}
                />
              ))}
            </ul>
          </section>
        )
      )}
    </div>
  )
}
