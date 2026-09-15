import type { Metadata } from "next"

import { CloseBoard } from "@/components/close/close-board"
import { requireSession } from "@/lib/auth/guard"

/**
 * `/dashboard` — the close board, and the landing surface after sign-in.
 *
 * Workspace-wide rather than scoped to the selected customer: the close is made of
 * every customer, and the board is where a consultant picks which one to move next.
 */

export const metadata: Metadata = {
  title: "Overview",
  description:
    "Each customer's report for the open period: what is delivered, in flight, " +
    "not delivered or not yet requested.",
}

export default async function DashboardPage() {
  const user = await requireSession()
  return <CloseBoard userId={user.id} />
}
