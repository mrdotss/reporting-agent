"use client"

import { useState } from "react"
import { EnvelopeSimpleIcon, TrashIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import type { ContactView, DeliveryView } from "@/lib/delivery/store"

/**
 * "Send to customer" on a verified report: the customer's contacts, and one button that
 * approves this report and emails it to them. Approving is recorded with who sent it.
 * The confirmation is part of the card — the viewer's browser shows no dialogs.
 */

const when = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Jakarta",
})

function DeliveryLine({ delivery }: Readonly<{ delivery: DeliveryView }>) {
  const delivered = delivery.recipients.filter((r) => r.ok).length
  const opened = delivery.openCount > 0 ? ` · opened ${delivery.openCount}×` : " · not opened yet"
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm">
        {delivery.status === "failed" ? (
          <span className="text-destructive">Not sent</span>
        ) : (
          <>
            Sent {when.format(new Date(delivery.approvedAt))} WIB to {delivered} of {delivery.recipients.length}
            {delivery.recipients.length === 1 ? " contact" : " contacts"}
            <span className="text-muted-foreground">{opened}</span>
          </>
        )}
      </p>
      {delivery.recipients
        .filter((r) => !r.ok)
        .map((r) => (
          <p key={r.email} className="text-xs text-destructive">
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
  mailReady,
}: Readonly<{
  runId: string
  workspaceId: string
  projectId: string
  customer: string
  contacts: readonly ContactView[]
  delivery: DeliveryView | null
  canEdit: boolean
  canSend: boolean
  mailReady: boolean
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

  return (
    <section aria-labelledby="send-title" data-slot="send-card" className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 md:p-5">
      <div className="flex flex-col gap-0.5">
        <h2 id="send-title" className="text-section">
          Send to customer
        </h2>
        <p className="text-meta text-muted-foreground">
          Emails {customer}&rsquo;s contacts a link to this verified report, from your domain. The link expires; the report
          is not attached.
        </p>
      </div>

      {delivery === null ? null : <DeliveryLine delivery={delivery} />}

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground uppercase">Contacts</p>
        {contacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No contacts yet.</p>
        ) : (
          <ul className="flex flex-col">
            {contacts.map((contact) => (
              <li key={contact.id} className="flex items-center justify-between gap-2 border-t border-border/60 py-1.5 first:border-t-0">
                <span className="min-w-0 truncate text-sm">
                  {contact.name} <span className="font-mono text-xs text-muted-foreground">{contact.email}</span>
                </span>
                {canEdit ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${contact.name}`}
                    disabled={busy}
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
            className="flex flex-wrap gap-2"
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
            <input
              id="contact-name"
              aria-label="Contact name"
              placeholder="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-8 w-36 rounded-md border border-input bg-background px-2.5 text-sm"
            />
            <input
              id="contact-email"
              aria-label="Contact email"
              type="email"
              placeholder="name@customer.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-8 min-w-48 flex-1 rounded-md border border-input bg-background px-2.5 text-sm"
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy || !name.trim() || !email.trim()}>
              Add
            </Button>
          </form>
        ) : null}
      </div>

      {!mailReady ? (
        <p className="text-xs text-muted-foreground">Email is not set up on this server yet, so nothing can be sent.</p>
      ) : !canSend ? (
        <p className="text-xs text-muted-foreground">Only an Owner or Admin can approve and send a report.</p>
      ) : confirming ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2">
          <span className="text-sm">
            Send this verified report to {contacts.length} {contacts.length === 1 ? "contact" : "contacts"}?
          </span>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={async () => {
              const body = await call<{ delivery: DeliveryView }>(`/api/runs/${runId}/deliver`, { method: "POST" })
              setConfirming(false)
              if (body) setDelivery(body.delivery)
            }}
          >
            {busy ? "Sending…" : "Send"}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button type="button" className="self-start" disabled={busy || contacts.length === 0} onClick={() => setConfirming(true)}>
          <EnvelopeSimpleIcon aria-hidden="true" />
          {delivery === null ? "Approve and send" : "Send again"}
        </Button>
      )}

      {error === null ? null : (
        <p aria-live="polite" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
