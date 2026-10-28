import { describe, expect, test } from "vitest"

import type { PageRun } from "@/lib/builder/store"

import { layoutTiles, readMinutes } from "./page-strip"

/** The page strip's numbering: each run's first and last page, and the tile cap. */

const run = (key: string, pages: number): PageRun => ({ key, label: key, pages })

describe("layoutTiles", () => {
  test("numbers pages across runs", () => {
    expect(layoutTiles([run("cover", 1), run("a", 3), run("b", 2)]).map((row) => [row.first, row.last, row.tiles])).toEqual([
      [1, 1, 1],
      [2, 4, 3],
      [5, 6, 2],
    ])
  })

  test("stops drawing tiles at 48 but keeps counting", () => {
    const rows = layoutTiles([run("a", 40), run("b", 20), run("c", 5)])
    expect(rows.map((row) => row.tiles)).toEqual([40, 8, 0])
    expect(rows.at(-1)?.last).toBe(65)
  })
})

describe("readMinutes", () => {
  test("about half a minute a page, never under one", () => {
    expect([1, 7, 18].map(readMinutes)).toEqual([1, 4, 10])
  })
})
