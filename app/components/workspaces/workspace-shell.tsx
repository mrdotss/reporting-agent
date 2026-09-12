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
import { GaugeIcon, PlusIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { ThemeToggle } from "@/components/app-shell/theme-toggle"
import { can, type WorkspaceRole } from "@/lib/workspaces/policy"
import { cn } from "@/lib/utils"

/**
 * The shell, as a file header rather than a rail.
 *
 * ## Why there is no sidebar
 *
 * There was a 256px dark navy rail down the left in both themes. It cost a sixth of
 * the working width on every screen, and it split the app into "rail world" and
 * "content world" — two different grounds, two different token sets, a permanent
 * vertical seam. What it bought was five links.
 *
 * This product issues documents and proves them. A document does not have a rail; it
 * has a **header** — who it belongs to, what it is, where you are in it — and then it
 * has the document. So navigation is two shallow bands on the same paper as the
 * content, separated from it by one hairline:
 *
 *   1. the **register bar** — the mark, where you are, which customer project is in
 *      scope, and the controls that are always available;
 *   2. the **strip** — the five destinations, as a tab row.
 *
 * Five links do not need a drawer, a collapse toggle, or a second mobile rendering.
 * The strip scrolls horizontally under its own overflow at phone width and that is the
 * whole mobile story — which is why `collapsed`, the mobile `Dialog`, and the
 * duplicated `navigation` tree that had to render inside both are all gone.
 *
 * ## The project picker is in the header because it is scope, not navigation
 *
 * Every figure on every screen below is filtered by it. Putting it in the register bar
 * beside the breadcrumb states that: this is which customer's work you are looking at,
 * and it does not change what page you are on.
 */

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

/**
 * The five destinations.
 *
 * Named for what a consultant is looking for, not for the metaphor the rest of this
 * design runs on. An earlier pass labelled these Register · Records · Profiles ·
 * Sources, which is the assay vocabulary applied to navigation — and navigation is the
 * one place it should not be. A tab label is read in a fifth of a second by someone
 * who already knows what they want; it has to name the thing, not evoke it.
 *
 * The metaphor still carries the surfaces it belongs to — the counterfoil, the seal,
 * the stamp, the tally — where a reader is actually looking at a record and the
 * framing does work. Here it only made someone guess which tab held last month's
 * report.
 */
const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/reports", label: "Reports" },
  { href: "/report-profiles", label: "Presets" },
  { href: "/subscriptions", label: "Connectors" },
  { href: "/projects", label: "Projects" },
]

