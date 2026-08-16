"use client"

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  SECRET_MAX_LIFETIME_MONTHS,
  maxSecretExpiry,
  withinSecretLifetime,
} from "@/lib/subscriptions/input"

/**
 * The `secret_expires_at` field, shared by the wizard's credentials step and the
 * rotate-secret dialog (Requirements 11.7, 11.9).
 *
 * It exists as one component for one reason: **both surfaces submit the same field
 * to the same validation, so both have to state the same accepted range.** The
 * 24-month cap is a fact about Azure, not a policy of ours, and a wizard that said
 * "24 months" beside a rotate dialog that said nothing would leave a consultant
 * guessing which surface was authoritative. There is one sentence about it, here.
 *
 * The other thing it centralises is the **conversion**. `<input type="datetime-local">`
 * yields `YYYY-MM-DDTHH:mm` with no offset, and `secretExpiresAtSchema` requires an
 * ISO 8601 instant *with* one — a local datetime names no instant, and guessing an
 * offset for it is how a secret appears to expire seven hours from when it does. So
 * {@link localDateTimeToIso} does the conversion once, through the browser's own
 * local-time parse, and both callers use it.
 *
 * ## Why the accepted range is checked here and again on the server
 *
 * The route is the authority (`secretExpiresAtSchema` reads the clock at parse
 * time, so the "current instant" is the request's own). This check is a courtesy:
 * it saves a consultant a round trip and, in the wizard's case, a 30-second
 * preflight spent on a submission that cannot be recorded. Both read the *same*
 * pure predicates from `lib/subscriptions/input.ts` — {@link withinSecretLifetime}
 * and {@link maxSecretExpiry} — so there is no second definition of the range to
 * drift.
 *
 * ## No `min`, no `max`, no `required`
 *
 * The same reasoning `components/auth/login-form.tsx` records. Native constraint
 * validation refuses the submission with a browser bubble of its own wording, which
 * would pre-empt the message Requirement 11.9 requires — the one that *states the
 * accepted range*. Letting the submission through to our own validation keeps one
 * authority and one sentence.
 */

/**
 * A `datetime-local` value as an ISO 8601 instant, or `null` if it names none.
 *
 * `new Date("2027-03-01T09:30")` is parsed as **local** time per the ECMAScript
 * date-time string format, which is exactly what the control means, so
 * `toISOString()` then produces the right instant with an explicit `Z`. An empty
 * or unparseable value returns `null` rather than an `Invalid Date`, so a caller
 * cannot forward `"Invalid Date"` into a request body.
 *
 * Pure, and exported for its own test: the whole correctness of this field is that
 * a local wall-clock time submitted from `+07:00` records the instant the customer
 * meant, and that is a property of this function rather than of the markup.
 */
export function localDateTimeToIso(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null

  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) return null

  return parsed.toISOString()
}

/**
 * Is this `datetime-local` value inside the accepted window at `now`?
 *
 * Defers to {@link withinSecretLifetime}, so "after now and at most 24 months out"
 * has exactly one implementation and it is the one the route enforces. An
 * unparseable value is **not** accepted — failing closed, the same direction the
 * schema fails, because the field's entire purpose is to make an expired credential
 * visible before it produces a clean, fully-verified, empty report.
 */
export function isAcceptedExpiry(value: string, now: Date): boolean {
  const iso = localDateTimeToIso(value)
  if (iso === null) return false

  return withinSecretLifetime(new Date(iso), now)
}

/**
 * The latest acceptable expiry, as a local `YYYY-MM-DD`, for the field's copy.
 *
 * Rendered rather than described, because "at most 24 months from now" is a
 * calculation the consultant would otherwise do while reading an Azure portal
 * blade. Not applied as a `max` attribute — see the module docstring.
 */
function latestAcceptedDate(now: Date): string {
  const bound = maxSecretExpiry(now)

  return [
    String(bound.getUTCFullYear()).padStart(4, "0"),
    String(bound.getUTCMonth() + 1).padStart(2, "0"),
    String(bound.getUTCDate()).padStart(2, "0"),
  ].join("-")
}

type SecretExpiryFieldProps = Readonly<{
  /** The input's id, so the caller owns label association and `aria-describedby`. */
  id: string
  /** The current `datetime-local` value. */
  value: string
  onValueChange: (value: string) => void
  /** Set when the caller's validation rejected this field. */
  invalid?: boolean
  /**
   * The instant the accepted range is stated against.
   *
   * A prop rather than a `new Date()` read, so the rendered bound is the same
   * instant the caller validated with and a test can pin it.
   */
  now: Date
}>

export function SecretExpiryField({
  id,
  value,
  onValueChange,
  invalid = false,
  now,
}: SecretExpiryFieldProps) {
  const descriptionId = `${id}-description`

  return (
    <Field data-slot="secret-expiry-field">
      <FieldLabel htmlFor={id}>Client secret expires</FieldLabel>

      <Input
        id={id}
        name="secretExpiresAt"
        type="datetime-local"
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={descriptionId}
        onChange={(event) => onValueChange(event.target.value)}
      />

      {/*
        Requirement 11.7, stated in full: the maximum, the common issuance, and
        what to enter. Mist neutrals — an expiry a consultant is about to record
        is not an error state, so `--destructive` appears nowhere in this field.
      */}
      <FieldDescription id={descriptionId}>
        Enter the expiry Azure reported when the secret was issued. Azure caps a
        service-principal secret at a maximum lifetime of{" "}
        {SECRET_MAX_LIFETIME_MONTHS} months, and one is commonly issued for 6 to
        12 months. The expiry must be after now and at most{" "}
        {SECRET_MAX_LIFETIME_MONTHS} months from now — no later than{" "}
        <span className="font-mono tabular-nums">
          {latestAcceptedDate(now)}
        </span>
        . You will be warned before it lapses, because an expired secret returns
        no resources at all.
      </FieldDescription>
    </Field>
  )
}
