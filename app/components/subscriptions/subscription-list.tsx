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
import { Stamp, type StampTone } from "@/components/ui/stamp"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ProviderMark } from "@/components/subscriptions/provider-mark"
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
    readonly tone: StampTone
  }
> = {
  disabled: { label: "Credential rejected", tone: "unproven" },
  expired: { label: "Secret expired", tone: "unproven" },
  expiring: { label: "Secret expiring", tone: "attention" },
  pending: { label: "Scope unverified", tone: "attention" },
  active: { label: "Connected", tone: "verified" },
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
/**
 * What this connector's state means, when it means something worth saying.
 *
 * It used to return the remedy too — a `RotateSecretDialog` under every branch — which
 * is what put rotation at the foot of the card while Scan sat up in the facts row. The
 * remedy moved to the actions group beside Scan, and with it went this component's need
 * for the subscription and the clock: a notice explains, it does not act.
 */
function StateNotice({ state }: Readonly<{ state: SubscriptionState }>) {
  if (state.kind === "expiring") {
    return (
      <SecretExpiryBanner state={state} />
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

      </div>
    )
  }

  return null
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
          <h2 className="text-section">
            No subscriptions connected yet
          </h2>

          <p className="max-w-prose text-sm text-muted-foreground">
            Connecting one takes a script your customer runs and a credential
            they hand back. Nothing is saved until Azure&apos;s permissions
            response proves read at the subscription&apos;s own scope.
          </p>
        </div>

        <Link
          data-slot="button"
          href="/subscriptions/new"
          className={buttonVariants()}
        >
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
              size="sm"
              className="rounded-xl border border-border shadow-none ring-0"
            >
              <CardHeader>
                {/*
                  The source's mark beside its name. Every connection is Azure today —
                  the picker marks AWS and on-premises visible and unclickable — so this
                  is a constant rather than a column read. It is drawn per row anyway,
                  because the row is where a mixed list would need it and a mark added
                  later to a list that never had one is a layout change on every row.
                  When a second provider lands, this reads the connection's own field.
                */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="flex items-center gap-2.5">
                    <ProviderMark kind="azure" />
                    <CardTitle>{view.displayName}</CardTitle>
                  </span>

                  <span className="flex flex-wrap items-center gap-2">
                  <Stamp tone={badge.tone}>{badge.label}</Stamp>

                  <Stamp tone="neutral">
                    {view.fidelityTier === "enhanced"
                      ? "Enhanced fidelity"
                      : "Baseline fidelity"}
                  </Stamp>

                  {view.scopeVerified ? (
                    <Stamp tone="neutral">Scope verified</Stamp>
                  ) : null}
                  </span>
                </div>
              </CardHeader>

              <CardContent className="flex flex-col gap-4">
                {/*
                  Facts on the left, actions on the right, on one line where there is
                  room. The column layout put four short values and two small buttons
                  down the left edge of a surface 1200px wide and left the rest empty —
                  which reads as a card that failed to load its right-hand side.
                */}
                <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
                <dl className="flex flex-col gap-2 text-sm sm:flex-row sm:gap-10">
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-micro text-muted-foreground uppercase">
                      Subscription
                    </dt>

                    {/*
                      Requirement 10.4's mask, set in Geist Mono with tabular
                      numerals so a column of ids lines up and a differing id does
                      not reflow its row.
                    */}
                    <dd data-slot="masked-subscription-id">
                      <Identifier
                        value={view.maskedSubscriptionId}
                        kind="mask"
                        label="Subscription"
                      />
                    </dd>
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <dt className="text-micro text-muted-foreground uppercase">
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

                {/*
                  The entry point to the scan (Requirement 4.5). Phase 0 ships a screen
                  nobody can reach without it: there is no `subscriptions/[id]` page, so
                  the list is where a per-subscription action hangs.

                  Offered only when the scan could actually run. `POST .../scan` refuses a
                  subscription whose scope is unverified or whose secret has expired — an
                  inventory query is RBAC-filtered, so a scan through a narrowed role would
                  present a partial estate as the whole one. Rendering a control that is
                  certain to be refused trains the reader to ignore refusals, so the
                  condition here mirrors the route's rather than restating a subset of it.
                */}
                <div className="flex flex-wrap items-center gap-2">
                  {view.scopeVerified && state.kind !== "expired" ? (
                    <Link
                      data-slot="button"
                      href={`/subscriptions/${view.id}/scan`}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      <MagnifyingGlassIcon aria-hidden="true" />
                      Scan
                    </Link>
                  ) : null}

                  {/*
                    Rotation sits with Scan rather than under the card, because both
                    answer "what can I do with this connector" and a reader looking for
                    one is looking in the same place for the other. It used to be
                    returned by `StateNotice`, which put it at the foot of the card on
                    every state while Scan sat up here — two controls on one object, in
                    two unrelated positions.
                  */}
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
                </div>
                </div>

                <StateNotice state={state} />
              </CardContent>
            </Card>
          </li>
        )
      })}
    </ul>
  )
}
