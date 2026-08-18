import type { Metadata } from "next"
import Link from "next/link"
import { PlusIcon, StackIcon } from "@phosphor-icons/react/ssr"

import { NewTemplateButton } from "@/components/templates/new-template-button"
import { Card, CardContent } from "@/components/ui/card"
import { requireSession } from "@/lib/auth/guard"
import { toTemplateView, type TemplateView } from "@/lib/db/views"
import { listTemplates, readLatestVersion } from "@/lib/templates/store"

/**
 * `/templates` — every template this user owns (Requirements 1.4, 10.2).
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
 * ## The version shown is the one a run would pin
 *
 * `readLatestVersion` resolves the **highest existing** version rather than
 * reading `current_version_id`, matching what the enqueue does (Requirement 9.6).
 * The two agree in ordinary operation; showing the pointer instead would mean a
 * consultant who just saved version 4 sees version 3 beside a template that runs
 * as version 4.
 */

export const metadata: Metadata = {
  title: "Templates",
  description:
    "Compose a report template from typed blocks. A template is rules, not " +
    "resource ids, so one works for every subscription you have connected.",
}

/** The digest, truncated for the line, as every other digest in the app is shown. */
function shortDigest(digest: string | null): string | null {
  return digest === null ? null : digest.slice(0, 12)
}

function TemplateRow({ template }: Readonly<{ template: TemplateView }>) {
  const digest = shortDigest(template.currentVersionSha256)

  return (
    <Card data-slot="template-row">
      <CardContent className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link
            href={`/templates/${template.id}/edit`}
            className="font-heading text-sm font-medium tracking-tight underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
          >
            {template.name}
          </Link>

          {template.description === "" ? null : (
            <p className="max-w-prose text-sm text-muted-foreground">
              {template.description}
            </p>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {template.currentVersion === null ? (
            // Not an error, and worded so it does not read as one: a template
            // with no version is a draft the wizard has not finished, which is
            // an ordinary state on the way to a first save.
            <>No saved version yet</>
          ) : (
            <>
              Version{" "}
              <span className="font-mono tabular-nums">
                {template.currentVersion}
              </span>{" "}
              · <span className="font-mono">{digest}</span>
            </>
          )}
          {template.hasDraft ? " · unsaved draft" : null}
        </p>
      </CardContent>
    </Card>
  )
}

export default async function TemplatesPage() {
  const user = await requireSession()

  const rows = await listTemplates(user.id)

  // One resolve per template. A user holds three starters plus what they author
  // — single digits, not a page — and the alternative is a `DISTINCT ON` whose
  // ordering has to be kept consistent with the store's own.
  const templates = await Promise.all(
    rows.map(async (row) =>
      toTemplateView(row, (await readLatestVersion(user.id, row.id)) ?? null)
    )
  )

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-medium tracking-tight">
            Templates
          </h1>

          <p className="max-w-prose text-sm text-muted-foreground">
            A template is <em>rules</em> — resource types, tag filters, a period
            that resolves fresh at every run — so one template works for every
            subscription you have connected, and next month&rsquo;s report needs
            no edit.
          </p>
        </div>

        <NewTemplateButton />
      </div>

      {templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-2">
            <StackIcon aria-hidden="true" className="size-5 text-muted-foreground" />

            <p className="text-sm text-muted-foreground">
              You have no templates. Three starters are normally created with
              your account; if none is here, author one and the wizard will walk
              you through the seven steps.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {templates.map((template) => (
            <TemplateRow key={template.id} template={template} />
          ))}
        </div>
      )}

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <PlusIcon aria-hidden="true" />
        Editing a template creates a new version. A report already generated
        stays pinned to the version it was rendered from, so an archived report
        never changes.
      </p>
    </div>
  )
}
