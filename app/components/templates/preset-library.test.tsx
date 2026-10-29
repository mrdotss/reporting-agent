import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"

import { PresetLibrary } from "./preset-library"
import type { TemplateView } from "@/lib/db/views"
import { messageText } from "@/lib/messages/catalog"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}))

/**
 * The presets list: cards by default, the table as List.
 *
 * Asserted here: narrowing a long list (search, the state filters, the source filter),
 * the one state pill that replaced "unsaved draft", the Customer column rule, the
 * sketch that says it is a sketch, and deleting — including the case where the server
 * refuses, which is not an error but a fact about the account.
 */

function profile(overrides: Partial<TemplateView> = {}): TemplateView {
  return {
    provider: "azure",
    archivedAt: null,
    hasIncidentReport: false,
    sectionTypes: ["at_a_glance", "virtual_machines", "vm_utilization", "backup_report"],
    id: "t-1",
    name: "Enesis Monthly",
    description: "",
    currentVersion: 4,
    currentVersionSha256: "adb4b1fd0299aaaa",
    hasDraft: true,
    hasUnpublishedEdits: false,
    schemaVersion: 4,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    projectId: "p-1",
    ...overrides,
  }
}

const PUBLISHED = profile()
const DRAFT = profile({
  id: "t-2",
  name: "Untitled profile",
  currentVersion: null,
  currentVersionSha256: null,
  hasUnpublishedEdits: true,
  sectionTypes: [],
})
const PENDING = profile({ id: "t-3", name: "FATechID Monthly", hasUnpublishedEdits: true })
const EMPTY = profile({ id: "t-4", name: "Standard", currentVersion: 12, sectionTypes: [], hasDraft: false })
const AWS = profile({
  id: "t-5",
  name: "hinsandbox",
  provider: "aws",
  sectionTypes: ["regions", "ec2_instances", "backups", "coverage_and_verification"],
  projectId: "p-2",
})

const CUSTOMERS = new Map([
  ["p-1", "FATechID"],
  ["p-2", "HIN"],
])

function cards() {
  return screen.queryAllByRole("article")
}

function cardOf(name: string) {
  const card = cards().find((article) => within(article).queryByRole("link", { name }))
  if (card === undefined) throw new Error(`no card for ${name}`)
  return card
}

