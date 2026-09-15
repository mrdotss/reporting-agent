import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const { loadPage } = vi.hoisted(() => ({ loadPage: vi.fn() }))
vi.mock("@/lib/workspaces/pending-invitation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspaces/pending-invitation")>()),
  loadPage,
}))

import { AcceptInvitation } from "@/components/workspaces/accept-invitation"
import { PendingInvitationResume } from "@/components/workspaces/pending-invitation-resume"
import { PENDING_INVITATION_KEY } from "@/lib/workspaces/pending-invitation"

/**
 * Accepting an invitation (roles-and-ask-access Req 9): it lands on the dashboard, and
 * a press that had to sign in or sign up first is finished without a second press.
 */

const TOKEN = "a".repeat(43)

function stubFetch(status: number) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

beforeEach(() => {
  loadPage.mockReset()
  sessionStorage.clear()
  window.history.replaceState(null, "", "/invitations/accept")
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AcceptInvitation", () => {
  test("an accepted invitation lands on the dashboard", async () => {
    window.history.replaceState(null, "", `/invitations/accept#${TOKEN}`)
    const fetchMock = stubFetch(200)

    render(<AcceptInvitation />)
    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }))

    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/dashboard"))
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ action: "accept", token: TOKEN })
  })

  test("signed out, the token waits in this tab and sign-in returns here", async () => {
    window.history.replaceState(null, "", `/invitations/accept#${TOKEN}`)
    stubFetch(401)

    render(<AcceptInvitation />)
    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }))

    await waitFor(() =>
      expect(loadPage).toHaveBeenCalledWith("/login?returnTo=%2Finvitations%2Faccept")
    )
    expect(sessionStorage.getItem(PENDING_INVITATION_KEY)).toBe(TOKEN)
  })

  test("back from sign-in, the waiting invitation is accepted without a second press", async () => {
    sessionStorage.setItem(PENDING_INVITATION_KEY, TOKEN)
    const fetchMock = stubFetch(200)

    render(<AcceptInvitation />)

    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/dashboard"))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(PENDING_INVITATION_KEY)).toBeNull()
  })

  test("an unusable invitation says so and stops waiting", async () => {
    sessionStorage.setItem(PENDING_INVITATION_KEY, TOKEN)
    stubFetch(404)

    render(<AcceptInvitation />)

    await screen.findByRole("alert")
    expect(loadPage).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(PENDING_INVITATION_KEY)).toBeNull()
  })
})

describe("PendingInvitationResume", () => {
  test("an invitation waiting after sign-up returns to the accept page", () => {
    sessionStorage.setItem(PENDING_INVITATION_KEY, TOKEN)
    render(<PendingInvitationResume />)
    expect(loadPage).toHaveBeenCalledWith("/invitations/accept", { replace: true })
  })

  test("with nothing waiting, the shell stays where it is", () => {
    render(<PendingInvitationResume />)
    expect(loadPage).not.toHaveBeenCalled()
  })
})
