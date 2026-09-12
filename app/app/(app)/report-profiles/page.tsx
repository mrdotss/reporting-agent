import { PageBody } from "@/components/app-shell/page-body"
import { selectedFilter } from "@/lib/workspaces/context"
import type { Metadata } from "next"
import Link from "next/link"
import { PlusIcon, StackIcon } from "@phosphor-icons/react/ssr"

import { NewTemplateButton } from "@/components/templates/new-template-button"
import { ProfileTable } from "@/components/templates/profile-table"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { requireSession } from "@/lib/auth/guard"
import { designPreviewEnabled } from "@/lib/design-preview/enabled"
import { toTemplateView } from "@/lib/db/views"
import { listTemplates, readLatestVersionForView } from "@/lib/templates/store"

/**
 * `/report-profiles` — every report profile this user owns (Requirements 1.4, 10.2).
 *
 * A **server** component. It resolves the signed-in user, reads that user's
 * templates scoped by `user_id`, projects each to {@link TemplateView} and hands
 * them down. Nothing here writes.
 *
 * The three starters are created with the account, so this list is never empty
 * for a real user (Requirement 10.2) — but it renders an empty state anyway,
 * because Requirement 10.6 allows starter seeding to fail and leave a user with
 * none, and a blank page is not an explanation.
 *
 * The list itself is a client component (`ProfileTable`): search and filtering
 * are interactions over a set this page has already read, and round-tripping a
 * keystroke to the server to hide rows already in the browser would be slower and
 * no more correct. This component stays the one that reads the database.
 *
 * ## The version shown is the one a run would pin
 *
 * `readLatestVersionForView` resolves the **highest existing** version rather than
 * reading `current_version_id`, matching what the enqueue does (Requirement 9.6).
 * The two agree in ordinary operation; showing the pointer instead would mean a
 * consultant who just saved version 4 sees version 3 beside a template that runs
 * as version 4.
 */

export const metadata: Metadata = {
  title: "Report Profiles",
  description:
    "Compose a report profile from typed sections. A profile is rules, not " +
    "resource ids, so one works for every subscription you have connected.",
}

export default async function TemplatesPage() {
  const user = await requireSession()
  const projectScope = await selectedFilter(user.id)

  const rows = await listTemplates(user.id, projectScope)

  // One resolve per template. A user holds three starters plus what they author
  // — single digits, not a page — and the alternative is a `DISTINCT ON` whose
  // ordering has to be kept consistent with the store's own.
  const templates = await Promise.all(
    rows.map(async (row) =>
      toTemplateView(
        row,
        (await readLatestVersionForView(user.id, row.id)) ?? null
      )
    )
  )

  return (
    <PageBody kind="wide">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-title">
            Report presets
          </h1>

          <p className="max-w-prose text-sm text-muted-foreground">
            Reuse your customer’s resources, metrics, and document style. Save a new version when you’re ready to use your changes.
          </p>
        </div>

        <div className="flex items-center gap-4">
          {designPreviewEnabled() ? (
            <Link
              href="/report-profiles/design-preview"
              className="text-sm underline underline-offset-4"
            >
              Open design lab
            </Link>
          ) : null}
          <NewTemplateButton />
        </div>
      </div>

      {templates.length === 0 ? (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <StackIcon />
            </EmptyMedia>
            <EmptyTitle>No report profiles</EmptyTitle>
            <EmptyDescription>
              Three starters are normally created with your account. If none is
              here, author one and the wizard walks you through the steps.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <NewTemplateButton />
          </EmptyContent>
        </Empty>
      ) : (
        <ProfileTable templates={templates} />
      )}

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <PlusIcon aria-hidden="true" />
        Editing a report profile creates a new version. A report already
        generated stays pinned to the version it was rendered from, so an
        archived report never changes.
      </p>
    </PageBody>
  )
}
