"use client"

import { useState } from "react"
import { CheckCircleIcon, EnvelopeSimpleIcon, PlusIcon, TrashIcon, WarningCircleIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ContactView, DeliveryView } from "@/lib/delivery/store"

/**
 * "Send to customer" on a verified report: the customer's contacts, and one button that
 * approves this report and emails it to them. Approving is recorded with who sent it.
 * The confirmation is part of the card — the viewer's browser shows no dialogs.
 *
 * Three zones: the last send's outcome, the contacts it goes to, and the action. The
 * action sits in its own footer so the one irreversible control is never among the
 * contact list's own buttons.
 */

const when = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Jakarta",
})

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("") || "?"

function DeliveryStatus({ delivery }: Readonly<{ delivery: DeliveryView }>) {
  const delivered = delivery.recipients.filter((r) => r.ok).length
  const failed = delivery.status === "failed"
  return (
    <div className="flex flex-col gap-1.5 border-y border-border bg-muted/40 px-4 py-3 md:px-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="flex items-center gap-2 text-sm">
          {failed ? (
            <WarningCircleIcon aria-hidden="true" weight="fill" className="size-4 shrink-0 text-destructive" />
          ) : (
            <CheckCircleIcon aria-hidden="true" weight="fill" className="size-4 shrink-0 text-(--status-verified)" />
          )}
          {failed ? (
            <span className="text-destructive">Not sent</span>
          ) : (
            <span>
              Sent {when.format(new Date(delivery.approvedAt))} WIB to {delivered} of {delivery.recipients.length}
              {delivery.recipients.length === 1 ? " contact" : " contacts"}
            </span>
          )}
        </p>
        {failed ? null : (
          <span className="rounded-md bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-border">
            {delivery.openCount > 0 ? `Opened ${delivery.openCount}×` : "Not opened yet"}
          </span>
        )}
      </div>
      {delivery.recipients
        .filter((r) => !r.ok)
        .map((r) => (
          <p key={r.email} className="pl-6 text-xs text-destructive">
            {r.email}: {r.error}
          </p>
        ))}
    </div>
  )
}

export function SendCard({
  runId,
  workspaceId,
  projectId,
  customer,
  contacts: initialContacts,
  delivery: initialDelivery,
  canEdit,
  canSend,
  mailIssue,
}: Readonly<{
  runId: string
  workspaceId: string
  projectId: string
  customer: string
  contacts: readonly ContactView[]
  delivery: DeliveryView | null
  canEdit: boolean
  canSend: boolean
  /** Why email is off on this server, naming the setting; `null` when it can send. */
  mailIssue: string | null
}>) {
  const [contacts, setContacts] = useState(initialContacts)
  const [delivery, setDelivery] = useState(initialDelivery)
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function call<T>(url: string, init: RequestInit): Promise<T | null> {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } })
      const body = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } }
      if (!response.ok) {
        setError(body.error?.message ?? "That did not work. Nothing changed.")
        return null
      }
      return body
    } catch {
      setError("That did not work. Check your connection and try again.")
      return null
    } finally {
      setBusy(false)
    }
  }

  const audience = `${contacts.length} ${contacts.length === 1 ? "contact" : "contacts"}`

  return (
    <section
      aria-labelledby="send-title"
      data-slot="send-card"
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card"
    >
      <header className="flex flex-col gap-1 px-4 pt-4 pb-3 md:px-5 md:pt-5">
        <h2 id="send-title" className="text-section">
          Send to customer
        </h2>
        <p className="text-meta text-muted-foreground">
          Emails {customer}&rsquo;s contacts a link to this verified report, from your domain. The link expires, and the
          report is not attached.
        </p>
      </header>

      {delivery === null ? null : <DeliveryStatus delivery={delivery} />}

      <div className="flex flex-col gap-3 px-4 py-4 md:px-5">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-micro font-medium tracking-wide text-muted-foreground uppercase">Contacts</h3>
          {contacts.length === 0 ? null : <span className="text-xs text-muted-foreground tabular-nums">{contacts.length}</span>}
        </div>

        {contacts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
            No contacts yet. Add the people at {customer} who should receive this report.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {contacts.map((contact) => (
              <li key={contact.id} className="flex items-center gap-3 px-3 py-2.5">
                <span
                  aria-hidden="true"
                  className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
                >
                  {initials(contact.name)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{contact.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{contact.email}</span>
                </span>
                {canEdit ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${contact.name}`}
                    disabled={busy}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={async () => {
                      if (await call(`/api/customers/contacts/${contact.id}`, { method: "DELETE" })) {
                        setContacts((all) => all.filter((c) => c.id !== contact.id))
                      }
                    }}
                  >
                    <TrashIcon aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canEdit ? (
          <form
            className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]"
            onSubmit={async (event) => {
              event.preventDefault()
              const body = await call<{ contact: ContactView }>("/api/customers/contacts", {
                method: "POST",
                body: JSON.stringify({ workspaceId, projectId, name, email }),
              })
              if (body) {
                setContacts((all) => [...all, body.contact].sort((a, b) => a.name.localeCompare(b.name)))
                setName("")
                setEmail("")
              }
            }}
          >
            <Input
              id="contact-name"
              aria-label="Contact name"
              placeholder="Name"
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Input
              id="contact-email"
              aria-label="Contact email"
              type="email"
              placeholder={`name@${customer.toLowerCase().replace(/[^a-z0-9]+/g, "") || "customer"}.com`}
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Button type="submit" variant="outline" disabled={busy || !name.trim() || !email.trim()}>
              <PlusIcon aria-hidden="true" />
              Add
            </Button>
          </form>
        ) : null}
      </div>

      <footer className="flex flex-col gap-2 border-t border-border bg-muted/30 px-4 py-3 md:px-5">
        {mailIssue !== null ? (
          <p className="text-xs text-muted-foreground">Email is not set up on this server, so nothing can be sent. {mailIssue}</p>
        ) : !canSend ? (
          <p className="text-xs text-muted-foreground">Only an Owner or Admin can approve and send a report.</p>
        ) : confirming ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm">Send this verified report to {audience}?</span>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={async () => {
                  const body = await call<{ delivery: DeliveryView }>(`/api/runs/${runId}/deliver`, { method: "POST" })
                  setConfirming(false)
                  if (body) setDelivery(body.delivery)
                }}
              >
                {busy ? "Sending…" : "Send"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {contacts.length === 0 ? "Add a contact to send." : `Goes to ${audience}, one email each.`}
            </span>
            <Button type="button" disabled={busy || contacts.length === 0} onClick={() => setConfirming(true)}>
              <EnvelopeSimpleIcon aria-hidden="true" />
              {delivery === null ? "Approve and send" : "Send again"}
            </Button>
          </div>
        )}
        {error === null ? null : (
          <p aria-live="polite" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </footer>
    </section>
  )
}
