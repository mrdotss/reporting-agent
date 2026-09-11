import { notFound } from "next/navigation"
import { requireSession } from "@/lib/auth/guard"
import { selectedContext, workspaceUiEnabled } from "@/lib/workspaces/context"
import { teamDetails } from "@/lib/workspaces/store"
import { can } from "@/lib/workspaces/policy"
import { TeamManager } from "@/components/workspaces/team-manager"
export default async function SettingsPage(){const user=await requireSession();if(!workspaceUiEnabled())notFound();const {workspace}=await selectedContext(user.id);if(!can(workspace.role,"manage"))notFound();const data=await teamDetails(user.id,workspace.id);return <TeamManager {...data} userId={user.id} nowIso={new Date().toISOString()}/>}
