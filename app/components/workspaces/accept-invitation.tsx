"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

const pendingInvitationKey = "reporting-pending-invitation"

export function AcceptInvitation() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function accept() {
    setBusy(true)
    setError("")
    try {
      // Keep the bearer token out of server-rendered URLs and login query strings.
      const token =
        location.hash.slice(1) || sessionStorage.getItem(pendingInvitationKey)
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
        throw new Error("Invalid invitation")
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "accept", token }),
      })
      if (response.status === 401) {
        sessionStorage.setItem(pendingInvitationKey, token)
        location.assign("/login?returnTo=%2Finvitations%2Faccept")
        return
      }
      if (!response.ok) throw new Error("Invitation unavailable")
      sessionStorage.removeItem(pendingInvitationKey)
      history.replaceState(null, "", location.pathname)
      router.push("/projects")
      router.refresh()
    } catch {
      setError(
        "This invitation is unavailable, expired, or already used. Ask the workspace administrator for a new link."
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mx-auto max-w-lg">
      <CardContent className="space-y-5 pt-6">
        <h1 className="text-title">Join a reporting workspace</h1>
        <p className="text-sm text-muted-foreground">
          Accepting gives you access to its customer projects according to the
          invitation’s role. Sign in if prompted, then confirm here. Opening
          this page does not join the workspace.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button disabled={busy} onClick={accept}>
          {busy ? "Joining…" : "Accept invitation"}
        </Button>
      </CardContent>
    </Card>
  )
}
