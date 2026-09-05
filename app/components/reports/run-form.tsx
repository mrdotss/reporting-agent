"use client"

import { useCallback, useEffect, useId, useState } from "react"
import { useRouter } from "next/navigation"
import { PlayIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type {
  ConnectedSubscriptionView,
  RunView,
  TemplateView,
} from "@/lib/db/views"
import { messageText } from "@/lib/messages/catalog"
import {
  buildRunCreateBody,
  MAX_REVISION_AUTHOR_LENGTH,
  MAX_REVISION_LENGTH,
  MAX_REVISION_NOTE_LENGTH,
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

/**
 * The lowest `schema_version` that renders front matter, and therefore the lowest
 * that needs the per-run values below (Requirements 13.7, 13.14).
 *
 * A `>=` comparison against a named threshold rather than `=== 2`, so a v3 template
 * — which will still have a cover and a document-control page — asks for them too
 * instead of silently falling through to the v1 branch and being rejected at the
 * enqueue. That silent fall-through is precisely the defect this field fixes, and
 * `=== 2` would reintroduce it on the next schema bump.
 */
const FRONT_MATTER_SCHEMA_VERSION = 2

/**
 * The lowest `schema_version` at which this form asks for **nothing** about the
 * document.
 *
 * A v3 profile carries the document's name, its number pattern and its signatories,
 * and `enqueueRun` derives the revision row from the account's own history — a
 * re-run of one period is the second issue of one document, which is a fact rather
 * than a field. So the whole Document details fieldset is a v2 surface now, and a
 * v3 run is two selects and a button.
 */
const DERIVED_REVISION_SCHEMA_VERSION = 3

/** What the route answers with. Parsed defensively — it is a network response. */
/** What `GET /api/runs/reusable` answers with. */
type ReusableCandidate = {
  readonly runId: string
  readonly collectedAt: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly resourceCount: number | null
  readonly gapCount: number | null
}

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

  /**
   * The per-run front-matter values a `schema_version >= 2` template needs
   * (Requirement 13.7).
   *
   * Held whether or not the selected template is v2, and **not cleared when the
   * selection changes to v1**: a consultant who types a revision note, looks at a v1
   * template and comes back should find their typing intact. What decides whether
   * these travel is `requiresFrontMatter` at submit time, not whether the inputs are
   * currently on screen — so a v1 run cannot carry them even if they hold values.
   *
   * Requirement 12.8 — `customerName` is deliberately **not** collected here.
   * It moved onto the pinned template's `identity.customer_name` at
   * schema_version 3 (task 4.4); nothing that identifies the customer is
   * asked at run time.
   */
  const [revision, setRevision] = useState("")
  const [revisionNote, setRevisionNote] = useState("")
  const [revisionAuthor, setRevisionAuthor] = useState("")

  const subscriptionFieldId = useId()
  const reuseFieldId = useId()
  const templateFieldId = useId()
  const revisionFieldId = useId()
  const revisionNoteFieldId = useId()
  const revisionAuthorFieldId = useId()

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

  /**
   * The snapshot this submission could reuse, and whether the consultant chose to.
   *
   * `undefined` while the answer is unknown — before both selects have values, and while
   * the request is in flight. `null` means asked and there is none. The distinction
   * matters on screen: "no earlier collection of this period" is a statement, and
   * showing it before the question was asked would be a wrong one.
   */
  const [reusable, setReusable] = useState<ReusableCandidate | null | undefined>(
    undefined
  )
  const [reuse, setReuse] = useState(false)

  useEffect(() => {
    if (!connectedSubscriptionId || !templateId) {
      setReusable(undefined)
      return
    }

    // Aborted on change rather than left to resolve. Two selections in quick succession
    // otherwise race, and the slower answer — about a profile no longer selected — wins.
    const controller = new AbortController()
    setReusable(undefined)

    const query = new URLSearchParams({
      connectedSubscriptionId,
      templateId,
      timezone,
    })
    fetch(`/api/runs/reusable?${query}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { candidate: null }))
      .then((body: { candidate: ReusableCandidate | null }) => {
        setReusable(body.candidate)
        // Never pre-ticked. Collecting is the safe default: it is what every run did
        // before this existed, and reuse is a choice about which numbers the document
        // carries rather than a preference about speed.
        setReuse(false)
      })
      .catch(() => {
        // An unreachable lookup is not a reason to block a run. No offer is shown and
        // the submission collects, which is what it would have done anyway.
        if (!controller.signal.aborted) setReusable(null)
      })

    return () => controller.abort()
  }, [connectedSubscriptionId, templateId, timezone])

  const selectedTemplate = templates.find(
    (template) => template.id === templateId
  )

  /**
   * Whether the selected template renders front matter, and so whether this run has
   * to carry a customer name and a revision row (Requirement 13.14).
   *
   * `undefined` — no template selected — is **not** treated as v2: there is nothing to
   * run yet, and asking for a document's details before choosing the document reads
   * as the form having lost its place.
   */
  const requiresFrontMatter =
    selectedTemplate !== undefined &&
    selectedTemplate.schemaVersion >= FRONT_MATTER_SCHEMA_VERSION &&
    selectedTemplate.schemaVersion < DERIVED_REVISION_SCHEMA_VERSION

  // Trimmed once, and these are the values both the gate and the request body use, so
  // a note of three spaces cannot pass the check and then travel as whitespace.
  const trimmedRevision = revision.trim()
  const trimmedRevisionNote = revisionNote.trim()
  const trimmedRevisionAuthor = revisionAuthor.trim()

  const frontMatterComplete =
    trimmedRevision !== "" &&
    trimmedRevisionNote !== "" &&
    trimmedRevisionAuthor !== ""

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
          // Built by `buildRunCreateBody` rather than inline here, so the shape this
          // form sends is the shape an integration test can feed to the real
          // `enqueueRun` — see that function's note. Building it inline is what let
          // the form and the enqueue disagree about v2 in the first place.
          body: JSON.stringify(
            buildRunCreateBody({
              connectedSubscriptionId,
              templateId,
              timezone,
              frontMatter: requiresFrontMatter
                ? {
                    revision: trimmedRevision,
                    note: trimmedRevisionNote,
                    author: trimmedRevisionAuthor,
                  }
                : null,
              reuseSnapshotRunId:
                reuse && reusable ? reusable.runId : null,
            })
          ),
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
      requiresFrontMatter,
      reusable,
      reuse,
      router,
      submitting,
      templateId,
      timezone,
      trimmedRevision,
      trimmedRevisionAuthor,
      trimmedRevisionNote,
    ]
  )

  if (subscriptions.length === 0) {
    return (
      <p
        data-slot="run-form-no-subscriptions"
        className="text-sm text-muted-foreground"
      >
        {messageText("ui.run_form.no_subscriptions", "en")}
      </p>
    )
  }

  const canSubmit =
    !submitting &&
    connectedSubscriptionId !== "" &&
    templateId !== "" &&
    selectedTemplate?.currentVersion != null &&
    // A v2 template without its front-matter values would be rejected by the enqueue
    // with a message the browser deliberately does not show (`internalError()` is
    // fixed text), so the refusal has to happen here, where it can say what is
    // missing.
    (!requiresFrontMatter || frontMatterComplete)

  return (
    <form
      data-slot="run-form"
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-xl border border-border px-4 py-4"
    >
      <Field>
        <FieldLabel htmlFor={subscriptionFieldId}>{messageText("ui.run_form.subscription_label", "en")}</FieldLabel>

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
            {messageText("ui.run_form.no_selectable_hint", "en")}
          </FieldDescription>
        ) : null}
      </Field>

      <Field>
        <FieldLabel htmlFor={templateFieldId}>{messageText("ui.run_form.template_label", "en")}</FieldLabel>

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
            {messageText("ui.run_form.no_templates_hint", "en")}
          </FieldDescription>
        ) : runnable.length === 0 ? (
          <FieldDescription>
            {messageText("ui.run_form.no_template_versions_hint", "en")}
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
          {messageText("ui.run_form.pinned_version_hint", "en", { version: String(selectedTemplate.currentVersion) })}{" "}
          <span className="font-mono">
            {selectedTemplate.currentVersionSha256.slice(0, 12)}
          </span>
        </p>
      )}

      {!requiresFrontMatter ? null : (
        <fieldset
          data-slot="run-form-front-matter"
          className="flex flex-col gap-4 rounded-lg border border-border px-3 py-3"
        >
          <legend className="px-1 font-heading text-sm font-medium tracking-tight">
            {messageText("ui.run_form.front_matter_heading", "en")}
          </legend>

          <FieldDescription>
            {messageText("ui.run_form.front_matter_hint", "en")}
          </FieldDescription>

          <Field>
            <FieldLabel htmlFor={revisionFieldId}>
              {messageText("ui.run_form.revision_label", "en")}
            </FieldLabel>

            <Input
              id={revisionFieldId}
              name="revision"
              value={revision}
              maxLength={MAX_REVISION_LENGTH}
              autoComplete="off"
              spellCheck={false}
              className="font-mono tabular-nums"
              onChange={(event) => setRevision(event.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor={revisionNoteFieldId}>
              {messageText("ui.run_form.revision_note_label", "en")}
            </FieldLabel>

            <Input
              id={revisionNoteFieldId}
              name="revisionNote"
              value={revisionNote}
              maxLength={MAX_REVISION_NOTE_LENGTH}
              onChange={(event) => setRevisionNote(event.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor={revisionAuthorFieldId}>
              {messageText("ui.run_form.revision_author_label", "en")}
            </FieldLabel>

            <Input
              id={revisionAuthorFieldId}
              name="revisionAuthor"
              value={revisionAuthor}
              maxLength={MAX_REVISION_AUTHOR_LENGTH}
              autoComplete="name"
              onChange={(event) => setRevisionAuthor(event.target.value)}
            />
          </Field>

          {frontMatterComplete ? null : (
            <p
              data-slot="run-form-front-matter-incomplete"
              // Announced for the same reason the submit error is: the button going
              // from enabled to disabled is otherwise a silent change.
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >
              {messageText("ui.run_form.front_matter_incomplete", "en")}
            </p>
          )}
        </fieldset>
      )}

      {/*
        The reuse offer, shown only when there is one to make.

        Deliberately not a silent optimisation. Re-running one period asks Azure the same
        question again and Azure may answer differently — late-arriving samples, a resized
        machine, a resource deleted since — so a consultant re-running to fix a cover page
        would otherwise get a document whose figures moved for reasons unrelated to the
        fix. Which they want depends on why they are re-running, which only they know.
      */}
      {reusable === null || reusable === undefined ? null : (
        <div
          data-slot="run-form-reuse"
          className="flex flex-col gap-1.5 rounded-lg border border-border px-3.5 py-3"
        >
          <label className="flex items-start gap-2.5 text-sm">
            <input
              id={reuseFieldId}
              type="checkbox"
              name="reuseSnapshot"
              checked={reuse}
              onChange={(event) => setReuse(event.target.checked)}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">
                {messageText("ui.run_form.reuse_label", "en")}
              </span>
              <span className="text-xs text-muted-foreground">
                {messageText("ui.run_form.reuse_detail", "en", {
                  collected: new Date(reusable.collectedAt)
                    .toISOString()
                    .slice(0, 10),
                  // `?? ""` because `messageText` answers `undefined` for an id the
                  // catalogue does not declare, and an interpolation value must be a
                  // string. A missing fragment degrades to nothing rather than printing
                  // `undefined` into the sentence around it.
                  resources:
                    reusable.resourceCount === null
                      ? ""
                      : (messageText("ui.run_form.reuse_resources", "en", {
                          count: String(reusable.resourceCount),
                        }) ?? ""),
                  gaps: reusable.gapCount
                    ? (messageText("ui.run_form.reuse_gaps", "en", {
                        count: String(reusable.gapCount),
                      }) ?? "")
                    : "",
                })}
              </span>
            </span>
          </label>
        </div>
      )}

      <FieldDescription>
        {/*
          The period is the template's, not this form's, and it resolves at the
          moment the run is enqueued rather than now (Requirement 4.3). Saying so
          is what stops a consultant looking for the date fields that used to be
          here.
        */}
        {messageText("ui.run_form.period_explanation", "en", { timezone })}
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
          {submitting ? messageText("ui.run_form.submitting", "en") : messageText("ui.run_form.submit", "en")}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {messageText("ui.run_form.duration_hint", "en")}
      </p>
    </form>
  )
}
