import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon, UsersThreeIcon } from "@phosphor-icons/react/ssr"

import { PageBody } from "@/components/app-shell/page-body"
import { RequestButton } from "@/components/close/request-button"
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

export const metadata: Metadata = {
  title: "Request a report",
  description: "Request a customer's report against a saved preset.",
}

/**
 * `/reports/new` — request a report against a saved preset.
 *
 * Two selects and a read-only summary of what the preset will print. There are
 * deliberately no date fields: the period is a **rule** the preset declares and it
 * resolves at the moment the run is enqueued.
 *
 * A report belongs to one customer, whose connectors and presets the form offers. With
 * **All customers** selected in the sidebar there is no such customer yet, so this page
 * asks which one — picking it scopes the app to that customer and the form appears —
 * instead of the request button silently refusing.
 */

function BackToReports() {
  return (
    <Link
      href="/reports"
      className="flex w-fit items-center gap-1.5 rounded-lg text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
    >
      <ArrowLeftIcon aria-hidden="true" className="size-4" />
      All reports
    </Link>
  )
}

export default async function NewReportPage() {
  const user = await requireSession()

  const { workspace, projects, project } = await selectedContext(user.id)
  if (!can(workspace.role, "edit")) notFound()

  const active = projects.filter((candidate) => !candidate.archivedAt)

  if (!project || project.archivedAt) {
    if (active.length === 0) {
      return (
        <Empty className="mx-auto max-w-lg py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersThreeIcon />
            </EmptyMedia>
            <EmptyTitle>No active customer yet</EmptyTitle>
            <EmptyDescription>
              A report is requested for a customer. Add one, connect their Azure
              subscription, and request their report here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link
              href="/workspace-settings?tab=customers"
              className={buttonVariants({ variant: "outline" })}
            >
              Add a customer
            </Link>
          </EmptyContent>
        </Empty>
      )
    }

    return (
      <PageBody kind="reading">
        <header className="flex flex-col gap-3">
          <BackToReports />
          <div className="flex flex-col gap-1">
            <h1 className="text-title text-balance">Request a report</h1>
            <p className="max-w-prose text-meta text-muted-foreground">
              Which customer is it for? The form offers that customer&rsquo;s connectors
              and presets.
            </p>
          </div>
        </header>

        <ul className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
          {active.map((candidate) => (
            <li
              key={candidate.id}
              className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3 first:border-t-0"
            >
              <span className="min-w-0 truncate font-medium">{candidate.name}</span>
              <RequestButton
                workspaceId={workspace.id}
                projectId={candidate.id}
                customerName={candidate.name}
                label="Request"
              />
            </li>
          ))}
        </ul>
      </PageBody>
    )
  }

  const scope = { workspaceId: workspace.id, projectId: project.id }

  const [subscriptions, rows] = await Promise.all([
    listConnectedSubscriptions(user.id, scope),
    listTemplates(user.id, scope),
  ])

  const templates = await Promise.all(
    rows.map(async (row) =>
      toTemplateView(row, (await readLatestVersionForView(user.id, row.id)) ?? null)
    )
  )

  return (
    <PageBody kind="reading">
      <header className="flex flex-col gap-3">
        <BackToReports />
        <div className="flex flex-col gap-1">
          <h1 className="text-title text-balance">Request a report</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            Choose a connector and a preset for {project.name}. The preset decides the
            period, the scope and the document.
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
