import type { Metadata } from "next"

import { PageBody } from "@/components/app-shell/page-body"
import { DescribeScreen } from "@/components/presets/describe-screen"
import { requireSession } from "@/lib/auth/guard"
import { THEME_FONT_VARIABLES } from "@/lib/builder/fonts"
import { messageText } from "@/lib/messages/catalog"
import { listConnectedSubscriptions } from "@/lib/subscriptions/store"
import { selectedContext } from "@/lib/workspaces/context"
import { can } from "@/lib/workspaces/policy"

/**
 * `/report-profiles/describe` — Describe it: draft a preset outline from a sentence, then
 * open it in the builder.
 *
 * The cloud defaults to the selected customer's first active connection, as on the Start
 * screen. Drafting needs no customer; saving does, on the same terms as any new preset.
 */

export const metadata: Metadata = {
  title: "Describe a preset",
  description: "Draft a preset outline from a description.",
}

export default async function DescribePresetPage() {
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
        <h1 className="text-title">{messageText("ui.describe.title", "en")}</h1>
        <p className="max-w-prose text-sm text-muted-foreground">{messageText("ui.describe.lead", "en")}</p>
      </div>
      <div className={`contents ${THEME_FONT_VARIABLES}`}>
        <DescribeScreen defaultProvider={defaultProvider} canCreate={canCreate} />
      </div>
    </PageBody>
  )
}
