import "server-only"

import { platformAdminEmails } from "@/lib/admin/platform"
import { askAllows, askLevel, type AskLevel } from "@/lib/chat/ask-level"
import { getPool } from "@/lib/db"
import { WorkspaceAccessError } from "@/lib/workspaces/access"
import type { WorkspaceRole } from "@/lib/workspaces/policy"

/**
 * Who may use Ask in a workspace, decided in Postgres (roles-and-ask-access Req 6).
 *
 * One statement reads the three facts {@link askLevel} decides from: the caller's role in
 * the workspace, whether a platform admin has granted the caller Ask, and whether the
 * workspace's owner is a platform admin. The navigation, the page, the chat store and every
 * chat route ask here, so none of them can show a conversation another would refuse.
 */

export async function readAskLevel(userId: string, workspaceId: string): Promise<AskLevel> {
  const admins = platformAdminEmails()
  // No platform admin, no Ask — for everyone, including accounts granted while there was
  // one (roles-and-ask-access Req 6.4). Removing the setting is the off switch.
  if (admins.length === 0) return "none"

  const { rows } = await getPool().query<{
    role: WorkspaceRole
    granted: boolean
    admin_home: boolean
  }>(
    `select m.role::text as role,
            exists (select 1 from ask_access a where a.user_id = m.user_id) as granted,
            exists (select 1 from workspace_members o join users u on u.id = o.user_id
                     where o.workspace_id = m.workspace_id and o.role = 'owner'
                       and u.email_normalized = any($3::text[])) as admin_home
       from workspace_members m
      where m.workspace_id = $1 and m.user_id = $2`,
    [workspaceId, userId, admins]
  )
  const row = rows[0]
  return askLevel({
    role: row?.role ?? null,
    granted: row?.granted ?? false,
    adminHome: row?.admin_home ?? false,
  })
}

/** The caller's level, or a {@link WorkspaceAccessError} when it does not allow `need`. */
export async function requireAskLevel(
  userId: string,
  workspaceId: string,
  need: Exclude<AskLevel, "none">
): Promise<AskLevel> {
  const level = await readAskLevel(userId, workspaceId)
  if (!askAllows(level, need)) throw new WorkspaceAccessError()
  return level
}
