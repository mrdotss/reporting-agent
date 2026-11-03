"use client"
import { RequestSummary } from "@/components/reports/request-summary"
import { useWorkspace, useCreationScope } from "@/components/workspaces/workspace-context"
import { can } from "@/lib/workspaces/policy"

import { useCallback, useEffect, useId, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ArrowCounterClockwiseIcon, CheckCircleIcon, PlayIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { IncidentsFieldset } from "@/components/reports/incidents-fieldset"
import { RegionsFieldset } from "@/components/reports/regions-fieldset"
import { SchedulePanel } from "@/components/schedules/schedule-panel"
import { Identifier } from "@/components/identifier"
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
  type Incident,
} from "@/lib/runs/input"
import type { ScheduleView } from "@/lib/schedules/view"
import { subscriptionRunBlocker } from "@/lib/subscriptions/state"
import {
  ProviderMark,
  SOURCE_NAMES,
  SOURCE_SHORT_NAMES,
} from "@/components/subscriptions/provider-mark"
import { sectionCount } from "@/components/templates/preset-status"
import { sectionEntry, sectionTitle } from "@/lib/builder/catalogue"
import { cn } from "@/lib/utils"

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
  schedule = null,
  initialTemplateId,
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
  /** This customer's monthly schedule, when it has one. */
  schedule?: ScheduleView | null
  /**
   * A preset to start on, from "Request a report" on the preset list. Honoured only when
   * it is runnable; the connector then starts on the first one of that preset's source.
   */
  initialTemplateId?: string
}>) {
  const workspace = useWorkspace()
  const projectScope = useCreationScope()
  const router = useRouter()

  const now = new Date(nowIso)

  const selectable = subscriptions.filter(
    (subscription) => blockedReason(subscription, now) === null
  )

  const initialTemplate = templates.find(
    (template) => template.id === initialTemplateId && template.currentVersion !== null
  )
  const [connectedSubscriptionId, setConnectedSubscriptionId] = useState(
    (initialTemplate === undefined
      ? undefined
      : selectable.find((subscription) => subscription.provider === initialTemplate.provider)
    )?.id ??
      selectable[0]?.id ??
      ""
  )

  // A preset is written for one source and a run pairs a connector only with presets
  // for the same one, so the preset choices narrow to the selected connector's provider.
  // The enqueue refuses a mismatched pair as well; this is what keeps the form from
  // offering one.
  const providerOf = (subscriptionId: string) =>
    subscriptions.find((entry) => entry.id === subscriptionId)?.provider ?? "azure"
  const selectedProvider = providerOf(connectedSubscriptionId)
  const providerName = SOURCE_NAMES[selectedProvider]
  const forProvider = templates.filter(
    (template) => template.provider === selectedProvider
  )
  const runnable = forProvider.filter(
    (template) => template.currentVersion !== null
  )

  const [templateId, setTemplateId] = useState(
    initialTemplate !== undefined && initialTemplate.provider === selectedProvider
      ? initialTemplate.id
      : (runnable[0]?.id ?? "")
  )

  /**
   * The AWS regions this run covers: `null` for every enabled region, otherwise the ones
   * ticked. Offered only when the connector has more than one region to choose between,
   * and reset whenever the connector changes — another account's regions are not a choice.
   */
  const enabledRegions =
    selectedProvider === "aws"
      ? (subscriptions.find((entry) => entry.id === connectedSubscriptionId)?.regions ?? [])
      : []
  const offersRegions = enabledRegions.length > 1
  const [pickedRegions, setPickedRegions] = useState<string[] | null>(null)
  const regions = offersRegions && pickedRegions !== null ? pickedRegions : []
  const regionsKey = regions.join(",")
  const regionsIncomplete = offersRegions && pickedRegions !== null && pickedRegions.length === 0
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
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [revision, setRevision] = useState("")
  const [revisionNote, setRevisionNote] = useState("")
  const [revisionAuthor, setRevisionAuthor] = useState("")

  const reuseFieldId = useId()
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
    // A snapshot of every region is not a snapshot of two, so the offer is asked for the
    // same choice the submission will carry.
    if (regionsKey !== "") query.set("regions", regionsKey)
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
  }, [connectedSubscriptionId, regionsKey, templateId, timezone])

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
            {...projectScope, ...buildRunCreateBody({
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
              incidents: selectedTemplate?.hasIncidentReport ? incidents : [],
              regions,
            })}
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
      incidents,
      regions,
      requiresFrontMatter,
      reusable,
      reuse,
      router,
      selectedTemplate?.hasIncidentReport,
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
    (!workspace || (!!workspace.projectId && !workspace.archived && can(workspace.role,"edit"))) &&
    !submitting &&
    connectedSubscriptionId !== "" &&
    templateId !== "" &&
    selectedTemplate?.currentVersion != null &&
    // A v2 template without its front-matter values would be rejected by the enqueue
    // with a message the browser deliberately does not show (`internalError()` is
    // fixed text), so the refusal has to happen here, where it can say what is
    // missing.
    (!requiresFrontMatter || frontMatterComplete) &&
    !regionsIncomplete

  /**
   * Why the submit is refused, in one sentence, or `undefined` when it is not.
   *
   * Derived from the same conditions `canSubmit` is, rather than written beside each
   * field: a reason that lived next to the input it came from was four lines away from
   * the control it explained, in the other column.
   */
  const submitBlockedReason =
    selectable.length === 0
      ? (messageText("ui.run_form.no_selectable_hint", "en") ?? undefined)
      : runnable.length === 0
        ? (messageText("ui.run_form.no_template_versions_hint", "en") ?? undefined)
        : requiresFrontMatter && !frontMatterComplete
          ? (messageText("ui.run_form.front_matter_incomplete", "en") ?? undefined)
          : regionsIncomplete
            ? (messageText("ui.run_form.regions_none_picked", "en") ?? undefined)
            : undefined

  // Resolved once: it does not vary per option, and the literal guard wants message ids
  // reaching `messageText` on one line rather than wrapped across four inside a map.
  const noVersionLabel = messageText("ui.run_form.no_version", "en") ?? ""

  /** Select a connector, moving the preset to one for its source when it has to. */
  const chooseConnection = (value: string) => {
    setConnectedSubscriptionId(value)
    setPickedRegions(null)
    // A preset for another source is no longer a valid choice; move to the first
    // runnable preset for this connector's source instead.
    const nextProvider = providerOf(value)
    if (templates.find((entry) => entry.id === templateId)?.provider !== nextProvider) {
      setTemplateId(
        templates.find(
          (entry) => entry.provider === nextProvider && entry.currentVersion !== null
        )?.id ?? ""
      )
    }
  }

  const presetsHint =
    templates.length === 0
      ? messageText("ui.run_form.no_templates_hint", "en")
      : forProvider.length === 0
        ? messageText("ui.run_form.no_provider_presets", "en", { provider: providerName })
        : runnable.length === 0
          ? messageText("ui.run_form.no_template_versions_hint", "en")
          : messageText("ui.run_form.provider_presets", "en", { provider: providerName })

  return (
    <form
      data-slot="run-form"
      onSubmit={submit}
      className={workspace ? "grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]" : "flex flex-col gap-4"}
    >
      <div className="flex min-w-0 flex-col">
        {/*
          Three numbered steps down a rail: where to read from, what to print, and the
          optional rest. The first two are the whole request for a normal month; the
          third is everything a consultant reaches for only sometimes.

          Cards rather than selects, because each choice carries more than a name — the
          connector's source, its masked id and whether it can run; the preset's version,
          size and description — and a select collapsed all of that into one line.
          Native radios underneath, so arrow keys move between cards and a screen reader
          hears a group of options with one checked.
        */}
        <RunFormStep number={1} done={connectedSubscriptionId !== ""} title={messageText("ui.run_form.step_connection", "en")} hint={messageText("ui.run_form.step_connection_hint", "en")}>
          <fieldset data-slot="run-form-connections" className="grid gap-3 sm:grid-cols-2">
            <legend className="sr-only">{messageText("ui.run_form.subscription_label", "en")}</legend>
            {subscriptions.map((subscription) => {
              const reason = blockedReason(subscription, now)
              const checked = subscription.id === connectedSubscriptionId
              return (
                <label
                  key={subscription.id}
                  data-slot="run-form-connection"
                  data-checked={checked ? "true" : "false"}
                  className={cn(
                    "relative flex min-w-0 items-center gap-3.5 rounded-xl border border-border bg-card p-4 transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring/40",
                    reason === null ? "cursor-pointer hover:border-ring" : "cursor-not-allowed opacity-60",
                    checked && "border-primary bg-primary/6 ring-3 ring-primary/15 hover:border-primary"
                  )}
                >
                  <input
                    type="radio"
                    name="connectedSubscriptionId"
                    value={subscription.id}
                    checked={checked}
                    disabled={reason !== null}
                    onChange={() => chooseConnection(subscription.id)}
                    className="sr-only"
                  />
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-background">
                    <ProviderMark kind={subscription.provider} className="size-6" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[15px] font-semibold">{subscription.displayName}</span>
                    <Identifier
                      value={subscription.maskedSubscriptionId}
                      kind="mask"
                      label="Subscription"
                      className="text-muted-foreground"
                    />
                    {/* Disabled *and* the reason, so the card never just refuses. */}
                    {reason === null ? (
                      <span className="flex items-center gap-1.5 text-xs text-(--status-verified)">
                        <span aria-hidden="true" className="size-1.5 rounded-full bg-(--status-verified)" />
                        {messageText("ui.run_form.connection_ready", "en")}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">{reason}</span>
                    )}
                  </span>
                  {checked ? (
                    <CheckCircleIcon aria-hidden="true" weight="fill" className="size-5 shrink-0 text-primary" />
                  ) : null}
                </label>
              )
            })}
          </fieldset>

          {selectable.length === 0 ? (
            <FieldDescription className="mt-3">
              {messageText("ui.run_form.no_selectable_hint", "en")}
            </FieldDescription>
          ) : null}
        </RunFormStep>

        <RunFormStep
          number={2}
          done={templateId !== ""}
          title={messageText("ui.run_form.step_preset", "en")}
          hint={presetsHint}
          aside={
            <Link
              href="/report-profiles"
              className="rounded-sm text-sm font-medium text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
            >
              {messageText("ui.run_form.browse_presets", "en")}
            </Link>
          }
        >
          {forProvider.length === 0 ? null : (
            <fieldset data-slot="run-form-presets" className="flex flex-col gap-2.5">
              <legend className="sr-only">{messageText("ui.run_form.template_label", "en")}</legend>
              {forProvider.map((template) => {
                const checked = template.id === templateId
                const unrunnable = template.currentVersion === null
                return (
                  <label
                    key={template.id}
                    data-slot="run-form-preset"
                    data-checked={checked ? "true" : "false"}
                    className={cn(
                      "relative flex min-w-0 items-start gap-4 rounded-xl border border-border bg-card p-4 transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring/40",
                      unrunnable ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-ring",
                      checked && "border-primary bg-primary/6 ring-3 ring-primary/15 hover:border-primary"
                    )}
                  >
                    <input
                      type="radio"
                      name="templateId"
                      value={template.id}
                      checked={checked}
                      disabled={unrunnable}
                      onChange={() => setTemplateId(template.id)}
                      className="sr-only"
                    />
                    <PageGlyph />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span data-slot="run-form-preset-name" className="text-[15px] font-semibold">{template.name}</span>
                        <span className="rounded-md border border-border px-1.5 font-mono text-[11px] text-muted-foreground tabular-nums">
                          {unrunnable ? noVersionLabel : `v${template.currentVersion}`}
                        </span>
                      </span>
                      {template.description.trim() === "" ? null : (
                        <span className="line-clamp-2 text-sm text-muted-foreground">{template.description}</span>
                      )}
                      {template.sectionTypes.length === 0 ? null : (
                        <span className="text-xs text-muted-foreground">{sectionCount(template.sectionTypes.length)}</span>
                      )}
                    </span>
                    {checked ? (
                      <CheckCircleIcon aria-hidden="true" weight="fill" className="size-5 shrink-0 text-primary" />
                    ) : null}
                  </label>
                )
              })}
            </fieldset>
          )}
        </RunFormStep>

        <RunFormStep
          number={3}
          last
          title={messageText("ui.run_form.step_options", "en")}
          optional={messageText("ui.run_form.step_options_optional", "en")}
          hint={messageText("ui.run_form.step_options_hint", "en")}
        >
          <div className="flex flex-col gap-3">
      {!requiresFrontMatter ? null : (
        <fieldset
          data-slot="run-form-front-matter"
          className="flex flex-col gap-4 rounded-xl border border-border bg-card px-4 pt-3.5 pb-4"
        >
          <legend className="float-left mb-1 w-full text-sm font-semibold">
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

          {/* Only where there is no summary rail to carry it. With the rail, this
              printed the same sentence twice on one screen — once under the fields and
              once beside the button. */}
          {frontMatterComplete || workspace ? null : (
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

      {/* Only for an AWS connector with more than one enabled region to choose between. */}
      {offersRegions ? (
        <RegionsFieldset
          enabled={enabledRegions}
          picked={pickedRegions}
          onChange={setPickedRegions}
        />
      ) : null}

      {/*
        A monthly schedule for this customer. Only inside a workspace — a schedule belongs
        to a customer — and never for a preset that needs per-run front-matter values,
        which a timer has nobody to ask for.
      */}
      {projectScope.workspaceId && projectScope.projectId ? (
        <SchedulePanel
          workspaceId={projectScope.workspaceId}
          projectId={projectScope.projectId}
          connectedSubscriptionId={connectedSubscriptionId}
          templateId={templateId}
          regions={regions}
          schedule={schedule}
          nameOfConnector={(id) => subscriptions.find((entry) => entry.id === id)?.displayName}
          nameOfTemplate={(id) => templates.find((entry) => entry.id === id)?.name}
          canSave={
            connectedSubscriptionId !== "" &&
            selectedTemplate?.currentVersion != null &&
            !requiresFrontMatter &&
            !regionsIncomplete
          }
        />
      ) : null}

      {/* Only for a preset whose report has an Incident Report table to print into. */}
      {selectedTemplate?.hasIncidentReport ? (
        <IncidentsFieldset incidents={incidents} onChange={setIncidents} />
      ) : null}

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
          className="rounded-xl border border-border bg-card px-4 py-3.5"
        >
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <ArrowCounterClockwiseIcon aria-hidden="true" className="mt-0.5 size-[18px] shrink-0 text-primary" />
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="font-semibold">
                {messageText("ui.run_form.reuse_label", "en")}
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">
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
            <input
              id={reuseFieldId}
              type="checkbox"
              name="reuseSnapshot"
              checked={reuse}
              onChange={(event) => setReuse(event.target.checked)}
              className="mt-1 size-4 shrink-0 accent-primary"
            />
          </label>
        </div>
      )}

      {/*
        The explanations a first request needs and a tenth does not: how the period
        resolves, what the run pins, and how long it takes. Folded, so the form reads as
        the three choices it is; one click away for whoever is checking.
      */}
      <details data-slot="run-form-details" className="group mt-1 text-sm">
        <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30">
          {messageText("ui.run_form.details_summary", "en")}
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <FieldDescription className="text-sm">
            {/*
              The period is the template's, not this form's, and it resolves at the
              moment the run is enqueued rather than now (Requirement 4.3). Saying so
              is what stops a consultant looking for the date fields that used to be
              here.
            */}
            {messageText("ui.run_form.period_explanation", "en", { timezone })}
          </FieldDescription>
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
              <Identifier
                value={selectedTemplate.currentVersionSha256}
                kind="digest"
                label="Definition digest"
              />
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {messageText("ui.run_form.duration_hint", "en")}
          </p>
        </div>
      </details>
          </div>
        </RunFormStep>

      {error === null ? null : (
        <p
          data-slot="run-form-error"
          // Announced, because the submit button returning to rest is otherwise the only
          // change on the page and a screen-reader user would not know the request failed.
          aria-live="polite"
          className="mt-4 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <div className={workspace ? "hidden" : "mt-4 flex justify-start"}>
        <Button type="submit" disabled={!canSubmit}>
          <PlayIcon aria-hidden="true" />
          {submitting ? messageText("ui.run_form.submitting", "en") : messageText("ui.run_form.submit", "en")}
        </Button>
      </div>
      </div>
      {workspace && (
        <RequestSummary
          key={`${connectedSubscriptionId}:${templateId}:${timezone}`}
          connectionId={connectedSubscriptionId}
          templateId={templateId}
          timezone={timezone}
          disabled={!canSubmit}
          submitting={submitting}
          blockedReason={submitBlockedReason}
          cover={
            selectedTemplate === undefined
              ? null
              : {
                  title: selectedTemplate.name,
                  customer: workspace.projectName ?? null,
                  kicker: [SOURCE_SHORT_NAMES[selectedProvider], subscriptions.find((entry) => entry.id === connectedSubscriptionId)?.displayName]
                    .filter(Boolean)
                    .join(" · "),
                }
          }
          sectionTitles={
            selectedTemplate === undefined || selectedTemplate.provider === "onprem"
              ? []
              : selectedTemplate.sectionTypes.map((type) =>
                  sectionTitle(sectionEntry(selectedTemplate.provider as "azure" | "aws", type), "en")
                )
          }
          regions={offersRegions ? (pickedRegions === null ? (messageText("ui.request_summary.regions_all", "en", { count: String(enabledRegions.length) }) ?? undefined) : regions.join(", ")) : undefined}
        />
      )}
    </form>
  )
}

/**
 * One numbered step on the form's rail: a numbered dot, a line down to the next step,
 * and the step's heading, hint and controls. The dot fills once the step has a choice.
 */
function RunFormStep({
  number,
  title,
  hint,
  optional,
  aside,
  done = false,
  last = false,
  children,
}: Readonly<{
  number: number
  title: string | undefined
  hint?: string
  optional?: string
  aside?: React.ReactNode
  done?: boolean
  last?: boolean
  children: React.ReactNode
}>) {
  return (
    <section data-slot="run-form-step" className="flex gap-4 sm:gap-5">
      <div className="flex flex-col items-center">
        <span
          aria-hidden="true"
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-full border text-sm font-semibold tabular-nums",
            done ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card text-foreground"
          )}
        >
          {number}
        </span>
        {last ? null : <span aria-hidden="true" className="mt-1.5 w-px flex-1 bg-border" />}
      </div>
      <div className={cn("flex min-w-0 flex-1 flex-col", last ? "pb-2" : "pb-8")}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pt-1">
          <h2 className="text-[17px] font-semibold">
            {title}
            {optional === undefined ? null : (
              <span className="ml-2 text-sm font-normal text-muted-foreground">{optional}</span>
            )}
          </h2>
          {aside}
        </div>
        {hint === undefined ? null : (
          <p className="mt-0.5 mb-4 text-sm text-muted-foreground">{hint}</p>
        )}
        {children}
      </div>
    </section>
  )
}

/** A small page with a header band, lines and a chart: what a preset prints, in miniature. */
function PageGlyph() {
  return (
    <span
      aria-hidden="true"
      className="flex h-[60px] w-[46px] shrink-0 flex-col gap-[3px] rounded-[4px] border border-border bg-background p-[5px]"
    >
      <span className="h-2 rounded-[1px] bg-primary/70" />
      <span className="h-[3px] w-4/5 rounded-full bg-muted-foreground/40" />
      <span className="flex h-3 items-end gap-[2px]">
        <span className="h-1/2 flex-1 bg-primary/45" />
        <span className="h-[90%] flex-1 bg-primary/45" />
        <span className="h-[70%] flex-1 bg-primary/45" />
      </span>
      <span className="h-[3px] rounded-full bg-muted-foreground/40" />
      <span className="h-[3px] w-3/4 rounded-full bg-muted-foreground/40" />
    </span>
  )
}
