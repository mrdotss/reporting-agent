import { StrictMode } from "react"
import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import {
  type DesignSpec,
  type TemplateDefinition,
} from "@/lib/templates/definition"

import { StepDesign, formatSampleFigure } from "./step-design"

afterEach(cleanup)

/**
 * The separator controls and sample figure in the design step (Requirement 16.9).
 *
 * Three concerns:
 * 1. The sample figure renders with the declared format.
 * 2. The default resolves from `identity.language`.
 * 3. `formatSampleFigure` produces the correct output for known values.
 */

const BASE_DESIGN: DesignSpec = {
  preset: "corporate",
  accent_color: "#1f6f78",
  density: "normal",
  table_style: "hairline",
  number_format: {
    decimal_places: 2,
    group_thousands: true,
  },
  cover_page: true,
  logo: null,
  page_size: "A4",
}

function makeDefinition(
  overrides: Partial<{
    language: "en" | "id"
    number_format: DesignSpec["number_format"]
  }> = {}
): TemplateDefinition {
  return {
    schema_version: 2,
    identity: {
      name: "Test Template",
      language: overrides.language ?? "en",
    },
    scope: { resource_types: [] },
    period: { months: 1 },
    metrics: [],
    blocks: [],
    design: {
      ...BASE_DESIGN,
      number_format: overrides.number_format ?? BASE_DESIGN.number_format,
    },
  } as unknown as TemplateDefinition
}

describe("StepDesign separator controls", () => {
  test("renders the separator fieldset with preview", () => {
    render(
      <StrictMode>
        <StepDesign
          definition={makeDefinition()}
          onChange={() => {}}
          thumbnails={[]}
        />
      </StrictMode>
    )

    expect(
      screen.getByText("Number separators")
    ).toBeInTheDocument()
    expect(
      screen.getByLabelText("Sample figures in the declared number format")
    ).toBeInTheDocument()
  })

  test("sample shows en defaults (period decimal, comma grouping)", () => {
    render(
      <StepDesign
        definition={makeDefinition({ language: "en" })}
        onChange={() => {}}
        thumbnails={[]}
      />
    )

    const preview = screen.getByLabelText(
      "Sample figures in the declared number format"
    )
    // 462.81 at 2 decimal places, grouped => "462.81 GB"
    expect(preview.textContent).toContain("462.81 GB")
    // 1234567.5 at 2 decimal places, grouped => "1,234,567.50 B"
    expect(preview.textContent).toContain("1,234,567.50 B")
  })

  test("sample shows id defaults (comma decimal, period grouping)", () => {
    render(
      <StepDesign
        definition={makeDefinition({ language: "id" })}
        onChange={() => {}}
        thumbnails={[]}
      />
    )

    const preview = screen.getByLabelText(
      "Sample figures in the declared number format"
    )
    // 462.81 at 2 decimal places, grouped => "462,81 GB"
    expect(preview.textContent).toContain("462,81 GB")
    // 1234567.5 at 2 decimal places, grouped => "1.234.567,50 B"
    expect(preview.textContent).toContain("1.234.567,50 B")
  })

  test("declared separators override language defaults", () => {
    render(
      <StepDesign
        definition={makeDefinition({
          language: "en",
          number_format: {
            decimal_places: 2,
            group_thousands: true,
            decimal_separator: ",",
            grouping_separator: ".",
          },
        })}
        onChange={() => {}}
        thumbnails={[]}
      />
    )

    const preview = screen.getByLabelText(
      "Sample figures in the declared number format"
    )
    // Overridden to comma-decimal, period-grouping
    expect(preview.textContent).toContain("462,81 GB")
    expect(preview.textContent).toContain("1.234.567,50 B")
  })
})

describe("formatSampleFigure", () => {
  test("0.58 with en defaults at 2dp", () => {
    expect(
      formatSampleFigure(0.58, {
        decimalPlaces: 2,
        groupThousands: true,
        decimalSeparator: ".",
        groupingSeparator: ",",
      })
    ).toBe("0.58")
  })

  test("0.58 with id defaults at 2dp", () => {
    expect(
      formatSampleFigure(0.58, {
        decimalPlaces: 2,
        groupThousands: true,
        decimalSeparator: ",",
        groupingSeparator: ".",
      })
    ).toBe("0,58")
  })

  test("462.81 with id defaults at 2dp", () => {
    expect(
      formatSampleFigure(462.81, {
        decimalPlaces: 2,
        groupThousands: true,
        decimalSeparator: ",",
        groupingSeparator: ".",
      })
    ).toBe("462,81")
  })

  test("1234567.5 with en defaults at 2dp grouped", () => {
    expect(
      formatSampleFigure(1234567.5, {
        decimalPlaces: 2,
        groupThousands: true,
        decimalSeparator: ".",
        groupingSeparator: ",",
      })
    ).toBe("1,234,567.50")
  })

  test("1234567.5 with grouping disabled", () => {
    expect(
      formatSampleFigure(1234567.5, {
        decimalPlaces: 2,
        groupThousands: false,
        decimalSeparator: ".",
        groupingSeparator: ",",
      })
    ).toBe("1234567.50")
  })

  test("0 decimal places shows no fraction", () => {
    expect(
      formatSampleFigure(462.81, {
        decimalPlaces: 0,
        groupThousands: false,
        decimalSeparator: ".",
        groupingSeparator: ",",
      })
    ).toBe("463")
  })

  test("negative value", () => {
    expect(
      formatSampleFigure(-1234.5, {
        decimalPlaces: 1,
        groupThousands: true,
        decimalSeparator: ".",
        groupingSeparator: ",",
      })
    ).toBe("-1,234.5")
  })

  test("grouping only on integer part with 3 or fewer digits: no grouping", () => {
    expect(
      formatSampleFigure(123.456, {
        decimalPlaces: 3,
        groupThousands: true,
        decimalSeparator: ".",
        groupingSeparator: ",",
      })
    ).toBe("123.456")
  })

  test("apostrophe grouping separator", () => {
    expect(
      formatSampleFigure(1234567.5, {
        decimalPlaces: 2,
        groupThousands: true,
        decimalSeparator: ".",
        groupingSeparator: "\u2019",
      })
    ).toBe("1\u2019234\u2019567.50")
  })
})
