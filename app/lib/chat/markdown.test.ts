import { describe, expect, test } from "vitest"

import { parseInline, parseMarkdown } from "@/lib/chat/markdown"
import { parseAnswer } from "@/lib/chat/views"

describe("parseMarkdown — the little of Markdown an answer uses", () => {
  test("a pipe table becomes a table, header, alignment and rows", () => {
    const [block] = parseMarkdown(
      [
        "| VM | Avg CPU | Max CPU |",
        "|:---|---:|:---:|",
        "| CPN-App | ⟦fig:f1⟧0.18%⟦/fig⟧ | ⟦fig:f2⟧27.31%⟦/fig⟧ |",
        "| CPN-MCP | ⟦fig:f3⟧1.11%⟦/fig⟧ | ⟦fig:f4⟧43.91%⟦/fig⟧ |",
      ].join("\n")
    )

    expect(block).toMatchObject({
      kind: "table",
      header: ["VM", "Avg CPU", "Max CPU"],
      align: ["left", "right", "center"],
    })
    expect(block.kind === "table" && block.rows).toHaveLength(2)
    // The figure markers survive into the cell, where the chip renderer takes them.
    const cell = block.kind === "table" ? block.rows[0][1] : ""
    expect(parseAnswer(cell)).toEqual([{ kind: "figure", factId: "f1", text: "0.18%" }])
  })

  test("headings, lists and rules", () => {
    const blocks = parseMarkdown(
      ["## Virtual machines", "", "- first item", "- second item", "", "---", "", "1. one", "2. two"].join(
        "\n"
      )
    )
    expect(blocks).toEqual([
      { kind: "heading", level: 2, text: "Virtual machines" },
      { kind: "list", ordered: false, items: ["first item", "second item"] },
      { kind: "rule" },
      { kind: "list", ordered: true, items: ["one", "two"] },
    ])
  })

  test("a wrapped list item keeps its continuation line", () => {
    const [block] = parseMarkdown("- the machine is idle\n  most of the month\n- the next one")
    expect(block).toEqual({
      kind: "list",
      ordered: false,
      items: ["the machine is idle most of the month", "the next one"],
    })
  })

  test("a chart marker, a quote and a fenced block each stand alone", () => {
    expect(parseMarkdown("⟦chart:c1⟧")).toEqual([{ kind: "chart", id: "c1" }])
    expect(parseMarkdown("> mind the gap")).toEqual([{ kind: "quote", text: "mind the gap" }])
    expect(parseMarkdown("```\nsoffice --headless\n```")).toEqual([
      { kind: "code", text: "soffice --headless" },
    ])
  })

  test("an unfinished table still renders the rows that arrived", () => {
    const [block] = parseMarkdown("| VM | Avg |\n|---|---|\n| CPN-App | 0.18% |\n| CPN-MC")
    expect(block.kind === "table" && block.rows).toEqual([["CPN-App", "0.18%"], ["CPN-MC"]])
  })

  test("blank lines separate paragraphs, and a single newline does not", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { kind: "paragraph", text: "one\ntwo" },
      { kind: "paragraph", text: "three" },
    ])
  })
})

describe("parseInline — emphasis inside a run of text", () => {
  test("bold, italic and code", () => {
    expect(parseInline("**Virtual Machines** run *fast* on `Standard_B2als_v2`")).toEqual([
      { kind: "strong", text: "Virtual Machines" },
      { kind: "plain", text: " run " },
      { kind: "emphasis", text: "fast" },
      { kind: "plain", text: " on " },
      { kind: "code", text: "Standard_B2als_v2" },
    ])
  })

  test("an underscore inside a name is not emphasis", () => {
    expect(parseInline("Standard_D2s_v3 and snake_case_name")).toEqual([
      { kind: "plain", text: "Standard_D2s_v3 and snake_case_name" },
    ])
  })

  test("a lone asterisk is left alone", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ kind: "plain", text: "2 * 3 = 6" }])
  })
})
