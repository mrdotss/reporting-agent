import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("@/lib/aws/s3", () => ({ getSnapshotJson: async () => ({}) }))

import { parseAgentOutcomes, type AgentParagraphOutcome } from "@/lib/runs/agent"

import { AgentNotes } from "./agent-notes"

/**
 * The report page's note on agent paragraphs the report does not carry (`agent.json`).
 *
 * The report delivered either way; what matters is that the consultant can see, per
 * section, whether their note stood in or nothing did, and why the words are missing.
 */

afterEach(cleanup)

const BUNDLE = {
  schema_version: 1,
  paragraphs: [
    { block_id: "sec_a__u_1", section_id: "sec_a", section_title: "Compute use", outcome: "written", reason: "written" },
    { block_id: "sec_a__u_2", section_id: "sec_a", section_title: "Compute use", outcome: "note", reason: "unprovable_figures" },
    { block_id: "sec_b__u_3", section_id: "sec_b", section_title: "Volumes", outcome: "omitted", reason: "model_failed" },
  ],
}

describe("agent.json", () => {
  test("is read paragraph by paragraph", () => {
    expect(parseAgentOutcomes(BUNDLE)).toEqual([
      { blockId: "sec_a__u_1", sectionTitle: "Compute use", outcome: "written", reason: "written" },
      { blockId: "sec_a__u_2", sectionTitle: "Compute use", outcome: "note", reason: "unprovable_figures" },
      { blockId: "sec_b__u_3", sectionTitle: "Volumes", outcome: "omitted", reason: "model_failed" },
    ])
  })

  test("a file it cannot read, or one with nothing in it, is no note at all", () => {
    expect(parseAgentOutcomes({ schema_version: 2, paragraphs: [] })).toBeNull()
    expect(parseAgentOutcomes({ schema_version: 1, paragraphs: [] })).toBeNull()
    expect(parseAgentOutcomes({ schema_version: 1, paragraphs: [{ outcome: "maybe" }] })).toBeNull()
  })
})

describe("the note on the report's page", () => {
  test("names each missing paragraph's section, what printed instead, and why", () => {
    render(<AgentNotes outcomes={parseAgentOutcomes(BUNDLE)!} />)
    expect(screen.getByRole("heading", { name: "2 agent paragraphs aren’t in this report" })).toBeTruthy()
    expect(screen.getByText(/1 of 3 agent paragraphs were written/)).toBeTruthy()
    const items = screen.getAllByRole("listitem").map((item) => item.textContent)
    expect(items).toEqual([
      "Compute useYour note printed instead. The agent wrote a number it was not shown, so its words were refused.",
      "VolumesLeft out. The model could not be reached, or did not answer in time.",
    ])
  })

  test("says nothing when every paragraph was written", () => {
    const written: AgentParagraphOutcome[] = [{ blockId: "a", sectionTitle: "A", outcome: "written", reason: "written" }]
    const { container } = render(<AgentNotes outcomes={written} />)
    expect(container.innerHTML).toBe("")
  })
})
