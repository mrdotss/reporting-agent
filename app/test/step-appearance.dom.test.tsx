/**
 * The wizard's Appearance step — the chart half.
 *
 * The one behaviour here that is not visible in `chart-styles.test.ts`: the preview cards
 * are set in the **selected** face, so choosing a font re-draws all six rather than only
 * restyling the three font buttons. That was asked for explicitly, and it is the kind of
 * wiring that looks done in a screenshot of the default state and is not.
 */

import { cleanup, render, screen, fireEvent, within } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"

import { StepAppearance } from "@/components/templates/step-appearance"
import { CHART_FONT_STACKS } from "@/lib/profiles/chart-styles"
import {
  CHART_FONTS,
  CHART_STYLES,
  type TemplateDefinition,
} from "@/lib/templates/definition"

// The repo's DOM convention: `screen` reads `document.body`, so a render left standing
// makes the next test's query ambiguous rather than failing where the mistake is.
afterEach(cleanup)

function baseDefinition(): TemplateDefinition {
  return {
    schema_version: 3,
    provider: "azure",
    identity: { name: "Contoso", language: "en" },
    period: { kind: "month", year: 2026, month: 8, timezone: "Asia/Jakarta" },
    // A complete `design`, because the step embeds `StepDesign` for the theme block and
    // that reads `number_format` — which the validator requires on every v3 profile, so a
    // partial one here would be testing a definition the app cannot store.
    design: {
      preset: "editorial",
      accent_color: "#1f6f78",
      density: "normal",
      table_style: "hairline",
      page_size: "A4",
      cover_page: true,
      logo: null,
      number_format: {
        decimal_places: 2,
        group_thousands: true,
        decimal_separator: ".",
        grouping_separator: ",",
      },
    },
    front_matter: {},
    sections: [],
  } as unknown as TemplateDefinition
}

/** The step is controlled, so a test needs the state the wizard would hold. */
function Harness({ onDefinition }: { onDefinition?: (d: TemplateDefinition) => void }) {
  const [definition, setDefinition] = useState<TemplateDefinition>(baseDefinition)
  return (
    <StepAppearance
      definition={definition}
      onChange={(next) => {
        setDefinition(next)
        onDefinition?.(next)
      }}
      thumbnails={[]}
    />
  )
}

/** Scoped to their own radiogroup, always. The step also embeds the theme picker, whose
 * options are radios too, and an unscoped `getByRole("radio", ...)` matches across all
 * three groups — which is a test that passes for the wrong reason on a good day. */
function styles() {
  return within(screen.getByRole("radiogroup", { name: "Chart design" }))
}

function fonts() {
  return within(screen.getByRole("radiogroup", { name: "Chart font" }))
}

function styleCards() {
  return styles().getAllByRole("radio")
}

function fontButtons() {
  return fonts().getAllByRole("radio")
}

/** Every preview's resolved face, read off the SVG the card draws. */
function previewFaces(container: HTMLElement): string[] {
  return [...container.querySelectorAll("svg[role='img']")].map(
    (svg) => (svg as SVGElement).style.fontFamily
  )
}

describe("the chart design cards", () => {
  it("offers exactly the styles a profile may name, with stacked selected by default", () => {
    render(<Harness />)
    const cards = styleCards()
    expect(cards).toHaveLength(CHART_STYLES.length)

    const checked = cards.filter((card) => card.getAttribute("aria-checked") === "true")
    expect(checked).toHaveLength(1)
    expect(checked[0]).toHaveTextContent("Stacked panels")
  })

  it("writes the chosen style into the definition's design", () => {
    let latest: TemplateDefinition | undefined
    render(<Harness onDefinition={(d) => (latest = d)} />)

    fireEvent.click(styles().getByRole("radio", { name: /Range band/ }))

    const design = (latest as unknown as { design: Record<string, unknown> }).design
    expect(design.chart_style).toBe("range_band")
    // And it patches rather than replaces: the accent the consultant already chose is
    // still there. Replacing `design` wholesale is the defect the Brand resolution used
    // to hide, because something downstream put the missing keys back.
    expect(design.accent_color).toBe("#1f6f78")
  })

  it("marks the one style whose preview carries a bitmap", () => {
    render(<Harness />)
    const flagged = styleCards().filter((card) =>
      within(card).queryByText(/Bitmap/i)
    )
    expect(flagged).toHaveLength(1)
    expect(flagged[0]).toHaveTextContent("Soft area")
  })
})

describe("the chart font", () => {
  it("offers exactly the faces a profile may name", () => {
    render(<Harness />)
    expect(fontButtons()).toHaveLength(CHART_FONTS.length)
  })

  it("writes the chosen face into the definition's design", () => {
    let latest: TemplateDefinition | undefined
    render(<Harness onDefinition={(d) => (latest = d)} />)

    fireEvent.click(fonts().getByRole("radio", { name: /Monospace/ }))

    expect(
      (latest as unknown as { design: Record<string, unknown> }).design.chart_font
    ).toBe("monospace")
  })

  it("re-draws every style preview in the selected face", () => {
    const { container } = render(<Harness />)

    // The default. Six previews, all in the grotesque stack.
    const before = previewFaces(container)
    expect(before).toHaveLength(CHART_STYLES.length)
    expect(new Set(before)).toEqual(new Set([CHART_FONT_STACKS.grotesque]))

    fireEvent.click(fonts().getByRole("radio", { name: /Monospace/ }))

    const after = previewFaces(container)
    expect(after).toHaveLength(CHART_STYLES.length)
    expect(new Set(after)).toEqual(new Set([CHART_FONT_STACKS.monospace]))

    // And back, through the third face — so this is the selection driving the previews
    // rather than one hard-coded branch that happens to move.
    fireEvent.click(fonts().getByRole("radio", { name: /Document/ }))
    expect(new Set(previewFaces(container))).toEqual(
      new Set([CHART_FONT_STACKS.document])
    )
  })
})
