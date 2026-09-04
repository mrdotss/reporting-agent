/**
 * Tests for task 8.4 — the fixed front-matter section of the builder.
 *
 * Verifies:
 * - FrontMatterForm renders all three sections (cover, document control, TOC)
 * - Signature slots show per-role with the "ruled box" statement
 * - Document-number pattern validates its closed placeholder set on the step
 * - TOC section shows "retained and not emitted" when approach is `none`
 * - BlockPalette has no entry for cover, document_control, or toc
 * - The palette's first entry is a content block (heading)
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import {
  FrontMatterForm,
  TOC_ADOPTED_APPROACH,
  type FrontMatterFormValues,
} from "@/components/templates/front-matter-form"
import {
  BlockPalette,
  PALETTE_GROUPS,
} from "@/components/templates/block-palette"
import { APPROVER_ROLES } from "@/lib/templates/definition"

// ---------------------------------------------------------------------------
// FrontMatterForm
// ---------------------------------------------------------------------------

function defaultValues(): FrontMatterFormValues {
  return {
    cover: { enabled: true, logo: null, contact_block: null, subtitle: null, logo_key: null },
    document_control: {
      document_name: null,
      document_number_pattern: null,
      confidentiality_notice_id: null,
    confidentiality_notice: null,
      distribution: [],
      approvers: [],
    },
    toc: { enabled: true, max_level: 3 },
  }
}

describe("FrontMatterForm", () => {
  it("renders all three sections", () => {
    const onChange = vi.fn()
    render(<FrontMatterForm values={defaultValues()} onChange={onChange} />)

    expect(screen.getByText("Cover")).toBeInTheDocument()
    expect(screen.getByText("Document Control")).toBeInTheDocument()
    expect(screen.getByText("Table of Contents")).toBeInTheDocument()
  })

  it("renders a signature slot per declared approver role", () => {
    const onChange = vi.fn()
    render(<FrontMatterForm values={defaultValues()} onChange={onChange} />)

    for (const role of APPROVER_ROLES) {
      // Each role produces two inputs (name + company). Check both exist.
      const nameInputs = screen.getAllByRole("textbox", {
        name: new RegExp(`${role} name`, "i"),
      })
      expect(nameInputs.length).toBeGreaterThanOrEqual(1)
    }
  })

  it("states that an unsupplied signature renders a ruled box, never the typed name", () => {
    const onChange = vi.fn()
    const { container } = render(
      <FrontMatterForm values={defaultValues()} onChange={onChange} />
    )

    // Each SignatureSlot has this text in a <p>
    const statements = container.querySelectorAll(
      '[data-slot="front-matter-form"] p'
    )
    const ruledBoxStatements = Array.from(statements).filter((el) =>
      /unsupplied signature renders a ruled box/i.test(el.textContent ?? "")
    )
    expect(ruledBoxStatements.length).toBe(APPROVER_ROLES.length)
  })

  it("enumerates the document-number placeholder set", () => {
    const onChange = vi.fn()
    const { container } = render(
      <FrontMatterForm values={defaultValues()} onChange={onChange} />
    )

    // The placeholder descriptions are rendered somewhere in the form
    const html = container.innerHTML
    for (const ph of ["{template}", "{year}", "{month}", "{run}"]) {
      expect(html).toContain(ph)
    }
    // Descriptions are present
    expect(html).toContain("Report profile identifier")
    expect(html).toContain("Period start year")
    expect(html).toContain("Run identifier")
  })

  it("validates document-number pattern on the step: rejects undeclared placeholder", () => {
    const onChange = vi.fn()
    const vals: FrontMatterFormValues = {
      ...defaultValues(),
      document_control: {
        ...defaultValues().document_control,
        document_number_pattern: "RPT/{quarter}/{run}",
      },
    }
    render(<FrontMatterForm values={vals} onChange={onChange} />)

    const alerts = screen.getAllByRole("alert")
    const undeclaredAlert = alerts.find((el) =>
      /undeclared placeholder/i.test(el.textContent ?? "")
    )
    expect(undeclaredAlert).toBeDefined()
  })

  it("validates document-number pattern on the step: rejects no varying placeholder", () => {
    const onChange = vi.fn()
    const vals: FrontMatterFormValues = {
      ...defaultValues(),
      document_control: {
        ...defaultValues().document_control,
        document_number_pattern: "RPT/{template}/{year}{month}",
      },
    }
    render(<FrontMatterForm values={vals} onChange={onChange} />)

    const alerts = screen.getAllByRole("alert")
    const varyingAlert = alerts.find((el) =>
      /must include at least one of/i.test(el.textContent ?? "")
    )
    expect(varyingAlert).toBeDefined()
  })

  it("passes validation for a valid pattern", () => {
    const onChange = vi.fn()
    const vals: FrontMatterFormValues = {
      ...defaultValues(),
      document_control: {
        ...defaultValues().document_control,
        document_number_pattern: "RPT/{template}/{year}{month}/{run}",
      },
    }
    const { container } = render(
      <FrontMatterForm values={vals} onChange={onChange} />
    )

    // No alert within the form for the pattern
    const alerts = container.querySelectorAll('[role="alert"]')
    expect(alerts.length).toBe(0)
  })

  it("calls onChange when a field is edited", () => {
    const onChange = vi.fn()
    const { container } = render(
      <FrontMatterForm values={defaultValues()} onChange={onChange} />
    )

    // Target the subtitle input specifically by its max-length
    const subtitleInput = container.querySelector(
      `input[placeholder="Optional subtitle"]`
    ) as HTMLInputElement
    expect(subtitleInput).not.toBeNull()
    fireEvent.change(subtitleInput, { target: { value: "My Subtitle" } })

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        cover: expect.objectContaining({ subtitle: "My Subtitle" }),
      })
    )
  })

  it("presents TOC as 'retained and not emitted' when approach is none", () => {
    if (TOC_ADOPTED_APPROACH === "none") {
      const onChange = vi.fn()
      render(<FrontMatterForm values={defaultValues()} onChange={onChange} />)
      expect(screen.getByText(/retained.*not emitted/i)).toBeInTheDocument()
    } else {
      // Current state: approach is adopted, so no "retained" badge
      const onChange = vi.fn()
      render(<FrontMatterForm values={defaultValues()} onChange={onChange} />)
      expect(
        screen.queryByText(/retained.*not emitted/i)
      ).not.toBeInTheDocument()
    }
  })

  it("is presented as a fixed section with data-slot attribute", () => {
    const onChange = vi.fn()
    const { container } = render(
      <FrontMatterForm values={defaultValues()} onChange={onChange} />
    )

    const region = container.querySelector('[data-slot="front-matter-form"]')
    expect(region).not.toBeNull()
    expect(region?.getAttribute("role")).toBe("region")
    expect(region?.getAttribute("aria-label")).toBe(
      "Front matter configuration"
    )
  })
})

// ---------------------------------------------------------------------------
// BlockPalette — no cover, no document control, no TOC
// ---------------------------------------------------------------------------

describe("BlockPalette", () => {
  it("has NO palette entry for cover", () => {
    const allTypes = PALETTE_GROUPS.flatMap((g) => g.entries.map((e) => e.type))
    expect(allTypes).not.toContain("cover")
  })

  it("has NO palette entry for document_control or toc (they are not block types)", () => {
    const allTypes = PALETTE_GROUPS.flatMap((g) => g.entries.map((e) => e.type))
    expect(allTypes).not.toContain("document_control")
    expect(allTypes).not.toContain("toc")
  })

  it("first entry in the palette is a content block (heading), not cover", () => {
    const firstEntry = PALETTE_GROUPS[0].entries[0]
    expect(firstEntry.type).toBe("heading")
  })

  it("renders without cover in the DOM", () => {
    const onInsert = vi.fn()
    render(<BlockPalette onInsert={onInsert} />)

    const buttons = screen.getAllByRole("button")
    const blockTypes = buttons.map((b) => b.getAttribute("data-block-type"))
    expect(blockTypes).not.toContain("cover")
  })
})
