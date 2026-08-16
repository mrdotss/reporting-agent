import { ClockCountdownIcon } from "@phosphor-icons/react/ssr"

import {
  EXPIRY_WARNING_DAYS,
  expiryWarningText,
  type SubscriptionState,
} from "@/lib/subscriptions/state"

/**
 * The approaching-expiry warning (Requirements 13.2, 13.6).
 *
 * Three things about it are requirements rather than taste, and each is held by
 * construction here:
 *
 * **It is non-dismissible.** There is no close control, no `onDismiss` prop and no
 * local state — so there is nothing to dismiss and nothing a later edit could wire
 * a dismissal to. That matters because of what the warning is for: an expired
 * client secret returns zero resources, zero resources means zero figures, and zero
 * figures means zero *unverifiable* figures — so the run passes collection,
 * compilation, rendering **and verification** and delivers a clean, fully-verified,
 * empty report. A banner a consultant can wave away is a banner they wave away in
 * the week they are busy.
 *
 * **The sentence comes from {@link expiryWarningText}.** Not composed here. The
 * same warning appears on the run screens for the same subscription, and two
 * components phrasing — or flooring — the day count differently is two products as
 * far as the reader is concerned. `expiryWarningText` also owns the one case that
 * reads as a bug if you get it wrong: `0` days becomes "less than a day", never
 * "expires in 0 days".
 *
 * **It is mist neutral.** Requirement 13.6 reserves `--destructive` for the expired
 * state, and this is not that: a secret with three weeks left is a working secret,
 * `subscriptionRunBlocker` lets runs through on it, and colouring it red would
 * spend the one token that means *this document could not be proven*. Surface
 * `--muted`, hairline `--border`, text `--muted-foreground`, and the icon inherits.
 *
 * A **server** component — no state, no interactivity — so Phosphor comes from
 * `@phosphor-icons/react/ssr`.
 */

/**
 * The `expiring` member of {@link SubscriptionState}, and nothing wider.
 *
 * Taking the narrowed state rather than a bare `number` is what stops this banner
 * from being rendered for a state that is not expiring: `resolveSubscriptionState`
 * is the only producer of the type, and only its third precedence step yields it.
 * A `wholeDaysRemaining: number` prop would happily accept a count computed beside
 * the one function that is supposed to own the arithmetic.
 */
export type ExpiringState = Extract<SubscriptionState, { kind: "expiring" }>

type SecretExpiryBannerProps = Readonly<{
  state: ExpiringState
}>

export function SecretExpiryBanner({ state }: SecretExpiryBannerProps) {
  return (
    <div
      role="status"
      data-slot="secret-expiry-banner"
      className="flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      <ClockCountdownIcon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0"
      />

      {/*
        Exactly `expiryWarningText`, and nothing appended inside this element. The
        remedy — the rotate control — is a sibling in the row, so the warning's
        text stays the one sentence the requirement names.
      */}
      <p data-slot="secret-expiry-warning">
        {expiryWarningText(state.wholeDaysRemaining)}
      </p>

      <span className="sr-only">
        {` This warning appears from ${EXPIRY_WARNING_DAYS} days before the recorded expiry and cannot be dismissed.`}
      </span>
    </div>
  )
}
