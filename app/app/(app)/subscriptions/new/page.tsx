import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { ConnectSubscriptionView } from "@/components/subscriptions/connect-page"
import { requireSession } from "@/lib/auth/guard"
import { selectedContext } from "@/lib/workspaces/context"
import { can } from "@/lib/workspaces/policy"

/**
 * `/subscriptions/new` — the onboarding wizard (Requirements 11.3–11.7, 11.9,
 * 11.10, 12.7).
 *
 * Not found below Admin (roles-and-ask-access Req 5). Connecting records a customer's
 * credential, the create routes already refuse Editors and Viewers, and a wizard they
 * could fill in but never save would only cost them the time it takes. The page itself
 * is {@link ConnectSubscriptionView}, handed the render instant so the expiry range it
 * states and the one it validates are the same.
 */

export const metadata: Metadata = {
  title: "Connect a subscription",
  description:
    "Connect a customer's Azure subscription read-only, and prove read at " +
    "subscription scope before the connection is accepted.",
}

export default async function NewSubscriptionPage() {
  const user = await requireSession()
  const { workspace } = await selectedContext(user.id)
  if (!can(workspace.role, "connect")) notFound()

  return <ConnectSubscriptionView nowIso={new Date().toISOString()} />
}
