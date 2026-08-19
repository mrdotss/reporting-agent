"use client"

import {
  CheckCircleIcon,
  CircleNotchIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import { z } from "zod"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"

/**
 * The wizard's fourth step — and the **only** place a connection can be saved
 * from (Requirements 11.10, 12.7, 12.13).
 *
 * ## Requirement 11.10, structurally
 *
 * "No control anywhere that saves a connection without a `scope_verified: true`
 * result" is held here by construction rather than by a `disabled` attribute:
 *
 *   * The save control is {@link ConnectControl}, which is **module-private** and
 *     takes a required `verified: VerifiedPreflight` — a type whose
 *     `scopeVerified` is the literal `true`. A rejected outcome is not assignable
 *     to it, so the control cannot be constructed from one.
 *   * The only place it is rendered is inside the branch where TypeScript has
 *     already narrowed `outcome.scopeVerified` to `true`, and the value it is
 *     handed is that narrowed outcome.
 *   * `onConnect` takes the same type, so the wizard's create call cannot be
 *     invoked with anything else either.
 *
 * A disabled button would be the wrong shape for this: disabled is a state, and
 * states get flipped by a later edit that looks harmless. Here there is no
 * rejected-outcome value that *reaches* a save control at all — the rejected
 * branch renders no such control, and could not render one if it wanted to.
 *
 * ## Requirement 12.7 — the copy is ours, not the runtime's
 *
 * The rejection message relayed from the agent is displayed, but it is **not** the
 * explanation. This component states the subscription-scope Reader requirement and
 * why a resource-group-scoped assignment is rejected from its own copy, keyed on
 * the terminal code, because the requirement is about what the Web_App displays. A
 * UI that only echoed a message from a subprocess would satisfy Requirement 12.7
 * exactly as long as the subprocess kept sending that sentence.
 *
 * `AUTH_EXPIRED` gets its own copy for the same reason it gets its own code
 * (Requirement 12.13): the remedy differs. An unverified scope is a role assignment
 * the customer changes; an expired secret is a credential the consultant rotates.
 * Collapsing them would leave the consultant arguing with an administrator about a
 * role that was correct all along.
 */

// --- The result, parsed at the boundary -------------------------------------

/**
 * `POST /api/subscriptions/test` answers with one of these two shapes.
 *
 * Parsed rather than asserted, in the spirit of Requirement 7.7 one boundary over:
 * a route response is input to the browser the same way a request body is input to
 * a route, and `as PreflightOutcome` on a `fetch` result is the cast that rule
 * forbids.
 *
 * `z.union` rather than `z.discriminatedUnion`: the discriminant is a boolean, both
 * members are small, and a plain union tries each in turn with the same outcome and
 * no reliance on discriminated-union support for boolean literals.
 *
 * Deliberately **not** imported from `lib/subscriptions/preflight.ts`. That module
 * carries `import "server-only"` because it takes the plaintext client secret, so a
 * client component may not name it — and the shape that matters here is the *wire*
 * shape, which is what a schema states and a TypeScript type only describes.
 */
const verifiedPreflightSchema = z.object({
  scopeVerified: z.literal(true),
  fidelityTier: z.enum(["baseline", "enhanced"]),
})

const rejectedPreflightSchema = z.object({
  scopeVerified: z.literal(false),
  /** A `run_error_code` value. Relayed, never invented in the browser. */
  code: z.string(),
  message: z.string(),
})

export const preflightResultSchema = z.union([
  verifiedPreflightSchema,
  rejectedPreflightSchema,
])

export type PreflightResult = z.output<typeof preflightResultSchema>

/**
 * A preflight that proved read at subscription scope.
 *
 * The type that gates the save path. `scopeVerified` is the literal `true`, so
 * there is no assignment from a rejected result and no widening that would let one
 * through.
 */
export type VerifiedPreflight = z.output<typeof verifiedPreflightSchema>

/** Handed the narrowed result, so it cannot be called without one. */
export type ConnectHandler = (verified: VerifiedPreflight) => void

// --- What each rejection means ----------------------------------------------

type RejectionGuidance = {
  readonly heading: string
  readonly body: string
  /**
   * What to go and change, named per code.
   *
   * Separate from `body` because it is the sentence a reader acts on, and because it
   * was previously **hardcoded to "Fix the role assignment"** for every code. On an
   * `AUTH_FAILED` — Azure refusing the secret before any permission was evaluated —
   * that sends someone to re-check an RBAC assignment that was never the problem and
   * was never even examined. A closing instruction that is right for one code and
   * wrong for the rest is worse than none, because it reads as the specific advice.
   */
  readonly action: string
}

/**
 * Our own explanation per terminal code.
 *
 * `SCOPE_UNVERIFIED` carries both halves Requirement 12.7 names: the
 * subscription-scope Reader requirement, and the reason a resource-group-scoped
 * assignment is rejected. The second half is the one worth spelling out — it sounds
 * like pedantry until you know that the narrower assignment *works*: inventory
 * succeeds, metrics succeed, every figure verifies, and the delivered document is
 * missing most of the estate with nothing in the data to say so.
 */
const REJECTION_GUIDANCE: Record<string, RejectionGuidance> = {
  SCOPE_UNVERIFIED: {
    heading: "Read at subscription scope was not proved",
    body:
      "The Reader role must be assigned at subscription scope — at " +
      "/subscriptions/<id> itself. An assignment scoped to a resource group is " +
      "rejected, and not for tidiness: a service principal holding Reader on one " +
      "resource group still returns that group's resources, so every inventory " +
      "query succeeds, every metric query succeeds and every figure verifies " +
      "while the report is missing most of the subscription — with nothing in " +
      "the data to say so. Coverage checks cannot detect what RBAC hides, which " +
      "is why the permissions response is checked directly and why this " +
      "connection is not saved.",
    action: "Fix the role assignment and test again.",
  },
  AUTH_EXPIRED: {
    heading: "Azure rejected the client secret as expired",
    body:
      "The credential itself was refused, so nothing about the role assignment " +
      "was established either way. Issue a new client secret for the same app " +
      "registration, record its expiry, and submit it here. The role assignment " +
      "does not need to be made again.",
    action: "Issue a new client secret and test again.",
  },
  AUTH_FAILED: {
    heading: "Azure rejected the credential",
    body:
      "The tenant id, client id or client secret was not accepted. This is not " +
      "the same as an expired secret: check that the three values belong to the " +
      "same app registration and that the secret was copied whole. The most " +
      "common cause is the portal's two adjacent columns: Certificates & secrets " +
      "lists a Secret ID and a Value, and only the Value authenticates. The Value " +
      "is shown once, when the secret is created, and is masked on every later " +
      "visit — so a secret copied after the fact is usually the ID.",
    action:
      "Correct the credential and test again. The role assignment was never " +
      "evaluated, so it does not need to be changed.",
  },
}

/** For a code we have no specific copy for — including one from a newer runtime. */
const DEFAULT_GUIDANCE: RejectionGuidance = {
  heading: "The connection was not accepted",
  body:
    "Read at subscription scope was not proved, so nothing was saved. The " +
    "service principal needs the Reader role at subscription scope; an " +
    "assignment scoped to a resource group is rejected because it returns one " +
    "group's resources while leaving the report incomplete.",
  action: "Resolve the reason above and test again.",
}

function guidanceFor(code: string): RejectionGuidance {
  return REJECTION_GUIDANCE[code] ?? DEFAULT_GUIDANCE
}

// --- What each fidelity tier means -----------------------------------------

const FIDELITY_COPY: Record<VerifiedPreflight["fidelityTier"], string> = {
  baseline:
    "Platform metrics only. Averages, minima and maxima are exact; percentiles " +
    "are estimates and every report will say so wherever one appears.",
  enhanced:
    "Azure Monitor Agent and a data collection rule were found, so true " +
    "percentiles, per-volume disk free space and guest-observed memory are " +
    "available.",
}

// --- The save control -------------------------------------------------------

/**
 * The one control that saves a connection.
 *
 * Module-private, and its `verified` parameter is what makes Requirement 11.10
 * structural — see the module docstring. There is deliberately no `outcome:
 * PreflightResult` variant of this component and no `disabled` prop driven by the
 * outcome: a rejected result has no path to it.
 */
function ConnectControl({
  verified,
  onConnect,
  connecting,
}: Readonly<{
  verified: VerifiedPreflight
  onConnect: ConnectHandler
  connecting: boolean
}>) {
  return (
    <Button
      type="button"
      data-slot="save-connection"
      disabled={connecting}
      onClick={() => onConnect(verified)}
    >
      {connecting ? (
        <CircleNotchIcon
          aria-hidden="true"
          className="motion-safe:animate-spin"
        />
      ) : null}

      {connecting ? "Connecting…" : "Connect this subscription"}
    </Button>
  )
}

// --- The step ---------------------------------------------------------------

type PreflightResultProps = Readonly<{
  outcome: PreflightResult
  /** Called with the narrowed verified result; never reachable otherwise. */
  onConnect: ConnectHandler
  /** Back to the credentials step, to correct a value and test again. */
  onBack: () => void
  connecting: boolean
  /** A failure of the *create* request, distinct from a rejected preflight. */
  connectError: string | null
}>

export function PreflightResult({
  outcome,
  onConnect,
  onBack,
  connecting,
  connectError,
}: PreflightResultProps) {
  if (!outcome.scopeVerified) {
    const guidance = guidanceFor(outcome.code)

    return (
      <section
        data-slot="preflight-result"
        aria-live="polite"
        className="flex flex-col gap-4"
      >
        {/*
          `--destructive` is correct here and reserved for it: the connection was
          refused, and nothing was saved. This is one of the two states the token
          exists for.
        */}
        <div className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3">
          <WarningCircleIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-destructive"
          />

          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-heading text-sm font-medium text-destructive">
                {guidance.heading}
              </h3>

              <Badge variant="destructive" className="font-mono">
                {outcome.code}
              </Badge>
            </div>

            <p className="text-sm text-muted-foreground">{guidance.body}</p>

            {/*
              The runtime's own sentence, kept separate from ours and clearly
              attributed. It is bounded and already scrubbed by the runtime's
              redaction guard, and it is the only place the specific reason lives
              — but it is evidence, not the explanation.
            */}
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                Reported by the preflight:
              </span>{" "}
              {outcome.message}
            </p>

            <p className="text-sm font-medium">
              Nothing was saved. {guidance.action}
            </p>
          </div>
        </div>

        <div className="flex justify-start">
          <Button type="button" variant="outline" onClick={onBack}>
            Back to the credentials
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section
      data-slot="preflight-result"
      aria-live="polite"
      className="flex flex-col gap-4"
    >
      <div className="flex gap-3 rounded-lg border border-border bg-muted/40 px-3 py-3">
        <CheckCircleIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-primary dark:text-sidebar-primary"
        />

        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-heading text-sm font-medium tracking-tight">
              Read at subscription scope is proved
            </h3>

            <Badge variant="secondary">{outcome.fidelityTier}</Badge>
          </div>

          <p className="text-sm text-muted-foreground">
            The service principal holds read at this subscription&apos;s own
            scope, checked against the permissions response rather than inferred
            from a successful inventory query.
          </p>

          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              Fidelity tier {outcome.fidelityTier}:
            </span>{" "}
            {FIDELITY_COPY[outcome.fidelityTier]}
          </p>
        </div>
      </div>

      <FieldError>{connectError}</FieldError>

      <div className="flex flex-wrap items-center gap-2">
        <ConnectControl
          verified={outcome}
          onConnect={onConnect}
          connecting={connecting}
        />

        <Button
          type="button"
          variant="ghost"
          onClick={onBack}
          disabled={connecting}
        >
          Change the credentials
        </Button>
      </div>
    </section>
  )
}
