import { describe, expect, test } from "vitest"

import { answerPlainText, parseAnswer } from "@/lib/chat/views"

describe("parseAnswer — the two runtime markers", () => {
  test("a figure becomes a figure segment with its fact id", () => {
    expect(parseAnswer("CPU averaged ⟦fig:f3⟧8.06%⟦/fig⟧ in August.")).toEqual([
      { kind: "text", text: "CPU averaged " },
      { kind: "figure", factId: "f3", text: "8.06%" },
      { kind: "text", text: " in August." },
    ])
  })

  test("an estimate nests its own figures", () => {
    expect(parseAnswer("⟦est⟧About ⟦fig:f1⟧USD 0.228 per 1 Hour⟦/fig⟧ × 730.⟦/est⟧")).toEqual([
      {
        kind: "estimate",
        children: [
          { kind: "text", text: "About " },
          { kind: "figure", factId: "f1", text: "USD 0.228 per 1 Hour" },
          { kind: "text", text: " × 730." },
        ],
      },
    ])
  })

  test("an estimate still open while streaming is shown, and stray marker characters are dropped", () => {
    expect(parseAnswer("Roughly ⟦est⟧half of ⟦fig:f2⟧19.74%")).toEqual([
      { kind: "text", text: "Roughly " },
      { kind: "estimate", children: [{ kind: "text", text: "half of fig:f219.74%" }] },
    ])
  })

  test("markup-looking text stays text", () => {
    const text = '<img src=x onerror="alert(1)"> and <script>steal()</script>'
    expect(parseAnswer(text)).toEqual([{ kind: "text", text }])
  })

  test("plain text drops the markers and keeps the verified strings", () => {
    expect(answerPlainText("CPU ⟦fig:f1⟧8.06%⟦/fig⟧, ⟦est⟧about half⟦/est⟧.")).toBe(
      "CPU 8.06%, about half."
    )
  })
})
