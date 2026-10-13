import { afterEach, describe, expect, test } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"

import { ReportTabs } from "@/components/reports/report-tabs"
import { VerificationPanel } from "@/components/reports/verification-panel"
import type { VerificationView } from "@/lib/db/views"
import type { RunGap } from "@/lib/runs/gaps"

afterEach(cleanup)

const gap = (gapType: string, resourceId: string): RunGap => ({
  gapType,
  resourceId,
  metric: null,
  message: "recorded",
  intervalStart: null,
})

const gaps: RunGap[] = [
  gap("backup_not_configured", "db-1"),
  gap("backup_not_configured", "db-2"),
  gap("backup_not_configured", "db-3"),
  gap("deallocated", "vm-1"),
]

describe("ReportTabs", () => {
  test("Overview counts the gaps by reason, most first", () => {
    render(<ReportTabs gaps={gaps} machines={null} proof={<p>proof</p>} />)
    const rows = screen.getAllByRole("button", { name: /Backup not configured|Machine stopped/ })
    expect(rows.map((row) => row.textContent)).toEqual(["Backup not configured3", "Machine stopped1"])
    expect(screen.getByRole("tab", { name: /Gaps/ })).toHaveTextContent("4")
  })

  test("a reason opens the Gaps tab with that group expanded", () => {
    render(<ReportTabs gaps={gaps} machines={null} proof={<p>proof</p>} />)
    fireEvent.click(screen.getByRole("button", { name: /Machine stopped/ }))

    expect(screen.getByRole("tab", { name: /Gaps/ })).toHaveAttribute("aria-selected", "true")
    const stopped = screen.getByRole("button", { name: "Machine stopped, 1 entry" })
    expect(stopped).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("button", { name: "Backup not configured, 3 entries" })).toHaveAttribute(
      "aria-expanded",
      "false"
    )
    const group = stopped.closest("[data-slot='gap-group']") as HTMLElement
    expect(within(group).getByText("vm-1")).toBeInTheDocument()
  })
})

describe("VerificationPanel inline layout", () => {
  const sha = (c: string) => c.repeat(64)
  const passed = {
    id: "ver-1",
    status: "pass",
    figureCount: 448,
    snapshotSha256: sha("a"),
    docxSha256: sha("b"),
    pdfSha256: sha("c"),
    replay: { possible: true, objectsFolded: 11, objectsNamed: 11 },
    driftSample: { n: 25, method: "stratified", seed: sha("d"), notRequeried: [] },
    blockingFindings: [],
    advisoryFindings: [],
    counts: { blocking: 0, advisory: 0 },
    createdAt: "2026-10-01T00:00:00.000Z",
    textFactCount: 0,
    historicalPoints: [],
  } as unknown as VerificationView

  test("a pass lists the checks and fingerprints without repeating the verdict", () => {
    render(
      <VerificationPanel
        verification={passed}
        layout="inline"
        definition={{ label: "Definition · hinsandbox v6", sha256: sha("e") }}
      />
    )
    expect(screen.queryByRole("heading", { name: /figures traced/ })).toBeNull()
    expect(screen.getByRole("heading", { name: "Checks" })).toBeInTheDocument()
    expect(screen.getByText("11 of 11 archived objects re-folded.")).toBeInTheDocument()
    expect(screen.getByText("Definition · hinsandbox v6")).toBeInTheDocument()
  })

  test("a failed verification keeps the full card even when asked for inline", () => {
    render(
      <VerificationPanel
        verification={{ ...passed, status: "fail" } as VerificationView}
        layout="inline"
      />
    )
    expect(screen.getByRole("heading", { name: "Not delivered" })).toBeInTheDocument()
  })
})
