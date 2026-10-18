"use client"

import { PlusIcon } from "@phosphor-icons/react"
import Link from "next/link"

import { buttonVariants } from "@/components/ui/button"
import { useWorkspace } from "@/components/workspaces/workspace-context"
import { can } from "@/lib/workspaces/policy"
import { cn } from "@/lib/utils"

/**
 * "New preset" — opens the Start screen, where the provider, a starter and a look are
 * chosen before the builder opens.
 *
 * Disabled where a preset cannot be created: no customer selected, an archived customer, or
 * a role that cannot edit. The Start screen says the same if it is reached another way.
 */
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
  const disabled =
    !!workspace && (!workspace.projectId || workspace.archived || !can(workspace.role, "edit"))

  if (disabled) {
    return (
      <span className={className ?? "flex flex-col items-end gap-1"}>
        <span aria-disabled="true" className={cn(buttonVariants(), "pointer-events-none opacity-50")}>
          {icon ? <PlusIcon aria-hidden="true" /> : null}
          {label}
        </span>
      </span>
    )
  }

  return (
    <span className={className ?? "flex flex-col items-end gap-1"}>
      <Link href="/report-profiles/new" className={buttonVariants()}>
        {icon ? <PlusIcon aria-hidden="true" /> : null}
        {label}
      </Link>
    </span>
  )
}
