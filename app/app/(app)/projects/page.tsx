import { redirect } from "next/navigation"

/**
 * `/projects` → the Customers tab of Workspace.
 *
 * Projects are customers in the interface now, and they are managed beside the team
 * that works on them. The route stays so a bookmark still lands somewhere useful.
 */
export default function ProjectsPage(): never {
  redirect("/workspace-settings?tab=customers")
}
