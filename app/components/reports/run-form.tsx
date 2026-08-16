"use client"

import { useCallback, useId, useState } from "react"
import { useRouter } from "next/navigation"
import { PlayIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type { ConnectedSubscriptionView, RunView } from "@/lib/db/views"
import {
  MAX_PERIOD_DAYS,
  MIN_PERIOD_DAYS,
  checkPeriod,
  localDateIn,
} from "@/lib/runs/input"
import { subscriptionRunBlocker } from "@/lib/subscriptions/state"

/**
 * Request a report run (Requirements 37.1, 37.2, 37.4, 37.9, 37.10).
 *
 * ## Why this posts to a route rather than calling a server action
 *
 * `lib/actions/runs.ts#enqueueRun` takes the owning **user id as its first argument**, so
 * exposing it as a Server Function would make it a browser-reachable endpoint through
 * which any caller could enqueue a run against any user's subscription — and `actor_id`
 * is what prefixes every artifact key. So the module carries `import "server-only"` and
 * this form `fetch`es `POST /api/runs`, exactly as the subscriptions wizard posts to
 * `/api/subscriptions`. One orchestration path is preserved either way
 * (Requirement 37.4): form-triggered and chat-triggered runs both arrive at that action,
 * through that route.
 *
 * ## The form validates, and the server decides
 *
 * The period rules — 1 to 31 local days, ending at or before today **in the run's own
 * zone** — are checked here with the *same* pure `checkPeriod` the action uses, so the
 * hint a consultant reads and the rejection the server would send cannot disagree. That
 * is the point of the shared module rather than a duplicated rule: a form with its own
 * arithmetic is how a field hint and a route come to describe different months.
 *
 * The client check is a **courtesy**, not a gate. The action re-runs it against its own
 * instant, because the browser's clock is not authoritative and a form left open across
 * midnight would otherwise submit a period that has not finished.
 *
 * ## The composer is disabled with a reason, never silently
 *
 * A subscription whose scope was never verified, or whose secret has expired, cannot start
 * a run — the enqueue refuses it and so does the reaper. `subscriptionRunBlocker` is the
 * same predicate both of those use and the same one the expiry banner renders from, so the
 * option is disabled here **and says why**. A control that did nothing when clicked reads
 * as a bug, and the consultant would try it repeatedly.
 */

/** The default scope: virtual machines, which is what this spec collects. */
const DEFAULT_RESOURCE_TYPE = "Microsoft.Compute/virtualMachines"

/** The customer's zone, and the default the invoke context carries. */
const DEFAULT_TIMEZONE = "Asia/Jakarta"

/** What the route answers with. Parsed defensively — it is a network response. */
type CreateResponse = {
  readonly run?: RunView
  readonly error?: { readonly message?: string; readonly code?: string }
}

/** Why a subscription cannot be selected, or `null`. */
function blockedReason(
  subscription: ConnectedSubscriptionView,
  now: Date
): string | null {
  const blocker = subscriptionRunBlocker(subscription, now)
  if (blocker === null) return null

  return blocker === "AUTH_EXPIRED"
    ? "its client secret has expired"
    : "read at subscription scope is not proved"
}

export function RunForm({
  subscriptions,
  nowIso,
}: Readonly<{
  subscriptions: readonly ConnectedSubscriptionView[]
  /**
   * One instant, fixed by the server for this render.
   *
   * A prop rather than `new Date()` in the component body, for the reason
   * `subscription-list.tsx` takes one: every option is judged against the same clock, and
   * a value read during render would differ between the server pass and hydration and
   * produce a mismatch on the one screen whose job is to be precise about dates.
   */
  nowIso: string
}>) {
  const router = useRouter()

  const now = new Date(nowIso)

  const selectable = subscriptions.filter(
    (subscription) => blockedReason(subscription, now) === null
  )

  const [connectedSubscriptionId, setConnectedSubscriptionId] = useState(
    selectable[0]?.id ?? ""
  )
  const [periodStart, setPeriodStart] = useState("")
  const [periodEnd, setPeriodEnd] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const subscriptionFieldId = useId()
  const startFieldId = useId()
  const endFieldId = useId()

  /**
   * The report timezone.
   *
   * A constant rather than a field, because `ConnectedSubscriptionView` carries no
   * timezone and this spec has no surface for choosing one: the customer is
   * Asia/Jakarta, and that is the default the invoke context carries. It is a *named*
   * constant here rather than an inline string because it is threaded through three
   * places below — the period check, the hint, and the request body — and they must
   * agree, since the zone decides local-day bucketing and therefore every daily figure.
   */
  const timezone = DEFAULT_TIMEZONE

  /** Today in the run's zone, so the date inputs cannot offer a future day. */
  const latestDate = localDateIn(timezone, now)

  const periodProblem =
    periodStart === "" || periodEnd === ""
      ? null
      : checkPeriod({ periodStart, periodEnd, timezone }, now)

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()

      if (submitting) return
      setError(null)
      setSubmitting(true)

      try {
        const response = await fetch("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectedSubscriptionId,
            periodStart,
            periodEnd,
            timezone,
            scope: { resource_types: [DEFAULT_RESOURCE_TYPE] },
          }),
        })

        const body = (await response.json()) as CreateResponse

        if (!response.ok || body.run === undefined) {
          setError(
            body.error?.message ??
              "The run could not be requested. Nothing was started."
          )
          return
        }

        // Both 201 (inserted) and 200 (the existing run, returned because the derived
        // `dedupe_key` already existed) land here, and both navigate to the same place.
        // A double-submitted form therefore shows the run it already created rather than
        // an error about a duplicate — which is the whole point of the idempotency guard.
        router.push(`/reports/${body.run.id}`)
      } catch {
        setError(
          "The run could not be requested. Check your connection and try again."
        )
      } finally {
        setSubmitting(false)
      }
    },
    [
      connectedSubscriptionId,
      periodEnd,
      periodStart,
      router,
      submitting,
      timezone,
    ]
  )

  if (subscriptions.length === 0) {
    return (
      <p
        data-slot="run-form-no-subscriptions"
        className="text-sm text-muted-foreground"
      >
        Connect an Azure subscription before requesting a report. Nothing can be
        collected until read at subscription scope has been proved.
      </p>
    )
  }

  const canSubmit =
    !submitting &&
    connectedSubscriptionId !== "" &&
    periodStart !== "" &&
    periodEnd !== "" &&
    periodProblem === null

  return (
    <form
      data-slot="run-form"
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-xl border border-border px-4 py-4"
    >
      <Field>
        <FieldLabel htmlFor={subscriptionFieldId}>Subscription</FieldLabel>

        {/*
          A native `<select>` styled to match `Input`. The registry's Select is not in
          this app yet, and adding a primitive is a separate decision from shipping this
          screen — a native select is keyboard-accessible, works without JavaScript for
          the value it holds, and needs no focus management.
        */}
        <select
          id={subscriptionFieldId}
          value={connectedSubscriptionId}
          onChange={(event) => setConnectedSubscriptionId(event.target.value)}
          className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          {subscriptions.map((subscription) => {
            const reason = blockedReason(subscription, now)

            return (
              <option
                key={subscription.id}
                value={subscription.id}
                disabled={reason !== null}
              >
                {subscription.displayName}
                {" — "}
                {subscription.maskedSubscriptionId}
                {/* Disabled *and* the reason, so the control never just refuses. */}
                {reason === null ? "" : ` (unavailable: ${reason})`}
              </option>
            )
          })}
        </select>

        {selectable.length === 0 ? (
          <FieldDescription>
            None of your subscriptions can start a run yet. Each one needs a
            proved subscription-scope Reader assignment and a client secret
            Azure still accepts.
          </FieldDescription>
        ) : null}
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={startFieldId}>First day</FieldLabel>
          <Input
            id={startFieldId}
            type="date"
            value={periodStart}
            max={latestDate}
            onChange={(event) => setPeriodStart(event.target.value)}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor={endFieldId}>Last day</FieldLabel>
          <Input
            id={endFieldId}
            type="date"
            value={periodEnd}
            max={latestDate}
            onChange={(event) => setPeriodEnd(event.target.value)}
          />
        </Field>
      </div>

      <FieldDescription>
        {/*
          The accepted range, stated as Requirement 37.10 requires — and stated in terms
          of *local* days in the report's zone, because that is what the collector buckets
          by and what "July" means in this product.
        */}
        {MIN_PERIOD_DAYS} to {MAX_PERIOD_DAYS} local days in {timezone}, ending
        at or before {latestDate}. A period is local: &ldquo;July 2026&rdquo;
        means July in that zone, not July in UTC.
      </FieldDescription>

      {periodProblem === null ? null : (
        <p
          data-slot="run-form-period-problem"
          className="text-sm text-destructive"
        >
          {periodProblem === "inverted"
            ? "The first day is after the last day."
            : periodProblem === "too_long"
              ? `That period is longer than ${MAX_PERIOD_DAYS} local days.`
              : periodProblem === "ends_in_future"
                ? "That period ends after today in the report's timezone, so part of it has not happened yet."
                : "That is not a calendar period this server can resolve."}
        </p>
      )}

      {error === null ? null : (
        <p
          data-slot="run-form-error"
          // Announced, because the submit button returning to rest is otherwise the only
          // change on the page and a screen-reader user would not know the request failed.
          aria-live="polite"
          className="text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <div className="flex justify-start">
        <Button type="submit" disabled={!canSubmit}>
          <PlayIcon aria-hidden="true" />
          {submitting ? "Requesting…" : "Request a report"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        A run takes 8 to 12 minutes at a few hundred resources. It is recorded
        rather than streamed, so closing this tab does not affect it.
      </p>
    </form>
  )
}
