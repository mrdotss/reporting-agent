import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"

import { DepthCoach } from "@/components/subscriptions/depth-coach"
import { depthChecklist } from "@/lib/subscriptions/depth"

afterEach(cleanup)

describe("DepthCoach", () => {
  test("shows each open item with its count and steps, and links the report it read", () => {
    const checklist = depthChecklist({
      provider: "aws",
      scopeVerified: true,
      metricsHistorySince: null,
      gaps: [
        { gapType: "optimizer_not_available", resourceId: "arn:aws:ec2:us-east-1:123456789012:instance/i-01" },
        { gapType: "backup_not_configured", resourceId: "arn:aws:rds:us-east-1:123456789012:db:orders" },
      ],
    })
    render(<DepthCoach checklist={checklist} runId="run-1" periodStart="2026-08-01" />)

    expect(screen.getByText(/From the August 2026 report/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open the report" })).toHaveAttribute("href", "/reports/run-1")
    expect(screen.getByRole("img", { name: "2 of 4 done" })).toBeInTheDocument()

    const optimizer = screen.getByText("Enroll AWS Compute Optimizer").closest("li")!
    expect(optimizer).toHaveAttribute("data-state", "open")
    expect(within(optimizer).getByText("1")).toBeInTheDocument()
    expect(within(optimizer).getByText("How to close it")).toBeInTheDocument()

    const done = screen.getByText("No access errors").closest("li")!
    expect(done).toHaveAttribute("data-state", "done")
    expect(within(done).queryByText("How to close it")).toBeNull()
  })

  test("before a first report it says the gap checks come later", () => {
    const checklist = depthChecklist({ provider: "azure", scopeVerified: true, metricsHistorySince: null, gaps: null })
    render(<DepthCoach checklist={checklist} runId={null} periodStart={null} />)

    expect(screen.getByText(/Gap-based checks start after the first completed report/)).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Open the report" })).toBeNull()
    expect(screen.getByText("Protect VMs with Azure Backup").closest("li")).toHaveAttribute("data-state", "unknown")
  })
})
