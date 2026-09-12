import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"

import { DIGEST_VISIBLE, Identifier } from "./identifier"

afterEach(cleanup)

/** A real masked subscription id: a uuid with the last four characters kept. */
const MASKED = `${"*".repeat(32)}95a4`
const DIGEST = "d9662f168e5412ab7c039f4e82b1cc7a15d0e6b93f2a8471cc09ee55d3b6a2f10"

describe("the identifier", () => {
  test("a masked id draws the mask rather than printing it", () => {
    // The defect: 32 identical characters rendered literally, three times on one page.
    const { container } = render(<Identifier value={MASKED} kind="mask" />)
    const visible = [...container.querySelectorAll("[aria-hidden='true']")]
      .map((node) => node.textContent ?? "")
      .join("")

    expect(visible).toContain("95a4")
    expect(visible).not.toContain("****")
    expect(visible.length).toBeLessThan(12)
  })

  test("a mask that kept its separators is still drawn as a mask", () => {
    // `maskSubscriptionId` replaces a fixed count of leading characters, so whether
    // the uuid's hyphens survive depends on where the count lands. Both shapes exist
    // in this codebase, and stripping only the first run of asterisks left
    // `-****-****-****-********` on screen.
    const hyphenated = "********-****-****-****-********3301"
    const { container } = render(<Identifier value={hyphenated} kind="mask" />)
    const visible = [...container.querySelectorAll("[aria-hidden='true']")]
      .map((node) => node.textContent ?? "")
      .join("")

    expect(visible).toContain("3301")
    expect(visible).not.toContain("*")
    expect(visible).not.toContain("-")
  })

  test("it reveals nothing the value did not already reveal", () => {
    // The masking is the server's. This shortens the meaningless half and must never
    // widen what is shown — so the visible text is a subset of the value it was given.
    const { container } = render(<Identifier value={MASKED} kind="mask" />)
    const visible = [...container.querySelectorAll("[aria-hidden='true']")]
      .map((node) => node.textContent ?? "")
      .join("")
      .replace(/[•]/g, "")

    expect(MASKED).toContain(visible)
  })

  test("the whole value stays available to a reader that is not looking", () => {
    render(<Identifier value={MASKED} kind="mask" label="Subscription" />)
    expect(screen.getByText(`Subscription: ${MASKED}`)).toBeTruthy()
  })

  test("a digest is truncated to one length, wherever it appears", () => {
    // Five call sites sliced digests to 12, 24, 12, 12 and a local constant. A digest
    // at four different lengths in one app reads as four different kinds of thing.
    const { container } = render(<Identifier value={DIGEST} kind="digest" />)
    const visible = (
      container.querySelector("[aria-hidden='true']")?.textContent ?? ""
    ).trim()

    expect(visible).toBe(DIGEST.slice(0, DIGEST_VISIBLE))
    expect(container.textContent).toContain(DIGEST)
  })

  test("it is set in the figures face", () => {
    // Identifiers line up in columns and get compared character by character. That is
    // what mono and tabular figures are for.
    const { container } = render(<Identifier value={DIGEST} kind="digest" />)
    const node = container.querySelector('[data-slot="identifier"]')!
    expect(node.className).toContain("font-mono")
    expect(node.className).toContain("tabular-nums")
  })
})
