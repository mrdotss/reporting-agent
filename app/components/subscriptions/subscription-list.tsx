import Link from "next/link"
import {
  PlugsConnectedIcon,
  PlusIcon,
  SealWarningIcon,
  ShieldWarningIcon,
} from "@phosphor-icons/react/ssr"

import { RotateSecretDialog } from "@/components/subscriptions/rotate-secret-dialog"
import { SecretExpiryBanner } from "@/components/subscriptions/secret-expiry-banner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { ConnectedSubscriptionView } from "@/lib/db/views"
import {
  resolveSubscriptionState,
  type SubscriptionState,
} from "@/lib/subscriptions/state"

/**
 * The connected subscriptions screen (Requirements 10.2, 13.2, 13.3, 13.6).
 *
 * A **server** component. Every row it renders is a
 * {@link ConnectedSubscriptionView} — the one shape allowed to cross to the browser
 * (Requirement 10.2) — so the unmasked subscription id, the tenant id, the client
 * id and the ciphertext are absent by construction rather than filtered here. The
 * only client leaf below it is {@link RotateSecretDialog}, which needs a form.
 *
 * ## `resolveSubscriptionState` decides, not this file
 *
 * The displayed state is read from `lib/subscriptions/state.ts` and nothing about
 * expiry is computed here. That module is also the predicate the enqueue and reaper
 * gates reject from, which is the point: a screen that did its own date arithmetic
 * is how a banner and a gate come to disagree about the same row — offering a
 * rotate button for a subscription the enqueue happily invokes with, or the reverse.
 *
 * `now` is a prop for the same reason it is a parameter there. The page passes one
 * instant, so every row on one render is judged against the same clock and a test
 * can pin the boundary.
 *
 * ## Where `--destructive` is allowed
 *
 * Requirement 13.6, applied literally: the token appears only in the `expired` and
 * `disabled` branches of {@link StateNotice} and on the rotate trigger they render.
 * The `expiring` branch is {@link SecretExpiryBanner} in mist neutrals, and
 * `pending` — never preflighted — is mist neutral too. A gap in coverage and an
 * approaching expiry are information; red here would spend the one token that means
 * *this document could not be proven*.
 */

const STATE_BADGE: Record<
  SubscriptionState["kind"],
  {
    readonly label: string
    readonly variant: "secondary" | "outline" | "destructive"
  }
> = {
  disabled: { label: "credential rejected", variant: "destructive" },
  expired: { label: "secret expired", variant: "destructive" },
  expiring: { label: "secret expiring", variant: "outline" },
  pending: { label: "scope unverified", variant: "outline" },
  active: { label: "active", variant: "secondary" },
}

/**
 * The per-state notice, which is where Requirements 13.2 and 13.3 land.
 *
 * `expired` and `disabled` are separate branches rather than one "expired" case,
 * because they are separate facts with the same remedy: one is the recorded date
 * having passed, the other is Azure having **rejected** the credential while that
 * recorded date is still in the future (Requirement 13.9). The second is the more
 * important message — the date a consultant typed in said the secret was fine.
 */
function StateNotice({
  state,
  view,
  nowIso,
}: Readonly<{
  state: SubscriptionState
  view: ConnectedSubscriptionView
  nowIso: string
}>) {
  if (state.kind === "expiring") {
    return (
      <div className="flex flex-col gap-2">
        <SecretExpiryBanner state={state} />

        <div className="flex justify-start">
          <RotateSecretDialog
            subscriptionId={view.id}
            displayName={view.displayName}
            emphasis="neutral"
            nowIso={nowIso}
          />
        </div>
      </div>
    )
  }

  if (state.kind === "expired" || state.kind === "disabled") {
    return (
      <div
        data-slot="secret-expired-notice"
        className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2"
      >
        <div className="flex items-start gap-2 text-sm text-destructive">
          <SealWarningIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0"
          />

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

        <div className="flex justify-start">
          <RotateSecretDialog
            subscriptionId={view.id}
            displayName={view.displayName}
            emphasis="expired"
            nowIso={nowIso}
          />
        </div>
      </div>
    )
  }

  if (state.kind === "pending") {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted px-3 py-2">
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <ShieldWarningIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0"
          />

          <p>
            Read at subscription scope has not been proved for this connection,
            so runs against it are blocked. The Reader role must be assigned at
            subscription scope; an assignment scoped to a resource group is
            rejected because it returns that group&apos;s resources while
            leaving the report incomplete.
          </p>
        </div>

        <div className="flex justify-start">
          <RotateSecretDialog
            subscriptionId={view.id}
            displayName={view.displayName}
            emphasis="neutral"
            nowIso={nowIso}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-start">
      <RotateSecretDialog
        subscriptionId={view.id}
        displayName={view.displayName}
        emphasis="neutral"
        nowIso={nowIso}
      />
    </div>
  )
}

