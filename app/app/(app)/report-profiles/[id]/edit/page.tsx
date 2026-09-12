import { PageBody } from "@/components/app-shell/page-body"
import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"

import { requireProject } from "@/lib/workspaces/access"
import { can } from "@/lib/workspaces/policy"
import { WizardShell } from "@/components/templates/wizard-shell"
import { requireSession } from "@/lib/auth/guard"
import { toTemplateView, templateViewCurrentVersion } from "@/lib/db/views"
import { METRIC_CATALOG } from "@/lib/templates/catalog"
import { AZURE_SECTIONS } from "@/lib/profiles/sections"
import { COLLECTED_FACT_SOURCES } from "@/lib/profiles/facts"
import { toSchemaVersion2 } from "@/lib/templates/migrate"
import { readLatestScan } from "@/lib/scans/store"
import { readTypeCounts } from "@/lib/scans/view"
import { themeThumbnails } from "@/lib/templates/theme-thumbnails"
import { listConnectedSubscriptions } from "@/lib/subscriptions/store"
import {
  getTemplate,
  readLatestVersion,
  TemplateNotFoundError,
} from "@/lib/templates/store"

/**
 * `/report-profiles/[id]/edit` — the five-step wizard (Requirement 11).
 *
 * A **server** component whose only job is to resolve the draft and hand it to
 * {@link WizardShell}, which is the **one** `"use client"` boundary on this
 * screen and owns every piece of wizard state. Everything below it is a child of
 * that boundary rather than a separate island, so there is one place where the
 * draft lives and no two components that could disagree about it.
 *
 * ## What the server resolves, and why each of the three
 *
 * **The draft**, because Requirement 11.8 restores "every persisted value" on
 * reopen and the opening step is derived from it.
 *
 * **The latest version's definition** as the fallback when there is no draft. A
 * consultant reopening a saved template expects to see the template, not an empty
 * form — and a wizard that opened blank over a saved version would invite them to
 * rebuild it and save an emptier version 5 over a complete version 4.
 *
 * **The catalog**, so step 4 can present the Metric_Catalog's selectable items
 * (Requirement 5.6) without a client fetch on first paint. `GET
 * /api/report-profiles/catalog` exists for a client that needs to refresh it; this is
 * the initial value.
 *
 * `requireSession()` again, not because the `(app)` layout's check was
 * insufficient but because this page needs the **user id** to scope its reads,
 * and a layout cannot hand a value to a page.
 */

export const metadata: Metadata = {
  title: "Edit report profile",
  description: "Compose a report profile from typed sections.",
}

type PageProps = Readonly<{ params: Promise<{ id: string }> }>

export default async function EditTemplatePage({ params }: PageProps) {
  const user = await requireSession()
  const { id } = await params

  // Resolved before any JSX is constructed. The reads are what can raise, and
  // wrapping the render in the same `try` would put a component tree inside a
  // catch — which swallows an error thrown *during* render into a 404 that has
  // nothing to do with ownership.
  const loaded = await loadTemplate(user.id, id)
  if (loaded.template.workspaceId && loaded.template.projectId) {
    const project = await requireProject(user.id, { workspaceId: loaded.template.workspaceId, projectId: loaded.template.projectId })
    if (!can(project.role, "edit") || project.archived_at) redirect(`/report-profiles/${id}`)
  }


  // The first active subscription: what the section list's offerability gate and the
  // Lookback hint both read from. A profile is not tied to a connection — one is chosen
  // when a report is run — so this is a default for *describing* what is connected, never
  // a constraint on what the profile may declare.
  const subscriptions = await listConnectedSubscriptions(user.id, { workspaceId: loaded.template.workspaceId ?? undefined, projectId: loaded.template.projectId ?? undefined })
  const previewSubscription =
    subscriptions.find((entry) => entry.status === "active") ?? null

  // The most recent scan for that subscription. `null` (no subscription, or no scan
  // yet) means every section renders offerable.
  const latestScan =
    previewSubscription === null
      ? null
      : await readLatestScan(user.id, previewSubscription.id)
  const scanTypeCounts =
    latestScan === null ? undefined : readTypeCounts(latestScan.typeCounts)

  return (
    <PageBody kind="wide">
      <WizardShell
      template={toTemplateView(
        loaded.template,
        loaded.version === null
          ? null
          : templateViewCurrentVersion(loaded.version)
      )}
      initialDefinition={loaded.initialDefinition}
      catalog={METRIC_CATALOG}
      sectionCatalogue={AZURE_SECTIONS}
      thumbnails={themeThumbnails()}
      scanTypeCounts={scanTypeCounts}
      collectedFactSources={COLLECTED_FACT_SOURCES}
      // On the same reasoning as `scanTypeCounts` above: the depth of the connection this
      // page defaults to, which tells the Lookback control what to say, not what to allow.
      metricsHistorySince={previewSubscription?.metricsHistorySince ?? null}
      />
    </PageBody>
  )
}

async function loadTemplate(userId: string, id: string) {
  try {
    const template = await getTemplate(userId, id)
    const version = (await readLatestVersion(userId, id)) ?? null

    // The draft wins when there is one — it is by definition newer than the last
    // saved version, which is the whole reason it is persisted separately.
    const opened = template.draftDefinition ?? version?.definition ?? null

    return {
      template,
      version,
      // Requirement 13.12 — a stored `schema_version` 1 definition opens as a
      // version-2 draft. Applied **here**, on open, and nowhere else:
      //
      //   * `toSchemaVersion2` is pure, so this rewrites what the wizard shows and
      //     touches no row. The stored version is unchanged and every report pinned
      //     to it goes on rendering exactly as delivered.
      //   * a *save* then writes a **new** version row carrying `front_matter`,
      //     because `insertVersion` only ever inserts. There is no branch anywhere
      //     that upgrades a version in place, which is what makes "applies no write
      //     to the existing version row" structural rather than remembered.
      //   * `version` above is deliberately **not** migrated. It is what the
      //     template's stored state is presented from, and showing a migrated
      //     version there would tell a consultant the row already says something it
      //     does not.
      initialDefinition: opened === null ? null : toSchemaVersion2(opened),
    }
  } catch (thrown) {
    // Requirement 1.5 — another user's template is not found, and the answer is
    // indistinguishable from an id that exists for no row. `notFound()` renders
    // the same 404 page either way.
    if (thrown instanceof TemplateNotFoundError) notFound()

    throw thrown
  }
}
