import { describe, expect, test } from "vitest"

import {
  addTallies,
  answerFigures,
  estimateCount,
  figureNumbers,
  tallyFigures,
  tallyLine,
} from "@/lib/chat/figures"
import type { ChatCitation } from "@/lib/chat/views"

const citation = (factId: string, source: string): ChatCitation => ({
  fact_id: factId,
  source,
  label: factId,
  formatted: factId,
})

describe("answerFigures", () => {
  const text =
    "⟦fig:f7⟧6.2%⟦/fig⟧ then ⟦fig:f2⟧10⟦/fig⟧, again ⟦fig:f7⟧6.2%⟦/fig⟧, ⟦est⟧about ⟦fig:f9⟧$70⟦/fig⟧⟦/est⟧."

  test("numbers each figure by first appearance and repeats keep their number", () => {
    const figures = answerFigures(text, {})
    expect(figures.map((f) => [f.number, f.factId])).toEqual([
      [1, "f7"],
      [2, "f2"],
      [3, "f9"],
    ])
  })

  test("carries the printed string and the citation", () => {
    const figures = answerFigures("⟦fig:f1⟧8.06%⟦/fig⟧", {
      f1: citation("f1", "report"),
    })
    expect(figures).toEqual([
      {
        number: 1,
        factId: "f1",
        text: "8.06%",
        citation: citation("f1", "report"),
      },
    ])
  })

  test("a figure with no recorded source has no citation", () => {
    expect(answerFigures("⟦fig:f1⟧1⟦/fig⟧", {})[0]?.citation).toBeUndefined()
  })

  test("text with no markers has no figures, and a half-streamed marker is not one", () => {
    expect(answerFigures("Nothing cited here.", {})).toEqual([])
    expect(answerFigures("so far ⟦fig:f1⟧8.0", {})).toEqual([])
  })

  test("figureNumbers maps ids to numbers", () => {
    const numbers = figureNumbers(
      answerFigures("⟦fig:f4⟧a⟦/fig⟧ ⟦fig:f1⟧b⟦/fig⟧", {})
    )
    expect(numbers.get("f4")).toBe(1)
    expect(numbers.get("f1")).toBe(2)
  })
})

describe("the tally", () => {
  test("counts estimates by their opening marker", () => {
    expect(estimateCount("⟦est⟧a⟦/est⟧ and ⟦est⟧b⟦/est⟧")).toBe(2)
    expect(estimateCount("none")).toBe(0)
  })

  test("splits traced, live and unsourced figures", () => {
    const figures = answerFigures(
      "⟦fig:f1⟧a⟦/fig⟧⟦fig:f2⟧b⟦/fig⟧⟦fig:f3⟧c⟦/fig⟧⟦fig:f4⟧d⟦/fig⟧",
      {
        f1: citation("f1", "report"),
        f2: citation("f2", "live"),
        f3: citation("f3", "price"),
      }
    )
    expect(tallyFigures(figures, 2)).toEqual({
      traced: 2,
      live: 1,
      unsourced: 1,
      estimates: 2,
    })
  })

  test("the line names only what the answer holds", () => {
    expect(tallyLine({ traced: 4, live: 1, unsourced: 0, estimates: 4 })).toBe(
      "4 traced · 1 live · 4 estimates"
    )
    expect(tallyLine({ traced: 1, live: 0, unsourced: 0, estimates: 1 })).toBe(
      "1 traced · 1 estimate"
    )
    expect(tallyLine({ traced: 0, live: 0, unsourced: 0, estimates: 0 })).toBe(
      "No figures cited"
    )
    expect(tallyLine({ traced: 0, live: 0, unsourced: 2, estimates: 0 })).toBe(
      "2 without a source"
    )
  })

  test("tallies add", () => {
    expect(
      addTallies(
        { traced: 1, live: 2, unsourced: 3, estimates: 4 },
        { traced: 1, live: 1, unsourced: 1, estimates: 1 }
      )
    ).toEqual({ traced: 2, live: 3, unsourced: 4, estimates: 5 })
  })
})
