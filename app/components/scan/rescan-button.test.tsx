import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import { RescanButton } from "./rescan-button"

const refresh = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}))

/**
 * The "Re-scan" control (task: post-v3 bug fix).
 *
 * It was a native `<form method="post" action="/api/subscriptions/[id]/scan">`,
 * which cannot work: a native form POST sends `application/x-www-form-urlencoded`
 * and the route parses its body with `readJsonBody`, so every press answered
 * `400 MALFORMED_BODY` — and because a form POST is a navigation, the browser
 * RENDERED that JSON error as the page. The scan never ran, so the page it
 * returned to showed no resources, which reads as an empty subscription rather
 * than a broken button.
 *
 * The content type is therefore the load-bearing assertion here, not an
 * implementation detail.
 */

beforeEach(() => {
  refresh.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubFetch(response: Partial<Response> & { json?: () => unknown }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
    ...response,
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("RescanButton", () => {
  test("POSTs application/json with an empty object body", async () => {
    const fetchMock = stubFetch({ ok: true })

    render(<RescanButton subscriptionId="sub-1" language="en" />)
    fireEvent.click(screen.getByRole("button", { name: "Re-scan" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe("/api/subscriptions/sub-1/scan")
    expect(init.method).toBe("POST")
    // The whole point: the route's `readJsonBody` must be handed JSON. A form
    // POST's urlencoded body is what produced MALFORMED_BODY.
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" })
    // `scanPostBodySchema` is `z.object({}).strict()` — an empty object, sent
    // explicitly rather than omitted.
    expect(init.body).toBe("{}")
  })

  test("percent-encodes the subscription id into the path", async () => {
    const fetchMock = stubFetch({ ok: true })

    render(<RescanButton subscriptionId="a/b?c" language="en" />)
    fireEvent.click(screen.getByRole("button", { name: "Re-scan" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "/api/subscriptions/a%2Fb%3Fc/scan"
    )
  })

  test("refreshes the page on success rather than reloading the window", async () => {
    stubFetch({ ok: true })

    render(<RescanButton subscriptionId="sub-1" language="en" />)
    fireEvent.click(screen.getByRole("button", { name: "Re-scan" }))

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })

  test("surfaces the route's own error message, not a generic one", async () => {
    // SCOPE_UNVERIFIED / SECRET_EXPIRED carry the only actionable text there is;
    // replacing them with a generic failure would discard it.
    stubFetch({
      ok: false,
      json: async () => ({
        error: {
          message:
            "This subscription's client secret has expired. Rotate the secret before scanning.",
          code: "SECRET_EXPIRED",
        },
      }),
    })

    render(<RescanButton subscriptionId="sub-1" language="en" />)
    fireEvent.click(screen.getByRole("button", { name: "Re-scan" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /client secret has expired/
    )
    expect(refresh).not.toHaveBeenCalled()
  })

  test("falls back to the catalog message when the error body is not JSON", async () => {
    stubFetch({
      ok: false,
      json: async () => {
        throw new Error("not json")
      },
    })

    render(<RescanButton subscriptionId="sub-1" language="en" />)
    fireEvent.click(screen.getByRole("button", { name: "Re-scan" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The scan could not be started."
    )
  })

  test("reports a network failure instead of silently doing nothing", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"))
    vi.stubGlobal("fetch", fetchMock)

    render(<RescanButton subscriptionId="sub-1" language="en" />)
    fireEvent.click(screen.getByRole("button", { name: "Re-scan" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Check your connection/
    )
  })

  test("renders the Indonesian label when the language is id", () => {
    stubFetch({ ok: true })
    render(<RescanButton subscriptionId="sub-1" language="id" />)
    expect(
      screen.getByRole("button", { name: "Pindai ulang" })
    ).toBeInTheDocument()
  })
})
