import { notFound } from "next/navigation"

import { TeamManager } from "@/components/workspaces/team-manager"
import { requireSession } from "@/lib/auth/guard"
import { selectedContext } from "@/lib/workspaces/context"
import { can } from "@/lib/workspaces/policy"
import { teamDetails } from "@/lib/workspaces/store"

export default async function SettingsPage() {
  const user = await requireSession()
  const { workspace } = await selectedContext(user.id)
  if (!can(workspace.role, "manage")) notFound()
  const data = await teamDetails(user.id, workspace.id)
  return (
    <TeamManager {...data} userId={user.id} nowIso={new Date().toISOString()} />
  )
}
