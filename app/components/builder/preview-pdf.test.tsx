import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { BuilderProvider, type BuilderEnvironment } from "@/components/builder/context"
import { PreviewPdf } from "@/components/builder/preview-pdf"
import { emptyDraftV4 } from "@/lib/builder/draft"
import { METRIC_CATALOG } from "@/lib/templates/catalog"
import type { PreviewSource } from "@/lib/templates/input"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mount(previewSources: readonly PreviewSource[], provider: "aws" | "azure" = "aws") {
  const environment: BuilderEnvironment = {
    templateId: "tmpl-1",
    catalog: METRIC_CATALOG,
    collectedFactSources: [],
    metricsHistorySince: null,
    latestVersion: null,
    previewSources,
  }
  render(
    <BuilderProvider initial={emptyDraftV4("Draft", provider)} environment={environment}>
      <PreviewPdf templateId="tmpl-1" />
    </BuilderProvider>
  )
  fireEvent.click(screen.getByRole("button", { name: /Preview PDF/ }))
}

/** A tab the component opens on the click and later points at the PDF. */
function stubTab() {
  const tab = {
    opener: {} as unknown,
    closed: false,
    close: vi.fn(),
    location: { href: "" },
    document: { title: "", body: { style: {} as Record<string, string>, textContent: "" } },
  }
  vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window)
  return tab
}

const PRODUCTION: PreviewSource = { id: "conn-1", name: "Production AWS", period: { start: "2026-09-01", end: "2026-09-30" } }
const STAGING: PreviewSource = { id: "conn-2", name: "Staging AWS", period: null }

describe("PreviewPdf", () => {
  test("with no connection of this provider, says how to get one", async () => {
    mount([], "azure")
    expect(await screen.findByText(/No active Azure connection in this project/)).toBeInTheDocument()
  })

  test("lists each connection with its latest report, and one without a report is disabled", async () => {
    mount([PRODUCTION, STAGING])
    expect(await screen.findByRole("button", { name: /Production AWS.*2026-09-01 to 2026-09-30/ })).toBeEnabled()
    expect(screen.getByRole("button", { name: /Staging AWS.*No completed report yet/ })).toBeDisabled()
  })

  test("sends the draft as it stands and points the tab it opened at the PDF", async () => {
    const tab = stubTab()
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ previewId: "pv-1", url: "https://signed.example/preview.pdf", periodStart: "2026-09-01", periodEnd: "2026-09-30" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    )
    vi.stubGlobal("fetch", fetchMock)
    mount([PRODUCTION])

    fireEvent.click(await screen.findByRole("button", { name: /Production AWS/ }))

    // Opened on the click itself, so the popup blocker lets it through.
    expect(window.open).toHaveBeenCalledWith("", "_blank")
    expect(tab.opener).toBeNull()
    await waitFor(() => expect(tab.location.href).toBe("https://signed.example/preview.pdf"))
    expect(screen.getByRole("link", { name: "Open the PDF" })).toHaveAttribute("href", "https://signed.example/preview.pdf")

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/api/report-profiles/tmpl-1/preview")
    const body = JSON.parse(String(init.body)) as { connectedSubscriptionId: string; definition: { schema_version: number }; supersedes?: string }
    expect(body.connectedSubscriptionId).toBe("conn-1")
    expect(body.definition.schema_version).toBe(4)
    expect(body.supersedes).toBeUndefined()

    // The next preview names this one, so the server can delete what it replaces.
    fireEvent.click(screen.getByRole("button", { name: /Production AWS/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const second = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)) as { supersedes?: string }
    expect(second.supersedes).toBe("pv-1")
  })

  test("a failed render closes the tab and says what went wrong", async () => {
    const tab = stubTab()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "A completed report is needed before a preview can be rendered." } }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        })
      )
    )
    mount([PRODUCTION])
    fireEvent.click(await screen.findByRole("button", { name: /Production AWS/ }))

    expect(await screen.findByRole("alert")).toHaveTextContent("A completed report is needed")
    expect(tab.close).toHaveBeenCalled()
  })
})
