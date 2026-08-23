import { describe, expect, test } from "vitest"

import {
  MessageInterpolationError,
  messageText,
} from "@/lib/messages/catalog"

/**
 * Interpolation behaviour for `messageText` (task 6.6).
 *
 * The contract: when `params` is supplied, the placeholder set of the resolved
 * message must exactly equal the parameter set. A mismatch in either direction
 * raises `MessageInterpolationError` naming the id and both sets. A call with no
 * params returns the raw string unchanged — backward compatible with every
 * existing call site.
 */

describe("messageText interpolation", () => {
  test("no params returns the raw template string unchanged", () => {
    const result = messageText("doc.chart.other_series", "en")

    expect(result).toBe("Other ({count} series)")
  })

  test("matching params interpolates correctly", () => {
    const result = messageText("doc.chart.other_series", "en", { count: "3" })

    expect(result).toBe("Other (3 series)")
  })

  test("numeric param values are stringified", () => {
    const result = messageText("doc.chart.other_series", "en", { count: 7 })

    expect(result).toBe("Other (7 series)")
  })

  test("interpolation works with Indonesian", () => {
    const result = messageText("doc.chart.other_series", "id", { count: 5 })

    expect(result).toBe("Lainnya (5 seri)")
  })

  test("extra caller parameter raises MessageInterpolationError", () => {
    expect(() =>
      messageText("doc.chart.other_series", "en", {
        count: "3",
        extra: "bad",
      })
    ).toThrow(MessageInterpolationError)

    try {
      messageText("doc.chart.other_series", "en", {
        count: "3",
        extra: "bad",
      })
    } catch (e) {
      expect(e).toBeInstanceOf(MessageInterpolationError)
      const err = e as MessageInterpolationError
      expect(err.stringId).toBe("doc.chart.other_series")
      expect(err.messagePlaceholders).toEqual(new Set(["count"]))
      expect(err.callerParameters).toEqual(new Set(["count", "extra"]))
    }
  })

  test("wrong parameter name raises MessageInterpolationError", () => {
    expect(() =>
      messageText("doc.chart.other_series", "en", { name: "wrong" })
    ).toThrow(MessageInterpolationError)

    try {
      messageText("doc.chart.other_series", "en", { name: "wrong" })
    } catch (e) {
      const err = e as MessageInterpolationError
      expect(err.messagePlaceholders).toEqual(new Set(["count"]))
      expect(err.callerParameters).toEqual(new Set(["name"]))
    }
  })

  test("params on a message with no placeholders raises", () => {
    expect(() =>
      messageText("doc.chart.empty", "en", { count: "5" })
    ).toThrow(MessageInterpolationError)

    try {
      messageText("doc.chart.empty", "en", { count: "5" })
    } catch (e) {
      const err = e as MessageInterpolationError
      expect(err.messagePlaceholders).toEqual(new Set())
      expect(err.callerParameters).toEqual(new Set(["count"]))
    }
  })

  test("MessageInterpolationError is an Error", () => {
    const err = new MessageInterpolationError(
      "doc.x.y",
      new Set(["a"]),
      new Set(["b"])
    )

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("MessageInterpolationError")
    expect(err.message).toContain("doc.x.y")
    expect(err.message).toContain("a")
    expect(err.message).toContain("b")
  })
})

describe("the three new ids (task 6.6)", () => {
  test("doc.chart.empty is declared with the exact literal value", () => {
    expect(messageText("doc.chart.empty", "en")).toBe(
      "This chart carries no plotted values"
    )
    expect(messageText("doc.chart.empty", "id")).toBeTruthy()
  })

  test("doc.chart.other_series carries the {count} placeholder", () => {
    const en = messageText("doc.chart.other_series", "en")
    const id = messageText("doc.chart.other_series", "id")

    expect(en).toContain("{count}")
    expect(id).toContain("{count}")
  })

  test("doc.preview.notice is declared with the exact literal value including em dash", () => {
    expect(messageText("doc.preview.notice", "en")).toBe(
      "Preview \u2014 rendered from a stored snapshot. Not a verified deliverable."
    )
    expect(messageText("doc.preview.notice", "id")).toBeTruthy()
  })
})
