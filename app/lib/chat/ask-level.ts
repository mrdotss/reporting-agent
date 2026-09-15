import type { WorkspaceRole } from "@/lib/workspaces/policy"

/**
 * What a member may do with Ask in one workspace (roles-and-ask-access Req 6).
 *
 * Pure and deliberately not `server-only`: this is the product's rule, and nothing that
 * shows or hides Ask should re-derive it. `lib/chat/access.ts` reads the three facts from
 * Postgres and asks here.
 *
 * Ask is an account grant, not a role:
 *
 * - **Ask home** — a workspace owned by a platform admin. Its members use Ask by role:
 *   Owner, Admin and Editor chat, a Viewer reads the history. A member the admin has
 *   granted Ask to has moved to their own, and no longer sees this one.
 * - **Granted owner** — an account holding a grant uses Ask in the workspaces it owns. The
 *   people it invites do not get it.
 * - **Everyone else** — none. The page is not found and Ask is not in the navigation.
 */
export type AskLevel = "chat" | "read" | "none"

export function askLevel({
  role,
  granted,
  adminHome,
}: Readonly<{
  /** The member's role in this workspace, or `null` for someone who is not a member. */
  role: WorkspaceRole | null
  /** Whether a platform admin has granted this account Ask. */
  granted: boolean
  /** Whether this workspace's owner is a platform admin. */
  adminHome: boolean
}>): AskLevel {
  if (role === null) return "none"
  if (granted && role === "owner") return "chat"
  if (adminHome && !granted) return role === "viewer" ? "read" : "chat"
  return "none"
}

/** Whether `level` allows `need`: chatting includes reading, reading is not chatting. */
export function askAllows(level: AskLevel, need: Exclude<AskLevel, "none">): boolean {
  return need === "read" ? level !== "none" : level === "chat"
}
