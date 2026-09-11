import { z } from "zod"
export const scopeInput = {
  workspaceId: z.string().min(1).max(200).optional(),
  projectId: z.string().min(1).max(200).optional(),
}
export const workspaceActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create_workspace"),
      name: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      action: z.literal("select"),
      workspaceId: z.string().min(1).max(200),
      projectId: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("project"),
      workspaceId: z.string().min(1).max(200),
      id: z.string().max(200).optional(),
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(1000).optional(),
      archived: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("invite"),
      workspaceId: z.string().min(1).max(200),
      role: z.enum(["admin", "editor", "viewer"]),
    })
    .strict(),
  z
    .object({ action: z.literal("accept"), token: z.string().length(43) })
    .strict(),
  z
    .object({
      action: z.literal("revoke"),
      workspaceId: z.string().min(1).max(200),
      id: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal("member"),
      workspaceId: z.string().min(1).max(200),
      userId: z.string().min(1).max(200),
      role: z.enum(["admin", "editor", "viewer"]).nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal("transfer"),
      workspaceId: z.string().min(1).max(200),
      userId: z.string().min(1).max(200),
    })
    .strict(),
])

/** Host reflects the browser-facing authority; Next's internal request URL may use localhost. */
export function permitsWorkspaceOrigin(origin: string | null, host: string | null, fetchSite: string | null): boolean {
  if (fetchSite === "cross-site") return false
  if (!origin) return fetchSite === null || fetchSite === "same-origin" || fetchSite === "none"
  if (!host) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.origin === origin && parsed.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}
