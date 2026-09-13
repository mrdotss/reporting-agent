"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import {
  FileTextIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PlugsIcon,
  PlusIcon,
  SidebarIcon,
  SquaresFourIcon,
  StackIcon,
} from "@phosphor-icons/react"

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { Kbd } from "@/components/ui/kbd"
import { useSidebar } from "@/components/ui/sidebar"
import {
  CLOSE_STATE_LABEL,
  StatusMark,
} from "@/components/ui/status-mark"
import { workspaceMutation } from "@/components/workspaces/workspace-context"
import type { SidebarCustomer } from "@/components/app-shell/app-sidebar"

const PAGES = [
  { href: "/dashboard", label: "Close board", icon: SquaresFourIcon },
  { href: "/reports", label: "Reports", icon: FileTextIcon },
  { href: "/report-profiles", label: "Presets", icon: StackIcon },
  { href: "/subscriptions", label: "Connectors", icon: PlugsIcon },
  { href: "/workspace-settings", label: "Workspace", icon: GearSixIcon },
] as const

/**
 * ⌘K / Ctrl+K: jump to a page, scope to a customer, or start the one action this
 * product exists for. The trigger doubles as the header's search field so the shortcut
 * is discoverable rather than folklore.
 */
export function CommandMenu({
  workspaceId,
  customers,
  canRequest,
}: Readonly<{
  workspaceId: string
  customers: readonly SidebarCustomer[]
  canRequest: boolean
}>) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const { toggleSidebar } = useSidebar()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const run = (action: () => void) => {
    setOpen(false)
    action()
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search customers, pages and actions"
        className="flex h-9 w-9 items-center gap-2 rounded-lg border border-border bg-muted px-2.5 text-meta text-muted-foreground transition-colors outline-none hover:border-input focus-visible:ring-3 focus-visible:ring-ring/30 md:w-60"
      >
        <MagnifyingGlassIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="hidden truncate md:inline">Search customers, reports…</span>
        <Kbd className="ml-auto hidden md:inline-flex">⌘K</Kbd>
      </button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search"
        description="Jump to a page or a customer, or run an action."
      >
        <CommandInput placeholder="Search customers, pages, actions…" />
        <CommandList>
          <CommandEmpty>Nothing matches that.</CommandEmpty>
          <CommandGroup heading="Go to">
            {PAGES.map(({ href, label, icon: Icon }) => (
              <CommandItem key={href} onSelect={() => run(() => router.push(href))}>
                <Icon aria-hidden="true" />
                {label}
              </CommandItem>
            ))}
          </CommandGroup>
          {customers.length > 0 && (
            <CommandGroup heading="Customers">
              {customers.map((customer) => (
                <CommandItem
                  key={customer.id}
                  value={`customer ${customer.name}`}
                  onSelect={() =>
                    run(async () => {
                      await workspaceMutation({
                        action: "select",
                        workspaceId,
                        projectId: customer.id,
                      })
                      router.push("/dashboard")
                      router.refresh()
                    })
                  }
                >
                  <span className="grid size-4 place-items-center">
                    <StatusMark state={customer.state} />
                  </span>
                  {customer.name}
                  <CommandShortcut>{CLOSE_STATE_LABEL[customer.state]}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandSeparator />
          <CommandGroup heading="Actions">
            {canRequest && (
              <CommandItem onSelect={() => run(() => router.push("/reports/new"))}>
                <PlusIcon aria-hidden="true" />
                Request a report
              </CommandItem>
            )}
            <CommandItem
              onSelect={() =>
                run(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))
              }
            >
              <MoonIcon aria-hidden="true" />
              Toggle dark mode
            </CommandItem>
            <CommandItem onSelect={() => run(toggleSidebar)}>
              <SidebarIcon aria-hidden="true" />
              Toggle sidebar
              <CommandShortcut>Ctrl B</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  )
}