type SubscriptionListProps = Readonly<{
  subscriptions: readonly ConnectedSubscriptionView[]
  /** One instant for the whole render — see the module docstring. */
  now: Date
}>

export function SubscriptionList({
  subscriptions,
  now,
}: SubscriptionListProps) {
  const nowIso = now.toISOString()

  if (subscriptions.length === 0) {
    return (
      <div
        data-slot="subscription-list-empty"
        className="flex flex-col items-start gap-4 rounded-xl border border-border bg-muted/40 px-6 py-10"
      >
        <PlugsConnectedIcon
          aria-hidden="true"
          className="size-6 text-muted-foreground"
        />

        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-base font-medium tracking-tight">
            No subscriptions connected yet
          </h2>

          <p className="max-w-prose text-sm text-muted-foreground">
            Connecting one takes a script your customer runs and a credential
            they hand back. Nothing is saved until Azure&apos;s permissions
            response proves read at the subscription&apos;s own scope.
          </p>
        </div>

        <Button render={<Link href="/subscriptions/new" />}>
          <PlusIcon aria-hidden="true" />
          Connect a subscription
        </Button>
      </div>
    )
  }

  return (
    <ul
      data-slot="subscription-list"
      aria-label="Connected subscriptions"
      className="flex flex-col gap-4"
    >
      {subscriptions.map((view) => {
        const state = resolveSubscriptionState(view, now)
        const badge = STATE_BADGE[state.kind]

        return (
          <li key={view.id}>
            <Card
              data-slot="subscription-row"
              data-state={state.kind}
              className="rounded-xl border border-border shadow-none ring-0"
            >
              <CardHeader>
                <CardTitle>{view.displayName}</CardTitle>

                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={badge.variant}>{badge.label}</Badge>

                  <Badge variant="outline">
                    {view.fidelityTier === "enhanced"
                      ? "enhanced fidelity"
                      : "baseline fidelity"}
                  </Badge>

                  {view.scopeVerified ? (
                    <Badge variant="outline">scope verified</Badge>
                  ) : null}
                </div>
              </CardHeader>

              <CardContent className="flex flex-col gap-4">
                <dl className="flex flex-col gap-2 text-sm sm:flex-row sm:gap-8">
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-xs tracking-widest text-muted-foreground uppercase">
                      Subscription
                    </dt>

                    {/*
                      Requirement 10.4's mask, set in Geist Mono with tabular
                      numerals so a column of ids lines up and a differing id does
                      not reflow its row.
                    */}
                    <dd
                      data-slot="masked-subscription-id"
                      className="font-mono tabular-nums"
                    >
                      {view.maskedSubscriptionId}
                    </dd>
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <dt className="text-xs tracking-widest text-muted-foreground uppercase">
                      Secret expires
                    </dt>

                    {/*
                      The stored instant, rendered as its UTC calendar date with the
                      zone named. Not locale-formatted: a locale format differs
                      between the server pass and the browser, and an expiry date is
                      exactly the value nobody should have to wonder about.
                    */}
                    <dd className="font-mono tabular-nums">
                      {view.secretExpiresAt.slice(0, 10)}
                      <span className="ml-1 text-xs text-muted-foreground">
                        UTC
                      </span>
                    </dd>
                  </div>
                </dl>

                <StateNotice state={state} view={view} nowIso={nowIso} />
              </CardContent>
            </Card>
          </li>
        )
      })}
    </ul>
  )
}
