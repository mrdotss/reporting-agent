import type { Metadata } from "next"

import { AcceptInvitation } from "@/components/workspaces/accept-invitation"

export const metadata: Metadata = {
  title: "Join a workspace",
  description: "Accept an invitation to a Utilize Space workspace.",
}

export default function InvitePage() {
  return (
    <main className="min-h-screen bg-background px-4 py-20">
      <AcceptInvitation />
    </main>
  )
}
