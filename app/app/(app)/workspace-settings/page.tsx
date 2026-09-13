import Link from "next/link"
import { notFound } from "next/navigation"

import { CloseDayForm } from "@/components/workspaces/close-day-form"
import { ProjectManager } from "@/components/workspaces/project-manager"
import { TeamManager } from "@/components/workspaces/team-manager"
import { requireSession } from "@/lib/auth/guard"
import { getPool } from "@/lib/db"
import { selectedContext } from "@/lib/workspaces/context"
import { can } from "@/lib/workspaces/policy"
import { teamDetails } from "@/lib/workspaces/store"
import { cn } from "@/lib/utils"

/**
 * `/workspace-settings` — the workspace's customers, its team, and its close.
 *
 * The tab is in the URL (`?tab=`), not in client state: each tab reads different rows on
 * the server, a link can land on one, and the sidebar's "New workspace" flow sends a
 * consultant straight to Customers.
 */

const TABS = [
  { key: "customers", label: "Customers" },
  { key: "members", label: "Members" },
  { key: "close", label: "Close" },
] as const

type TabKey = (typeof TABS)[number]["key"]

function readTab(raw: string | string[] | undefined): TabKey {
  return TABS.some((tab) => tab.key === raw) ? (raw as TabKey) : "customers"
}

export default async function SettingsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>
}>) {
  const user = await requireSession()
  const { workspace } = await selectedContext(user.id)
  if (!can(workspace.role, "manage")) notFound()

  const tab = readTab((await searchParams).tab)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <p className="text-micro text-muted-foreground uppercase">Workspace</p>
        <h1 className="text-title">{workspace.name}</h1>
      </header>

      <nav aria-label="Workspace sections">
        <ul className="inline-flex gap-0.5 rounded-[9px] bg-muted p-[3px]">
          {TABS.map(({ key, label }) => (
            <li key={key}>
              <Link
                href={`/workspace-settings?tab=${key}`}
                aria-current={tab === key ? "page" : undefined}
                className={cn(
                  "inline-flex h-7.5 items-center rounded-md px-3 text-meta font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/30",
                  tab === key
                    ? "bg-card text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.05)]"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {tab === "customers" ? (
        <Customers userId={user.id} workspaceId={workspace.id} />
      ) : tab === "members" ? (
        <Members userId={user.id} workspaceId={workspace.id} />
      ) : (
        <section
          aria-labelledby="close-title"
          className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5"
        >
          <div className="flex flex-col gap-0.5">
            <h2 id="close-title" className="text-section">
              Close
            </h2>
            <p className="text-meta text-muted-foreground">
              When each period&apos;s reports are due, for every customer in this
              workspace.
            </p>
          </div>
          <CloseDayForm workspaceId={workspace.id} closeDay={workspace.closeDay} />
        </section>
      )}
    </div>
  )
}

async function Customers({
  userId,
  workspaceId,
}: Readonly<{ userId: string; workspaceId: string }>) {
  const { rows } = await getPool().query(
    `select p.id, p.name, p.description, p.archived_at as "archivedAt",
            (select count(*)::int from connected_subscriptions c where c.project_id = p.id) connections,
            (select count(*)::int from report_templates t where t.project_id = p.id) profiles,
            (select count(*)::int from report_runs r where r.project_id = p.id) reports
       from projects p
       join workspace_members m on m.workspace_id = p.workspace_id
      where p.workspace_id = $1 and m.user_id = $2
      order by p.created_at`,
    [workspaceId, userId]
  )
  return <ProjectManager projects={rows} />
}

async function Members({
  userId,
  workspaceId,
}: Readonly<{ userId: string; workspaceId: string }>) {
  const data = await teamDetails(userId, workspaceId)
  return <TeamManager {...data} userId={userId} nowIso={new Date().toISOString()} />
}
