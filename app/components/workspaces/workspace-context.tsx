"use client"

import { createContext, useContext, useMemo } from "react"

import type { WorkspaceRole } from "@/lib/workspaces/policy"

/**
 * Which workspace and customer the pages below the shell are scoped to.
 *
 * Provided once by the layout. Client components that create something — a preset, a
 * connector, a run — read the creation scope from here rather than each re-deriving it
 * from cookies.
 */
export type Scope = {
  workspaceId: string
  projectId?: string
  role: WorkspaceRole
  projectName?: string
  archived: boolean
}

export const WorkspaceContext = createContext<Scope | null>(null)

export function WorkspaceProvider({
  scope,
  children,
}: Readonly<{ scope: Scope; children: React.ReactNode }>) {
  return <WorkspaceContext.Provider value={scope}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace() {
  return useContext(WorkspaceContext)
}

export function useCreationScope() {
  const context = useWorkspace()
  const workspaceId = context?.workspaceId
  const projectId = context?.projectId
  return useMemo(
    () => (workspaceId ? { workspaceId, projectId } : {}),
    [workspaceId, projectId]
  )
}

export async function workspaceMutation(body: unknown) {
  const response = await fetch("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok)
    throw new Error(result.error?.message ?? "The change could not be saved.")
  return result
}
