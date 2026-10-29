import Link from "next/link"
import {
  ArrowRightIcon,
  KeyIcon,
  SquaresFourIcon,
  StackIcon,
  TargetIcon,
} from "@phosphor-icons/react/ssr"

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
import { ProviderMark } from "@/components/subscriptions/provider-mark"
import {
  ExpiryMeter,
  StateNotice,
  canScanConnector,
  secretDaysLeft,
} from "@/components/subscriptions/subscription-list"
import { buttonVariants } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ConnectedSubscriptionView, ScanView } from "@/lib/db/views"
import type { DepthChecklist } from "@/lib/subscriptions/depth"
import { resolveSubscriptionState } from "@/lib/subscriptions/state"
import { cn } from "@/lib/utils"

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
    <div data-slot="connector-header" className="flex flex-col gap-3 px-4 pt-5 md:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-background">
            <ProviderMark kind={subscription.provider} className="size-6!" />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-lg font-semibold tracking-[-0.01em]">
              What&rsquo;s in <span className="font-mono">{subscription.displayName}</span>
            </h2>
            <p className="text-meta text-muted-foreground">{scannedLine}</p>
          </div>
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
    <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-3 px-4 py-4 text-meta md:px-6">
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

/**
 * Each tab is a summary card: what the tab holds, in one number or phrase, and an
 * arrow that says the card opens something. The selected card is outlined in the
 * accent, so the four read as a choice rather than as headings.
 */
function AccessSummary({ subscription, now }: Readonly<{ subscription: ConnectedSubscriptionView; now: Date }>) {
  const state = resolveSubscriptionState(subscription, now)
  if (subscription.provider === "aws") {
    return subscription.scopeVerified ? (
      <span className="text-(--status-verified)">Role verified</span>
    ) : (
      <span className="text-(--status-attention)">Role not verified</span>
    )
  }
  if (state.kind === "expired" || state.kind === "disabled") {
    return <span className="text-(--status-failed)">Secret expired</span>
  }
  const days = secretDaysLeft(subscription, now)
  return (
    <span className={state.kind === "expiring" ? "text-(--status-attention)" : "text-(--status-verified)"}>
      {days} {days === 1 ? "day" : "days"} left
    </span>
  )
}

const TAB_CARD = cn(
  "group/tab h-auto! flex-col! items-stretch! justify-start! gap-2 rounded-xl! border! border-border! bg-card px-4 py-3.5 text-left whitespace-normal text-foreground!",
  "transition-[border-color,box-shadow,background-color] hover:border-input! hover:shadow-[0_4px_14px_-8px_rgb(23_24_28/0.25)]",
  "data-active:border-primary! data-active:bg-primary/[0.035] data-active:ring-3 data-active:ring-primary/12 dark:data-active:bg-primary/[0.06]",
  "after:hidden"
)

function TabCard({
  value,
  icon,
  label,
  children,
  hint,
}: Readonly<{
  value: string
  icon: React.ReactNode
  label: string
  children: React.ReactNode
  hint: string
}>) {
  return (
    <TabsTrigger value={value} className={TAB_CARD}>
      <span className="flex items-center gap-1.5 text-meta font-semibold text-muted-foreground group-data-active/tab:text-primary">
        {icon}
        {label}
      </span>
      <span className="min-h-7 text-lg leading-7 font-semibold tracking-[-0.01em]">{children}</span>
      <span className="flex items-center justify-between gap-2 text-xs font-normal text-muted-foreground">
        {hint}
        <ArrowRightIcon
          aria-hidden="true"
          className="size-4 transition-transform group-hover/tab:translate-x-0.5 group-hover/tab:text-primary group-data-active/tab:text-primary"
        />
      </span>
    </TabsTrigger>
  )
}

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
      <Tabs defaultValue="overview" className="mt-5 gap-0">
        <TabsList
          aria-label="Connector details"
          className="grid h-auto! w-full grid-cols-2 gap-3 rounded-none bg-transparent p-0 px-4 md:px-6 lg:grid-cols-4"
        >
          <TabCard
            value="overview"
            icon={<SquaresFourIcon aria-hidden="true" className="size-4" />}
            label="Overview"
            hint="Mix and largest types"
          >
            {inventory.reported ? `${inventory.figures[2][0] ?? 0} regions` : "Not scanned yet"}
          </TabCard>
          <TabCard
            value="resources"
            icon={<StackIcon aria-hidden="true" className="size-4" />}
            label="Resources"
            hint={inventory.reported ? `${inventory.typeCount} types in ${inventory.grouped.length} groups` : "Scan to list them"}
          >
            {inventory.reported ? <span className="font-mono text-2xl font-medium tabular-nums">{inventory.total}</span> : "—"}
          </TabCard>
          <TabCard
            value="depth"
            icon={<TargetIcon aria-hidden="true" className="size-4" />}
            label="Data depth"
            hint={depth === null ? "After the first report" : open.length === 0 ? "Nothing left to fix" : "Steps for each one"}
          >
            {depth === null ? (
              "Not checked yet"
            ) : (
              <span className="flex items-baseline gap-2">
                <span className="font-mono text-2xl font-medium tabular-nums">
                  {depth.checklist.done}/{depth.checklist.total}
                </span>
                {open.length === 0 ? null : (
                  <span className="text-meta font-semibold text-(--status-attention)">{open.length} to fix</span>
                )}
              </span>
            )}
          </TabCard>
          <TabCard
            value="access"
            icon={<KeyIcon aria-hidden="true" className="size-4" />}
            label="Access"
            hint={subscription.provider === "aws" ? "Nothing expires" : "Client secret"}
          >
            <AccessSummary subscription={subscription} now={now} />
          </TabCard>
        </TabsList>

        <div aria-hidden="true" className="mx-4 mt-5 border-t border-border/60 md:mx-6" />
        <TabsContent value="overview">
          {inventory.reported ? (
            <div className="flex flex-col gap-5 px-4 py-4 md:px-6">
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
            <p className="px-4 py-6 text-meta text-muted-foreground md:px-6">
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
