import { cookies } from "next/headers"

import { AppHeader } from "@/components/app-shell/app-header"
import { AppSidebar } from "@/components/app-shell/app-sidebar"
import { UserMenu } from "@/components/app-shell/user-menu"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PendingInvitationResume } from "@/components/workspaces/pending-invitation-resume"
import { WorkspaceProvider } from "@/components/workspaces/workspace-context"
import { isPlatformAdmin } from "@/lib/admin/platform"
import { requireSession } from "@/lib/auth/guard"
import { readAskLevel } from "@/lib/chat/access"
import { loadAttention } from "@/lib/close/attention"
import { loadClose } from "@/lib/close/load"
import { monthName } from "@/lib/close/period"
import { selectedContext } from "@/lib/workspaces/context"
import { can } from "@/lib/workspaces/policy"

/**
 * The authenticated shell (Requirements 7.6, 7.8).
 *
 * ## This layout is the route guard
 *
 * `requireSession()` runs on **every** authenticated render and resolves the session
 * against Postgres — expiry is a column and sign-out is a `DELETE`, so only the row can
 * answer whether a request is still signed in. There is no `proxy.ts` and no
 * `middleware.ts` in this app on purpose: a proxy check sees a cookie rather than a
 * session, and a revoked session still presents a cookie.
 *
 * Called with **no argument**, so an unauthenticated request lands on a clean `/login`
 * with no `returnTo`. It is awaited outside any `try`/`catch`: `redirect` signals by
 * throwing `NEXT_REDIRECT`, and a `catch` in its path would swallow the redirect.
 *
 * ## The composition
 *
 * shadcn's inset sidebar around one lifted page. The close — the open period and each
 * customer's state in it — is loaded here, once, because the rail shows it on every
 * page. `<UserMenu />` is server-rendered and handed down as a node, so the signed-in
 * email and the sign-out Server Function never cross into the rail's client bundle.
 *
 * The sidebar's open state is read from shadcn's own `sidebar_state` cookie, so a
 * collapsed rail renders collapsed on the server and does not flash open.
 */
export default async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const user = await requireSession()

  const [{ workspace, workspaces, project }, jar] = await Promise.all([
    selectedContext(user.id),
    cookies(),
  ])
  const { period, board } = await loadClose(user.id, workspace)
  const [attention, askLevel] = await Promise.all([
    loadAttention(user.id, workspace.id, board),
    readAskLevel(user.id, workspace.id),
  ])
  // Ask is in the navigation only where it is open (roles-and-ask-access Req 6), and the
  // Admin link only for a platform admin (Req 7).
  const askAvailable = askLevel !== "none"
  const platformAdmin = isPlatformAdmin(user.email)

  const customers = board.rows.map((row) => ({
    id: row.project.id,
    name: row.project.name,
    state: row.current.state,
  }))
  // Not tied to the selected customer: with All customers selected, the request page
  // asks which customer the report is for. What it needs is an editor and a customer.
  const canRequest = can(workspace.role, "edit") && board.rows.length > 0

  return (
    <WorkspaceProvider
      scope={{
        workspaceId: workspace.id,
        projectId: project?.id,
        projectName: project?.name,
        role: workspace.role,
        archived: !!project?.archivedAt,
      }}
    >
      <TooltipProvider>
        <SidebarProvider defaultOpen={jar.get("sidebar_state")?.value !== "false"}>
          <a
            href="#app-content"
            className="sr-only rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground outline-none focus-visible:not-sr-only focus-visible:absolute focus-visible:start-4 focus-visible:top-4 focus-visible:z-50"
          >
            Skip to content
          </a>

          <AppSidebar
            workspace={workspace}
            workspaces={workspaces}
            customers={customers}
            selectedCustomerId={project?.id}
            period={period}
            connectorsNeedAttention={attention.some((item) =>
              item.key.startsWith("connector:")
            )}
            askAvailable={askAvailable}
            platformAdmin={platformAdmin}
            userMenu={<UserMenu email={user.email} />}
          />

          <SidebarInset className="min-w-0">
            <AppHeader
              periodLabel={monthName(period.month)}
              scopeLabel={project?.name}
              workspaceId={workspace.id}
              customers={customers}
              canRequest={canRequest}
              askAvailable={askAvailable}
              settingsAvailable={can(workspace.role, "edit")}
            />
            <div
              id="app-content"
              className="mx-auto w-full max-w-[80rem] px-4 py-6 md:px-7 md:py-7"
            >
              {project?.archivedAt && (
                <p className="mb-6 rounded-lg border border-border bg-muted px-3 py-2.5 text-sm">
                  This customer is archived. Its reports remain available to read.
                </p>
              )}
              {children}
            </div>
          </SidebarInset>
        </SidebarProvider>
        <Toaster position="bottom-right" />
        <PendingInvitationResume />
      </TooltipProvider>
    </WorkspaceProvider>
  )
}
