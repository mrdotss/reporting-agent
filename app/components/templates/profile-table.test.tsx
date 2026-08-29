import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { ProfileTable } from "./profile-table"
import type { TemplateView } from "@/lib/db/views"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}))

/**
 * The report-profile table (task 2.1).
 *
 * The two behaviours worth asserting are the ones the cards could not do: narrowing
 * a long list, and deleting a row — including the case where the server refuses,
 * which is not an error but a fact about the account.
 */

function profile(overrides: Partial<TemplateView> = {}): TemplateView {
  return {
    id: "t-1",
    name: "Enesis Monthly",
    description: "",
    currentVersion: 4,
    currentVersionSha256: "adb4b1fd0299aaaa",
    hasDraft: false,
    schemaVersion: 3,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  }
}

const PUBLISHED = profile()
const DRAFT = profile({
  id: "t-2",
  name: "Untitled profile",
  currentVersion: null,
  currentVersionSha256: null,
  hasDraft: true,
})

describe("narrowing the list", () => {
  test("search matches on name and hides the rest", () => {
    render(<ProfileTable templates={[PUBLISHED, DRAFT]} />)
    expect(screen.getByText("Enesis Monthly")).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/search profiles/i), {
      target: { value: "untitled" },
    })

    expect(screen.queryByText("Enesis Monthly")).not.toBeInTheDocument()
    expect(screen.getByText("Untitled profile")).toBeInTheDocument()
  })

  test("a search matching nothing says so and names the term", () => {
    render(<ProfileTable templates={[PUBLISHED, DRAFT]} />)

    fireEvent.change(screen.getByLabelText(/search profiles/i), {
      target: { value: "zzz" },
    })

    expect(screen.getByText(/No profile matches/)).toBeInTheDocument()
  })

  test("the Drafts filter keeps only profiles with no saved version", () => {
    render(<ProfileTable templates={[PUBLISHED, DRAFT]} />)

    fireEvent.click(screen.getByRole("button", { name: /^Drafts/ }))

    expect(screen.queryByText("Enesis Monthly")).not.toBeInTheDocument()
    expect(screen.getByText("Untitled profile")).toBeInTheDocument()
  })

  test("there is no selection checkbox", () => {
    render(<ProfileTable templates={[PUBLISHED, DRAFT]} />)
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
  })
})

describe("deleting", () => {
  test("a 204 closes the dialog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 }))
    )
    render(<ProfileTable templates={[DRAFT]} />)

    fireEvent.click(screen.getByLabelText("Delete Untitled profile"))
    expect(screen.getByText(/Delete .Untitled profile/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Delete profile" }))
    await vi.waitFor(() =>
      expect(screen.queryByText(/Delete .Untitled profile/)).not.toBeInTheDocument()
    )
  })

  test("a 409 shows the server's reason instead of an error", async () => {
    const reason =
      "That template has produced at least one report, so its versions are " +
      "pinned and it cannot be deleted."
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: reason }), { status: 409 })
      )
    )
    render(<ProfileTable templates={[PUBLISHED]} />)

    fireEvent.click(screen.getByLabelText("Delete Enesis Monthly"))
    fireEvent.click(screen.getByRole("button", { name: "Delete profile" }))

    // The refusal replaces the confirm: its own wording, and no second chance to
    // press a button that cannot succeed.
    await vi.waitFor(() => expect(screen.getByText(reason)).toBeInTheDocument())
    // The title names the profile and the refusal, so the dialog reads as a
    // statement about this profile rather than as a failed action.
    expect(
      screen.getByText(/Enesis Monthly.* cannot be deleted/)
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Delete profile" })
    ).not.toBeInTheDocument()
  })
})
