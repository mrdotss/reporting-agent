import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"

import { DocumentPreview } from "./document-preview"
import type { SectionCatalogueEntry } from "./step-sections"
import { SAMPLE_KPIS, SAMPLE_ROWS } from "@/lib/profiles/preview-sample"
import type { TemplateDefinition } from "@/lib/templates/definition"

afterEach(cleanup)

/**
 * The design sample, and the line it must not cross.
 *
 * It exists because the rail used to open on a dashed box reading "Render a preview and
 * the composed page appears here" — a panel describing itself. It fills that space with
 * something drawn from the choices a consultant is making, over declared sample figures.
 *
 * The risk it carries is the mirror of its usefulness: a page that looks like a report
 * and is not one. So the tests below are mostly about the labelling, and one of them
 * asserts a thing that cannot be configured away.
 */

const CATALOGUE: readonly SectionCatalogueEntry[] = [
  {
    key: "vm_inventory",
    number: 1,
    title_id: "section.vm_inventory.title",
    group: "inventory",
    position: "free",
    repeatable: false,
    needs_resource_types: [],
    needs_fact_sources: [],
    metric_bearing: false,
  },
]

function draft(overrides: Record<string, unknown> = {}): TemplateDefinition {
  return {
    schema_version: 3,
    identity: {
      name: "FATechID",
      report_title: "Monthly infrastructure",
      customer_name: "Enesis",
      language: "en",
    },
    scope: {},
    period: { kind: "last_full_month" },
    metrics: {},
    blocks: [],
    sections: [{ id: "sec_1", type: "vm_inventory" }],
    design: {
      preset: "corporate",
      accent_color: "#1f6f78",
      density: "normal",
      table_style: "banded",
      number_format: { decimal_places: 2, group_thousands: true },
      cover_page: true,
      logo: null,
      page_size: "A4",
    },
    front_matter: {
      document_control: { document_name: "Monthly Infrastructure Report" },
    },
    ...overrides,
  } as unknown as TemplateDefinition
}

