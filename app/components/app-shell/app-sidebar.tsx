"use client"

import { useState, type ReactNode } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  CaretUpDownIcon,
  ChatsCircleIcon,
  CheckIcon,
  FileTextIcon,
  GearSixIcon,
  PlugsIcon,
  PlusIcon,
  ShieldCheckIcon,
  SquaresFourIcon,
  StackIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react"

import { PeriodChip } from "@/components/app-shell/period-chip"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import {
  CLOSE_STATE_LABEL,
  StatusMark,
  type CloseState,
} from "@/components/ui/status-mark"
import { workspaceMutation } from "@/components/workspaces/workspace-context"
import { monthName, type ClosePeriod } from "@/lib/close/period"
import { can, type WorkspaceRole } from "@/lib/workspaces/policy"

/**
 * The navigation rail: shadcn's `Sidebar`, `variant="inset"`, collapsing to icons.
 *
 * It sits on the mori ground and the page is the one lifted object beside it, so
 * navigation and content read as one room rather than as "sidebar world" and
 * "content world". Four things live here, in the order a consultant needs them:
 *
 *   1. which workspace, and a way to switch it;
 *   2. the close — the month being reported on and how long is left;
 *   3. where to go: this period's work, then the library it is built from;
 *   4. the customers, each with the state of their report for the open month.
 *
 * The customer list replaces the old header project picker. Picking a customer scopes
 * every page to it; "All customers" clears the scope. It is scope, but it is also the
 * list of things the close is made of, and that is why it belongs in the rail.
 */

export type SidebarCustomer = Readonly<{
  id: string
  name: string
  state: CloseState
}>

export type AppSidebarProps = Readonly<{
  workspace: { id: string; name: string; role: WorkspaceRole }
  workspaces: readonly { id: string; name: string }[]
  customers: readonly SidebarCustomer[]
  selectedCustomerId?: string
  period: ClosePeriod
  connectorsNeedAttention: boolean
  /** Whether Ask is open to this member in this workspace (roles-and-ask-access Req 6). */
  askAvailable: boolean
  /** Whether this account administers Ask (roles-and-ask-access Req 7). */
  platformAdmin: boolean
  userMenu: ReactNode
}>

const THIS_PERIOD = [
  { href: "/dashboard", label: "Overview", icon: SquaresFourIcon },
  { href: "/reports", label: "Reports", icon: FileTextIcon },
  { href: "/ask", label: "Ask", icon: ChatsCircleIcon },
] as const

const LIBRARY = [
  { href: "/report-profiles", label: "Presets", icon: StackIcon },
  { href: "/subscriptions", label: "Connectors", icon: PlugsIcon },
] as const

