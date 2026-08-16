"use client"

import { useCallback, useId, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowLeftIcon, CircleNotchIcon } from "@phosphor-icons/react"
import { z } from "zod"

import { ArmTemplateStep } from "@/components/subscriptions/arm-template-step"
import { AzScriptStep } from "@/components/subscriptions/az-script-step"
import {
  PreflightResult,
  preflightResultSchema,
  type PreflightResult as PreflightResultValue,
  type VerifiedPreflight,
} from "@/components/subscriptions/preflight-result"
import {
  SecretExpiryField,
  isAcceptedExpiry,
  localDateTimeToIso,
} from "@/components/subscriptions/secret-expiry-field"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { isSubscriptionId } from "@/lib/subscriptions/azure-artifacts"
import {
  CLIENT_SECRET_MESSAGE,
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MESSAGE,
  SECRET_EXPIRY_MESSAGE,
} from "@/lib/subscriptions/input"
import { cn } from "@/lib/utils"

/**
 * The four-step onboarding wizard (Requirements 11.3–11.7, 11.9, 11.10, 12.7).
 *
 * ## Requirement 11.10 is held by the shape of this file
 *
 * There are exactly **two** requests here, and only one of them writes:
 *
 *   * {@link PREFLIGHT_ENDPOINT} tests a credential and persists nothing.
 *   * {@link CREATE_ENDPOINT} saves the connection, and its only caller is
 *     {@link connect}, whose parameter is a {@link VerifiedPreflight} — a type
 *     whose `scopeVerified` is the literal `true`. `PreflightResult` renders the
 *     control that calls it **only** inside the branch where the outcome has been
 *     narrowed to that type, and the control itself
 *     (`preflight-result.tsx`'s private `ConnectControl`) requires the same type.
 *
 * So there is no state of this wizard in which a save control exists without a
 * verified result behind it, and no argument through which the create request could
 * be issued from a rejected one. That is deliberately stronger than disabling a
 * button: a `disabled` flag is a state, and states get flipped by a later edit that
 * looks harmless.
 *
 * The server holds the same line independently and does not trust this one:
 * `POST /api/subscriptions` runs its **own** preflight and reads `scope_verified`
 * off that result, because the create schema has no field for it and
 * Requirement 12.14 reserves writing a `true` value to the Preflight_Service. This
 * component's structure is what makes the *wizard's flow* honest; the route is what
 * makes it enforced.
 *
 * ## Why this is the one client component in the group
 *
 * The step machine, the draft credential and the two requests all need the browser.
 * What does **not** is the required copy: {@link ConnectWizardProps.explainer} is
 * the server-rendered `<ReaderRoleExplainer />`, passed in as a prop rather than
 * imported, the same arrangement the `(app)` layout uses to keep `<UserMenu />` off
 * the client side of the sidebar. Requirements 11.3–11.5 are compliance copy; they
 * belong in the initial HTML.
 *
 * ## The draft credential
 *
 * `clientSecret` lives in this component's state for as long as the wizard is open,
 * which is unavoidable — a form that collects a secret holds it. It is never
 * persisted, never put in a URL, never logged, and the field is `type="password"`
 * with `autoComplete="off"`. It leaves in exactly two request bodies, over TLS, to
 * the two routes above.
 */

// --- The two endpoints ------------------------------------------------------

/** Tests a credential. Persists nothing (Requirements 12.11, 12.12). */
const PREFLIGHT_ENDPOINT = "/api/subscriptions/test"

/**
 * Saves the connection. The **only** writing request in this component, called
 * from the **only** function that requires a {@link VerifiedPreflight}.
 */
const CREATE_ENDPOINT = "/api/subscriptions"

/** Where an accepted connection lands. */
const SUBSCRIPTIONS_PATH = "/subscriptions"

// --- The steps --------------------------------------------------------------

const STEP_KEYS = ["role", "artifacts", "credentials", "result"] as const

type StepKey = (typeof STEP_KEYS)[number]

const STEP_LABELS: Record<StepKey, string> = {
  role: "Access",
  artifacts: "Role assignment",
  credentials: "Credentials",
  result: "Result",
}

