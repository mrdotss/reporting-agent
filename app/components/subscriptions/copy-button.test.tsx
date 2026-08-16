import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { CopyButton } from "./copy-button"

/**
 * The artifact copy control (Requirement 11.6's surface).
 *
 * Two claims, and only two:
 *
 *   * **What lands on the clipboard is exactly the `value` handed in.** The script a
 *     customer runs has to be the script that was reviewed on screen, character for
 *     character — a control that trimmed or re-templated it would put an untested
 *     transformation between the generator's property test and a privileged command
 *     line.
 *   * **The outcome is announced.** A copy is invisible: nothing changes except this
 *     control's own glyph, so a screen-reader user has no way to know the click did
 *     anything. The failure path matters more than the success one, because a
 *     browser can refuse `writeText` for reasons the visitor cannot fix and
 *     "nothing happened" is the worst possible answer to that.
 */

const ARTIFACT =
  "#!/usr/bin/env bash\nset -euo pipefail\n\nSCOPE='/subscriptions/x'\n"

afterEach(cleanup)

describe("CopyButton", () => {
  test("it places the value on the clipboard verbatim", async () => {
    const user = userEvent.setup()

    render(<CopyButton value={ARTIFACT} label="Copy the az CLI script" />)

    await user.click(
      screen.getByRole("button", { name: "Copy the az CLI script" })
    )

    // Read back through the same API the component wrote through, so the assertion
    // is about the clipboard's contents rather than about the call's arguments.
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(ARTIFACT)
    })
  })

  test("the label is the accessible name, because two of these share a step", async () => {
    render(<CopyButton value={ARTIFACT} label="Copy the ARM template" />)

    // A step renders both artifacts, and two controls both named "Copy" are
    // indistinguishable in a list of buttons — which is why the prop is required
    // rather than defaulted.
    expect(
      screen.getByRole("button", { name: "Copy the ARM template" })
    ).toBeInTheDocument()
  })

  test("success is announced through a live region", async () => {
    const user = userEvent.setup()

    render(<CopyButton value={ARTIFACT} label="Copy the az CLI script" />)

    const region = screen.getByRole("status")

    // The region exists before it has content, so the announcement lands on an
    // element the assistive technology is already observing.
    expect(region).toHaveAttribute("aria-live", "polite")
    expect(region.textContent).toBe("")

    await user.click(screen.getByRole("button"))

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/copied/i)
    })
  })

  test("a refused clipboard says what to do instead", async () => {
    const user = userEvent.setup()

    // An insecure origin, a denied permission, an embedded webview: the visitor
    // cannot fix any of them, so the control has to point at the way round.
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new Error("denied")
    )

    render(<CopyButton value={ARTIFACT} label="Copy the az CLI script" />)

    await user.click(screen.getByRole("button"))

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(
        /select the text above and copy it/i
      )
    })

    // And it does not claim success.
    expect(screen.getByRole("status").textContent).not.toMatch(/copied/i)

    vi.restoreAllMocks()
  })
})
