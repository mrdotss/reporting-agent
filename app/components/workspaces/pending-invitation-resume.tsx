"use client"

import { useEffect } from "react"

import {
  INVITATION_PATH,
  loadPage,
  pendingInvitation,
} from "@/lib/workspaces/pending-invitation"

/**
 * Finishes joining a workspace for a visitor who pressed Accept, was sent to sign
 * in, and created an account instead (roles-and-ask-access Req 9).
 *
 * Registration lands on the dashboard — it is not the resumption of an
 * interrupted request (Requirement 7.1) — so the shell notices the invitation
 * still waiting in this tab and returns to the page that accepts it. The accept
 * page forgets the token whatever the outcome, so this can send a visitor back at
 * most once per press. Renders nothing.
 */
export function PendingInvitationResume() {
  useEffect(() => {
    if (pendingInvitation() !== null) loadPage(INVITATION_PATH, { replace: true })
  }, [])

  return null
}
