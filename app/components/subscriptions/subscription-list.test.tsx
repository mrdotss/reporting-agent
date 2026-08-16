import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import type { ConnectedSubscriptionView } from "@/lib/db/views"
import { expiryWarningText } from "@/lib/subscriptions/state"

/**
 * The subscriptions screen's rows (Requirements 10.2, 13.2, 13.3, 13.6).
 *
 * ## What is real
 *
 * The list, the banner, the notices and `resolveSubscriptionState` are the
 * production code. Nothing computes a state for this file to render — the fixtures
 * are `ConnectedSubscriptionView`s and an injected `now`, exactly what the page
 * passes, so the state on screen is the one the enqueue and reaper gates reject
 * from. A test that handed the list a pre-resolved state would assert only that a
 * component can render a string it was given, and would keep passing after the
 * banner and the gate started disagreeing about the same row.
 *
 * `next/navigation` is doubled because `RotateSecretDialog` — the one client leaf
 * below the list — reads the router. That is the whole seam.
 *
 * ## Why `now` is a fixture rather than the clock
 *
 * Every case here is a statement about a boundary: 30 days out, 31 days out, at the
 * expiry, past it, and `disabled` while the recorded date is still in the future.
 * None of those is reachable from "whatever time the suite happened to run at", and
 * the last one is precisely the case a real clock cannot produce.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

import { SubscriptionList } from "./subscription-list"

// --- Fixtures ---------------------------------------------------------------

const NOW = new Date("2026-07-01T00:00:00.000Z")

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** The unmasked id never reaches this component — the view carries the mask. */
const MASKED_ID = "********-****-****-****-********3301"

function view(
  overrides: Partial<ConnectedSubscriptionView> = {}
): ConnectedSubscriptionView {
  return {
    id: "row-0001",
    displayName: "Northwind Traders",
    maskedSubscriptionId: MASKED_ID,
    scopeVerified: true,
    secretExpiresAt: new Date(NOW.getTime() + 400 * MS_PER_DAY).toISOString(),
    fidelityTier: "baseline",
    status: "active",
    ...overrides,
  }
}

/** A view whose recorded expiry sits `days` (plus an hour) after `NOW`. */
function expiringIn(days: number): ConnectedSubscriptionView {
  return view({
    secretExpiresAt: new Date(
      NOW.getTime() + days * MS_PER_DAY + 60 * 60 * 1000
    ).toISOString(),
  })
}

function renderList(subscriptions: readonly ConnectedSubscriptionView[]): void {
  render(<SubscriptionList subscriptions={subscriptions} now={NOW} />)
}

function banner(): Element | null {
  return document.querySelector('[data-slot="secret-expiry-banner"]')
}

function expiredNotice(): Element | null {
  return document.querySelector('[data-slot="secret-expired-notice"]')
}

function row(): Element | null {
  return document.querySelector('[data-slot="subscription-row"]')
}

afterEach(cleanup)

// ---------------------------------------------------------------------------

