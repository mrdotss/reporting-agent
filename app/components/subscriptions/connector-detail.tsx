import Link from "next/link"

import { Identifier } from "@/components/identifier"
import { RescanButton } from "@/components/scan/rescan-button"
import {
  InventoryOverview,
  InventoryResources,
  InventoryUnavailable,
  readInventory,
} from "@/components/subscriptions/connector-inventory"
import { DepthCoach } from "@/components/subscriptions/depth-coach"
import { RotateSecretDialog } from "@/components/subscriptions/rotate-secret-dialog"
import {
  ExpiryMeter,
  StateNotice,
  canScanConnector,
} from "@/components/subscriptions/subscription-list"
import { buttonVariants } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ConnectedSubscriptionView, ScanView } from "@/lib/db/views"
import type { DepthChecklist } from "@/lib/subscriptions/depth"
import { resolveSubscriptionState } from "@/lib/subscriptions/state"

/**
 * The selected connector, beside the list: what it can do now (its header), and what it
 * can see, in four tabs — Overview, Resources, Data depth, Access — so the page is one
 * screen tall instead of the inventory and the depth checklist stacked under each other.
 *
 * A server component. The tabs are the one client piece; every panel is rendered here
 * and handed to them as children.
 */

/**
 * The connector's name, its last scan, and the controls that change it. The state notice
 * (expiring, expired, rejected, unverified) sits under them, next to the remedy.
 */
export function ConnectorHeader({
  subscription,
  scannedLine,
  now,
  canConnect,
}: Readonly<{
  subscription: ConnectedSubscriptionView
  scannedLine: string
  now: Date
  /** Owner and Admin: Scan, Rotate, Role setup (roles-and-ask-access Req 5). */
  canConnect: boolean
}>) {
  const state = resolveSubscriptionState(subscription, now)
  return (
    <div data-slot="connector-header" className="flex flex-col gap-3 px-4 pt-4 md:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-section">
            What&rsquo;s in <span className="font-mono">{subscription.displayName}</span>
          </h2>
          <p className="text-meta text-muted-foreground">{scannedLine}</p>
        </div>
        {canConnect ? (
          <span className="flex items-center gap-2">
            {canScanConnector(subscription, now) ? (
              <RescanButton subscriptionId={subscription.id} language="en" />
            ) : null}
            {subscription.provider === "aws" ? (
              <Link
                href={`/subscriptions/${encodeURIComponent(subscription.id)}/setup`}
                className={buttonVariants({
                  variant: state.kind === "pending" ? "default" : "outline",
                  size: "sm",
                })}
              >
                {state.kind === "pending" ? "Finish setup" : "Role setup"}
              </Link>
            ) : (
              <RotateSecretDialog
                subscriptionId={subscription.id}
                displayName={subscription.displayName}
                emphasis={state.kind === "expired" || state.kind === "disabled" ? "expired" : "neutral"}
                nowIso={now.toISOString()}
              />
            )}
          </span>
        ) : null}
      </div>
      {state.kind === "active" ? null : <StateNotice state={state} provider={subscription.provider} />}
    </div>
  )
}

function Access({ subscription, now }: Readonly<{ subscription: ConnectedSubscriptionView; now: Date }>) {
  const state = resolveSubscriptionState(subscription, now)
  const aws = subscription.provider === "aws"
  return (
    <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-3 px-4 py-4 text-meta md:px-5">
      <dt className="text-muted-foreground">{aws ? "Account" : "Subscription"}</dt>
      <dd>
        <Identifier value={subscription.maskedSubscriptionId} kind="mask" label={aws ? "Account" : "Subscription"} />
      </dd>
      {aws ? (
        <>
          <dt className="text-muted-foreground">Access</dt>
          <dd>Assumed role with an external ID</dd>
          <dt className="text-muted-foreground">Secret</dt>
          <dd>None stored, so nothing expires</dd>
          <dt className="text-muted-foreground">Read-only role</dt>
          <dd>{subscription.scopeVerified ? "Verified" : "Not verified yet"}</dd>
        </>
      ) : (
        <>
          <dt className="text-muted-foreground">Client secret</dt>
          <dd className="min-w-0">
            <ExpiryMeter view={subscription} state={state} now={now} />
          </dd>
          <dt className="text-muted-foreground">Reader role</dt>
          <dd>{subscription.scopeVerified ? "Proved at subscription scope" : "Not proved at subscription scope"}</dd>
        </>
      )}
      <dt className="text-muted-foreground">Fidelity</dt>
      <dd>{subscription.fidelityTier === "enhanced" ? "Enhanced" : "Baseline"}</dd>
    </dl>
  )
}