/**
 * The wizard's state.
 *
 * A discriminated union rather than a `step` string beside a nullable outcome,
 * because the result step is meaningless without a result: the `result` member
 * **carries** the outcome, so there is no reachable state where the fourth step is
 * showing and there is nothing to show. That is the same reason
 * `PreflightOutcome` on the server is a union rather than a record of optionals.
 */
type WizardState =
  | { readonly step: "role" }
  | { readonly step: "artifacts" }
  | { readonly step: "credentials" }
  | { readonly step: "result"; readonly outcome: PreflightResultValue }

/** The credentials step's fields, as typed. */
type CredentialDraft = {
  displayName: string
  tenantId: string
  clientId: string
  clientSecret: string
  /** A `datetime-local` value — see `secret-expiry-field.tsx`. */
  secretExpiresAtLocal: string
  logAnalyticsWorkspaceId: string
}

const EMPTY_DRAFT: CredentialDraft = {
  displayName: "",
  tenantId: "",
  clientId: "",
  clientSecret: "",
  secretExpiresAtLocal: "",
  logAnalyticsWorkspaceId: "",
}

/** Which fields a validation pass rejected, for `aria-invalid`. */
type DraftField = keyof CredentialDraft | "subscriptionId"

// --- Messages ---------------------------------------------------------------

const SUBSCRIPTION_ID_MESSAGE =
  "Enter the Azure subscription id as a GUID in 8-4-4-4-12 hyphenated form, " +
  "for example 3f2504e0-4f89-11d3-9a0c-0305e82c3301."

const TENANT_ID_MESSAGE =
  "Enter the directory (tenant) id as a GUID in 8-4-4-4-12 hyphenated form."

const CLIENT_ID_MESSAGE =
  "Enter the application (client) id as a GUID in 8-4-4-4-12 hyphenated form. " +
  "This is the app registration's application id, not the service " +
  "principal's object id."

const WORKSPACE_ID_MESSAGE =
  "Leave the Log Analytics workspace id blank, or enter it as a GUID in " +
  "8-4-4-4-12 hyphenated form."

// --- Reading a route's answer ----------------------------------------------

/**
 * The error envelope every route handler answers in (`lib/api/response.ts`).
 *
 * Parsed rather than asserted: a route response is input to the browser exactly the
 * way a request body is input to a route, and `as ApiErrorBody` on a `fetch` result
 * is the cast Requirement 7.7 forbids, one boundary over.
 */
const apiErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
  }),
})

/** What a `fetch` to one of the two endpoints produced. */
type RouteAnswer = { readonly status: number; readonly body: unknown }

async function postJson(path: string, body: unknown): Promise<RouteAnswer> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  let parsed: unknown
  try {
    parsed = (await response.json()) as unknown
  } catch {
    parsed = undefined
  }

  return { status: response.status, body: parsed }
}

/**
 * The message a non-success answer carries, or a fallback.
 *
 * The route's own sentence is preferred because it is the one that states the
 * accepted range for a rejected expiry (Requirement 11.9) and the accepted shape for
 * a rejected id — both written next to the schema that enforces them, so neither can
 * drift from what is actually accepted.
 */
function messageFrom(answer: RouteAnswer): string {
  const parsed = apiErrorSchema.safeParse(answer.body)
  if (parsed.success) return parsed.data.error.message

  return (
    "The request could not be completed, and nothing was saved. Try again in " +
    "a moment."
  )
}

// --- The component ----------------------------------------------------------

type ConnectWizardProps = Readonly<{
  /**
   * The server-rendered `<ReaderRoleExplainer />` (Requirements 11.3–11.5).
   *
   * A prop rather than an import, so compliance copy stays server-rendered while
   * the step machine around it runs in the browser.
   */
  explainer: React.ReactNode
  /**
   * The page-render instant, as ISO 8601.
   *
   * Passed down rather than read here, for two reasons. A `new Date()` during
   * render differs between the server pass and hydration, which is a hydration
   * mismatch on any date the copy prints; and the expiry range the field *states*
   * has to be the range the wizard *validates against*, which one instant
   * guarantees and two do not. The route re-validates against the request's own
   * instant regardless — that is the authority.
   */
  nowIso: string
}>

