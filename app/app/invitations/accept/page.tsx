import { notFound } from "next/navigation"
import { workspaceUiEnabled } from "@/lib/workspaces/context"
import { AcceptInvitation } from "@/components/workspaces/accept-invitation"

export default function InvitePage() {
  if (!workspaceUiEnabled()) notFound()
  return (
    // `workspace-design` explicitly: this page sits outside the `(app)` group, so it does
    // not get the scope from `WorkspaceShell` the way every other workspace screen does.
    // It is the first thing an invited teammate sees, and it would otherwise render in
    // the old tokens while the workspace they are joining renders in the new ones.
    <main className="workspace-design min-h-screen bg-background px-4 py-20">
      <AcceptInvitation />
    </main>
  )
}
