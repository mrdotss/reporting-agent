import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { reportArtifactKey, snapshotArtifactKey } from "@/lib/db/views"

import { DownloadCard } from "./download-card"

/**
 * The two download controls, and the moment a URL comes into existence
 * (Requirements 40.1, 40.3, 40.7).
 *
 * `test/db/report-run-end-to-end.integration.test.ts` proves the *set* of controls is a
 * fact about the run row, and that the route refuses to mint for an unproven run. Neither
 * of those can reach the thing this file asserts, because the claim is about a DOM:
 *
 *  * **Exactly two controls**, one per recorded downloadable key, and the snapshot key
 *    that sits in the same array gets none — a control for `snapshot.json` would offer a
 *    consultant a download that is not the report.
 *  * **No URL exists before an activation.** Requirement 40.1 says the URL is minted at
 *    the moment the control is activated rather than at surface render, and 40.3 says none
 *    is placed in a server-rendered payload. The check is therefore an *absence* in the
 *    markup and a *zero* on the fetch counter before the first click.
 *  * **A fresh URL per activation.** Two activations of one control produce two requests,
 *    and the component holds neither result: no `useState` here carries a link, so there
 *    is nothing to re-render a stale credential from.
 *  * **A failed mint keeps the control** (40.7). The failure is a sentence beside the
 *    button rather than a disabled button, because a transient storage error should cost a
 *    retry rather than the ability to download a report that verified.
 *
 * `fetch` is the double, and it is the only one: the component under test is the real one,
 * and `window.location.assign` is replaced because jsdom refuses a navigation.
 */

const ACTOR = "usr_01HQZX8QW9K7YB4T2C3M5N6P7Q"
const RUN = "run_01HQZX8QW9K7YB4T2C3M5N6P7Q"

/**
 * The keys `toRunView` projects for a `completed` run whose verification passed — built
 * through the production builders, so this fixture cannot drift into a key shape the
 * route would not authorize.
 */
const ARTIFACT_KEYS = [
  snapshotArtifactKey(ACTOR, RUN),
  reportArtifactKey(ACTOR, RUN, "report.docx"),
  reportArtifactKey(ACTOR, RUN, "report.pdf"),
]

let requested: string[]
let assigned: string[]
let respond: (key: string) => Response

/** jsdom's own `Location`, kept so `afterEach` can put it back. */
const realLocation = window.location

beforeEach(() => {
  requested = []
  assigned = []
  respond = (key) =>
    new Response(
      JSON.stringify({
        // A nonce, so two mints for one key are distinguishable.
        url: `https://s3.test/${key}?signature=${requested.length}`,
        expiresIn: 300,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )

  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input)
    requested.push(url)
    const key = new URL(url, "https://app.test").searchParams.get("key") ?? ""
    return respond(key)
  })

  // jsdom implements no navigation, so the assignment is captured. Capturing it is also
  // the assertion: the URL is *used* immediately and never stored.
  //
  // `window.location` is replaced wholesale rather than spied on, because jsdom's own
  // `Location` refuses both a spy and a per-property redefinition. `configurable: true`
  // is what lets `restoreLocation` put the original back in `afterEach`.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      ...realLocation,
      href: realLocation.href,
      assign: (url: string | URL) => {
        assigned.push(String(url))
      },
    },
  })
})

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: realLocation,
  })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  cleanup()
})

function controls(): HTMLElement[] {
  return screen.getAllByRole("button")
}

describe("Requirement 40.1 — exactly two controls, and no URL at render", () => {
  test("the two report keys get a control each and the snapshot key gets none", () => {
    render(<DownloadCard artifactKeys={ARTIFACT_KEYS} />)

    expect(controls()).toHaveLength(2)
    expect(screen.getByRole("button", { name: /word document/i })).toBeVisible()
    expect(screen.getByRole("button", { name: /^pdf$/i })).toBeVisible()
    expect(screen.queryByRole("button", { name: /snapshot/i })).toBeNull()
  })

  test("no request is made and no URL appears in the markup before an activation", () => {
    const { container } = render(<DownloadCard artifactKeys={ARTIFACT_KEYS} />)

    expect(requested).toEqual([])
    // Requirement 40.3 — a presigned URL is a credential, and one in a server-rendered
    // payload is a credential in the page source and in whatever cached that response.
    expect(container.innerHTML).not.toContain("https://s3.test")
    expect(container.innerHTML).not.toContain("signature=")
    expect(container.innerHTML).not.toContain("X-Amz-")
    // Not even as an `href`: these are buttons, so there is no link for a browser to
    // prefetch or a user to copy.
    expect(container.querySelectorAll("a")).toHaveLength(0)
  })

  test("a run with no downloadable key renders nothing at all", () => {
    // Requirement 40.4 as this component sees it: `toRunView` hands it no report key for
    // a run whose verification failed or is absent, so the gate is the empty array rather
    // than a prop this component has to honour.
    const { container } = render(
      <DownloadCard artifactKeys={[snapshotArtifactKey(ACTOR, RUN)]} />
    )

    expect(container.querySelector("[data-slot='download-card']")).toBeNull()
    expect(screen.queryAllByRole("button")).toHaveLength(0)
  })
})

describe("Requirement 40.3 — a fresh URL per activation, held nowhere", () => {
  test("each control requests its own key, once, on activation", async () => {
    const user = userEvent.setup()
    render(<DownloadCard artifactKeys={ARTIFACT_KEYS} />)

    await user.click(screen.getByRole("button", { name: /word document/i }))
    await user.click(screen.getByRole("button", { name: /^pdf$/i }))

    expect(requested).toHaveLength(2)
    expect(
      requested.map((url) =>
        new URL(url, "https://app.test").searchParams.get("key")
      )
    ).toEqual([
      reportArtifactKey(ACTOR, RUN, "report.docx"),
      reportArtifactKey(ACTOR, RUN, "report.pdf"),
    ])
    // Each URL was followed immediately rather than kept.
    expect(assigned).toHaveLength(2)
  })

  test("two activations of one control mint two distinct URLs", async () => {
    const user = userEvent.setup()
    const { container } = render(<DownloadCard artifactKeys={ARTIFACT_KEYS} />)

    const docx = screen.getByRole("button", { name: /word document/i })
    await user.click(docx)
    await user.click(docx)

    expect(requested).toHaveLength(2)
    expect(assigned[0]).not.toBe(assigned[1])
    // And neither survives into the DOM afterwards — the fetched URL is a local `const`
    // inside the handler, so there is no state a later render could put it back from.
    expect(container.innerHTML).not.toContain("signature=")
  })
})

describe("Requirement 40.7 — a failed mint keeps the control", () => {
  test("the refusal is stated and the control is still activatable", async () => {
    const user = userEvent.setup()
    // What the route answers for a run whose verification is fail or absent: not found,
    // with no URL and no indication of whether the artifact exists.
    respond = () =>
      new Response(JSON.stringify({ error: { message: "Not found." } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })

    render(<DownloadCard artifactKeys={ARTIFACT_KEYS} />)
    const docx = screen.getByRole("button", { name: /word document/i })
    await user.click(docx)

    const notice = await screen.findByText(/unavailable for download/i)
    expect(notice).toBeVisible()
    expect(notice.getAttribute("aria-live")).toBe("polite")
    expect(assigned).toEqual([])

    // Still two controls, neither disabled, and a second activation is made.
    expect(controls()).toHaveLength(2)
    expect(docx).not.toBeDisabled()
    await user.click(docx)
    expect(requested).toHaveLength(2)
  })
})
