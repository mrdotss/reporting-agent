import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { WizardShell } from "@/components/templates/wizard-shell"
import { requireSession } from "@/lib/auth/guard"
import { toTemplateView } from "@/lib/db/views"
import { METRIC_CATALOG } from "@/lib/templates/catalog"
import { themeThumbnails } from "@/lib/templates/theme-thumbnails"
import { getTemplate, readLatestVersion, TemplateNotFoundError } from "@/lib/templates/store"

/**
 * `/templates/[id]/edit` — the seven-step wizard (Requirement 11).
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
 * /api/templates/catalog` exists for a client that needs to refresh it; this is
 * the initial value.
 *
 * `requireSession()` again, not because the `(app)` layout's check was
 * insufficient but because this page needs the **user id** to scope its reads,
 * and a layout cannot hand a value to a page.
 */

export const metadata: Metadata = {
  title: "Edit template",
  description: "Compose a report template from typed blocks.",
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

  return (
    <WizardShell
      template={toTemplateView(loaded.template, loaded.version)}
      initialDefinition={loaded.initialDefinition}
      catalog={METRIC_CATALOG}
      thumbnails={themeThumbnails()}
    />
  )
}

async function loadTemplate(userId: string, id: string) {
  try {
    const template = await getTemplate(userId, id)
    const version = (await readLatestVersion(userId, id)) ?? null

    return {
      template,
      version,
      // The draft wins when there is one — it is by definition newer than the
      // last saved version, which is the whole reason it is persisted
      // separately.
      initialDefinition: template.draftDefinition ?? version?.definition ?? null,
    }
  } catch (thrown) {
    // Requirement 1.5 — another user's template is not found, and the answer is
    // indistinguishable from an id that exists for no row. `notFound()` renders
    // the same 404 page either way.
    if (thrown instanceof TemplateNotFoundError) notFound()

    throw thrown
  }
}
