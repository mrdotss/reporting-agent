/** Shared by server authorization and UI affordances. UI checks never replace SQL checks. */
export const ROLES = ["owner", "admin", "editor", "viewer"] as const
export type WorkspaceRole = (typeof ROLES)[number]
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
export function canManageMember(
  actor: WorkspaceRole,
  target: WorkspaceRole,
  next?: WorkspaceRole
): boolean {
  if (target === "owner" || next === "owner") return false
  return (
    actor === "owner" ||
    (actor === "admin" && target !== "admin" && next !== "admin")
  )
}