describe("Requirement 13.2 — the approaching-expiry warning", () => {
  test("it appears inside the 30-day window and names the whole days remaining", () => {
    renderList([expiringIn(7)])

    const warning = document.querySelector(
      '[data-slot="secret-expiry-warning"]'
    )
    expect(warning).not.toBeNull()

    // Two assertions, and they fail for different reasons. The first is that the
    // sentence comes from `expiryWarningText` rather than being composed here —
    // the same warning appears on the run screens, and two components phrasing the
    // count differently is two products as far as the reader is concerned. The
    // second pins the sentence itself, so a change to that function is caught too.
    expect(warning?.textContent).toBe(expiryWarningText(7))
    expect(warning?.textContent).toBe("This client secret expires in 7 days.")
  })

  test("it appears exactly at the 30-day boundary and not a millisecond before", () => {
    // The window is `now >= secretExpiresAt - 30d`, so an expiry exactly 30 days
    // out is *already* warning — the boundary is inclusive.
    renderList([
      view({
        secretExpiresAt: new Date(
          NOW.getTime() + 30 * MS_PER_DAY
        ).toISOString(),
      }),
    ])
    expect(banner()).not.toBeNull()

    cleanup()

    // One millisecond further out, and it is not. Non-vacuity for every assertion
    // in this describe: a list that always rendered the banner would satisfy them
    // all, and so would one that keyed on the wrong side of the comparison.
    renderList([
      view({
        secretExpiresAt: new Date(
          NOW.getTime() + 30 * MS_PER_DAY + 1
        ).toISOString(),
      }),
    ])
    expect(banner()).toBeNull()
  })

  test("nothing dismisses it", () => {
    renderList([expiringIn(3)])

    const region = banner()
    expect(region).not.toBeNull()

    // Requirement 13.2's "no control that dismisses that warning", asserted
    // structurally: there is no control inside the region at all, so there is
    // nothing a later edit could wire a dismissal to. The rotate control is a
    // sibling, not a child — it is the remedy, not an acknowledgement.
    expect(region?.querySelectorAll("button")).toHaveLength(0)
    expect(region?.querySelectorAll("a")).toHaveLength(0)
    expect(region?.querySelectorAll("[hidden]")).toHaveLength(0)
    expect(document.querySelectorAll("[data-dismiss]")).toHaveLength(0)
  })

  test("the remedy is offered beside it", () => {
    renderList([expiringIn(3)])

    // Rotation is the only thing that resolves the warning, so the screen has to
    // offer it — outside the banner, whose text is the one sentence the
    // requirement names.
    expect(
      screen.getByRole("button", { name: /rotate the secret/i })
    ).toBeInTheDocument()
  })
})

describe("Requirement 13.6 — --destructive is reserved for the expired state", () => {
  test("the approaching-expiry banner carries no destructive token", () => {
    renderList([expiringIn(3)])

    // Mist neutrals: `--muted`, `--border`, `--muted-foreground`. A secret with
    // three days left is a working secret — `subscriptionRunBlocker` lets runs
    // through on it — and red here would spend the one token that means *this
    // document could not be proven*.
    const markup = banner()?.outerHTML ?? ""

    expect(markup).not.toMatch(/destructive/)
    expect(markup).toMatch(/bg-muted/)
    expect(markup).toMatch(/text-muted-foreground/)
  })

  test("the row's state badge is not destructive while merely expiring", () => {
    renderList([expiringIn(3)])

    expect(row()?.getAttribute("data-state")).toBe("expiring")
    expect(expiredNotice()).toBeNull()
  })

  test("the expired notice does carry it", () => {
    renderList([
      view({ secretExpiresAt: new Date(NOW.getTime()).toISOString() }),
    ])

    // The other half of the reservation. Asserting only the absence above would
    // pass for a screen that never used the token at all.
    expect(expiredNotice()?.outerHTML ?? "").toMatch(/destructive/)
  })
})

describe("Requirement 13.3 — the expired state, and the rotation it offers", () => {
  test("an expiry at the current instant reads as expired", () => {
    // "At or after", not after: a row whose expiry equals `now` is expired.
    renderList([view({ secretExpiresAt: NOW.toISOString() })])

    expect(row()?.getAttribute("data-state")).toBe("expired")
    expect(expiredNotice()).not.toBeNull()
    expect(banner()).toBeNull()
    expect(
      screen.getByRole("button", { name: /rotate the secret/i })
    ).toBeInTheDocument()
  })

  test("a past expiry says runs are blocked, and why an empty report is the danger", () => {
    renderList([
      view({
        secretExpiresAt: new Date(NOW.getTime() - 5 * MS_PER_DAY).toISOString(),
      }),
    ])

    const copy = expiredNotice()?.textContent ?? ""

    expect(copy).toMatch(/expired/i)
    expect(copy).toMatch(/blocked/i)
    // The reason this state is loud: zero resources means zero figures, which
    // means zero unverifiable figures — a clean pass on every other gate.
    expect(copy).toMatch(/no resources at all/i)
    expect(copy).toMatch(/empty report/i)
  })

  test("a disabled row reads as expired even though its recorded date is in the future", () => {
    // Requirement 13.9's row, and the case that makes `disabled` outrank the
    // recorded date: the date was typed in by a consultant and Azure has since
    // refused the credential. A screen that checked the date first would show this
    // as healthy for another 400 days.
    renderList([view({ status: "disabled" })])

    expect(row()?.getAttribute("data-state")).toBe("disabled")

    const copy = expiredNotice()?.textContent ?? ""

    expect(copy).toMatch(/Azure rejected this credential as expired/i)
    expect(copy).toMatch(/entered by hand/i)
    expect(
      screen.getByRole("button", { name: /rotate the secret/i })
    ).toBeInTheDocument()
  })
})