function isCurrent(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function AppSidebar({
  workspace,
  workspaces,
  customers,
  selectedCustomerId,
  period,
  connectorsNeedAttention,
  askAvailable,
  platformAdmin,
  userMenu,
}: AppSidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")

  async function select(workspaceId: string, projectId?: string) {
    setBusy(true)
    setError("")
    try {
      await workspaceMutation({ action: "select", workspaceId, projectId })
      if (workspaceId !== workspace.id) router.push("/dashboard")
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "That selection didn’t save.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Sidebar variant="inset" collapsible="icon" aria-label="Primary">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      size="lg"
                      aria-label={`${workspace.name} — switch workspace`}
                    />
                  }
                >
                  <WorkspaceMark />
                  <span className="grid min-w-0 flex-1 text-left leading-tight">
                    <span className="truncate text-sm font-semibold tracking-tight">
                      Utilize Space
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {workspace.name}
                    </span>
                  </span>
                  <CaretUpDownIcon
                    aria-hidden="true"
                    className="ml-auto text-muted-foreground"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="min-w-60" align="start">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                    {workspaces.map((w) => (
                      <DropdownMenuItem
                        key={w.id}
                        disabled={busy}
                        onClick={() => w.id !== workspace.id && void select(w.id)}
                      >
                        <span className="truncate">{w.name}</span>
                        {w.id === workspace.id && (
                          <CheckIcon aria-hidden="true" className="ml-auto" />
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setCreating(true)}>
                    <PlusIcon aria-hidden="true" />
                    New workspace
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
          <PeriodChip period={period} />
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>This period</SidebarGroupLabel>
            <SidebarMenu>
              {THIS_PERIOD.filter(({ href }) => href !== "/ask" || askAvailable).map(({ href, label, icon: Icon }) => (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton
                    isActive={isCurrent(pathname, href)}
                    tooltip={label}
                    render={
                      <Link
                        href={href}
                        aria-current={isCurrent(pathname, href) ? "page" : undefined}
                      />
                    }
                  >
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupLabel>Library</SidebarGroupLabel>
            <SidebarMenu>
              {LIBRARY.map(({ href, label, icon: Icon }) => (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton
                    isActive={isCurrent(pathname, href)}
                    tooltip={label}
                    render={
                      <Link
                        href={href}
                        aria-current={isCurrent(pathname, href) ? "page" : undefined}
                      />
                    }
                  >
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                  </SidebarMenuButton>
                  {href === "/subscriptions" && connectorsNeedAttention && (
                    <SidebarMenuBadge>
                      <StatusMark state="attention" />
                      <span className="sr-only">A connector needs attention</span>
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupLabel>
              Customers · {monthName(period.month, "short")}
            </SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  isActive={selectedCustomerId === undefined}
                  tooltip="All customers"
                  disabled={busy}
                  onClick={() => void select(workspace.id)}
                >
                  <UsersThreeIcon aria-hidden="true" />
                  <span>All customers</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {customers.map((customer) => (
                <SidebarMenuItem key={customer.id}>
                  <SidebarMenuButton
                    size="sm"
                    isActive={selectedCustomerId === customer.id}
                    tooltip={`${customer.name} — ${CLOSE_STATE_LABEL[customer.state]}`}
                    disabled={busy}
                    onClick={() => void select(workspace.id, customer.id)}
                  >
                    <span className="grid size-4 shrink-0 place-items-center">
                      <StatusMark state={customer.state} />
                    </span>
                    <span className="truncate">{customer.name}</span>
                    <span className="sr-only">
                      , {monthName(period.month)}: {CLOSE_STATE_LABEL[customer.state]}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
            {error && (
              <p role="alert" className="px-2 pt-2 text-xs text-destructive">
                {error}
              </p>
            )}
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            {platformAdmin && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={isCurrent(pathname, "/admin")}
                  tooltip="Admin"
                  render={<Link href="/admin" />}
                >
                  <ShieldCheckIcon aria-hidden="true" />
                  <span>Admin</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            {can(workspace.role, "edit") && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={isCurrent(pathname, "/workspace-settings")}
                  tooltip="Workspace"
                  render={<Link href="/workspace-settings" />}
                >
                  <GearSixIcon aria-hidden="true" />
                  <span>Workspace</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
          <div className="px-2 pb-1 group-data-[collapsible=icon]:hidden">
            {userMenu}
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogTitle>Create workspace</DialogTitle>
          <DialogDescription>
            A separate space for your customers, connectors and team.
          </DialogDescription>
          <form
            onSubmit={async (event) => {
              event.preventDefault()
              setBusy(true)
              setError("")
              try {
                await workspaceMutation({ action: "create_workspace", name })
                setCreating(false)
                router.push("/workspace-settings?tab=customers")
                router.refresh()
              } catch (e) {
                setError(e instanceof Error ? e.message : "The workspace wasn’t created.")
              } finally {
                setBusy(false)
              }
            }}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor="workspace-name">
                Workspace name
              </label>
              <Input
                id="workspace-name"
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <Button disabled={busy} type="submit" className="w-fit">
              Create workspace
            </Button>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Three capacity bars, each partly filled: the product measures how much is used. */
function WorkspaceMark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground"
    >
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect x="2" y="2.5" width="14" height="3" rx="1.2" fill="currentColor" opacity=".32" />
        <rect x="2" y="2.5" width="10.5" height="3" rx="1.2" fill="currentColor" />
        <rect x="2" y="7.5" width="14" height="3" rx="1.2" fill="currentColor" opacity=".32" />
        <rect x="2" y="7.5" width="5" height="3" rx="1.2" fill="currentColor" />
        <rect x="2" y="12.5" width="14" height="3" rx="1.2" fill="currentColor" opacity=".32" />
        <rect x="2" y="12.5" width="12.5" height="3" rx="1.2" fill="currentColor" />
      </svg>
    </span>
  )
}