/** The switcher's one non-workspace row. Not a valid workspace id, by construction. */
const NEW_WORKSPACE = "__new_workspace__"

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
  const pathname = usePathname()
  const router = useRouter()

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")

  const current = NAV.find(
    (n) => pathname === n.href || pathname.startsWith(n.href + "/")
  )

  async function select(workspaceId: string, projectId?: string) {
    setBusy(true)
    setError("")
    try {
      await workspaceMutation({ action: "select", workspaceId, projectId })
      router.push("/dashboard")
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Selection failed.")
    } finally {
      setBusy(false)
    }
  }

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
      <div className="flex min-h-svh flex-col bg-background">
        <a
          href="#app-content"
          className="sr-only rounded-sm bg-primary px-3 py-2 text-sm font-medium text-primary-foreground outline-none focus-visible:not-sr-only focus-visible:absolute focus-visible:start-4 focus-visible:top-4 focus-visible:z-50"
        >
          Skip to content
        </a>

        <header className="sticky top-0 z-20 flex flex-col bg-sidebar text-sidebar-foreground">
          {/* Band one: identity, position, scope. */}
          <div className="flex h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-sidebar-border px-4 md:px-6">
            <Link
              href="/dashboard"
              className="flex shrink-0 items-center gap-2 rounded-sm font-heading text-sm font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            >
              {/*
                A gauge, not a seal.

                The mark should say what the product measures, and this one measures how
                much of a provisioned capacity is actually in use — a gauge is the
                instrument that reads exactly that, and it keeps the register bar in the
                same instrument vocabulary as the seal, the stamp and the counterfoil
                further down the page. `duotone` so it reads as a dial face rather than
                a solid blob at 16px.
              */}
              <GaugeIcon
                aria-hidden="true"
                weight="duotone"
                className="size-4 text-primary"
              />
              Utilize Space
            </Link>

            {/*
              The breadcrumb's first segment *is* the workspace, so it is the switcher
              rather than a label beside one. A separate picker would state the same
              fact twice and put the control somewhere other than where the fact is
              already written. With one workspace there is nothing to switch, so it
              renders as plain text and no empty control appears.
            */}
            <span className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
              <Select
                value={workspace.id}
                onValueChange={(v) => {
                  if (!v) return
                  // Creating a workspace belongs in the control you open when you
                  // want a different one — not as a permanent button at the foot of
                  // whatever page you happen to be reading.
                  if (v === NEW_WORKSPACE) setCreating(true)
                  else void select(v)
                }}
                disabled={busy}
              >
                <SelectTrigger
                  aria-label="Workspace"
                  className="h-7 w-auto min-w-0 gap-1.5 border-transparent bg-transparent px-1.5 text-meta hover:bg-accent"
                >
                  <SelectValue>{workspace.name}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_WORKSPACE}>
                    <PlusIcon aria-hidden="true" />
                    New workspace
                  </SelectItem>
                </SelectContent>
              </Select>

              <span aria-hidden="true" className="text-border">
                /
              </span>
              <span className="truncate text-foreground">
                {current?.label ?? "Settings"}
              </span>
            </span>

            <span className="ml-auto flex items-center gap-2">
              <Select
                value={project?.id ?? "all"}
                onValueChange={(v) =>
                  v && void select(workspace.id, v === "all" ? undefined : v)
                }
                disabled={busy}
              >
                <SelectTrigger
                  aria-label="Customer project"
                  className="workspace-selector h-7 w-36 text-meta md:w-52"
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
              {userMenu}
            </span>
          </div>

          {/* Band two: the strip. Scrolls rather than collapsing. */}
          {/*
            `overflow-y-hidden` is load-bearing, not belt-and-braces.

            CSS computes an axis from `visible` to `auto` the moment the *other* axis
            is anything else, so `overflow-x-auto` alone silently made this
            `overflow-y: auto` too. The tab links carry `-mb-px` to sit their active
            border on the strip's own, which puts the content one pixel taller than the
            box — and one pixel of vertical overflow is enough for a full scrollbar,
            arrows and all, parked at the right of the strip.
          */}
          <nav
            aria-label="Sections"
            className="flex overflow-x-auto overflow-y-hidden border-b border-border px-2 md:px-4"
          >
            {NAV.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                aria-current={current?.href === href ? "page" : undefined}
                className={cn(
                  "-mb-px shrink-0 border-b-2 px-3 py-2 text-meta whitespace-nowrap outline-none transition-colors",
                  "focus-visible:ring-3 focus-visible:ring-ring/30",
                  current?.href === href
                    ? "border-primary font-semibold text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </Link>
            ))}

            {can(workspace.role, "manage") && (
              <Link
                href="/workspace-settings"
                aria-current={
                  pathname.startsWith("/workspace-settings") ? "page" : undefined
                }
                className={cn(
                  "-mb-px ml-auto shrink-0 border-b-2 px-3 py-2 text-meta whitespace-nowrap outline-none transition-colors",
                  "focus-visible:ring-3 focus-visible:ring-ring/30",
                  pathname.startsWith("/workspace-settings")
                    ? "border-primary font-semibold text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                Settings
              </Link>
            )}
          </nav>
        </header>

        {error && (
          <p
            role="alert"
            className="mx-4 mt-4 rounded-sm border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive md:mx-6"
          >
            {error}
          </p>
        )}

        <main
          id="app-content"
          className="mx-auto w-full max-w-[92rem] px-4 py-8 md:px-6 md:py-10"
        >
          {project?.archivedAt && (
            <p className="mb-6 rounded-sm border border-border bg-muted px-3 py-2.5 text-sm">
              This project is archived. Its records remain available to read.
            </p>
          )}
          {children}
        </main>

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
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-1.5">
              <label
                className="text-sm font-medium"
                htmlFor="workspace-name"
              >
                Workspace name
              </label>
              <Input
                id="workspace-name"
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
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
    </WorkspaceContext.Provider>
  )
}
