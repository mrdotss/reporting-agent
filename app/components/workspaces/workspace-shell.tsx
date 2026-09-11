"use client"

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  BuildingsIcon,
  SquaresFourIcon,
  FolderIcon,
  PlugsConnectedIcon,
  StackIcon,
  FileTextIcon,
  GearIcon,
  SidebarSimpleIcon,
  ListIcon,
  PlusIcon,
} from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { ThemeToggle } from "@/components/app-shell/theme-toggle"
import { can, type WorkspaceRole } from "@/lib/workspaces/policy"
import { cn } from "@/lib/utils"

type Scope = {
  workspaceId: string
  projectId?: string
  role: WorkspaceRole
  projectName?: string
  archived: boolean
}
const WorkspaceContext = createContext<Scope | null>(null)
export function useWorkspace() {
  return useContext(WorkspaceContext)
}
export function useCreationScope() {
  const context = useWorkspace()
  const workspaceId = context?.workspaceId
  const projectId = context?.projectId
  return useMemo(
    () => (workspaceId ? { workspaceId, projectId } : {}),
    [workspaceId, projectId]
  )
}
export async function workspaceMutation(body: unknown) {
  const response = await fetch("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok)
    throw new Error(result.error?.message ?? "The change could not be saved.")
  return result
}
const NAV = [
  { href: "/dashboard", label: "Overview", icon: SquaresFourIcon },
  { href: "/projects", label: "Projects", icon: FolderIcon },
  { href: "/subscriptions", label: "Connections", icon: PlugsConnectedIcon },
  { href: "/report-profiles", label: "Report profiles", icon: StackIcon },
  { href: "/reports", label: "Reports", icon: FileTextIcon },
]
type Props = {
  children: ReactNode
  userMenu: ReactNode
  workspace: { id: string; name: string; role: WorkspaceRole }
  workspaces: { id: string; name: string; role: WorkspaceRole }[]
  projects: { id: string; name: string; archivedAt: Date | null }[]
  project?: { id: string; name: string; archivedAt: Date | null }
}
export function WorkspaceShell({
  children,
  userMenu,
  workspace,
  workspaces,
  projects,
  project,
}: Props) {
  const pathname = usePathname(),
    router = useRouter()
  const [collapsed, setCollapsed] = useState(false),
    [mobile, setMobile] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  const [creating, setCreating] = useState(false),
    [name, setName] = useState("")
  const current = NAV.find(
    (n) => pathname === n.href || pathname.startsWith(n.href + "/")
  )
  async function select(workspaceId: string, projectId?: string) {
    setBusy(true)
    setError("")
    try {
      await workspaceMutation({ action: "select", workspaceId, projectId })
      setMobile(false)
      router.push("/dashboard")
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Selection failed.")
    } finally {
      setBusy(false)
    }
  }
  const navigation = (
    <>
      <Link
        href="/dashboard"
        className="mb-8 flex items-center gap-2 px-2 text-lg font-semibold tracking-tight text-sidebar-foreground"
      >
        <BuildingsIcon className="size-6 text-sidebar-primary" />
        <span className={collapsed ? "md:hidden" : ""}>
          Utilization Reporting
        </span>
      </Link>
      <div className={collapsed ? "md:hidden" : ""}>
        <span className="mb-2 block px-2 text-[10px] font-semibold tracking-widest text-sidebar-foreground/60 uppercase">
          Workspace
        </span>
        <Select
          value={workspace.id}
          onValueChange={(v) => v && void select(v)}
          disabled={busy}
        >
          <SelectTrigger
            className="workspace-selector w-full"
            aria-label="Workspace"
          >
            <SelectValue>{workspace.name}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          className="mt-2 w-full justify-start text-xs text-sidebar-foreground/85 hover:text-sidebar-foreground"
          onClick={() => setCreating(true)}
        >
          <PlusIcon />
          New workspace
        </Button>
        <div className="my-6 h-px bg-slate-700" />
      </div>
      <nav aria-label="Workspace navigation" className="space-y-1">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            onClick={() => setMobile(false)}
            title={collapsed ? label : undefined}
            aria-current={current?.href === href ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-3 text-sm transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              current?.href === href
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/85"
            )}
          >
            <Icon
              aria-hidden
              className="size-5 shrink-0"
              weight={current?.href === href ? "fill" : "regular"}
            />
            <span className={collapsed ? "md:hidden" : ""}>{label}</span>
          </Link>
        ))}
      </nav>
      <div className="mt-auto space-y-5 pt-10">
        {can(workspace.role, "manage") && (
          <Link
            href="/workspace-settings"
            className="flex items-center gap-3 px-3 text-sm text-sidebar-foreground/85"
          >
            <GearIcon className="size-5" />
            <span className={collapsed ? "md:hidden" : ""}>
              Workspace settings
            </span>
          </Link>
        )}
        <div
          className={cn(
            "border-t border-slate-700 pt-5",
            collapsed && "md:hidden"
          )}
        >
          {userMenu}
        </div>
      </div>
    </>
  )
  return (
    <WorkspaceContext.Provider
      value={{
        workspaceId: workspace.id,
        projectId: project?.id,
        projectName: project?.name,
        role: workspace.role,
        archived: !!project?.archivedAt,
      }}
    >
      <div className="flex min-h-svh bg-background">
        <a
          href="#app-content"
          className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-card focus:p-3"
        >
          Skip to content
        </a>
        <aside
          className={cn(
            "sticky top-0 hidden h-svh shrink-0 flex-col overflow-y-auto bg-sidebar p-5 text-sidebar-foreground md:flex",
            collapsed ? "w-20 px-3" : "w-64"
          )}
        >
          {navigation}
        </aside>
        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 flex h-17 items-center justify-between gap-3 border-b bg-card px-4 md:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="hidden md:flex"
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                onClick={() => setCollapsed(!collapsed)}
              >
                <SidebarSimpleIcon />
              </Button>
              <Dialog open={mobile} onOpenChange={setMobile}>
                <DialogTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="md:hidden"
                      aria-label="Open navigation"
                    />
                  }
                >
                  <ListIcon />
                </DialogTrigger>
                <DialogContent className="inset-y-0 left-0 flex h-svh w-72 translate-x-0 translate-y-0 flex-col rounded-none bg-sidebar p-5 text-sidebar-foreground">
                  <DialogTitle className="sr-only">
                    Workspace navigation
                  </DialogTitle>
                  <DialogDescription className="sr-only">
                    Switch workspaces and navigate reporting.
                  </DialogDescription>
                  {navigation}
                </DialogContent>
              </Dialog>
              <div className="truncate text-sm text-muted-foreground">
                {workspace.name}
                <span className="mx-2 text-border">/</span>
                <span className="text-foreground">
                  {current?.label ?? "Workspace settings"}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Select
                value={project?.id ?? "all"}
                onValueChange={(v) =>
                  v && void select(workspace.id, v === "all" ? undefined : v)
                }
                disabled={busy}
              >
                <SelectTrigger
                  aria-label="Customer project"
                  className="w-40 border-input bg-card md:w-52"
                >
                  <SelectValue>{project?.name ?? "All projects"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All projects</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                      {p.archivedAt ? " · Archived" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <ThemeToggle />
            </div>
          </header>
          {error && (
            <p
              role="alert"
              className="m-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <main
            id="app-content"
            className="mx-auto max-w-[1500px] px-4 py-7 md:px-9 md:py-9"
          >
            {project?.archivedAt && (
              <p className="mb-5 rounded-lg border bg-muted p-3 text-sm">
                This project is archived. Its records remain available to read.
              </p>
            )}
            {children}
          </main>
        </div>
      </div>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogTitle>Create workspace</DialogTitle>
          <DialogDescription>
            A separate space for your customer projects and team.
          </DialogDescription>
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              setBusy(true)
              try {
                await workspaceMutation({ action: "create_workspace", name })
                setCreating(false)
                router.push("/projects")
                router.refresh()
              } catch (e) {
                setError(e instanceof Error ? e.message : "Creation failed.")
              } finally {
                setBusy(false)
              }
            }}
            className="space-y-4"
          >
            <label className="text-sm" htmlFor="workspace-name">
              Workspace name
            </label>
            <input
              id="workspace-name"
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border p-2.5"
            />
            <Button disabled={busy} type="submit">
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
    </WorkspaceContext.Provider>
  )
}