export function ConnectWizard({ explainer, nowIso }: ConnectWizardProps) {
  const router = useRouter()

  const now = useMemo(() => new Date(nowIso), [nowIso])

  const [state, setState] = useState<WizardState>({ step: "role" })
  const [subscriptionId, setSubscriptionId] = useState("")
  const [draft, setDraft] = useState<CredentialDraft>(EMPTY_DRAFT)

  const [problems, setProblems] = useState<readonly string[]>([])
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<DraftField>>(
    new Set()
  )
  const [testing, setTesting] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  const subscriptionIdInputId = useId()
  const displayNameId = useId()
  const tenantIdInputId = useId()
  const clientIdInputId = useId()
  const clientSecretId = useId()
  const expiryId = useId()
  const workspaceIdInputId = useId()
  const problemsId = useId()

  const clearProblems = useCallback(() => {
    setProblems([])
    setInvalidFields(new Set())
  }, [])

  const reject = useCallback(
    (found: readonly { field: DraftField; message: string }[]) => {
      setProblems(found.map(({ message }) => message))
      setInvalidFields(new Set(found.map(({ field }) => field)))
    },
    []
  )

  const updateDraft = useCallback(
    <K extends keyof CredentialDraft>(key: K, value: CredentialDraft[K]) => {
      setDraft((current) => ({ ...current, [key]: value }))
    },
    []
  )

  // --- Step 1 → 2 ---------------------------------------------------------

  const leaveRoleStep = useCallback(() => {
    if (!isSubscriptionId(subscriptionId)) {
      reject([{ field: "subscriptionId", message: SUBSCRIPTION_ID_MESSAGE }])
      return
    }

    clearProblems()
    setState({ step: "artifacts" })
  }, [clearProblems, reject, subscriptionId])

  // --- Step 3 → 4 ---------------------------------------------------------

  /**
   * Validate the draft and run the preflight (Requirements 11.9, 12.11, 12.12).
   *
   * The client-side pass is a courtesy — it saves a round trip and, more to the
   * point, a 30-second preflight spent on a submission that could not be recorded
   * anyway. Every predicate it uses is imported from
   * `lib/subscriptions/input.ts`, so there is one definition of the accepted
   * expiry range rather than a form's approximation of the route's.
   */
  const runPreflight = useCallback(async () => {
    const found: { field: DraftField; message: string }[] = []

    const displayName = draft.displayName.trim()
    if (
      displayName.length === 0 ||
      displayName.length > DISPLAY_NAME_MAX_LENGTH
    ) {
      found.push({ field: "displayName", message: DISPLAY_NAME_MESSAGE })
    }

    if (!isSubscriptionId(draft.tenantId)) {
      found.push({ field: "tenantId", message: TENANT_ID_MESSAGE })
    }

    if (!isSubscriptionId(draft.clientId)) {
      found.push({ field: "clientId", message: CLIENT_ID_MESSAGE })
    }

    if (draft.clientSecret.length === 0) {
      found.push({ field: "clientSecret", message: CLIENT_SECRET_MESSAGE })
    }

    if (!isAcceptedExpiry(draft.secretExpiresAtLocal, now)) {
      found.push({
        field: "secretExpiresAtLocal",
        message: SECRET_EXPIRY_MESSAGE,
      })
    }

    const workspaceId = draft.logAnalyticsWorkspaceId.trim()
    if (workspaceId.length > 0 && !isSubscriptionId(workspaceId)) {
      found.push({
        field: "logAnalyticsWorkspaceId",
        message: WORKSPACE_ID_MESSAGE,
      })
    }

    if (found.length > 0) {
      reject(found)
      return
    }

    clearProblems()
    setTesting(true)

    try {
      const answer = await postJson(PREFLIGHT_ENDPOINT, {
        displayName,
        subscriptionId,
        tenantId: draft.tenantId,
        clientId: draft.clientId,
        clientSecret: draft.clientSecret,
        secretExpiresAt: localDateTimeToIso(draft.secretExpiresAtLocal),
        logAnalyticsWorkspaceId: workspaceId,
      })

      // A rejected preflight is a `200` carrying an answer, not a failure: the
      // probe ran, and the result is that the scope could not be proved. Anything
      // else — a schema rejection, an unconfigured runtime, a lost session — is a
      // failure of the request rather than of the connection, and stays on this
      // step so the consultant can fix the submission.
      if (answer.status !== 200) {
        reject([{ field: "clientSecret", message: messageFrom(answer) }])
        return
      }

      const outcome = preflightResultSchema.safeParse(answer.body)
      if (!outcome.success) {
        reject([
          {
            field: "clientSecret",
            message:
              "The preflight answered in a shape this page does not " +
              "recognise, so nothing was saved. Try again, or check that the " +
              "reporting runtime is up to date.",
          },
        ])
        return
      }

      setConnectError(null)
      setState({ step: "result", outcome: outcome.data })
    } catch {
      reject([
        {
          field: "clientSecret",
          message:
            "The connection could not be tested — the request did not reach " +
            "the server. Nothing was saved.",
        },
      ])
    } finally {
      setTesting(false)
    }
  }, [clearProblems, draft, now, reject, subscriptionId])

  // --- Saving -------------------------------------------------------------

  /**
   * Save the connection (Requirement 11.10).
   *
   * The `verified` parameter is the **proof**, not payload: nothing derived from it
   * is sent. `POST /api/subscriptions` runs its own preflight and reads
   * `scope_verified` and `fidelity_tier` off that result, because the create schema
   * has no field for either and Requirement 12.14 reserves writing a `true` value
   * to the Preflight_Service. What the parameter buys is that this function — the
   * only caller of {@link CREATE_ENDPOINT} — cannot be invoked from a rejected
   * outcome, and neither can the control that calls it.
   */
  const connect = useCallback(
    async (verified: VerifiedPreflight) => {
      void verified

      setConnectError(null)
      setConnecting(true)

      try {
        const answer = await postJson(CREATE_ENDPOINT, {
          displayName: draft.displayName.trim(),
          subscriptionId,
          tenantId: draft.tenantId,
          clientId: draft.clientId,
          clientSecret: draft.clientSecret,
          secretExpiresAt: localDateTimeToIso(draft.secretExpiresAtLocal),
          logAnalyticsWorkspaceId: draft.logAnalyticsWorkspaceId.trim(),
        })

        if (answer.status !== 201) {
          setConnectError(messageFrom(answer))
          return
        }

        // The draft — the plaintext secret included — is dropped before
        // navigating, so a client-side back navigation cannot re-render a form
        // still holding it.
        setDraft(EMPTY_DRAFT)
        router.push(SUBSCRIPTIONS_PATH)
        router.refresh()
      } catch {
        setConnectError(
          "The connection could not be saved — the request did not reach the " +
            "server. Nothing was saved."
        )
      } finally {
        setConnecting(false)
      }
    },
    [draft, router, subscriptionId]
  )

  // --- Rendering ----------------------------------------------------------

  const currentIndex = STEP_KEYS.indexOf(state.step)

  /**
   * What the persistent live region says.
   *
   * A region that is **mounted with its content announces nothing** — assistive
   * technology has to be observing the node before the change happens — so the
   * result step's own `aria-live` cannot carry the news that a step was replaced.
   * This element is always in the tree and only its text changes, which is what
   * makes a step transition and a preflight answer audible at all.
   *
   * Empty on the first step, deliberately: there is nothing to announce about a
   * page that has just been read out.
   */
  const announcement = ((): string => {
    if (testing) {
      return (
        "Asking Azure whether this service principal holds read at " +
        "subscription scope. This can take up to 30 seconds."
      )
    }

    switch (state.step) {
      case "role":
        return ""
      case "artifacts":
        return "Step 2 of 4. The role assignment script and template are ready."
      case "credentials":
        return "Step 3 of 4. Enter the service principal credentials."
      case "result":
        return state.outcome.scopeVerified
          ? "Step 4 of 4. Read at subscription scope is proved. The " +
              "connection can now be saved."
          : `Step 4 of 4. The connection was not accepted: ${state.outcome.code}. Nothing was saved.`
    }
  })()

  const problemRegion =
    problems.length === 0 ? null : (
      <FieldError id={problemsId}>
        {problems.length === 1 ? (
          problems[0]
        ) : (
          <ul className="ml-4 flex list-disc flex-col gap-1">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
      </FieldError>
    )

  return (
    <div data-slot="connect-wizard" className="flex flex-col gap-8">
      {/*
        Always mounted, so a change to its text is a change the assistive
        technology is already watching for — see `announcement` above.
      */}
      <p
        role="status"
        aria-live="polite"
        data-slot="wizard-announcer"
        className="sr-only"
      >
        {announcement}
      </p>

      {/*
        A real ordered list, so the four steps are announced as four steps in
        order, with `aria-current="step"` on the one showing. Not clickable: a
        step is reachable by completing the one before it, and a jump to step 3
        would skip the id that steps 2 and 3 both depend on.
      */}
      <nav aria-label="Connection steps">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {STEP_KEYS.map((key, index) => {
            const done = index < currentIndex
            const current = index === currentIndex

            return (
              <li key={key} className="flex items-center gap-2">
                <span
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 rounded-4xl px-2.5 py-1",
                    current && "bg-primary/10 font-medium text-foreground",
                    done && "text-muted-foreground",
                    !current && !done && "text-muted-foreground/70"
                  )}
                >
                  <span className="font-mono tabular-nums">{index + 1}</span>
                  {STEP_LABELS[key]}
                </span>

                {index < STEP_KEYS.length - 1 ? (
                  <span aria-hidden="true" className="text-border">
                    /
                  </span>
                ) : null}
              </li>
            )
          })}
        </ol>
      </nav>

      {state.step === "role" ? (
        <div className="flex flex-col gap-6">
          {explainer}

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={subscriptionIdInputId}>
                Azure subscription id
              </FieldLabel>

              <Input
                id={subscriptionIdInputId}
                name="subscriptionId"
                value={subscriptionId}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalidFields.has("subscriptionId") || undefined}
                aria-describedby={
                  problems.length === 0 ? undefined : problemsId
                }
                className="font-mono tabular-nums"
                onChange={(event) => setSubscriptionId(event.target.value)}
              />

              <FieldDescription>
                The subscription the report will cover. The scripts on the next
                step are generated for this id and grant Reader at{" "}
                <span className="font-mono tabular-nums">
                  /subscriptions/&lt;id&gt;
                </span>{" "}
                and nowhere else.
              </FieldDescription>
            </Field>
          </FieldGroup>

          {problemRegion}

          <div className="flex justify-start">
            <Button type="button" onClick={leaveRoleStep}>
              Generate the role assignment
            </Button>
          </div>
        </div>
      ) : null}

      {state.step === "artifacts" ? (
        <div className="flex flex-col gap-8">
          <p className="text-sm text-muted-foreground">
            Send one of these to whoever owns subscription{" "}
            <span className="font-mono tabular-nums">{subscriptionId}</span>.
            Both make the same single grant, and neither contains a client
            secret — Azure issues that when the script runs, on their machine.
          </p>

          <AzScriptStep subscriptionId={subscriptionId} />

          <ArmTemplateStep subscriptionId={subscriptionId} />

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                clearProblems()
                setState({ step: "role" })
              }}
            >
              <ArrowLeftIcon aria-hidden="true" />
              Back
            </Button>

            <Button
              type="button"
              onClick={() => {
                clearProblems()
                setState({ step: "credentials" })
              }}
            >
              The role is assigned — enter the credentials
            </Button>
          </div>
        </div>
      ) : null}

      {state.step === "credentials" ? (
        <form
          aria-label="Service principal credentials"
          aria-busy={testing}
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault()
            void runPreflight()
          }}
        >
          <p className="text-sm text-muted-foreground">
            These are the three values the script printed, plus the expiry Azure
            reported for the secret. They are held encrypted and are never sent
            to a browser again.
          </p>

          {problemRegion}

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={displayNameId}>Connection name</FieldLabel>

              <Input
                id={displayNameId}
                name="displayName"
                value={draft.displayName}
                autoComplete="off"
                aria-invalid={invalidFields.has("displayName") || undefined}
                onChange={(event) =>
                  updateDraft("displayName", event.target.value)
                }
              />

              <FieldDescription>
                How this connection is labelled in the app — usually the
                customer&apos;s name.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor={tenantIdInputId}>
                Directory (tenant) id
              </FieldLabel>

              <Input
                id={tenantIdInputId}
                name="tenantId"
                value={draft.tenantId}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalidFields.has("tenantId") || undefined}
                className="font-mono tabular-nums"
                onChange={(event) =>
                  updateDraft("tenantId", event.target.value)
                }
              />
            </Field>

            <Field>
              <FieldLabel htmlFor={clientIdInputId}>
                Application (client) id
              </FieldLabel>

              <Input
                id={clientIdInputId}
                name="clientId"
                value={draft.clientId}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalidFields.has("clientId") || undefined}
                className="font-mono tabular-nums"
                onChange={(event) =>
                  updateDraft("clientId", event.target.value)
                }
              />
            </Field>

            <Field>
              <FieldLabel htmlFor={clientSecretId}>Client secret</FieldLabel>

              <Input
                id={clientSecretId}
                name="clientSecret"
                type="password"
                value={draft.clientSecret}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalidFields.has("clientSecret") || undefined}
                onChange={(event) =>
                  updateDraft("clientSecret", event.target.value)
                }
              />

              <FieldDescription>
                Azure prints this once. If it has been lost, issue a new one for
                the same app registration rather than repeating the role
                assignment.
              </FieldDescription>
            </Field>

            <SecretExpiryField
              id={expiryId}
              value={draft.secretExpiresAtLocal}
              invalid={invalidFields.has("secretExpiresAtLocal")}
              now={now}
              onValueChange={(value) =>
                updateDraft("secretExpiresAtLocal", value)
              }
            />

            <Field>
              <FieldLabel htmlFor={workspaceIdInputId}>
                Log Analytics workspace id (optional)
              </FieldLabel>

              <Input
                id={workspaceIdInputId}
                name="logAnalyticsWorkspaceId"
                value={draft.logAnalyticsWorkspaceId}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={
                  invalidFields.has("logAnalyticsWorkspaceId") || undefined
                }
                className="font-mono tabular-nums"
                onChange={(event) =>
                  updateDraft("logAnalyticsWorkspaceId", event.target.value)
                }
              />

              <FieldDescription>
                Only if the customer opted into Azure Monitor Agent and a data
                collection rule. Supplying it lets the preflight probe for the
                enhanced tier — true percentiles, per-volume disk free space and
                guest-observed memory. Left blank, every resource is baseline
                and percentiles are labelled as estimates.
              </FieldDescription>
            </Field>
          </FieldGroup>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={testing}
              onClick={() => {
                clearProblems()
                setState({ step: "artifacts" })
              }}
            >
              <ArrowLeftIcon aria-hidden="true" />
              Back
            </Button>

            <Button type="submit" disabled={testing}>
              {testing ? (
                <CircleNotchIcon
                  aria-hidden="true"
                  className="motion-safe:animate-spin"
                />
              ) : null}

              {testing ? "Proving the scope…" : "Test the connection"}
            </Button>
          </div>

          {/*
            The wait is real — the preflight is capped at 30 seconds and a cold
            container spends some of it starting — so it is stated rather than
            only spun. No live role: the persistent announcer at the top of the
            wizard is the one that speaks, and a second region carrying the same
            sentence would announce it twice.
          */}
          <p className="text-xs text-muted-foreground">
            {testing
              ? "Asking Azure whether this service principal holds read at subscription scope. This can take up to 30 seconds."
              : null}
          </p>
        </form>
      ) : null}

      {state.step === "result" ? (
        <PreflightResult
          outcome={state.outcome}
          connecting={connecting}
          connectError={connectError}
          onConnect={(verified) => {
            void connect(verified)
          }}
          onBack={() => {
            setConnectError(null)
            setState({ step: "credentials" })
          }}
        />
      ) : null}
    </div>
  )
}
