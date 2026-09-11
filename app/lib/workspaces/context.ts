import "server-only"
import { cookies } from "next/headers"
import {
  requireProject,
  requireWorkspace,
  type ProjectScope,
  WorkspaceAccessError,
} from "./access"
import { listProjects, listWorkspaces } from "./store"

/** Rollout controls presentation only. Scoped authorization is always active. */
export function workspaceUiEnabled() {
  return process.env.REPORT_WORKSPACE_UI === "1"
}
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
): Promise<Partial<ProjectScope> | undefined> {
  if (!workspaceUiEnabled()) return undefined
  const c = await selectedContext(userId)
  return { workspaceId: c.workspace.id, projectId: c.project?.id }
}
export async function creationScope(
  userId: string,
  input: Partial<ProjectScope>,
  permission: "edit" | "connect"
) {
  if (!input.workspaceId || !input.projectId) {
    if (workspaceUiEnabled()) throw new WorkspaceAccessError()
    const scope = {
      workspaceId: `imported-${userId}`,
      projectId: `imported-project-${userId}`,
    }
    await requireProject(userId, scope, permission)
    return scope
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
