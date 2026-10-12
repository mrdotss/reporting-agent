import type { Metadata } from "next"

import { ActionList } from "@/components/actions/action-list"
import { PageBody } from "@/components/app-shell/page-body"
import { requireSession } from "@/lib/auth/guard"
import { listActionItems } from "@/lib/action-register/store"
import { CLOSE_TIMEZONE } from "@/lib/close/load"
import { closePeriod } from "@/lib/close/period"
import { selectedContext } from "@/lib/workspaces/context"
import { can } from "@/lib/workspaces/policy"

/**
 * `/actions` — the selected customer's Action register, or every customer's with "All
 * customers". Every finding the verified reports raised, carried month to month with an
 * owner and a status, and resolved only when a report checks it clear.
 *
 * The list is keyed by the customer, so a switch mounts a fresh one rather than keeping
 * the rows (and their unsaved edits) of the customer before. "New this month" is the month
 * the close is for, the same open period the sidebar shows.
 */

export const metadata: Metadata = {
  title: "Actions",
  description: "What each customer's reports found to act on, who owns it, and what is resolved.",
}

export default async function ActionsPage() {
  const user = await requireSession()
  const { workspace, project } = await selectedContext(user.id)

  return (
    <PageBody kind="wide" className="max-w-[82rem]">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-title">Actions</h1>
        <p className="max-w-[62ch] text-meta text-muted-foreground">
          {project
            ? `What ${project.name}'s reports found to act on. Give each an owner; the next verified report resolves what it checks clear.`
            : "What every customer's reports found to act on. Give each an owner; the next verified report resolves what it checks clear."}
        </p>
      </header>
      <ActionList
        key={project?.id ?? "all"}
        items={await listActionItems(user.id, { workspaceId: workspace.id, projectId: project?.id })}
        canEdit={can(workspace.role, "edit")}
        showCustomer={project === undefined}
        newMonth={closePeriod(new Date(), workspace.closeDay, CLOSE_TIMEZONE).month}
        fileLabel={`actions-${(project?.name ?? "all-customers").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
      />
    </PageBody>
  )
}
