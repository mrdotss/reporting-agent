"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  FolderIcon,
  PlusIcon,
  ArrowRightIcon,
  ArchiveIcon,
} from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { can } from "@/lib/workspaces/policy"
import { useWorkspace, workspaceMutation } from "./workspace-shell"
type Project = {
  id: string
  name: string
  description: string
  archivedAt: Date | null
  connections: number
  profiles: number
  reports: number
}
export function ProjectManager({ projects }: { projects: Project[] }) {
  const workspace = useWorkspace(),
    router = useRouter()
  const [editing, setEditing] = useState<Project | null | undefined>(undefined),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  if (!workspace) return null
  const manage = can(workspace.role, "manage")
  async function action(body: Record<string, unknown>) {
    setBusy(true)
    setError("")
    try {
      await workspaceMutation({ ...body, workspaceId: workspace!.workspaceId })
      setEditing(undefined)
      router.refresh()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : "The change failed.")
      return false
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-medium tracking-widest text-muted-foreground uppercase">
            Customer work
          </p>
          <h1>Projects</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Keep each customer’s connections, profiles, and reports together.
          </p>
        </div>
        {manage && (
          <Button
            onClick={() => {
              setEditing(null)
              setName("")
              setDescription("")
            }}
          >
            <PlusIcon />
            New project
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
        {projects.map((p) => (
          <Card key={p.id}>
            <CardContent className="space-y-5 pt-6">
              <div className="flex items-start justify-between gap-3">
                <div className="rounded-lg bg-primary/10 p-3 text-primary">
                  <FolderIcon className="size-6" />
                </div>
                {p.archivedAt && (
                  <span className="rounded-md bg-muted px-2 py-1 text-xs">
                    Archived
                  </span>
                )}
              </div>
              <div>
                <h2 className="text-lg font-semibold">{p.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {p.description || "Customer reporting project"}
                </p>
              </div>
              <dl className="grid grid-cols-3 gap-3 border-y py-4">
                {[
                  ["Connections", p.connections],
                  ["Profiles", p.profiles],
                  ["Reports", p.reports],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dd className="font-mono text-xl tabular-nums">{value}</dd>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                  </div>
                ))}
              </dl>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={async () => {
                    if (await action({ action: "select", projectId: p.id }))
                      router.push("/dashboard")
                  }}
                >
                  Open project
                  <ArrowRightIcon />
                </Button>
                {manage && (
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing(p)
                        setName(p.name)
                        setDescription(p.description)
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void action({
                          action: "project",
                          id: p.id,
                          archived: !p.archivedAt,
                        })
                      }
                    >
                      <ArchiveIcon />
                      {p.archivedAt ? "Restore" : "Archive"}
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {projects.length === 0 && (
        <Card>
          <CardContent className="py-10">
            <h2>Create your first customer project.</h2>
            <p className="mt-2 text-muted-foreground">
              Then connect a subscription and configure a report profile.
            </p>
          </CardContent>
        </Card>
      )}
      <Dialog
        open={editing !== undefined}
        onOpenChange={(open) => !open && setEditing(undefined)}
      >
        <DialogContent>
          <DialogTitle>
            {editing ? "Edit project" : "New customer project"}
          </DialogTitle>
          <DialogDescription>
            Everyone in this workspace can see this project, according to their
            role.
          </DialogDescription>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              void action({
                action: "project",
                id: editing?.id,
                name,
                description,
              })
            }}
          >
            <label htmlFor="project-name" className="text-sm font-medium">
              Project name
            </label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
            />
            <label
              htmlFor="project-description"
              className="text-sm font-medium"
            >
              Description
            </label>
            <Input
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
            />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save project"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
