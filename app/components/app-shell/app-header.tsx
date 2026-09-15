"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { PlusIcon } from "@phosphor-icons/react"

import type { SidebarCustomer } from "@/components/app-shell/app-sidebar"
import { CommandMenu } from "@/components/app-shell/command-menu"
import { ThemeToggle } from "@/components/app-shell/theme-toggle"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { buttonVariants } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

/** Where each top-level path sits: this period's work, or the library it is built from. */
const TRAIL: readonly { prefix: string; parent: "period" | "Library"; label: string }[] = [
  { prefix: "/dashboard", parent: "period", label: "Overview" },
  { prefix: "/reports/new", parent: "period", label: "Request report" },
  { prefix: "/reports", parent: "period", label: "Reports" },
  { prefix: "/ask", parent: "period", label: "Ask" },
  { prefix: "/report-profiles", parent: "Library", label: "Presets" },
  { prefix: "/subscriptions", parent: "Library", label: "Connectors" },
  { prefix: "/workspace-settings", parent: "Library", label: "Workspace" },
  { prefix: "/admin", parent: "Library", label: "Admin" },
]

export function AppHeader({
  periodLabel,
  scopeLabel,
  workspaceId,
  customers,
  canRequest,
  askAvailable,
  settingsAvailable,
}: Readonly<{
  periodLabel: string
  /** The selected customer's name, or undefined when every customer is in scope. */
  scopeLabel?: string
  workspaceId: string
  customers: readonly SidebarCustomer[]
  canRequest: boolean
  /** Whether Ask is open to this member in this workspace (roles-and-ask-access Req 6). */
  askAvailable: boolean
  /** Whether this member may open Workspace settings (Editor and up). */
  settingsAvailable: boolean
}>) {
  const pathname = usePathname()
  const crumb = TRAIL.find(
    ({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
  const parent = crumb?.parent === "Library" ? "Library" : periodLabel

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 rounded-t-[inherit] border-b border-border bg-background px-3">
      <SidebarTrigger className="-ml-1" aria-label="Toggle sidebar (Ctrl+B)" />
      <Separator orientation="vertical" className="mr-1 data-vertical:h-4" />
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap">
          <BreadcrumbItem className="hidden sm:inline-flex">{parent}</BreadcrumbItem>
          <BreadcrumbSeparator className="hidden sm:inline-flex" />
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="truncate">
              {crumb?.label ?? "Utilize Space"}
            </BreadcrumbPage>
          </BreadcrumbItem>
          {scopeLabel && (
            <>
              <BreadcrumbSeparator className="hidden md:inline-flex" />
              <BreadcrumbItem className="hidden truncate md:inline-flex">
                {scopeLabel}
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto flex items-center gap-1.5">
        <CommandMenu
          workspaceId={workspaceId}
          customers={customers}
          canRequest={canRequest}
          askAvailable={askAvailable}
          settingsAvailable={settingsAvailable}
        />
        <ThemeToggle />
        {canRequest && (
          <Link href="/reports/new" className={cn(buttonVariants(), "gap-1.5")}>
            <PlusIcon aria-hidden="true" />
            <span className="hidden sm:inline">Request report</span>
            <span className="sr-only sm:hidden">Request report</span>
          </Link>
        )}
      </div>
    </header>
  )
}
