"use client"

import { useState } from "react"
import { CheckCircleIcon, EnvelopeSimpleIcon, PlusIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react"

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
 * contact list's own buttons. The add-contact fields stay folded behind one button
 * until they are needed, so the card fits beside the report as a narrow column.
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
    <div
      className={
        failed
          ? "flex gap-2.5 rounded-lg bg-(--status-failed-soft) px-3 py-2.5 text-(--status-failed)"
          : "flex gap-2.5 rounded-lg bg-(--status-verified-soft) px-3 py-2.5 text-(--status-verified)"
      }
    >
      {failed ? (
        <WarningCircleIcon aria-hidden="true" weight="fill" className="mt-0.5 size-4 shrink-0" />
      ) : (
        <CheckCircleIcon aria-hidden="true" weight="fill" className="mt-0.5 size-4 shrink-0" />
      )}
      <div className="flex min-w-0 flex-col text-sm">
        {failed ? (
          <span className="font-semibold">Not sent</span>
        ) : (
          <>
            <span className="font-semibold">Sent {when.format(new Date(delivery.approvedAt))} WIB</span>
            <span>
              To {delivered} of {delivery.recipients.length}
              {delivery.recipients.length === 1 ? " contact" : " contacts"} ·{" "}
              {delivery.openCount > 0 ? `opened ${delivery.openCount}×` : "not opened yet"}
            </span>
          </>
        )}
        {delivery.recipients
          .filter((r) => !r.ok)
          .map((r) => (
            <span key={r.email} className="text-xs break-all">
              {r.email}: {r.error}
            </span>
          ))}
      </div>
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
  const [adding, setAdding] = useState(false)
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

  const action = delivery === null ? "Approve and send" : "Send again"

  return (
    <section
      aria-labelledby="send-title"
      data-slot="send-card"
      className="flex min-w-0 flex-col rounded-xl border border-border bg-card"
    >
      <header className="flex flex-col gap-3 px-4 pt-4 pb-3 md:px-5">
        <h2 id="send-title" className="text-sm font-semibold">
          Send to customer
        </h2>
        {delivery === null ? (
          <p className="text-meta text-muted-foreground">
            Emails {customer}&rsquo;s contacts a link to this verified report, from your domain.
          </p>
        ) : (
          <DeliveryStatus delivery={delivery} />
        )}
      </header>

      <div className="flex flex-col px-4 md:px-5">
        {contacts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
            No contacts yet. Add the people at {customer} who should receive this report.
          </p>
        ) : (
          <ul aria-label="Contacts" className="flex flex-col">
            {contacts.map((contact) => (
              <li key={contact.id} className="flex items-center gap-2.5 border-t border-border py-2.5">
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
                    <XIcon aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {!canEdit ? null : adding || contacts.length === 0 ? (
          <form
            className="flex flex-col gap-2 border-t border-border pt-3 pb-1"
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
                setAdding(false)
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
            <div className="flex gap-2">
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
                Add
              </Button>
            </div>
          </form>
        ) : (
          <div className="border-t border-border pt-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 text-muted-foreground"
              onClick={() => setAdding(true)}
            >
              <PlusIcon aria-hidden="true" />
              Add contact
            </Button>
          </div>
        )}
      </div>

      <footer className="flex flex-col gap-2 px-4 pt-3 pb-4 md:px-5">
        {mailIssue !== null ? (
          <p className="text-xs text-muted-foreground">Email is not set up on this server, so nothing can be sent. {mailIssue}</p>
        ) : !canSend ? (
          <p className="text-xs text-muted-foreground">Only an Owner or Admin can approve and send a report.</p>
        ) : confirming ? (
          <div className="flex flex-col gap-2.5 rounded-lg bg-muted/60 p-3">
            <span className="text-sm">Send this verified report to {audience}?</span>
            <div className="flex justify-end gap-2">
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
          <>
            <Button
              type="button"
              className="w-full"
              disabled={busy || contacts.length === 0}
              onClick={() => setConfirming(true)}
            >
              <EnvelopeSimpleIcon aria-hidden="true" />
              {contacts.length === 0 ? action : `${action} to ${audience}`}
            </Button>
            <span className="text-xs text-muted-foreground">
              One email each, with a link from your domain. The link expires, and the report is not attached.
            </span>
          </>
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
