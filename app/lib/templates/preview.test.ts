import { describe, expect, test, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }))

const { previewSources } = await import("@/lib/templates/preview")

const CONNECTIONS = [
  { id: "aws-1", displayName: "Production AWS", provider: "aws", status: "active" },
  { id: "az-1", displayName: "Contoso Azure", provider: "azure", status: "active" },
  { id: "aws-2", displayName: "Old AWS", provider: "aws", status: "disabled" },
  { id: "aws-3", displayName: "Staging AWS", provider: "aws", status: "active" },
]

describe("previewSources", () => {
  test("offers only this provider's active connections, each with its latest report", async () => {
    const lookup = vi.fn(async (_user: string, id: string) =>
      id === "aws-1"
        ? { actorId: "u", runId: "r", snapshotId: "s", periodStart: "2026-09-01", periodEnd: "2026-09-30", timezone: "UTC" }
        : null
    )
    expect(await previewSources("u", CONNECTIONS, "aws", lookup)).toEqual([
      { id: "aws-1", name: "Production AWS", period: { start: "2026-09-01", end: "2026-09-30" } },
      // Kept, disabled with its reason, rather than vanishing.
      { id: "aws-3", name: "Staging AWS", period: null },
    ])
    expect(lookup.mock.calls.map(([, id]) => id)).toEqual(["aws-1", "aws-3"])
  })

  test("an Azure preset is offered the Azure connection alone", async () => {
    const sources = await previewSources("u", CONNECTIONS, "azure", async () => null)
    expect(sources.map((source) => source.id)).toEqual(["az-1"])
  })
})
