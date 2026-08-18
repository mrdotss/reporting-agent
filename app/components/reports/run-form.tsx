"use client"

import { useCallback, useId, useState } from "react"
import { useRouter } from "next/navigation"
import { PlayIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import type {
  ConnectedSubscriptionView,
  RunView,
  TemplateView,
} from "@/lib/db/views"
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
 * ## The form chooses a template; it does not choose a period or a scope
 *
 * Both used to be fields here, and both moved into the pinned template version
 * (Requirements 3.3, 4.3). A template stores the period as a **rule** —
 * `last_full_month`, `mtd` — that the enqueue resolves fresh at its own instant,
 * which is what makes a scheduled monthly report correct next month with no
 * edit; and it stores the scope as the union of its default and every block
 * override, which is what makes a block scoped to storage accounts actually
 * collect one.
 *
 * A form that still asked for either would be a second assertion about a fact
 * the definition already states, and the two would disagree the first time a
 * consultant added a block with a `scope_override`.
 *
 * ## The composer is disabled with a reason, never silently
 *
 * A subscription whose scope was never verified, or whose secret has expired, cannot start
 * a run — the enqueue refuses it and so does the reaper. `subscriptionRunBlocker` is the
 * same predicate both of those use and the same one the expiry banner renders from, so the
 * option is disabled here **and says why**. A control that did nothing when clicked reads
 * as a bug, and the consultant would try it repeatedly.
 */

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
  templates,
  nowIso,
}: Readonly<{
  subscriptions: readonly ConnectedSubscriptionView[]
  /**
   * Every template this user owns, with each one's highest saved version.
   *
   * A template carrying `currentVersion === null` has never completed step 7 of
   * the wizard, so there is no definition to pin and the enqueue would refuse it
   * (Requirement 9.6). It is offered **disabled with that reason** rather than
   * filtered out, the same treatment a blocked subscription gets and for the same
   * reason: a template a consultant just created and cannot find reads as a bug,
   * and "finish it in the wizard" is a thing they can act on.
   */
  templates: readonly TemplateView[]
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
  const runnable = templates.filter(
    (template) => template.currentVersion !== null
  )

  const [templateId, setTemplateId] = useState(runnable[0]?.id ?? "")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const subscriptionFieldId = useId()
  const templateFieldId = useId()

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

  const selectedTemplate = templates.find(
    (template) => template.id === templateId
  )

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
            templateId,
            timezone,
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
    [connectedSubscriptionId, router, submitting, templateId, timezone]
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
    templateId !== "" &&
    selectedTemplate?.currentVersion != null

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

      <Field>
        <FieldLabel htmlFor={templateFieldId}>Template</FieldLabel>

        <select
          id={templateFieldId}
          value={templateId}
          onChange={(event) => setTemplateId(event.target.value)}
          className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          {templates.map((template) => (
            <option
              key={template.id}
              value={template.id}
              disabled={template.currentVersion === null}
            >
              {template.name}
              {template.currentVersion === null
                ? " (unavailable: no saved version yet)"
                : ` — version ${template.currentVersion}`}
            </option>
          ))}
        </select>

        {templates.length === 0 ? (
          <FieldDescription>
            You have no templates. The three starters are created with your
            account; if none is listed, author one in the wizard.
          </FieldDescription>
        ) : runnable.length === 0 ? (
          <FieldDescription>
            None of your templates has a saved version yet. A template gets its
            first version when the wizard&rsquo;s last step completes.
          </FieldDescription>
        ) : null}
      </Field>

      {selectedTemplate?.currentVersionSha256 == null ? null : (
        <p
          data-slot="run-form-pinned-version"
          className="text-xs text-muted-foreground"
        >
          {/*
            The digest of the definition this run would pin, so a consultant who
            just saved can confirm the version they are about to run is the one
            they were looking at. Truncated for the line and shown in the mono
            face, the same treatment every other digest in the app gets.
          */}
          Pins version {selectedTemplate.currentVersion} ·{" "}
          <span className="font-mono">
            {selectedTemplate.currentVersionSha256.slice(0, 12)}
          </span>
        </p>
      )}

      <FieldDescription>
        {/*
          The period is the template's, not this form's, and it resolves at the
          moment the run is enqueued rather than now (Requirement 4.3). Saying so
          is what stops a consultant looking for the date fields that used to be
          here.
        */}
        The collection window comes from the template&rsquo;s own period rule and
        resolves when the run is enqueued, in {timezone}. A period is local:
        &ldquo;July 2026&rdquo; means July in that zone, not July in UTC.
      </FieldDescription>

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
