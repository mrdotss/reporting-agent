import type { Metadata } from "next"

import { PageBody } from "@/components/app-shell/page-body"
import { StartScreen } from "@/components/builder/start/start-screen"
import { requireSession } from "@/lib/auth/guard"
import { THEME_FONT_VARIABLES } from "@/lib/builder/fonts"
import { listConnectedSubscriptions } from "@/lib/subscriptions/store"
import { selectedContext } from "@/lib/workspaces/context"
import { can } from "@/lib/workspaces/policy"

/**
 * `/report-profiles/new` — the Start screen: provider, starter and look, then the builder.
 *
 * The provider defaults to the selected customer's first active connection, since that is
 * what a preset for them will most likely report on. It is a default, not a constraint.
 */

export const metadata: Metadata = {
  title: "New preset",
  description: "Start a preset from a starter.",
}

export default async function NewPresetPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ starter?: string | string[] }> }>) {
  const { starter } = await searchParams
  const user = await requireSession()
  const { workspace, project } = await selectedContext(user.id)
  const subscriptions = await listConnectedSubscriptions(user.id, {
    workspaceId: workspace.id,
    projectId: project?.id,
  })
  const active = subscriptions.find((entry) => entry.status === "active")
  const defaultProvider = active?.provider === "azure" ? "azure" : "aws"
  const canCreate = !!project && !project.archivedAt && can(workspace.role, "edit")

  return (
    <PageBody kind="wide">
      <div className="flex flex-col gap-1">
        <h1 className="text-title">New preset</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Choose where the report&rsquo;s figures come from, a starting layout and a look. Everything
          can be changed in the builder.
        </p>
      </div>
      <div className={`contents ${THEME_FONT_VARIABLES}`}>
        <StartScreen
          defaultProvider={defaultProvider}
          canCreate={canCreate}
          initialStarter={typeof starter === "string" ? starter : undefined}
        />
      </div>
    </PageBody>
  )
}
