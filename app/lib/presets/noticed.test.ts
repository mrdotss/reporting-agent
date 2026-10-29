import { describe, expect, test } from "vitest"

import { noticedSegments } from "./noticed"

describe("noticedSegments", () => {
  test("marks phrases in reading order and keeps every character", () => {
    const text = "A monthly report for the finance team: what we run, what sits idle, and what has no backup."
    const segments = noticedSegments(text)
    expect(segments.map((segment) => segment.text).join("")).toBe(text)
    expect(segments.filter((segment) => segment.marked).map((segment) => [segment.text, segment.order])).toEqual([
      ["monthly report", 0],
      ["finance team", 1],
      ["what we run", 2],
      ["sits idle", 3],
      ["no backup", 4],
    ])
  })

  test("prefers the longer phrase and matches whole words only", () => {
    const marked = noticedSegments("Backups and a six-month trend; trendy idleness")
      .filter((segment) => segment.marked)
      .map((segment) => segment.text)
    expect(marked).toEqual(["Backups", "six-month trend"])
  })

  test("reads Indonesian descriptions too", () => {
    const marked = noticedSegments("Laporan bulanan untuk tim keuangan: apa yang belum punya cadangan.")
      .filter((segment) => segment.marked)
      .map((segment) => segment.text)
    expect(marked).toEqual(["Laporan bulanan", "tim keuangan", "cadangan"])
  })

  test("caps the number of marks and returns plain text when nothing matches", () => {
    expect(noticedSegments("finance finance finance", 2).filter((segment) => segment.marked)).toHaveLength(2)
    expect(noticedSegments("Something else entirely")).toEqual([{ text: "Something else entirely", marked: false, order: -1 }])
    expect(noticedSegments("")).toEqual([])
  })
})
