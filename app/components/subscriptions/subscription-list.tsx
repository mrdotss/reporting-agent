import Link from "next/link"
import {
  PlugsConnectedIcon,
  PlusIcon,
  SealWarningIcon,
  ShieldWarningIcon,
} from "@phosphor-icons/react/ssr"

import { RescanButton } from "@/components/scan/rescan-button"
import { RotateSecretDialog } from "@/components/subscriptions/rotate-secret-dialog"
import { SecretExpiryBanner } from "@/components/subscriptions/secret-expiry-banner"
import { Identifier } from "@/components/identifier"
import { StatusBadge, type CloseState } from "@/components/ui/status-mark"
import { buttonVariants } from "@/components/ui/button"
import { ProviderMark } from "@/components/subscriptions/provider-mark"
import type { ConnectedSubscriptionView } from "@/lib/db/views"
import {
  resolveSubscriptionState,
  type SubscriptionState,
} from "@/lib/subscriptions/state"
import { cn } from "@/lib/utils"

/**
 * The connectors screen (Requirements 10.2, 13.2, 13.3, 13.6).
 *
 * A **server** component. Every row it renders is a
 * {@link ConnectedSubscriptionView} — the one shape allowed to cross to the browser
 * (Requirement 10.2) — so the unmasked subscription id, the tenant id, the client id and
 * the ciphertext are absent by construction.
 *
 * ## A card is a selection, not a navigation
 *
 * Clicking a connector selects it (`?c=<id>`) and the page shows what it can see beside
 * the list. Scan runs the scan in place and Rotate opens the rotation dialog, both on the
 * same line as the expiry meter, so a card is three lines tall.
 *
 * ## `resolveSubscriptionState` decides, not this file
 *
 * The displayed state is read from `lib/subscriptions/state.ts`, the same predicate the
 * enqueue and reaper gates reject from, so a screen and a gate cannot disagree.
 *
 * ## Where the failure colour is allowed
 *
 * Requirement 13.6: only the `expired` and `disabled` states, which block runs.
 */

const STATE_BADGE: Record<
  SubscriptionState["kind"],
  { readonly label: string; readonly state: CloseState }
> = {
  disabled: { label: "Credential rejected", state: "undelivered" },
  expired: { label: "Secret expired", state: "undelivered" },
  expiring: { label: "Expiring", state: "attention" },
  pending: { label: "Scope unverified", state: "attention" },
  active: { label: "Connected", state: "delivered" },
}

/** The span the expiry meter measures against: a two-year client secret, Azure's maximum. */
const METER_SPAN_DAYS = 730

const DAY_MS = 86_400_000

/** Whether `POST .../scan` would accept this connector. Mirrors the route's refusals. */
export function canScanConnector(view: ConnectedSubscriptionView, now: Date): boolean {
  const state = resolveSubscriptionState(view, now)
  return view.scopeVerified && state.kind !== "expired" && state.kind !== "disabled"
}

function StateNotice({ state }: Readonly<{ state: SubscriptionState }>) {
  if (state.kind === "expiring") {
    return <SecretExpiryBanner state={state} />
  }

  if (state.kind === "expired" || state.kind === "disabled") {
    return (
      <div
        data-slot="secret-expired-notice"
        className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2"
      >
        <div className="flex items-start gap-2 text-sm text-destructive">
          <SealWarningIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>
            {state.kind === "expired"
              ? "This client secret has expired. Runs against this subscription " +
                "are blocked, because an expired secret returns no resources at " +
                "all — which would otherwise deliver a fully-verified, empty " +
                "report."
              : "Azure rejected this credential as expired, even though the " +
                "recorded expiry is still in the future. The recorded date was " +
                "entered by hand; Azure's answer is the one that counts. Runs " +
                "against this subscription are blocked."}
          </p>
        </div>
      </div>
    )
  }

  if (state.kind === "pending") {
    return (
      <div className="flex flex-col gap-2 rounded-lg bg-muted px-3 py-2">
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <ShieldWarningIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>
            Read at subscription scope has not been proved for this connection,
            so runs against it are blocked. The Reader role must be assigned at
            subscription scope; an assignment scoped to a resource group is
            rejected because it returns that group&apos;s resources while
            leaving the report incomplete.
          </p>
        </div>
      </div>
    )
  }

  return null
}

/**
 * How much of the secret's life is left, as a bar coloured by what it means: healthy in
 * the verified green, amber inside the thirty-day warning window, red once it has run out.
 */
