import { notFound } from "next/navigation"
import { workspaceUiEnabled } from "@/lib/workspaces/context"
import { AcceptInvitation } from "@/components/workspaces/accept-invitation"

export default function InvitePage() {
  if (!workspaceUiEnabled()) notFound()
  return (
    <main className="min-h-screen bg-background px-4 py-20">
      <AcceptInvitation />
    </main>
  )
}
