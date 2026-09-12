"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { canManageMember, type WorkspaceRole } from "@/lib/workspaces/policy"
import { useWorkspace, workspaceMutation } from "./workspace-shell"
type Member = { userId: string; email: string; role: WorkspaceRole }
type Invite = {
  id: string
  role: WorkspaceRole
  expiresAt: Date
  acceptedAt: Date | null
  revokedAt: Date | null
}
export function TeamManager({
  members,
  invitations,
  userId,
  nowIso,
}: {
  members: Member[]
  invitations: Invite[]
  userId: string
  nowIso: string
}) {
  const workspace = useWorkspace(),
    router = useRouter()
  const [role, setRole] = useState<"admin" | "editor" | "viewer">("editor"),
    [link, setLink] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<Member | null>(null)
  if (!workspace) return null
  async function action(body: Record<string, unknown>) {
    setBusy(true)
    setError("")
    try {
      const r = await workspaceMutation({
        ...body,
        workspaceId: workspace!.workspaceId,
      })
      if (r.token) setLink(`${location.origin}/invitations/accept#${r.token}`)
      setConfirm(null)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.")
    } finally {
      setBusy(false)
    }
  }
  /** Invitations that still need something. An accepted one is a member, listed above. */
  const open = invitations.filter((invitation) => invitation.acceptedAt === null)

  return (
    <div className="space-y-7">
      <div>
        <p className="mb-2 text-xs tracking-widest text-muted-foreground uppercase">
          Workspace settings
        </p>
        <h1>Your team, one reporting workspace.</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Roles apply across every customer project in{" "}
          {workspace.workspaceId ? "this workspace" : "your workspace"}.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardContent className="pt-6">
            <h2 className="mb-4 text-lg font-semibold">Members</h2>
            {members.map((m) => (
              <div
                key={m.userId}
                className="flex flex-wrap items-center justify-between gap-3 border-t py-4"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium break-all">
                    {m.email}
                    {m.userId === userId ? " · You" : ""}
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {m.role}
                  </p>
                </div>
                {m.userId !== userId &&
                  canManageMember(workspace.role, m.role) && (
                    <div className="flex items-center gap-2">
                      <Select
                        value={m.role}
                        onValueChange={(v) =>
                          v &&
                          void action({
                            action: "member",
                            userId: m.userId,
                            role: v,
                          })
                        }
                        disabled={busy}
                      >
                        <SelectTrigger aria-label={`Role for ${m.email}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(workspace.role === "owner"
                            ? ["admin", "editor", "viewer"]
                            : ["editor", "viewer"]
                          ).map((r) => (
                            <SelectItem value={r} key={r}>
                              {r}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void action({
                            action: "member",
                            userId: m.userId,
                            role: null,
                          })
                        }
                      >
                        Remove
                      </Button>
                      {workspace.role === "owner" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirm(m)}
                        >
                          Make owner
                        </Button>
                      )}
                    </div>
                  )}
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-4 pt-6">
            <h2 className="text-lg font-semibold">Invite a teammate</h2>
            <p className="text-sm text-muted-foreground">
              Anyone with this link can join after signing in. Share it only
              with the intended teammate. It can be used once and expires in
              seven days.
            </p>
            <label className="text-sm font-medium" htmlFor="invite-role">
              Access level
            </label>
            <Select value={role} onValueChange={(v) => v && setRole(v)}>
              <SelectTrigger id="invite-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {workspace.role === "owner" && (
                  <SelectItem value="admin">Admin</SelectItem>
                )}
                <SelectItem value="editor">Editor</SelectItem>
                <SelectItem value="viewer">Viewer</SelectItem>
              </SelectContent>
            </Select>
            <Button
              disabled={busy}
              onClick={() => void action({ action: "invite", role })}
            >
              Create invitation link
            </Button>
            {link && (
              <div className="rounded-lg border bg-muted p-3">
                <label htmlFor="invite-link" className="text-xs">
                  Invitation link — copy before leaving
                </label>
                <input
                  id="invite-link"
                  readOnly
                  value={link}
                  className="my-2 w-full rounded-md border bg-card p-2 text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(link)
                    } catch {
                      setError("Select the link and copy it manually.")
                    }
                  }}
                >
                  Copy link
                </Button>
              </div>
            )}
            <div className="border-t pt-4 text-xs text-muted-foreground">
              <p>
                <strong>Admin:</strong> manages connections, projects, and team.
              </p>
              <p className="mt-2">
                <strong>Editor:</strong> edits profiles and requests reports.
              </p>
              <p className="mt-2">
                <strong>Viewer:</strong> reads and downloads reports.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardContent className="pt-6">
          <h2 className="mb-1 text-lg font-semibold">Invitations</h2>

          {/*
            Accepted invitations are not listed here.
            An accepted invitation *is* a member, and the members list above already
            says so — with their email, their role and the controls to change it. This
            card was repeating that with less detail: "Viewer · Accepted", for somebody
            named in full two inches higher.

            What belongs here is an invitation that still needs something: one waiting to
            be accepted, or one that ran out.
          */}
          <p className="mb-4 text-xs text-muted-foreground">
            Accepted invitations appear as members above.
          </p>

          {open.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {invitations.length === 0
                ? "No invitations yet."
                : "Nothing waiting — every invitation has been accepted."}
            </p>
          ) : (
            open.map((i) => {
              const status = i.revokedAt
                ? "Revoked"
                : new Date(i.expiresAt) <= new Date(nowIso)
                  ? "Expired"
                  : "Pending"
              return (
                <div
                  key={i.id}
                  className="flex justify-between gap-4 border-t py-3 text-sm"
                >
                  <span className="capitalize">
                    {i.role}{" "}
                    <span className="ml-2 text-muted-foreground">{status}</span>
                  </span>
                  {status === "Pending" &&
                    canManageMember(workspace.role, i.role) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void action({ action: "revoke", id: i.id })
                        }
                      >
                        Revoke
                      </Button>
                    )}
                </div>
              )
            })
          )}
        </CardContent>
      </Card>
      <Dialog
        open={!!confirm}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <DialogContent>
          <DialogTitle>Transfer workspace ownership?</DialogTitle>
          <DialogDescription>
            {confirm?.email} will become the Owner. Your role will become Admin.
          </DialogDescription>
          <Button
            disabled={busy}
            onClick={() =>
              confirm &&
              void action({ action: "transfer", userId: confirm.userId })
            }
          >
            Transfer ownership
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
