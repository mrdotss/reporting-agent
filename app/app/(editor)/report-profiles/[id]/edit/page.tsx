import type { Metadata } from "next"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"

import { Builder } from "@/components/builder/builder"
import { buttonVariants } from "@/components/ui/button"
import { requireSession } from "@/lib/auth/guard"
import { emptyDraftV4 } from "@/lib/builder/draft"
import type { DefinitionV4 } from "@/lib/builder/model"
import { COLLECTED_FACT_SOURCES } from "@/lib/profiles/facts"
import { readLatestScan } from "@/lib/scans/store"
import { readTypeCounts } from "@/lib/scans/view"
import { listConnectedSubscriptions } from "@/lib/subscriptions/store"
import { METRIC_CATALOG } from "@/lib/templates/catalog"
import { currentDisplayFormat } from "@/lib/templates/current-format"
import { previewSources } from "@/lib/templates/preview"
import { getTemplate, readLatestVersion, TemplateNotFoundError } from "@/lib/templates/store"
import { requireProject } from "@/lib/workspaces/access"
import { can } from "@/lib/workspaces/policy"

/**
 * `/report-profiles/[id]/edit` — the preset builder.
 *
 * A server component that resolves the draft and hands it to {@link Builder}, the one client
 * boundary on the screen.
 *
 * ## What opens
 *
 * The draft when there is one, else the latest version, else an empty v4 draft for the
 * preset's provider. The builder writes schema v4 only. A preset saved in an older format
 * opens as a notice instead: those presets are no longer used, and converting one in place
 * would mean guessing a layout nobody chose.
 */

export const metadata: Metadata = {
  title: "Preset builder",
  description: "Lay a report out block by block.",
}

type PageProps = Readonly<{ params: Promise<{ id: string }> }>

export default async function EditPresetPage({ params }: PageProps) {
  const user = await requireSession()
  const { id } = await params

  const loaded = await load(user.id, id)
  const { template } = loaded
  if (template.workspaceId && template.projectId) {
    const project = await requireProject(user.id, {
      workspaceId: template.workspaceId,
      projectId: template.projectId,
    })
    // There is no read-only view of a preset; somebody who cannot edit it goes back to
    // the list rather than to a page that does not exist.
    if (!can(project.role, "edit") || project.archived_at) redirect("/report-profiles")
  }

  const provider = template.provider === "aws" ? "aws" : "azure"
  const opened = template.draftDefinition ?? loaded.version?.definition ?? null
  const version = (opened as { schema_version?: unknown } | null)?.schema_version

  if (opened !== null && version !== 4) return <OlderFormat name={template.name} />

  const initial =
    opened === null
      ? emptyDraftV4(template.name, provider)
      : (currentDisplayFormat(opened) as DefinitionV4)

  // The live version, for Compare. An older-format version has nothing to line up with.
  const live = loaded.version?.definition ?? null
  const liveDefinition =
    live !== null && (live as { schema_version?: unknown }).schema_version === 4
      ? (currentDisplayFormat(live) as DefinitionV4)
      : null

  // The first active connection of the preset's own provider: what the Add panel's "found
  // in the account" hint and the lookback note read from. A preset is not tied to a
  // connection — one is chosen when a report runs — so this describes, never constrains.
  const subscriptions = await listConnectedSubscriptions(user.id, {
    workspaceId: template.workspaceId ?? undefined,
    projectId: template.projectId ?? undefined,
  })
  const connection =
    subscriptions.find((entry) => entry.status === "active" && entry.provider === provider) ?? null
  const scan = connection === null ? null : await readLatestScan(user.id, connection.id)
  const sources = await previewSources(user.id, subscriptions, provider)

  return (
    <Builder
      initial={initial}
      draftRevision={template.draftRevision ?? 0}
      storedName={template.name}
      environment={{
        templateId: template.id,
        catalog: METRIC_CATALOG,
        scanTypeCounts: scan === null ? undefined : readTypeCounts(scan.typeCounts),
        collectedFactSources: [...COLLECTED_FACT_SOURCES],
        metricsHistorySince: connection?.metricsHistorySince ?? null,
        latestVersion: loaded.version?.version ?? null,
        liveDefinition,
        previewSources: sources,
      }}
    />
  )
}

async function load(userId: string, id: string) {
  try {
    const template = await getTemplate(userId, id)
    const version = (await readLatestVersion(userId, id)) ?? null
    return { template, version }
  } catch (thrown) {
    // Another user's preset is not found, and says so the way an id that exists for no
    // row does.
    if (thrown instanceof TemplateNotFoundError) notFound()
    throw thrown
  }
}

function OlderFormat({ name }: Readonly<{ name: string }>) {
  return (
    <main className="grid min-h-svh place-items-center bg-background px-4">
      <div className="flex max-w-md flex-col gap-4 rounded-2xl border border-border bg-card p-6">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Older format
        </span>
        <h1 className="text-lg font-semibold text-balance">{name} was made before the builder</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          It can still be read in its reports, but it can&rsquo;t be edited here. Start a new preset
          from a starter instead — the builder lays it out block by block.
        </p>
        <div className="flex gap-2">
          <Link href="/report-profiles/new" className={buttonVariants({ size: "sm" })}>
            Start a new preset
          </Link>
          <Link href="/report-profiles" className={buttonVariants({ size: "sm", variant: "outline" })}>
            Back to presets
          </Link>
        </div>
      </div>
    </main>
  )
}