function ExpiryMeter({
  view,
  state,
  now,
}: Readonly<{ view: ConnectedSubscriptionView; state: SubscriptionState; now: Date }>) {
  const expiresMs = Date.parse(view.secretExpiresAt)
  const days = Number.isNaN(expiresMs)
    ? 0
    : Math.max(0, Math.floor((expiresMs - now.getTime()) / DAY_MS))
  const dead = state.kind === "expired" || state.kind === "disabled"
  const warn = !dead && days < 30
  const fill = dead ? 100 : Math.max(3, Math.min(100, (days / METER_SPAN_DAYS) * 100))

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        role="meter"
        aria-label="Client secret lifetime remaining"
        aria-valuemin={0}
        aria-valuemax={METER_SPAN_DAYS}
        aria-valuenow={Math.min(days, METER_SPAN_DAYS)}
        aria-valuetext={`${days} days left`}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={cn(
            "block h-full rounded-full",
            dead
              ? "bg-(--status-failed)"
              : warn
                ? "bg-(--status-attention)"
                : "bg-(--status-verified)"
          )}
          style={{ width: `${fill}%` }}
        />
      </div>
      <div className="flex justify-between gap-3 font-mono text-xs text-muted-foreground tabular-nums">
        <span className={cn(warn && "font-medium text-(--status-attention)", dead && "text-(--status-failed)")}>
          {dead ? "expired" : `${days} ${days === 1 ? "day" : "days"} left`}
        </span>
        {/* The stored instant as its UTC calendar date, zone named. */}
        <span className="truncate">secret · {view.secretExpiresAt.slice(0, 10)} UTC</span>
      </div>
    </div>
  )
}

type SubscriptionListProps = Readonly<{
  subscriptions: readonly ConnectedSubscriptionView[]
  /** One instant for the whole render. */
  now: Date
  /** The connector whose inventory the page is showing, if any. */
  selectedId?: string
}>

export function SubscriptionList({ subscriptions, now, selectedId }: SubscriptionListProps) {
  const nowIso = now.toISOString()

  if (subscriptions.length === 0) {
    return (
      <div
        data-slot="subscription-list-empty"
        className="flex flex-col items-start gap-4 rounded-xl border border-border bg-card px-6 py-10"
      >
        <PlugsConnectedIcon aria-hidden="true" className="size-6 text-muted-foreground" />

        <div className="flex flex-col gap-1">
          <h2 className="text-section">No subscriptions connected yet</h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Connecting one takes a script your customer runs and a credential
            they hand back. Nothing is saved until Azure&apos;s permissions
            response proves read at the subscription&apos;s own scope.
          </p>
        </div>

        <Link data-slot="button" href="/subscriptions/new" className={buttonVariants()}>
          <PlusIcon aria-hidden="true" />
          Connect a subscription
        </Link>
      </div>
    )
  }

  return (
    <ul
      data-slot="subscription-list"
      aria-label="Connected subscriptions"
      className="flex flex-col gap-2.5"
    >
      {subscriptions.map((view) => {
        const state = resolveSubscriptionState(view, now)
        const badge = STATE_BADGE[state.kind]
        const selected = view.id === selectedId

        return (
          <li key={view.id} className="min-w-0">
            <article
              data-slot="subscription-row"
              data-state={state.kind}
              data-selected={selected || undefined}
              className={cn(
                "relative flex flex-col gap-3 rounded-xl border bg-card p-3.5 transition-[border-color,box-shadow]",
                selected
                  ? "border-primary ring-3 ring-primary/15"
                  : "border-border hover:border-input"
              )}
            >
              <header className="flex items-center gap-2.5">
                <ProviderMark kind="azure" />
                {/*
                  The name is the selection. Its link covers the whole card through
                  `after:inset-0`, and the actions below sit above that layer, so a click
                  anywhere on the card selects it and a click on Scan or Rotate does not.
                */}
                <Link
                  href={`/subscriptions?c=${encodeURIComponent(view.id)}`}
                  scroll={false}
                  aria-current={selected ? "true" : undefined}
                  className="min-w-0 truncate font-mono text-sm font-semibold outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/30"
                >
                  {view.displayName}
                </Link>
                <span className="ml-auto shrink-0">
                  <StatusBadge state={badge.state} label={badge.label} />
                </span>
              </header>

              <div className="grid items-center gap-x-4 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                <div className="flex flex-col gap-0.5 text-sm">
                  <span className="text-xs text-muted-foreground">Subscription</span>
                  <span data-slot="masked-subscription-id">
                    <Identifier
                      value={view.maskedSubscriptionId}
                      kind="mask"
                      label="Subscription"
                    />
                  </span>
                </div>

                <ExpiryMeter view={view} state={state} now={now} />

                <span className="relative z-10 flex items-center gap-2">
                  {canScanConnector(view, now) ? (
                    <RescanButton subscriptionId={view.id} language="en" />
                  ) : null}
                  <RotateSecretDialog
                    subscriptionId={view.id}
                    displayName={view.displayName}
                    emphasis={
                      state.kind === "expired" || state.kind === "disabled"
                        ? "expired"
                        : "neutral"
                    }
                    nowIso={nowIso}
                  />
                </span>
              </div>

              {state.kind === "active" ? null : (
                <div className="relative z-10">
                  <StateNotice state={state} />
                </div>
              )}
            </article>
          </li>
        )
      })}
    </ul>
  )
}
