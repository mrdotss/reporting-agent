import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import type { ConnectedSubscriptionView, ScanView } from "@/lib/db/views"
import { depthChecklist } from "@/lib/subscriptions/depth"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}))

import { ConnectorDetail } from "./connector-detail"

afterEach(cleanup)

const NOW = new Date("2026-10-12T00:00:00.000Z")

const AWS: ConnectedSubscriptionView = {
  provider: "aws",
  regions: [],
  id: "conn-aws",
  displayName: "hinsandbox",
  maskedSubscriptionId: "********3312",
  scopeVerified: true,
  secretExpiresAt: null,
  fidelityTier: "baseline",
  metricsHistorySince: null,
  status: "active",
}

const SCAN: ScanView = {
  id: "scan-1",
  connectedSubscriptionId: "conn-aws",
  status: "complete",
  catalogVersion: null,
  sectionsCatalogueVersion: null,
  resourceCount: 164,
  typeCounts: {
    "AWS::EC2::Volume": 12,
    "AWS::EC2::Instance": 10,
    "AWS::EC2::SecurityGroup": 122,
    "AWS::EC2::VPC": 11,
    "AWS::EC2::EIP": 7,
    "AWS::RDS::DBInstance": 2,
  },
  childTypeCounts: { "AWS::EC2::Subnet": 44 },
  resourceGroups: [],
  regions: ["ap-southeast-1", "ap-southeast-3", "us-east-1", "eu-west-1"],
  regionCounts: null,
  regionProbes: null,
  truncated: false,
  errorCode: null,
  errorMessage: null,
  completedAt: "2026-09-27T12:35:00.000Z",
  createdAt: "2026-09-27T12:35:00.000Z",
  updatedAt: "2026-09-27T12:35:00.000Z",
}

const DEPTH = {
  checklist: depthChecklist({
    provider: "aws",
    scopeVerified: true,
    metricsHistorySince: null,
    gaps: [{ gapType: "optimizer_not_available", resourceId: "arn:aws:ec2:us-east-1:123456789012:instance/i-01" }],
  }),
  runId: "run-sep",
  periodStart: "2026-09-01",
}

describe("ConnectorDetail", () => {
  test("Overview shows the figures, and the tabs carry their counts", () => {
    render(<ConnectorDetail subscription={AWS} scan={SCAN} depth={DEPTH} now={NOW} canConnect />)

    expect(screen.getByRole("heading", { name: /What.s in hinsandbox/ })).toBeInTheDocument()
    expect(screen.getByText(/Last scanned 27 Sept, 19:35 WIB · Baseline fidelity/)).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Resources/ })).toHaveTextContent("164")
    expect(screen.getByRole("tab", { name: /Data depth/ })).toHaveTextContent(
      `${DEPTH.checklist.done}/${DEPTH.checklist.total}`
    )

    const figures = [...document.querySelectorAll("dd")].map((dd) => dd.textContent)
    expect(figures).toEqual(["164", "6", "4", "44"])
    expect(screen.getByText("Largest types")).toBeInTheDocument()
    expect(screen.getByText("Enroll AWS Compute Optimizer")).toBeInTheDocument()
  })

  test("Resources lists every type, and Access says an AWS role stores no secret", () => {
    render(<ConnectorDetail subscription={AWS} scan={SCAN} depth={DEPTH} now={NOW} canConnect />)

    fireEvent.click(screen.getByRole("tab", { name: /Resources/ }))
    expect(screen.getByText("AWS::RDS::DBInstance")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("tab", { name: /Access/ }))
    expect(screen.getByText("None stored, so nothing expires")).toBeInTheDocument()
  })

  test("Scan and Role setup are in the header, and only for Owners and Admins", () => {
    const { unmount } = render(<ConnectorDetail subscription={AWS} scan={SCAN} depth={DEPTH} now={NOW} canConnect />)
    expect(screen.getByRole("button", { name: /^scan$/i })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Role setup" })).toHaveAttribute("href", "/subscriptions/conn-aws/setup")
    unmount()

    render(<ConnectorDetail subscription={AWS} scan={SCAN} depth={DEPTH} now={NOW} canConnect={false} />)
    expect(screen.queryByRole("button", { name: /^scan$/i })).toBeNull()
    expect(screen.queryByRole("link", { name: "Role setup" })).toBeNull()
  })

  test("a connector never scanned says so instead of printing zeros", () => {
    render(<ConnectorDetail subscription={AWS} scan={null} depth={null} now={NOW} canConnect />)

    expect(screen.getByText(/Scan this connector to see the resources it can read/)).toBeInTheDocument()
    expect(document.querySelectorAll("dd")).toHaveLength(0)
  })
})
