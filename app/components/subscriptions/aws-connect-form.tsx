"use client"

import { useId, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

const CREATE_ENDPOINT = "/api/subscriptions/aws"
const ACCOUNT_ID = /^\d{12}$/

/**
 * The first step of an AWS connection: a name and the account id.
 *
 * Submitting saves the connector as pending, with an external id the server generates, and
 * moves to its setup page, where the customer's template is waiting. The consultant can
 * leave and come back: the setup page is where the connection is finished, whenever the
 * customer gets to it.
 */
export function AwsConnectForm() {
  const router = useRouter()
  const nameId = useId()
  const accountId = useId()
  const problemId = useId()

  const [displayName, setDisplayName] = useState("")
  const [account, setAccount] = useState("")
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const accountValid = ACCOUNT_ID.test(account.trim())

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (displayName.trim().length === 0) {
      setProblem("Give the connection a name your team will recognise.")
      return
    }
    if (!accountValid) {
      setProblem("An AWS account id is 12 digits, like 123456789012.")
      return
    }

    setBusy(true)
    setProblem(null)
    try {
      const response = await fetch(CREATE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: displayName.trim(), accountId: account.trim() }),
      })
      const body: unknown = await response.json().catch(() => null)

      if (response.status === 201 && isCreated(body)) {
        router.push(`/subscriptions/${encodeURIComponent(body.subscription.id)}/setup`)
        return
      }
      setProblem(messageOf(body) ?? "The connection could not be started. Try again.")
    } catch {
      setProblem("The connection could not be started. Check your network and try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
      <p className="max-w-prose text-sm text-muted-foreground">
        The customer creates a read-only IAM role that only this service can assume,
        and only with an external ID issued for this connection. No secret changes
        hands and nothing expires.
      </p>

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={nameId}>Connection name</FieldLabel>
          <Input
            id={nameId}
            name="displayName"
            value={displayName}
            autoComplete="off"
            maxLength={120}
            aria-describedby={problem === null ? undefined : problemId}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <FieldDescription>How the account appears on reports and in Ask.</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor={accountId}>AWS account id</FieldLabel>
          <Input
            id={accountId}
            name="accountId"
            value={account}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            maxLength={12}
            aria-invalid={(account.length > 0 && !accountValid) || undefined}
            aria-describedby={problem === null ? undefined : problemId}
            className="font-mono tabular-nums"
            onChange={(event) => setAccount(event.target.value.replace(/\D/g, ""))}
          />
          <FieldDescription>
            The 12-digit account to report on. The setup template is generated for this
            account and names it.
          </FieldDescription>
        </Field>
      </FieldGroup>

      {problem === null ? null : (
        <p id={problemId} role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}

      <div className="flex justify-start">
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create the setup template"}
        </Button>
      </div>
    </form>
  )
}

function isCreated(body: unknown): body is { subscription: { id: string } } {
  if (typeof body !== "object" || body === null) return false
  const subscription = (body as { subscription?: unknown }).subscription
  return (
    typeof subscription === "object" &&
    subscription !== null &&
    typeof (subscription as { id?: unknown }).id === "string"
  )
}

function messageOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null
  const error = (body as { error?: unknown }).error
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  const message = (body as { message?: unknown }).message
  return typeof message === "string" ? message : null
}
