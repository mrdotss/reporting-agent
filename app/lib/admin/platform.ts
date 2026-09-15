import "server-only"

import type { AdminAccountView } from "@/lib/admin/views"
import { getPool } from "@/lib/db"
import { normalizeEmail } from "@/lib/validation/email"
import { WorkspaceAccessError } from "@/lib/workspaces/access"
import type { WorkspaceRole } from "@/lib/workspaces/policy"

/**
 * The platform admin: who administers Ask, and the grants they make
 * (roles-and-ask-access Req 6, 7).
 *
 * ## Who is an admin
 *
 * The accounts named in `RPT_PLATFORM_ADMIN_EMAILS`, comma-separated, compared in
 * normalized form. Read from the environment at call time, like every other setting in
 * `lib/env.ts`, and optional: unset, there is no admin, no workspace is an Ask home and no
 * grant can be made — Ask is off for everyone rather than open to anyone.
 *
 * Configuration rather than a column, so becoming an admin is a deployment change and
 * never a row somebody with database-backed powers could write for somebody else.
 */

export const PLATFORM_ADMIN_EMAILS_VAR = "RPT_PLATFORM_ADMIN_EMAILS"

export function platformAdminEmails(): string[] {
  const raw = process.env[PLATFORM_ADMIN_EMAILS_VAR] ?? ""
  return [
    ...new Set(
      raw
        .split(",")
        .map(normalizeEmail)
        .filter((email) => email.length > 0)
    ),
  ]
}

export function isPlatformAdmin(email: string): boolean {
  return platformAdminEmails().includes(normalizeEmail(email))
}

/** Enough for the accounts this deployment has; the page says when the list is cut. */
export const ACCOUNT_LIST_LIMIT = 500

export async function listAccounts(): Promise<AdminAccountView[]> {
  const admins = platformAdminEmails()
  const { rows } = await getPool().query<{
    userId: string
    email: string
    joinedAt: Date
    ownedWorkspaces: number
    homeRole: WorkspaceRole | null
    grantedAt: Date | null
    admin: boolean
  }>(
    `select u.id as "userId",
            u.email,
            u.created_at as "joinedAt",
            (select count(*)::int from workspace_members o
              where o.user_id = u.id and o.role = 'owner') as "ownedWorkspaces",
            (select m.role::text from workspace_members m
              where m.user_id = u.id
                and exists (select 1 from workspace_members h join users a on a.id = h.user_id
                             where h.workspace_id = m.workspace_id and h.role = 'owner'
                               and a.email_normalized = any($1::text[]))
              order by array_position(array['owner','admin','editor','viewer'], m.role::text)
              limit 1) as "homeRole",
            g.granted_at as "grantedAt",
            u.email_normalized = any($1::text[]) as "admin"
       from users u
       left join ask_access g on g.user_id = u.id
      order by u.created_at desc
      limit $2`,
    [admins, ACCOUNT_LIST_LIMIT]
  )
  return rows.map((row) => ({
    ...row,
    joinedAt: row.joinedAt.toISOString(),
    grantedAt: row.grantedAt === null ? null : row.grantedAt.toISOString(),
  }))
}

/**
 * Grant or remove Ask for an account (roles-and-ask-access Req 7.3).
 *
 * Only a platform admin may, and not for another platform admin, whose Ask comes from
 * being one. Granting an account that already holds a grant keeps the original. Returns
 * when Ask was granted, or `null` once it is removed.
 */
export async function setAskAccess(
  input: Readonly<{
    admin: Readonly<{ id: string; email: string }>
    userId: string
    enabled: boolean
  }>
): Promise<string | null> {
  const admins = platformAdminEmails()
  if (!admins.includes(normalizeEmail(input.admin.email))) throw new WorkspaceAccessError()

  const target = await getPool().query<{ email_normalized: string }>(
    "select email_normalized from users where id = $1",
    [input.userId]
  )
  const email = target.rows[0]?.email_normalized
  if (email === undefined || admins.includes(email)) throw new WorkspaceAccessError()

  if (!input.enabled) {
    await getPool().query("delete from ask_access where user_id = $1", [input.userId])
    return null
  }

  const granted = await getPool().query<{ granted_at: Date }>(
    `insert into ask_access (user_id, granted_by) values ($1, $2)
     on conflict (user_id) do update set user_id = excluded.user_id
     returning granted_at`,
    [input.userId, input.admin.id]
  )
  const row = granted.rows[0]
  if (row === undefined) throw new Error("[admin] the Ask grant was not recorded")
  return row.granted_at.toISOString()
}
