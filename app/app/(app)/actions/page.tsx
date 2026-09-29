import type { Metadata } from "next"

import { ActionList } from "@/components/actions/action-list"
import { PageBody } from "@/components/app-shell/page-body"
import { requireSession } from "@/lib/auth/guard"
import { listActionItems } from "@/lib/action-register/store"
import { selectedContext } from "@/lib/workspaces/context"
import { can } from "@/lib/workspaces/policy"

/**
 * `/actions` — the selected customer's Action register. Every finding its verified reports
 * raised, carried month to month with an owner and a status, and resolved only when a
 * report checks it clear.
 */

export const metadata: Metadata = {
  title: "Actions",
  description: "What each customer's reports found to act on, who owns it, and what is resolved.",
}

export default async function ActionsPage() {
  const user = await requireSession()
  const { workspace, project } = await selectedContext(user.id)

  return (
    <PageBody kind="reading">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-title">Actions</h1>
        <p className="max-w-[62ch] text-meta text-muted-foreground">
          {project
            ? `What ${project.name}'s reports found to act on. Give each an owner; the next verified report resolves what it checks clear.`
            : "Choose a customer to see what its reports found to act on."}
        </p>
      </header>
      {project ? (
        <ActionList
          items={await listActionItems(user.id, { workspaceId: workspace.id, projectId: project.id })}
          canEdit={can(workspace.role, "edit")}
        />
      ) : null}
    </PageBody>
  )
}
