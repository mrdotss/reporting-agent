import type { WorkspaceRole } from "@/lib/workspaces/policy"

/**
 * One account as the admin page lists it (roles-and-ask-access Req 7).
 *
 * Pure, so the client list can name it: `lib/admin/platform.ts`, which builds it, is
 * `server-only`. Every field is meant for the platform admin's eyes and no one else's — the
 * page that renders it is not found for anyone else.
 */
export type AdminAccountView = Readonly<{
  userId: string
  email: string
  /** ISO 8601. */
  joinedAt: string
  ownedWorkspaces: number
  /** The account's highest role in a platform admin's workspaces, or null if in none. */
  homeRole: WorkspaceRole | null
  /** ISO 8601 when Ask was granted, or null. */
  grantedAt: string | null
  /** A platform admin has Ask by being one, so the page offers no switch for them. */
  admin: boolean
}>
