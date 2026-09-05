"use client"

import { useCallback, useState } from "react"
import { useRouter } from "next/navigation"
import { PlusIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import type { TemplateView } from "@/lib/db/views"

/**
 * "New template" — create a named row and open the wizard on it.
 *
 * `POST /api/templates` with a name and **no definition**, which creates a
 * template carrying no version and no draft. That is the state Requirement 1.1
 * permits (`current_version_id` nullable "only until the template's first version
 * exists") and the state step 1 of the wizard expects to open on.
 *
 * A default name rather than a prompt: the wizard's first step is *Identity*, and
 * asking for a name in a modal and then immediately asking for it again on step 1
 * is one question twice. The consultant renames it there.
 *
 * ## Why the scan screen's "Continue" is this same button
 *
 * It used to be a `<Link href="/report-profiles/new?scan=…">`, and that route has never
 * existed — `report-profiles/` holds `page.tsx` and `[id]/`, and `[id]` has only an
 * `edit` child, so the link matched nothing and every Continue from a finished scan
 * landed on a 404. Creating a profile is a POST that returns the id the wizard opens on;
 * there is no page to link to, which is why the button rather than the link is the fix.
 *
 * The scan id it carried is not needed either: `report-profiles/[id]/edit` calls
 * `readLatestScan` for the profile's own subscription, so the wizard finds the scan
 * itself rather than being handed one that might not be that profile's.
 */

const DEFAULT_NAME = "Untitled template"

type CreateResponse = {
  readonly template?: TemplateView
  readonly error?: { readonly message?: string }
}

export function NewTemplateButton({
  label = "New template",
  icon = true,
  className,
}: Readonly<{
  label?: string
  icon?: boolean
  className?: string
}> = {}) {
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = useCallback(async () => {
    if (creating) return
    setError(null)
    setCreating(true)

    try {
      const response = await fetch("/api/report-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: DEFAULT_NAME }),
      })

      const body = (await response.json()) as CreateResponse

      if (!response.ok || body.template === undefined) {
        setError(body.error?.message ?? "The template could not be created.")
        return
      }

      router.push(`/report-profiles/${body.template.id}/edit`)
    } catch {
      setError("The template could not be created. Check your connection.")
    } finally {
      setCreating(false)
    }
  }, [creating, router])

  return (
    <div className={className ?? "flex flex-col items-end gap-1"}>
      <Button type="button" onClick={create} disabled={creating}>
        {icon ? <PlusIcon aria-hidden="true" /> : null}
        {creating ? "Creating…" : label}
      </Button>

      {error === null ? null : (
        <p
          data-slot="new-template-error"
          // Announced, because the button returning to rest is otherwise the
          // only change on the page.
          aria-live="polite"
          className="text-sm text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  )
}
