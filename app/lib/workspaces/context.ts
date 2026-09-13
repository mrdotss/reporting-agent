import "server-only"
import { cookies } from "next/headers"
import {
  requireProject,
  requireWorkspace,
  type ProjectScope,
  WorkspaceAccessError,
} from "./access"
import { listProjects, listWorkspaces } from "./store"

export async function selectedContext(userId: string) {
  const workspaces = await listWorkspaces(userId)
  const jar = await cookies()
  const workspace =
    workspaces.find((w) => w.id === jar.get("report-workspace")?.value) ??
    workspaces[0]
  if (!workspace) throw new WorkspaceAccessError()
  const projects = await listProjects(userId, workspace.id)
  const selected = jar.get("report-project")?.value
  const project =
    selected === "all"
      ? undefined
      : (projects.find((p) => p.id === selected) ??
        projects.find((p) => !p.archivedAt))
  return { workspace, workspaces, projects, project }
}
export async function selectedFilter(
  userId: string
): Promise<Partial<ProjectScope>> {
  const c = await selectedContext(userId)
  return { workspaceId: c.workspace.id, projectId: c.project?.id }
}
/**
 * The scope a new preset, connector or run is created in.
 *
 * The shell passes one from every page. A caller with no scope — the starter presets
 * seeded at registration, before anyone has picked a customer — lands in the user's own
 * imported workspace, and still has to pass `requireProject` there.
 */
export async function creationScope(
  userId: string,
  input: Partial<ProjectScope>,
  permission: "edit" | "connect"
) {
  if (!input.workspaceId || !input.projectId) {
    const personal = {
      workspaceId: `imported-${userId}`,
      projectId: `imported-project-${userId}`,
    }
    await requireProject(userId, personal, permission)
    return personal
  }
  const scope = { workspaceId: input.workspaceId, projectId: input.projectId }
  await requireProject(userId, scope, permission)
  return scope
}
export async function selectContext(
  userId: string,
  workspaceId: string,
  projectId?: string
) {
  await requireWorkspace(userId, workspaceId)
  if (projectId) await requireProject(userId, { workspaceId, projectId })
  const jar = await cookies()
  const options = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  }
  jar.set("report-workspace", workspaceId, options)
  jar.set("report-project", projectId ?? "all", options)
}
