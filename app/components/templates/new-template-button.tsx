"use client"
import { useWorkspace, useCreationScope } from "@/components/workspaces/workspace-context"
import { can } from "@/lib/workspaces/policy"

import { useCallback, useState } from "react"
import { useRouter } from "next/navigation"
import { CaretDownIcon, PlusIcon } from "@phosphor-icons/react"

import {
  ProviderMark,
  SOURCE_NAMES,
  type SourceKind,
} from "@/components/subscriptions/provider-mark"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { TemplateView } from "@/lib/db/views"
import { SUPPORTED_PROVIDERS } from "@/lib/templates/definition"

/**
 * Create a preset, choosing the source it is written for.
 *
 * A preset's sections are one provider's catalogue, so the source is chosen here, once,
 * and locked. A source with no catalogue yet is listed and disabled — the same roadmap
 * the connector picker shows — rather than hidden, so the choice reads as a real one.
 */

const DEFAULT_NAME = "Untitled preset"

const SOURCES: readonly SourceKind[] = ["azure", "aws", "onprem"]

type CreateResponse = {
  readonly template?: TemplateView
  readonly error?: { readonly message?: string }
}

export function NewTemplateButton({
  label = "New preset",
  icon = true,
  className,
}: Readonly<{
  label?: string
  icon?: boolean
  className?: string
}> = {}) {
  const workspace = useWorkspace()
  const scope = useCreationScope()
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = useCallback(
    async (provider: SourceKind) => {
      if (creating) return
      setError(null)
      setCreating(true)

      try {
        const response = await fetch("/api/report-profiles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: DEFAULT_NAME, provider, ...scope }),
        })

        const body = (await response.json()) as CreateResponse

        if (!response.ok || body.template === undefined) {
          setError(body.error?.message ?? "The preset could not be created.")
          return
        }

        router.push(`/report-profiles/${body.template.id}/edit`)
      } catch {
        setError("The preset could not be created. Check your connection.")
      } finally {
        setCreating(false)
      }
    },
    [creating, router, scope]
  )

  const disabled =
    creating ||
    (!!workspace &&
      (!workspace.projectId || workspace.archived || !can(workspace.role, "edit")))

  return (
    <div className={className ?? "flex flex-col items-end gap-1"}>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button type="button" disabled={disabled} />}>
          {icon ? <PlusIcon aria-hidden="true" /> : null}
          {creating ? "Creating…" : label}
          <CaretDownIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Which source is it for?</DropdownMenuLabel>
            {SOURCES.map((source) => {
              const available = (SUPPORTED_PROVIDERS as readonly string[]).includes(source)
              return (
                <DropdownMenuItem
                  key={source}
                  disabled={!available}
                  onClick={() => available && void create(source)}
                >
                  <ProviderMark kind={source} className="[&_svg]:size-4" />
                  {SOURCE_NAMES[source]}
                  {available ? null : (
                    <span className="ml-auto pl-3 text-xs text-muted-foreground">Not yet</span>
                  )}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {error === null ? null : (
        <p
          data-slot="new-template-error"
          // Announced, because the button returning to rest is otherwise the only change.
          aria-live="polite"
          className="text-sm text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  )
}
