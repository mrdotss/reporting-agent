import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { DesignPreview } from "./design-preview"
const fetchMock = vi.fn()
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:sample-pdf")
      static revokeObjectURL = vi.fn()
    }
  )
  fetchMock.mockResolvedValue(
    new Response("%PDF-sample", {
      headers: { "Content-Type": "application/pdf" },
    })
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
it("resets all tuning when choosing a theme and disables invalid accents", () => {
  render(<DesignPreview />)
  fireEvent.change(screen.getByLabelText("Spacing"), {
    target: { value: "relaxed" },
  })
  fireEvent.click(screen.getByRole("button", { name: "technical theme" }))
  expect(screen.getByLabelText("Spacing")).toHaveValue("compact")
  expect(screen.getByLabelText("Accent colour")).toHaveValue("#33556b")
  fireEvent.change(screen.getByLabelText("Accent colour"), {
    target: { value: "oops" },
  })
  expect(screen.getByRole("button", { name: "Render preview" })).toBeDisabled()
  fireEvent.click(
    screen.getByRole("button", { name: "Reset to theme defaults" })
  )
  expect(screen.getByRole("button", { name: "Render preview" })).toBeEnabled()
})
it("preserves the previous PDF on failure and marks changed settings outdated", async () => {
  render(<DesignPreview />)
  fireEvent.click(screen.getByRole("button", { name: "Render preview" }))
  await screen.findByTitle("Rendered sample PDF")
  expect(screen.getByRole("link", { name: "Download PDF" })).toHaveAttribute(
    "href",
    "blob:sample-pdf"
  )
  fireEvent.change(screen.getByLabelText("Page size"), {
    target: { value: "Letter" },
  })
  expect(screen.getByRole("status")).toHaveTextContent("Preview outdated")
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({ error: { message: "PDF rendering failed." } }),
      { status: 503 }
    )
  )
  fireEvent.click(screen.getByRole("button", { name: "Render preview" }))
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "previous PDF is still available"
  )
  expect(screen.getByTitle("Rendered sample PDF")).toHaveAttribute(
    "src",
    "blob:sample-pdf#zoom=page-width&navpanes=0"
  )
  expect(
    screen.getByRole("link", { name: "Download previous PDF" })
  ).toBeInTheDocument()
})
it("keeps in-flight settings associated with their PDF and ignores duplicate clicks", async () => {
  let resolve!: (response: Response) => void
  fetchMock.mockReturnValue(
    new Promise<Response>((r) => {
      resolve = r
    })
  )
  render(<DesignPreview />)
  fireEvent.click(screen.getByRole("button", { name: "Render preview" }))
  fireEvent.click(screen.getByRole("button", { name: "Rendering…" }))
  fireEvent.click(screen.getByRole("button", { name: "minimal theme" }))
  await act(async () => {
    resolve(
      new Response("%PDF", { headers: { "Content-Type": "application/pdf" } })
    )
  })
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Preview outdated")
  )
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(screen.getByRole("link")).toHaveAttribute(
    "download",
    "design-preview-corporate.pdf"
  )
})
