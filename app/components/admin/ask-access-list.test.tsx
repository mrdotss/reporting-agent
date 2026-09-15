import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { AskAccessList } from "@/components/admin/ask-access-list"
import type { AdminAccountView } from "@/lib/admin/views"

/** The admin's list of who can use Ask (roles-and-ask-access Req 7). */

const ACCOUNTS: AdminAccountView[] = [
  {
    userId: "admin_1",
    email: "admin@example.test",
    joinedAt: "2026-08-01T00:00:00.000Z",
    ownedWorkspaces: 2,
    homeRole: "owner",
    grantedAt: null,
    admin: true,
  },
  {
    userId: "user_2",
    email: "consultant@example.test",
    joinedAt: "2026-09-01T00:00:00.000Z",
    ownedWorkspaces: 1,
    homeRole: "editor",
    grantedAt: null,
    admin: false,
  },
  {
    userId: "user_3",
    email: "partner@example.test",
    joinedAt: "2026-09-10T00:00:00.000Z",
    ownedWorkspaces: 1,
    homeRole: null,
    grantedAt: "2026-09-12T03:00:00.000Z",
    admin: false,
  },
]

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AskAccessList", () => {
  test("counts who has Ask, and offers no switch on a platform admin's own row", () => {
    render(<AskAccessList accounts={ACCOUNTS} currentUserId="admin_1" truncated={false} />)

    expect(screen.getByText(/accounts have Ask turned on/).textContent).toMatch(/^1 of 3/)
    expect(screen.getByText("Always on")).toBeTruthy()
    expect(screen.queryByRole("switch", { name: "Ask for admin@example.test" })).toBeNull()
    expect(screen.getByRole("switch", { name: "Ask for consultant@example.test" })).toBeTruthy()
  })

  test("turning Ask on saves it and shows the saved grant", async () => {
    const fetchMock = stubFetch(200, { userId: "user_2", grantedAt: "2026-09-16T01:00:00.000Z" })
    render(<AskAccessList accounts={ACCOUNTS} currentUserId="admin_1" truncated={false} />)

    fireEvent.click(screen.getByRole("switch", { name: "Ask for consultant@example.test" }))

    await screen.findByText("On since 16 Sept 2026")
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe("/api/admin/ask-access")
    expect(JSON.parse(String(init.body))).toEqual({ userId: "user_2", enabled: true })
    expect(screen.getByText(/Editor in your workspace, where Ask is now hidden from them/)).toBeTruthy()
  })

  test("a refused change says so and leaves the row as it was", async () => {
    stubFetch(404, {})
    render(<AskAccessList accounts={ACCOUNTS} currentUserId="admin_1" truncated={false} />)

    fireEvent.click(screen.getByRole("switch", { name: "Ask for partner@example.test" }))

    expect((await screen.findByRole("alert")).textContent).toBe("Ask wasn’t turned off. Try again.")
    await waitFor(() => expect(screen.getByText("On since 12 Sept 2026")).toBeTruthy())
  })

  test("the search narrows the list by email", () => {
    render(<AskAccessList accounts={ACCOUNTS} currentUserId="admin_1" truncated={false} />)

    fireEvent.change(screen.getByLabelText("Search accounts by email"), {
      target: { value: "PARTNER" },
    })

    expect(document.querySelectorAll('[data-slot="ask-access-row"]')).toHaveLength(1)
    expect(screen.getByText("partner@example.test")).toBeTruthy()
  })
})
