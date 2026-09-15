import { PageBody } from "@/components/app-shell/page-body"
import type { Metadata } from "next"
import Link from "next/link"
import { PlusIcon } from "@phosphor-icons/react/ssr"

import { ConnectorInventory } from "@/components/subscriptions/connector-inventory"
import {
  SubscriptionList,
  canScanConnector,
} from "@/components/subscriptions/subscription-list"
import { buttonVariants } from "@/components/ui/button"
import { requireSession } from "@/lib/auth/guard"
import { readLatestScan } from "@/lib/scans/store"
import { listConnectedSubscriptions } from "@/lib/subscriptions/store"
import { selectedContext } from "@/lib/workspaces/context"
import { can } from "@/lib/workspaces/policy"

/**
 * `/subscriptions` — the connectors, and what the selected one can see.
 *
 * The selection is in the URL (`?c=<id>`) so the inventory beside the list is a server
 * render of the latest scan, and a link can land on one connector. With no selection the
 * first connector is shown, so the right-hand side is never an empty column.
 *
 * Every member sees the connectors; only Owners and Admins get the controls that change
 * or scan one (roles-and-ask-access Req 5).
 */

export const metadata: Metadata = {
  title: "Connectors",
  description:
    "Connected Azure subscriptions, their client secret expiry and the resources each " +
    "one can read.",
}

export default async function SubscriptionsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>
}>) {
  const user = await requireSession()
  const { workspace, project } = await selectedContext(user.id)
  const projectScope = { workspaceId: workspace.id, projectId: project?.id }
  const canConnect = can(workspace.role, "connect")
  const params = await searchParams

  const subscriptions = await listConnectedSubscriptions(user.id, projectScope)
  const now = new Date()

  const requested = typeof params.c === "string" ? params.c : undefined
  const selected =
    subscriptions.find((subscription) => subscription.id === requested) ??
    subscriptions[0]
  const scan = selected === undefined ? null : await readLatestScan(user.id, selected.id)

  return (
    <PageBody kind="wide">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-title">Connectors</h1>
          <p className="max-w-[62ch] text-meta text-muted-foreground">
            Read-only access to each customer&rsquo;s Azure subscription. A connector
            with an expired secret fails its next run instead of delivering an empty
            report.
          </p>
        </div>

        {subscriptions.length === 0 || !canConnect ? null : (
          <Link
            data-slot="button"
            href="/subscriptions/new"
            className={buttonVariants({ variant: "outline" })}
          >
            <PlusIcon aria-hidden="true" />
            Add connector
          </Link>
        )}
      </header>

      {subscriptions.length === 0 || selected === undefined ? (
        <SubscriptionList subscriptions={subscriptions} now={now} canConnect={canConnect} />
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
          <SubscriptionList
            subscriptions={subscriptions}
            now={now}
            selectedId={selected.id}
            canConnect={canConnect}
          />
          <ConnectorInventory
            subscription={selected}
            scan={scan}
            canScan={canConnect && canScanConnector(selected, now)}
          />
        </div>
      )}
    </PageBody>
  )
}