describe("narrowing the list", () => {
  test("search matches on name and hides the rest", () => {
    render(<PresetLibrary templates={[PUBLISHED, DRAFT]} />)
    expect(screen.getByRole("link", { name: "Enesis Monthly" })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText("Search presets"), {
      target: { value: "untitled" },
    })

    expect(screen.queryByRole("link", { name: "Enesis Monthly" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Untitled profile" })).toBeInTheDocument()
  })

  test("a search matching nothing says so and names the term", () => {
    render(<PresetLibrary templates={[PUBLISHED, DRAFT]} />)

    fireEvent.change(screen.getByLabelText("Search presets"), {
      target: { value: "zzz" },
    })

    expect(screen.getByText(/No preset matches “zzz”/)).toBeInTheDocument()
  })

  test("Edits pending keeps unpublished presets and pending edits, not a draft that matches its version", () => {
    render(<PresetLibrary templates={[PUBLISHED, DRAFT, PENDING]} />)

    fireEvent.click(screen.getByRole("button", { name: /^Edits pending/ }))

    expect(cards()).toHaveLength(2)
    expect(screen.queryByRole("link", { name: "Enesis Monthly" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Untitled profile" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "FATechID Monthly" })).toBeInTheDocument()
  })

  test("Empty keeps presets with no sections", () => {
    render(<PresetLibrary templates={[PUBLISHED, EMPTY]} />)

    fireEvent.click(screen.getByRole("button", { name: /^Empty/ }))

    expect(cards()).toHaveLength(1)
    expect(screen.getByRole("link", { name: "Standard" })).toBeInTheDocument()
  })

  test("source chips appear only when there is more than one source", () => {
    const { unmount } = render(<PresetLibrary templates={[PUBLISHED, PENDING]} />)
    expect(screen.queryByRole("button", { name: /^Azure/ })).not.toBeInTheDocument()
    unmount()

    render(<PresetLibrary templates={[PUBLISHED, AWS]} />)
    fireEvent.click(screen.getByRole("button", { name: /^AWS/ }))
    expect(cards()).toHaveLength(1)
    expect(screen.getByRole("link", { name: "hinsandbox" })).toBeInTheDocument()
  })

  test("there is no selection checkbox", () => {
    render(<PresetLibrary templates={[PUBLISHED, DRAFT]} />)
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
  })
})

describe("what a card says", () => {
  test("the state is one pill, and a draft that matches its version is just live", () => {
    render(<PresetLibrary templates={[PUBLISHED, DRAFT, PENDING, EMPTY]} />)

    expect(within(cardOf("Enesis Monthly")).getByText("Live v4")).toBeInTheDocument()
    expect(within(cardOf("Untitled profile")).getByText("Draft")).toBeInTheDocument()
    expect(within(cardOf("FATechID Monthly")).getByText("Live v4 · edits pending")).toBeInTheDocument()
    expect(within(cardOf("Standard")).getByText("Live v12 · empty")).toBeInTheDocument()
    expect(screen.queryByText(/unsaved draft/)).not.toBeInTheDocument()
  })

  test("sections are named, without the appendix every preset ends with", () => {
    render(<PresetLibrary templates={[AWS]} />)
    const card = cardOf("hinsandbox")

    expect(within(card).getByText("Regions")).toBeInTheDocument()
    expect(within(card).getByText("EC2 Instances")).toBeInTheDocument()
    expect(within(card).getByText("Backups")).toBeInTheDocument()
    expect(within(card).queryByText("Coverage and Verification")).not.toBeInTheDocument()
    expect(within(card).getByText("4 sections")).toBeInTheDocument()
  })

  test("the thumbnail is labelled a sketch, and an empty preset looks empty", () => {
    render(<PresetLibrary templates={[PUBLISHED, EMPTY]} />)

    expect(
      within(cardOf("Enesis Monthly")).getByRole("img", { name: /Layout sketch of Enesis Monthly/ })
    ).toBeInTheDocument()
    expect(within(cardOf("Standard")).getAllByText("No sections yet").length).toBeGreaterThan(0)
    expect(within(cardOf("Standard")).getByText("Open it to add sections")).toBeInTheDocument()
  })

  test("the digest is not on the card", () => {
    render(<PresetLibrary templates={[PUBLISHED]} />)
    expect(within(cardOf("Enesis Monthly")).queryByText(/adb4b1/)).not.toBeInTheDocument()
  })

  test("a preset never published cannot be run, and says why", () => {
    render(<PresetLibrary templates={[DRAFT]} />)
    expect(
      screen.getByRole("button", { name: "Save a version of Untitled profile before running it" })
    ).toBeDisabled()
  })

  test("the customer shows only when presets from several customers are listed together", () => {
    const { unmount } = render(
      <PresetLibrary templates={[PUBLISHED, AWS]} customers={CUSTOMERS} showCustomer />
    )
    expect(within(cardOf("hinsandbox")).getByText("4 sections · HIN")).toBeInTheDocument()
    unmount()

    render(<PresetLibrary templates={[PUBLISHED, AWS]} customers={CUSTOMERS} showCustomer={false} />)
    expect(screen.queryByText(/HIN/)).not.toBeInTheDocument()
  })
})

describe("the List view", () => {
  test("shows the table, keeps the digest there, and is remembered", () => {
    render(<PresetLibrary templates={[PUBLISHED, PENDING]} />)

    fireEvent.click(screen.getByRole("button", { name: "List" }))

    expect(screen.getByRole("table")).toBeInTheDocument()
    expect(cards()).toHaveLength(0)
    expect(screen.getAllByText(/adb4b1/).length).toBeGreaterThan(0)
    expect(screen.getByText("Live v4 · edits pending")).toBeInTheDocument()
    expect(window.localStorage.getItem("presets.view")).toBe("list")
  })

  test("drops the Customer column where it would repeat itself", () => {
    const { unmount } = render(
      <PresetLibrary templates={[PUBLISHED]} customers={CUSTOMERS} showCustomer />
    )
    fireEvent.click(screen.getByRole("button", { name: "List" }))
    expect(screen.getByRole("columnheader", { name: "Customer" })).toBeInTheDocument()
    unmount()

    render(<PresetLibrary templates={[PUBLISHED]} customers={CUSTOMERS} showCustomer={false} />)
    expect(screen.getByRole("table")).toBeInTheDocument()
    expect(screen.queryByRole("columnheader", { name: "Customer" })).not.toBeInTheDocument()
  })
})

describe("deleting", () => {
  function openList() {
    fireEvent.click(screen.getByRole("button", { name: "List" }))
  }

  test("a 204 closes the dialog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 }))
    )
    render(<PresetLibrary templates={[DRAFT]} />)
    openList()

    fireEvent.click(screen.getByLabelText("Delete Untitled profile"))
    expect(screen.getByText(/Delete .Untitled profile/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Delete profile" }))
    await vi.waitFor(() =>
      expect(screen.queryByText(/Delete .Untitled profile/)).not.toBeInTheDocument()
    )
  })

  test("a 409 TEMPLATE_PINNED explains why instead of showing a status code", async () => {
    // The body shape the route really sends (lib/api/response.ts `conflict`).
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "That template has produced at least one report…",
                code: "TEMPLATE_PINNED",
              },
            }),
            { status: 409 }
          )
      )
    )
    const reason = messageText("ui.presets.delete_pinned", "en") ?? ""
    render(<PresetLibrary templates={[PUBLISHED]} />)
    openList()

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
    expect(screen.queryByText(/\(409\)/)).not.toBeInTheDocument()
  })

  test("any other refusal shows the server's own message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "Something specific happened." } }),
            { status: 409 }
          )
      )
    )
    render(<PresetLibrary templates={[PUBLISHED]} />)
    openList()

    fireEvent.click(screen.getByLabelText("Delete Enesis Monthly"))
    fireEvent.click(screen.getByRole("button", { name: "Delete profile" }))

    await vi.waitFor(() =>
      expect(screen.getByText("Something specific happened.")).toBeInTheDocument()
    )
  })

  test("a pinned refusal offers to archive the preset instead", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        if (init?.method === "DELETE") {
          return new Response(
            JSON.stringify({ error: { message: "pinned", code: "TEMPLATE_PINNED" } }),
            { status: 409 }
          )
        }
        return new Response(JSON.stringify({ template: {} }), { status: 200 })
      })
    )
    render(<PresetLibrary templates={[PUBLISHED]} />)
    openList()

    fireEvent.click(screen.getByLabelText("Delete Enesis Monthly"))
    fireEvent.click(screen.getByRole("button", { name: "Delete profile" }))
    const archive = await screen.findByRole("button", { name: "Archive instead" })
    fireEvent.click(archive)

    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: "Archive instead" })).not.toBeInTheDocument()
    )
    expect(calls[1]).toMatchObject({ url: "/api/report-profiles/t-1/archive" })
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ archived: true })
  })

  test("archived presets leave All and show only under Archived, with Restore", async () => {
    const ARCHIVED = profile({
      id: "t-9",
      name: "Old Standard",
      archivedAt: "2026-10-29T11:00:00.000Z",
    })
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    render(<PresetLibrary templates={[PUBLISHED, ARCHIVED]} />)

    expect(cards().map((card) => within(card).getAllByRole("link")[0]?.textContent)).not.toContain(
      "Old Standard"
    )
    expect(screen.getByRole("button", { name: /^All\s*1$/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /^Archived\s*1$/ }))
    expect(cardOf("Old Standard")).toBeInTheDocument()
    expect(within(cardOf("Old Standard")).getByText("Archived")).toBeInTheDocument()

    openList()
    fireEvent.click(screen.getByLabelText("Restore Old Standard"))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0]).toMatchObject([
      "/api/report-profiles/t-9/archive",
      { method: "POST", body: JSON.stringify({ archived: false }) },
    ])
  })

  test("no Archived filter while nothing is archived", () => {
    render(<PresetLibrary templates={[PUBLISHED]} />)
    expect(screen.queryByRole("button", { name: /^Archived/ })).not.toBeInTheDocument()
  })
})