const TAB_TRIGGER =
  "h-10 flex-none rounded-none px-0.5 text-meta data-active:font-semibold group-data-horizontal/tabs:after:bottom-[-1px] after:bg-primary"

export function ConnectorDetail({
  subscription,
  scan,
  depth,
  now,
  canConnect,
}: Readonly<{
  subscription: ConnectedSubscriptionView
  scan: ScanView | null
  depth: { checklist: DepthChecklist; runId: string | null; periodStart: string | null } | null
  now: Date
  canConnect: boolean
}>) {
  const inventory = readInventory(subscription, scan)
  const open = depth?.checklist.items.filter((item) => item.state === "open") ?? []

  return (
    <section
      aria-label={`Connector ${subscription.displayName}`}
      data-slot="connector-detail"
      className="flex min-w-0 flex-1 flex-col rounded-xl border border-border bg-card"
    >
      <ConnectorHeader
        subscription={subscription}
        scannedLine={inventory.scannedLine}
        now={now}
        canConnect={canConnect}
      />
      <Tabs defaultValue="overview" className="mt-2 gap-0">
        <TabsList
          variant="line"
          className="h-auto w-full justify-start gap-5 overflow-x-auto rounded-none border-b border-border px-4 md:px-5"
        >
          <TabsTrigger value="overview" className={TAB_TRIGGER}>
            Overview
          </TabsTrigger>
          <TabsTrigger value="resources" className={TAB_TRIGGER}>
            Resources
            {inventory.reported ? (
              <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
                {inventory.total}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="depth" className={TAB_TRIGGER}>
            Data depth
            {depth === null ? null : (
              <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
                {depth.checklist.done}/{depth.checklist.total}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="access" className={TAB_TRIGGER}>
            Access
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          {inventory.reported ? (
            <div className="flex flex-col gap-5 px-4 py-4 md:px-5">
              <InventoryOverview inventory={inventory} />
              {depth === null || open.length === 0 ? null : (
                <div className="flex flex-col gap-2">
                  <h3 className="text-meta font-medium">
                    Data depth{" "}
                    <span className="font-normal text-muted-foreground">
                      · {depth.checklist.done} of {depth.checklist.total} done
                    </span>
                  </h3>
                  <ul className="flex flex-col gap-1.5">
                    {open.map((item) => (
                      <li key={item.key} className="flex items-center gap-2.5 text-sm">
                        <span aria-hidden="true" className="size-2.5 shrink-0 rotate-45 rounded-[2px] bg-(--status-attention)" />
                        <span className="min-w-0 flex-1">{item.title}</span>
                        {item.affected === null || item.affected === 0 ? null : (
                          <span className="rounded-md bg-(--status-attention-soft) px-1.5 font-mono text-xs leading-5 text-(--status-attention) tabular-nums">
                            {item.affected}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-muted-foreground">How to close each one is under Data depth.</p>
                </div>
              )}
            </div>
          ) : (
            <InventoryUnavailable inventory={inventory} />
          )}
        </TabsContent>
        <TabsContent value="resources">
          {inventory.reported ? (
            <InventoryResources inventory={inventory} />
          ) : (
            <InventoryUnavailable inventory={inventory} />
          )}
        </TabsContent>
        <TabsContent value="depth">
          {depth === null ? (
            <p className="px-4 py-6 text-meta text-muted-foreground md:px-5">
              Data depth is checked once this connector has a completed report.
            </p>
          ) : (
            <DepthCoach checklist={depth.checklist} runId={depth.runId} periodStart={depth.periodStart} framed={false} />
          )}
        </TabsContent>
        <TabsContent value="access">
          <Access subscription={subscription} now={now} />
        </TabsContent>
      </Tabs>
    </section>
  )
}
