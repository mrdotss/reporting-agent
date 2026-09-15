"use client"

import { useCallback, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { DEFAULT_RETURN_TO } from "@/lib/validation/return-to"
import {
  INVITATION_PATH,
  forgetInvitation,
  isInvitationToken,
  loadPage,
  pendingInvitation,
  rememberInvitation,
} from "@/lib/workspaces/pending-invitation"

/**
 * Join a workspace from an invitation link (roles-and-ask-access Req 9).
 *
 * Opening the page joins nothing; pressing Accept does. After that press:
 *
 * - **Signed in:** the membership is written and the visitor lands on the
 *   dashboard of the workspace they joined. It used to push `/projects`, which
 *   redirects to Workspace settings, which is not found below Admin — so an
 *   invited Editor or Viewer landed on a 404.
 * - **Signed out:** the token waits in this tab and the visitor signs in. Back
 *   here, the page finishes the acceptance they already asked for. Creating an
 *   account instead lands on the dashboard, and the shell sends them back here
 *   (`pending-invitation-resume.tsx`).
 */
export function AcceptInvitation() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const accept = useCallback(async () => {
    setBusy(true)
    setError("")

    const unavailable = () => {
      forgetInvitation()
      setError(
        "This invitation is unavailable, expired, or already used. Ask the workspace owner for a new link."
      )
      setBusy(false)
    }

    // Keep the bearer token out of server-rendered URLs and login query strings.
    const token = location.hash.slice(1) || pendingInvitation()
    if (!isInvitationToken(token)) {
      unavailable()
      return
    }

    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "accept", token }),
      })
      if (response.status === 401) {
        rememberInvitation(token)
        loadPage(`/login?returnTo=${encodeURIComponent(INVITATION_PATH)}`)
        return
      }
      if (!response.ok) {
        unavailable()
        return
      }
      forgetInvitation()
      loadPage(DEFAULT_RETURN_TO)
    } catch {
      unavailable()
    }
  }, [])

  // A token waiting in this tab was put there by a press on Accept that had to
  // sign in first, so it is finished on arrival. A fresh link in the address bar
  // wins over it and waits for its own press. Scheduled rather than run in the
  // effect body, and cancelled on cleanup, so a development double-mount
  // accepts once.
  useEffect(() => {
    if (location.hash.length > 1 || pendingInvitation() === null) return
    const timer = window.setTimeout(() => void accept(), 0)
    return () => window.clearTimeout(timer)
  }, [accept])

  return (
    <Card className="mx-auto max-w-lg">
      <CardContent className="space-y-5 pt-6">
        <h1 className="text-title">Join a reporting workspace</h1>
        <p className="text-sm text-muted-foreground">
          Accepting gives you access to its customers according to the
          invitation’s role. Sign in if prompted — you&apos;ll come back here and
          join automatically. Opening this page does not join the workspace.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button disabled={busy} onClick={() => void accept()}>
          {busy ? "Joining…" : "Accept invitation"}
        </Button>
      </CardContent>
    </Card>
  )
}
