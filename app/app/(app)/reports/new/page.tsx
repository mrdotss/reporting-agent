import Link from "next/link"
import { ArrowLeftIcon, UsersThreeIcon } from "@phosphor-icons/react/ssr"

import { PageBody } from "@/components/app-shell/page-body"
import { RunForm } from "@/components/reports/run-form"
import { buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { requireSession } from "@/lib/auth/guard"
import { toTemplateView } from "@/lib/db/views"
import { listConnectedSubscriptions } from "@/lib/subscriptions/store"
import { listTemplates, readLatestVersionForView } from "@/lib/templates/store"
import { selectedContext } from "@/lib/workspaces/context"
import { can } from "@/lib/workspaces/policy"

/**
 * `/reports/new` — request a report against a saved preset.
 *
 * Two selects and a read-only summary of what the preset will print. There are
 * deliberately no date fields: the period is a **rule** the preset declares and it
 * resolves at the moment the run is enqueued, so a pair of dates here would be a
 * different report from the one the preset describes.
 */

export default async function NewReportPage() {
  const user = await requireSession()

  const { workspace, project } = await selectedContext(user.id)

  if (!project || project.archivedAt || !can(workspace.role, "edit")) {
    return (
      <Empty className="mx-auto max-w-lg py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersThreeIcon />
          </EmptyMedia>
          <EmptyTitle>Pick a customer first</EmptyTitle>
          <EmptyDescription>
            A report is requested for one active customer, by an Editor or
            higher. Choose a customer in the sidebar.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Link
            href="/workspace-settings?tab=customers"
            className={buttonVariants({ variant: "outline" })}
          >
            View customers
          </Link>
        </EmptyContent>
      </Empty>
    )
  }

  const scope = { workspaceId: workspace.id, projectId: project.id }

  const [subscriptions, rows] = await Promise.all([
    listConnectedSubscriptions(user.id, scope),
    listTemplates(user.id, scope),
  ])

  const templates = await Promise.all(
    rows.map(async (row) =>
      toTemplateView(
        row,
        (await readLatestVersionForView(user.id, row.id)) ?? null
      )
    )
  )

  return (
    <PageBody kind="reading">
      <header className="flex flex-col gap-3">
        <Link
          href="/reports"
          className="flex w-fit items-center gap-1.5 rounded-lg text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
          All reports
        </Link>

        <div className="flex flex-col gap-1">
          <h1 className="text-title text-balance">Request a report</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            Choose a connector and a preset for {project.name}. The preset
            decides the period, the scope and the document.
          </p>
        </div>
      </header>

      <RunForm
        subscriptions={subscriptions}
        templates={templates}
        nowIso={new Date().toISOString()}
      />
    </PageBody>
  )
}
