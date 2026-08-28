import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { StepDocument } from "./step-document"
import type { TemplateDefinition } from "@/lib/templates/definition"
import type { ThemeThumbnail } from "@/lib/templates/theme-thumbnails"

afterEach(cleanup)

/**
 * Step 4 — Document (task 7.3's follow-on bug fix).
 *
 * `wizard-shell.tsx`'s "4 Document" step rendered `StepMetrics` — a v1/v2
 * metric picker that reads `definition.metrics`, a field a v3 definition does
 * not carry at all — until this fix. `StepDocument` is the real front-matter
 * step: it reads and writes `definition.front_matter`, the field the v3
 * validator actually requires.
 */

/**
 * The four cards the preset picker renders. `src: null` is a legitimate state
 * (Requirement 13.8 — the card says the image is unavailable and stays
 * selectable), so these exercise the picker without needing real PNG bytes.
 */
const THUMBNAILS: readonly ThemeThumbnail[] = [
  { preset: "editorial", src: null, unavailableReason: "absent" },
  { preset: "corporate", src: null, unavailableReason: "absent" },
  { preset: "technical", src: null, unavailableReason: "absent" },
  { preset: "minimal", src: null, unavailableReason: "absent" },
]

function v3Definition(frontMatter?: unknown): TemplateDefinition {
  return {
    schema_version: 3,
    identity: { name: "Test", description: "", report_title: "Test" },
    front_matter: frontMatter,
    // `design` is required at every schema version
    // (`REQUIRED_TOP_LEVEL_KEYS`), and step 4 now renders `StepDesign` over it.
    design: {
      preset: "editorial",
      accent_color: "#1f6f78",
      density: "normal",
      table_style: "hairline",
      number_format: { decimal_places: 2, group_thousands: true },
      cover_page: true,
      logo: null,
      page_size: "A4",
    },
  } as unknown as TemplateDefinition
}

describe("StepDocument reads a v3 definition's front_matter, not metrics", () => {
  test("renders the front-matter sections with no front_matter present at all", () => {
    render(
      <StepDocument
        definition={v3Definition(undefined)}
        onChange={() => {}}
        thumbnails={THUMBNAILS}
      />
    )

    expect(screen.getByText("Cover")).toBeInTheDocument()
    expect(screen.getByText("Document Control")).toBeInTheDocument()
    expect(screen.getByText("Table of Contents")).toBeInTheDocument()
  })

  test("shows a stored cover subtitle", () => {
    render(
      <StepDocument
        definition={v3Definition({
          cover: { subtitle: "Monthly review" },
          document_control: {},
          toc: {},
        })}
        onChange={() => {}}
        thumbnails={THUMBNAILS}
      />
    )

    expect(screen.getByDisplayValue("Monthly review")).toBeInTheDocument()
  })

  test("editing the cover subtitle writes front_matter, never metrics or blocks", () => {
    const onChange = vi.fn()
    render(
      <StepDocument
        definition={v3Definition({ cover: {}, document_control: {}, toc: {} })}
        onChange={onChange}
        thumbnails={THUMBNAILS}
      />
    )

    fireEvent.change(screen.getByPlaceholderText("Optional subtitle"), {
      target: { value: "Q3 Report" },
    })

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]![0] as Record<string, unknown>
    expect(next).not.toHaveProperty("metrics")
    expect(next).not.toHaveProperty("blocks")
    expect(next).not.toHaveProperty("scope")
    const frontMatter = next.front_matter as { cover: { subtitle: string } }
    expect(frontMatter.cover.subtitle).toBe("Q3 Report")
  })

  test("adding a distribution row round-trips as {recipient, company, note}", () => {
    const onChange = vi.fn()
    render(
      <StepDocument
        definition={v3Definition({ cover: {}, document_control: {}, toc: {} })}
        onChange={onChange}
        thumbnails={THUMBNAILS}
      />
    )

    fireEvent.click(screen.getByText("Add recipient"))

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]![0] as {
      front_matter: { document_control: { distribution: unknown[] } }
    }
    expect(next.front_matter.document_control.distribution).toEqual([
      { recipient: "", company: "", note: "" },
    ])
  })

  test("never writes confidentiality_notice_id -- it is Brand-only at v3", () => {
    const onChange = vi.fn()
    render(
      <StepDocument
        definition={v3Definition({ cover: {}, document_control: {}, toc: {} })}
        onChange={onChange}
        thumbnails={THUMBNAILS}
      />
    )

    fireEvent.click(screen.getByText("Add recipient"))

    const next = onChange.mock.calls[0]![0] as {
      front_matter: { document_control: Record<string, unknown> }
    }
    expect(next.front_matter.document_control).not.toHaveProperty(
      "confidentiality_notice_id"
    )
  })
})
