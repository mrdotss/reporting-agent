import Link from "next/link"
import {
  MagnifyingGlassIcon,
  PlugsConnectedIcon,
  PlusIcon,
  SealWarningIcon,
  ShieldWarningIcon,
} from "@phosphor-icons/react/ssr"

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
 * (Requirement 10.2) — so the unmasked subscription id, the tenant id, the client
 * id and the ciphertext are absent by construction rather than filtered here. The
 * only client leaf below it is {@link RotateSecretDialog}, which needs a form.
 *
 * ## `resolveSubscriptionState` decides, not this file
 *
 * The displayed state is read from `lib/subscriptions/state.ts`. That module is also
 * the predicate the enqueue and reaper gates reject from, so a screen and a gate cannot
 * disagree about the same row. The expiry meter below is drawn from the same instant
 * the state was judged against.
 *
 * ## Where the failure colour is allowed
 *
 * Requirement 13.6: only the `expired` and `disabled` states, which block runs. An
 * approaching expiry is attention, and `pending` — never preflighted — is attention too.
 */

const STATE_BADGE: Record<
  SubscriptionState["kind"],
  { readonly label: string; readonly state: CloseState }
> = {
  disabled: { label: "Credential rejected", state: "undelivered" },
  expired: { label: "Secret expired", state: "undelivered" },
  expiring: { label: "Secret expiring", state: "attention" },
  pending: { label: "Scope unverified", state: "attention" },
  active: { label: "Connected", state: "delivered" },
}

/** The span the expiry meter measures against: a two-year client secret, Azure's maximum. */
const METER_SPAN_DAYS = 730

const DAY_MS = 86_400_000

/**
 * What this connector's state means, when it means something worth saying. A notice
 * explains; the remedy lives in the actions group beside Scan.
 */
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
 * How much of the secret's life is left, as a bar.
 *
 * A date reads once; a bar that has run down to a sliver reads every time the list is
 * scanned. Amber inside the thirty-day warning window, the same window the state uses.
 */
function ExpiryMeter({
  view,
  now,
}: Readonly<{ view: ConnectedSubscriptionView; now: Date }>) {
  const expiresMs = Date.parse(view.secretExpiresAt)
  const days = Number.isNaN(expiresMs)
    ? 0
    : Math.max(0, Math.floor((expiresMs - now.getTime()) / DAY_MS))
  const warn = days < 30
  const fill = Math.max(2, Math.min(100, Math.round((days / METER_SPAN_DAYS) * 100)))

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
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
            warn ? "bg-(--status-attention)" : "bg-muted-foreground/45"
          )}
          style={{ width: `${fill}%` }}
        />
      </div>
      <div className="flex justify-between gap-3 font-mono text-xs tabular-nums text-muted-foreground">
        <span className={cn(warn && "font-medium text-(--status-attention)")}>
          {days} {days === 1 ? "day" : "days"} left
        </span>
        {/*
          The stored instant as its UTC calendar date, zone named. Not locale-formatted:
          the server pass and the browser would format it differently.
        */}
        <span>
          {view.secretExpiresAt.slice(0, 10)} <span>UTC</span>
        </span>
      </div>
    </div>
  )
}

type SubscriptionListProps = Readonly<{
  subscriptions: readonly ConnectedSubscriptionView[]
  /** One instant for the whole render — see the module docstring. */
  now: Date
}>

export function SubscriptionList({ subscriptions, now }: SubscriptionListProps) {
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
      className="grid gap-3 lg:grid-cols-2"
    >
      {subscriptions.map((view) => {
        const state = resolveSubscriptionState(view, now)
        const badge = STATE_BADGE[state.kind]

        return (
          <li key={view.id} className="min-w-0">
            <article
              data-slot="subscription-row"
              data-state={state.kind}
              className="flex h-full flex-col gap-4 rounded-xl border border-border bg-card p-4"
            >
              <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="flex min-w-0 items-center gap-2.5">
                  <ProviderMark kind="azure" />
                  <h2 className="truncate text-section">{view.displayName}</h2>
                </span>

                <span className="ml-auto flex flex-wrap items-center gap-1.5">
                  <StatusBadge state={badge.state} label={badge.label} />
                </span>
              </header>

              <div className="grid items-end gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
                <dl className="flex flex-col gap-0.5 text-sm">
                  <dt className="text-xs text-muted-foreground">Subscription</dt>
                  <dd data-slot="masked-subscription-id">
                    <Identifier
                      value={view.maskedSubscriptionId}
                      kind="mask"
                      label="Subscription"
                    />
                  </dd>
                </dl>

                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">Secret expires</span>
                  <ExpiryMeter view={view} now={now} />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="rounded-md border border-border px-1.5 py-0.5">
                    {view.fidelityTier === "enhanced"
                      ? "Enhanced fidelity"
                      : "Baseline fidelity"}
                  </span>
                  {view.scopeVerified ? (
                    <span className="rounded-md border border-border px-1.5 py-0.5">
                      Scope verified
                    </span>
                  ) : null}
                </span>

                {/*
                  Scan and Rotate together, because both answer "what can I do with this
                  connector". Scan only when it could run: `POST .../scan` refuses an
                  unverified scope or an expired secret, and a control certain to be
                  refused trains the reader to ignore refusals (Requirement 4.5).
                */}
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  {view.scopeVerified && state.kind !== "expired" ? (
                    <Link
                      data-slot="button"
                      href={`/subscriptions/${view.id}/scan`}
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      <MagnifyingGlassIcon aria-hidden="true" />
                      Scan
                    </Link>
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

              <StateNotice state={state} />
            </article>
          </li>
        )
      })}
    </ul>
  )
}
