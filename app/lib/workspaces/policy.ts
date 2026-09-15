/** Shared by server authorization and UI affordances. UI checks never replace SQL checks. */
export const ROLES = ["owner", "admin", "editor", "viewer"] as const
export type WorkspaceRole = (typeof ROLES)[number]

/**
 * What a role may do inside its workspace (roles-and-ask-access Req 1). Every account owns
 * its own workspace, so these apply per workspace, never across them.
 *
 * - `read` — every member: dashboard, reports, presets, connectors.
 * - `edit` — presets, report requests and customers.
 * - `connect` — adding, rotating, disabling and scanning connectors.
 * - `manage` — seeing the Members and Close settings; only `own` changes them.
 * - `own` — inviting and changing members, the close day, transferring ownership.
 */
export type Permission = "read" | "edit" | "connect" | "manage" | "own"
export const PERMISSION_ROLES: Record<Permission, readonly WorkspaceRole[]> = {
  read: ROLES,
  edit: ["owner", "admin", "editor"],
  connect: ["owner", "admin"],
  manage: ["owner", "admin"],
  own: ["owner"],
}
export function can(role: WorkspaceRole, permission: Permission): boolean {
  return PERMISSION_ROLES[permission].includes(role)
}

/**
 * Whether `actor` may change a member or an invitation whose role is `target`, optionally
 * to `next` (roles-and-ask-access Req 2).
 *
 * Only the owner changes the team. Nobody becomes or stops being the owner here — that is
 * the ownership transfer, which demotes the old owner to admin in the same statement.
 */
export function canManageMember(
  actor: WorkspaceRole,
  target: WorkspaceRole,
  next?: WorkspaceRole
): boolean {
  return actor === "owner" && target !== "owner" && next !== "owner"
}
