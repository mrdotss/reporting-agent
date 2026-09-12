"use client"
import { PageBody } from "@/components/app-shell/page-body"
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
    <PageBody kind="wide" className="gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-micro text-muted-foreground uppercase">
            Customer work
          </p>
          <h1 className="text-title">Projects</h1>
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
      {/*
        A list, not a three-across grid of cards.
        One project in a 3-column grid is one card and two empty columns, and that is
        the ordinary case here — a consultant has a handful of customers, not thirty.
        A row reads correctly at one project and at forty, and the counts line up down
        a column instead of being three separate figures inside three separate boxes.
      */}
      <ul className="flex flex-col divide-y divide-border border-y border-border">
        {projects.map((p) => (
          <li key={p.id}>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-4 py-5">
              <div className="flex min-w-0 flex-1 items-start gap-3.5">
                <div className="rounded-lg bg-primary/10 p-2.5 text-primary">
                  <FolderIcon className="size-5" />
                </div>

                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold">{p.name}</h2>
                    {p.archivedAt && (
                      <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        Archived
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {p.description || "Customer reporting project"}
                  </p>
                </div>
              </div>

              <dl className="flex shrink-0 gap-7">
                {[
                  ["Connections", p.connections],
                  ["Profiles", p.profiles],
                  ["Reports", p.reports],
                ].map(([label, value]) => (
                  <div key={label} className="flex flex-col">
                    <dd className="text-figure-sm font-mono tabular-nums">
                      {value}
                    </dd>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                  </div>
                ))}
              </dl>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
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
            </div>
          </li>
        ))}
      </ul>
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
    </PageBody>
  )
}
