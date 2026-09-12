import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { RunFilters, RunPagination } from "./run-filters"

const push = vi.fn()
let search = ""

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(search),
}))

afterEach(() => {
  cleanup()
  push.mockClear()
  search = ""
  vi.useRealTimers()
})

const COUNTS = { all: 31, completed: 6, failed: 25, running: 0 }

function renderFilters(overrides: Partial<Parameters<typeof RunFilters>[0]> = {}) {
  return render(
    <RunFilters total={31} shown={25} offset={0} counts={COUNTS} {...overrides} />
  )
}

/**
 * The pager is its own component now, and its own render here.
 *
 * It used to sit inside the toolbar, which put "Previous / 1 of 5 / Next" *above* the
 * rows it pages through. Both halves still read and write the same query string, so
 * the split duplicates no state — which is what these two suites, sharing one set of
 * URL assertions, are here to keep true.
 */
function renderPager(
  overrides: Partial<Parameters<typeof RunPagination>[0]> = {}
) {
  return render(
    <RunPagination total={31} offset={0} pageSize={25} {...overrides} />
  )
}

/**
 * The run toolbar (task 2.2).
 *
 * Every filter is a URL change, because the page reads them on the server — the
 * list pages and filters in SQL. So what these assert is the URL each control
 * produces, not local state it might have kept.
 */

describe("filters travel in the URL", () => {
  test("a status chip sets the param and returns to the first page", () => {
    search = "page=3"
    renderFilters({ offset: 50 })

    fireEvent.click(screen.getByRole("button", { name: /^Failed/ }))

    expect(push).toHaveBeenCalledTimes(1)
    const [url] = push.mock.calls[0] as [string]
    expect(url).toContain("status=failed")
    // Staying on page three of a narrower result is how a filter appears to
    // have found nothing.
    expect(url).not.toContain("page=")
  })

  test("the All chip clears the param rather than setting status=all", () => {
    search = "status=failed"
    renderFilters()

    fireEvent.click(screen.getByRole("button", { name: /^All/ }))

    const [url] = push.mock.calls[0] as [string]
    expect(url).not.toContain("status=")
  })

  test("search commits on a debounce, not on every keystroke", () => {
    vi.useFakeTimers()
    renderFilters()

    fireEvent.change(screen.getByLabelText(/search runs/i), {
      target: { value: "enesis" },
    })
    expect(push).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)
    const [url] = push.mock.calls[0] as [string]
    expect(url).toContain("q=enesis")
  })
})

describe("the toolbar states the range", () => {
  test("against the true total, not the page size", () => {
    renderFilters({ total: 31, shown: 25, offset: 0 })
    expect(screen.getByText("1–25 / 31")).toBeInTheDocument()
  })
})

describe("the pager", () => {
  test("is absent when everything fits on one page", () => {
    renderPager({ total: 12 })
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument()
  })

  test("Previous is disabled on the first page and Next on the last", () => {
    renderPager({ total: 31, offset: 0 })
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled()

    cleanup()
    renderPager({ total: 31, offset: 25 })
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled()
  })

  test("it is not part of the toolbar", () => {
    // The whole point of the split: the filters render without a pager in them.
    renderFilters({ total: 31, shown: 25, offset: 0 })
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Previous" })
    ).not.toBeInTheDocument()
  })
})