describe("Requirement 12.6's surface — an unverified scope is stated, not styled as an error", () => {
  test("a pending row explains the subscription-scope requirement in mist neutrals", () => {
    renderList([view({ status: "pending", scopeVerified: false })])

    expect(row()?.getAttribute("data-state")).toBe("pending")

    const copy = row()?.textContent ?? ""

    expect(copy).toMatch(/has not been proved/i)
    expect(copy).toMatch(/resource group/i)
    expect(copy).toMatch(/blocked/i)

    // Never preflighted is information about coverage, not a failure of this
    // document, so the reserved token stays out of it.
    expect(expiredNotice()).toBeNull()
    expect(screen.queryByText(/scope verified/i)).toBeNull()
  })
})

describe("Requirement 10.2 — only the browser-safe projection is rendered", () => {
  test("the masked id is shown, in mono with tabular numerals", () => {
    renderList([view()])

    const id = document.querySelector('[data-slot="masked-subscription-id"]')

    expect(id?.textContent).toBe(MASKED_ID)
    // Every figure and identifier in this product is set in Geist Mono with
    // tabular numerals, so a column of ids lines up and a differing value does not
    // reflow its row.
    expect(id?.className).toMatch(/\bfont-mono\b/)
    expect(id?.className).toMatch(/\btabular-nums\b/)
  })

  test("no unmasked subscription id can appear, because none is in the props", () => {
    // The projection is what makes this structural: `ConnectedSubscriptionView`
    // carries `maskedSubscriptionId` and no unmasked form, so there is no value for
    // this component to render even by mistake. The mask characters are asserted so
    // the test would fail on a component that stripped them.
    renderList([view()])

    const text = document.body.textContent ?? ""

    expect(text).toContain(MASKED_ID)
    expect(text).not.toMatch(/3f2504e0-4f89-11d3-9a0c-0305e82c3301/)
    expect(text).not.toMatch(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/
    )
  })

  test("the fidelity tier is shown as a badge", () => {
    renderList([view({ fidelityTier: "enhanced" })])

    expect(screen.getByText("enhanced fidelity")).toBeInTheDocument()
  })
})

describe("The empty state", () => {
  test("no connections offers the way to make one", () => {
    renderList([])

    expect(
      document.querySelector('[data-slot="subscription-list-empty"]')
    ).not.toBeNull()

    expect(
      screen.getByRole("link", { name: /connect a subscription/i })
    ).toHaveAttribute("href", "/subscriptions/new")

    // And no row-shaped chrome that would read as a connection.
    expect(row()).toBeNull()
    expect(banner()).toBeNull()
  })

  test("several connections each get their own row and their own state", () => {
    renderList([
      view({ id: "a", displayName: "Alpha" }),
      { ...expiringIn(2), id: "b", displayName: "Beta" },
      view({ id: "c", displayName: "Gamma", status: "disabled" }),
    ])

    const rows = [
      ...document.querySelectorAll('[data-slot="subscription-row"]'),
    ]

    expect(rows).toHaveLength(3)
    expect(rows.map((element) => element.getAttribute("data-state"))).toEqual([
      "active",
      "expiring",
      "disabled",
    ])

    // One list, one accessible name, in the order the store returned them.
    expect(
      screen.getByRole("list", { name: "Connected subscriptions" })
    ).toBeInTheDocument()
  })
})