describe("the design sample", () => {
  test("it says it is a sample, twice, with no control that hides it", () => {
    // Once above the page and once in the page footer, so a screenshot of either half
    // carries the disclaimer. Both are rendered unconditionally — there is no prop that
    // suppresses them and no state they depend on.
    const { container } = render(
      <DocumentPreview definition={draft()} sectionCatalogue={CATALOGUE} />
    )

    expect(screen.getByText(/A4 · sample figures/)).toBeTruthy()
    expect(screen.getByText(/Sample figures · Corporate/)).toBeTruthy()
    expect(container.textContent).toContain("Nothing here is collected data")

    // Nothing offers to dismiss either.
    expect(container.querySelectorAll("button")).toHaveLength(0)
  })

  test("a long profile is counted past the page edge, never clipped", () => {
    // The page is a fixed proportion, so the contents list cannot simply grow. A
    // fourteen-section profile used to run its last entry through the bottom edge and
    // render it sliced in half. A page holds what fits and says how much it did not.
    const many = Array.from({ length: 14 }, (_, index) => ({
      id: `sec_${index}`,
      type: "vm_inventory",
    }))
    const { container } = render(
      <DocumentPreview
        definition={draft({ sections: many })}
        sectionCatalogue={CATALOGUE}
      />
    )

    const entries = container.querySelectorAll(
      '[data-slot="document-preview-page"] ol li'
    )
    expect(entries.length).toBeLessThan(many.length)
    expect(container.textContent).toContain(
      `and ${many.length - entries.length} more sections`
    )
  })

  test("a profile that fits says nothing about overflow", () => {
    const { container } = render(
      <DocumentPreview definition={draft()} sectionCatalogue={CATALOGUE} />
    )
    expect(container.textContent ?? "").not.toMatch(/\bmore sections?\b/)
  })

  test("it never claims to be the delivered document", () => {
    // Requirement 14.6 reserves that claim for the real `.pdf`. This surface is a
    // picture of a theme; a sentence here promising the delivered result would be the
    // product's central invariant broken in the one place nobody re-reads.
    const { container } = render(
      <DocumentPreview definition={draft()} sectionCatalogue={CATALOGUE} />
    )
    const text = container.textContent ?? ""

    expect(text).not.toMatch(/what you will receive|delivered result|the document itself will/i)
    // And it states no page count — a browser does not lay out Word's columns.
    expect(text).not.toMatch(/page \d+ of \d+/i)
  })

  test("the figures on it are the declared sample and nothing else", () => {
    const { container } = render(
      <DocumentPreview definition={draft()} sectionCatalogue={CATALOGUE} />
    )
    const text = container.textContent ?? ""

    for (const kpi of SAMPLE_KPIS) expect(text).toContain(kpi.value)
    for (const row of SAMPLE_ROWS) expect(text).toContain(row.resource)
  })

  test("the structure on it is the consultant's own", () => {
    // This is what makes it worth looking at rather than a colour swatch: their title,
    // their customer, their document name and the sections they chose, in order.
    const { container } = render(
      <DocumentPreview definition={draft()} sectionCatalogue={CATALOGUE} />
    )
    const text = container.textContent ?? ""

    expect(text).toContain("Monthly infrastructure")
    expect(text).toContain("Enesis")
    expect(text).toContain("Monthly Infrastructure Report")
    expect(text).toContain("Last full month")
  })

  test("a period is named as a rule, never as dates", () => {
    // The window resolves fresh at each run against the customer's zone. Printing
    // "1 – 31 August" would be a specific claim about a report that has not run.
    const { container } = render(
      <DocumentPreview
        definition={draft({ period: { kind: "mtd" } })}
        sectionCatalogue={CATALOGUE}
      />
    )
    expect(container.textContent).toContain("Month to date")
    expect(container.textContent ?? "").not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  test("every appearance choice reaches the page", () => {
    // The reason this panel exists. A choice that changes nothing visible here is a
    // control a consultant cannot evaluate, which is the state step 5 was in.
    const page = () =>
      document.querySelector('[data-slot="document-preview-page"]') as HTMLElement

    const { rerender } = render(
      <DocumentPreview definition={draft()} sectionCatalogue={CATALOGUE} />
    )
    expect(page().dataset).toMatchObject({
      preset: "corporate",
      density: "normal",
      tableStyle: "banded",
      pageSize: "A4",
    })
    const a4Ratio = page().style.aspectRatio

    rerender(
      <DocumentPreview
        definition={draft({
          design: {
            ...(draft().design as object),
            preset: "editorial",
            density: "compact",
            table_style: "bordered",
            page_size: "Letter",
          },
        })}
        sectionCatalogue={CATALOGUE}
      />
    )
    expect(page().dataset).toMatchObject({
      preset: "editorial",
      density: "compact",
      tableStyle: "bordered",
      pageSize: "Letter",
    })
    // Letter is squarer than A4 — the proportion is the whole point of the page size.
    expect(page().style.aspectRatio).not.toEqual(a4Ratio)
    expect(page().style.fontFamily).toContain("Liberation Serif")
  })

  test("changing the table style replaces every edge, not some of them", () => {
    // Written after React warned about a `border` shorthand mixed with a `borderBottom`
    // longhand. The order the two are applied in is not guaranteed across a re-render,
    // so switching away from `bordered` left its side rules behind — a table wearing
    // half of a style nobody had selected.
    const cell = () =>
      document.querySelector(
        '[data-slot="document-preview-page"] tbody td'
      ) as HTMLElement

    const bordered = {
      ...(draft().design as object),
      table_style: "bordered",
    }
    const { rerender } = render(
      <DocumentPreview
        definition={draft({ design: bordered })}
        sectionCatalogue={CATALOGUE}
      />
    )
    expect(cell().style.borderLeftStyle).toBe("solid")

    rerender(
      <DocumentPreview
        definition={draft({
          design: { ...bordered, table_style: "hairline" },
        })}
        sectionCatalogue={CATALOGUE}
      />
    )
    expect(cell().style.borderLeftStyle).toBe("none")
    expect(cell().style.borderRightStyle).toBe("none")
    expect(cell().style.borderBottomStyle).toBe("solid")
  })

  test("the accent colours the page rather than sitting in a swatch", () => {
    const { container } = render(
      <DocumentPreview
        definition={draft({
          design: { ...(draft().design as object), accent_color: "#945a31" },
        })}
        sectionCatalogue={CATALOGUE}
      />
    )
    const heading = container.querySelector("h4")!
    expect(heading.style.color).toBe("rgb(148, 90, 49)")
  })

  test("it survives a draft that has barely been started", () => {
    // The rail opens at step 2. A profile at that point has a name and almost nothing
    // else, and a preview that throws on a half-filled draft is worse than no preview.
    expect(() =>
      render(
        <DocumentPreview
          definition={{ schema_version: 3 } as unknown as TemplateDefinition}
          sectionCatalogue={[]}
        />
      )
    ).not.toThrow()
  })

  test("a chart is drawn, by the engine the runtime draws with", () => {
    const { container } = render(
      <DocumentPreview definition={draft()} sectionCatalogue={CATALOGUE} />
    )
    const svg = container.querySelector("svg")
    expect(svg).not.toBeNull()
    // ECharts numbers its instances, and two on one page collide on their clip-path
    // references. The prefix is per-surface for that reason.
    expect(container.innerHTML).not.toMatch(/zr\d+/)
  })

  test("switching the cover off is visible here", () => {
    const band = () =>
      (
        document.querySelector(
          '[data-slot="document-preview-page"] > div'
        ) as HTMLElement
      ).style.borderTop

    const { rerender } = render(
      <DocumentPreview definition={draft()} sectionCatalogue={CATALOGUE} />
    )
    const withCover = band()

    rerender(
      <DocumentPreview
        definition={draft({ front_matter: { cover: { enabled: false } } })}
        sectionCatalogue={CATALOGUE}
      />
    )
    expect(band()).not.toEqual(withCover)
  })
})

describe("the sample itself", () => {
  test("no figure on it is round", () => {
    // Round numbers read as placeholders, and a consultant stops judging whether the
    // column widths hold. Every figure carries a fraction or an odd count.
    for (const row of SAMPLE_ROWS) {
      for (const value of [row.average, row.peak, row.memory]) {
        expect(value).toMatch(/\.\d/)
        expect(value).not.toMatch(/\.00?\b/)
      }
    }
  })

  test("a KPI and the table agree where they name the same thing", () => {
    // They sit on one page. A sample whose headline average contradicts its own first
    // row is a sample that teaches a consultant to distrust the panel.
    const average = SAMPLE_KPIS.find((kpi) => kpi.label === "Average CPU")!
    expect(average.value).toBe(SAMPLE_ROWS[0].average)
  })
})
