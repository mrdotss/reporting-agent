import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type {
  ConnectedSubscriptionView,
  TemplateView,
} from "@/lib/db/views"

/**
 * The run form (Requirements 37.1, 37.2, 37.4, 13.7, 13.14).
 *
 * ## Why this file exists
 *
 * **It did not, and that is the whole defect.** Every other component in this
 * directory had a suite; this one shipped without one, and what shipped was a form
 * that submitted three fields to an enqueue requiring five for a
 * `schema_version >= 2` template. `POST /api/runs` answered `EnqueueRejectedError`
 * for every v2 run, and the browser showed `internalError()`'s fixed
 * "The request could not be completed." — so the failure was invisible without
 * reading the server log.
 *
 * Both halves were individually right. `lib/actions/runs.ts` correctly requires the
 * per-run front-matter values once it has resolved which version the run pinned;
 * `lib/runs/input.ts` correctly accepts them as *optional*, because the schema runs
 * before the version is resolved and cannot know yet whether it is v2. The form was
 * correct about what it sent. Nothing asserted that what the form sends satisfies what
 * the enqueue requires — which is the fourth defect in this codebase of exactly that
 * shape (see `tech.md`, "What a green suite does not prove").
 *
 * ## The assertion that matters
 *
 * These tests assert the **submitted body**, not that inputs rendered. A form whose
 * fields all appear and whose body is missing two keys is precisely the state that
 * shipped, and a test reading the DOM would have passed against it. `fetch` is doubled
 * to capture the body.
 *
 * The **round trip** — that this body reaches the real `enqueueRun` without being
 * rejected — is deliberately *not* here. It cannot be: `vitest.config.ts` runs `.tsx`
 * files in the jsdom project and the DB harness in the node project, and the node
 * project has no react plugin, so neither file can import the other's world. It lives
 * in `test/db/run-form-enqueue-round-trip.integration.test.ts`, over the same
 * `buildRunCreateBody` this form calls. That pair is the fix: this file describes what
 * the form sends, that file proves the enqueue accepts it.
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

import { RunForm } from "./run-form"

const NOW_ISO = "2026-08-25T00:00:00.000Z"

function subscription(
  over: Partial<ConnectedSubscriptionView> = {}
): ConnectedSubscriptionView {
  return {
    id: "sub-0001",
    displayName: "Contoso production",
    maskedSubscriptionId: "…c0ffee",
    scopeVerified: true,
    fidelityTier: "baseline",
    secretExpiresAt: "2027-01-01T00:00:00.000Z",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as ConnectedSubscriptionView
}

function template(over: Partial<TemplateView> = {}): TemplateView {
  return {
    id: "tmpl-v1",
    name: "Monthly utilization",
    description: "CPU, memory, disk and network.",
    currentVersion: 3,
    currentVersionSha256: "a".repeat(64),
    hasDraft: false,
    schemaVersion: 1,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-02T00:00:00.000Z",
    ...over,
  }
}

const V1 = template()
const V2 = template({
  id: "tmpl-v2",
  name: "Monthly utilization (with cover)",
  schemaVersion: 2,
})

/** The captured request bodies, in order. */
let bodies: Record<string, unknown>[] = []

beforeEach(() => {
  bodies = []

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      )

      return {
        ok: true,
        json: async () => ({ run: { id: "run-0001" } }),
      } as unknown as Response
    })
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Render with a given template set, selecting the first by default. */
function renderForm(templates: readonly TemplateView[]) {
  return render(
    <RunForm
      subscriptions={[subscription()]}
      templates={templates}
      nowIso={NOW_ISO}
    />
  )
}

/** Fill all four front-matter inputs with valid values. */
function fillFrontMatter(values?: {
  customerName?: string
  revision?: string
  note?: string
  author?: string
}) {
  fireEvent.change(screen.getByLabelText("Customer name"), {
    target: { value: values?.customerName ?? "Contoso Ltd" },
  })
  fireEvent.change(screen.getByLabelText("Revision"), {
    target: { value: values?.revision ?? "1.0" },
  })
  fireEvent.change(screen.getByLabelText("Revision note"), {
    target: { value: values?.note ?? "First issue" },
  })
  fireEvent.change(screen.getByLabelText("Author"), {
    target: { value: values?.author ?? "A. Consultant" },
  })
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /Request a report/,
  }) as HTMLButtonElement
}

// ---------------------------------------------------------------------------

describe("RunForm — a v2 template's per-run front-matter values", () => {
  test("submits customerName and a revisionHistoryRow of exactly revision, note and author", async () => {
    renderForm([V2])
    fillFrontMatter()

    fireEvent.click(submitButton())

    await waitFor(() => expect(bodies).toHaveLength(1))

    // The assertion the missing test would have made. Not "the inputs rendered" —
    // they did, in the shipped defect too; the body is what was wrong.
    expect(bodies[0]).toEqual({
      connectedSubscriptionId: "sub-0001",
      templateId: "tmpl-v2",
      timezone: "Asia/Jakarta",
      customerName: "Contoso Ltd",
      revisionHistoryRow: {
        revision: "1.0",
        note: "First issue",
        author: "A. Consultant",
      },
    })
  })

  test("the revision row carries exactly three keys, so a .strict() schema accepts it", async () => {
    renderForm([V2])
    fillFrontMatter()
    fireEvent.click(submitButton())

    await waitFor(() => expect(bodies).toHaveLength(1))

    // `revisionHistoryRowSchema` is `.strict()`: a fourth key is a rejection, not a
    // silent strip. Asserted as a sorted key list rather than by shape, so an added
    // field fails here rather than at the route.
    expect(
      Object.keys(bodies[0]!.revisionHistoryRow as object).sort()
    ).toEqual(["author", "note", "revision"])
  })

  test("values are trimmed, so whitespace does not travel as content", async () => {
    renderForm([V2])
    fillFrontMatter({
      customerName: "  Contoso Ltd  ",
      revision: " 1.0 ",
      note: "  First issue ",
      author: " A. Consultant  ",
    })
    fireEvent.click(submitButton())

    await waitFor(() => expect(bodies).toHaveLength(1))

    expect(bodies[0]!.customerName).toBe("Contoso Ltd")
    expect(bodies[0]!.revisionHistoryRow).toEqual({
      revision: "1.0",
      note: "First issue",
      author: "A. Consultant",
    })
  })

  test("the four inputs appear", () => {
    renderForm([V2])

    expect(screen.getByLabelText("Customer name")).toBeTruthy()
    expect(screen.getByLabelText("Revision")).toBeTruthy()
    expect(screen.getByLabelText("Revision note")).toBeTruthy()
    expect(screen.getByLabelText("Author")).toBeTruthy()
  })

  test("each input carries the bound its schema declares", () => {
    renderForm([V2])

    // The bounds come from `lib/runs/input.ts`, which is why they are the same
    // numbers the route validates against rather than a second set written here.
    expect(
      screen.getByLabelText("Customer name").getAttribute("maxLength")
    ).toBe("200")
    expect(screen.getByLabelText("Revision").getAttribute("maxLength")).toBe(
      "100"
    )
    expect(
      screen.getByLabelText("Revision note").getAttribute("maxLength")
    ).toBe("500")
    expect(screen.getByLabelText("Author").getAttribute("maxLength")).toBe(
      "200"
    )
  })
})

describe("RunForm — a v1 template answers for no page it does not have", () => {
  test("the four inputs do not appear", () => {
    renderForm([V1])

    expect(screen.queryByLabelText("Customer name")).toBeNull()
    expect(screen.queryByLabelText("Revision")).toBeNull()
    expect(screen.queryByLabelText("Revision note")).toBeNull()
    expect(screen.queryByLabelText("Author")).toBeNull()
  })

  test("the body carries neither customerName nor revisionHistoryRow", async () => {
    renderForm([V1])

    fireEvent.click(submitButton())

    await waitFor(() => expect(bodies).toHaveLength(1))

    // Absent, not empty-string. Both fields are `.optional()` with `min(1)`, so a
    // blank would fail the schema a v1 run has no reason to be answering to.
    expect(bodies[0]).toEqual({
      connectedSubscriptionId: "sub-0001",
      templateId: "tmpl-v1",
      timezone: "Asia/Jakarta",
    })
    expect("customerName" in bodies[0]!).toBe(false)
    expect("revisionHistoryRow" in bodies[0]!).toBe(false)
  })
})

describe("RunForm — changing the selected template", () => {
  test("v1 to v2 reveals the inputs, and back hides them", () => {
    renderForm([V1, V2])

    const select = screen.getByLabelText("Template")

    expect(screen.queryByLabelText("Customer name")).toBeNull()

    fireEvent.change(select, { target: { value: "tmpl-v2" } })
    expect(screen.getByLabelText("Customer name")).toBeTruthy()

    fireEvent.change(select, { target: { value: "tmpl-v1" } })
    expect(screen.queryByLabelText("Customer name")).toBeNull()
  })

  test("switching to v1 after filling the fields sends a v1 body, not a stale v2 one", async () => {
    renderForm([V1, V2])

    const select = screen.getByLabelText("Template")

    fireEvent.change(select, { target: { value: "tmpl-v2" } })
    fillFrontMatter()

    // The values are deliberately retained in state so a consultant who looks away
    // does not lose their typing. What must not happen is them *travelling* on a run
    // whose template has no front matter to print them on.
    fireEvent.change(select, { target: { value: "tmpl-v1" } })
    fireEvent.click(submitButton())

    await waitFor(() => expect(bodies).toHaveLength(1))

    expect("customerName" in bodies[0]!).toBe(false)
    expect("revisionHistoryRow" in bodies[0]!).toBe(false)
  })

  test("switching back to v2 keeps the typed values rather than clearing them", () => {
    renderForm([V1, V2])

    const select = screen.getByLabelText("Template")

    fireEvent.change(select, { target: { value: "tmpl-v2" } })
    fillFrontMatter({ customerName: "Contoso Ltd" })

    fireEvent.change(select, { target: { value: "tmpl-v1" } })
    fireEvent.change(select, { target: { value: "tmpl-v2" } })

    expect(
      (screen.getByLabelText("Customer name") as HTMLInputElement).value
    ).toBe("Contoso Ltd")
  })
})

describe("RunForm — an incomplete v2 submission is refused here, not by the server", () => {
  test("the submit button is disabled while any of the four is empty", () => {
    renderForm([V2])

    expect(submitButton().disabled).toBe(true)

    fillFrontMatter()
    expect(submitButton().disabled).toBe(false)
  })

  test.each([
    ["customerName", "Customer name"],
    ["revision", "Revision"],
    ["note", "Revision note"],
    ["author", "Author"],
  ])(
    "a whitespace-only %s blocks submission client-side",
    (_field, label) => {
      renderForm([V2])
      fillFrontMatter()

      // Whitespace, not empty: an empty field is the obvious case, and three spaces
      // is the one a `!== ""` check would let through and the route would then
      // reject with a message the browser does not display.
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: "   " },
      })

      expect(submitButton().disabled).toBe(true)
    }
  )

  test("no request is made while the fields are incomplete", () => {
    renderForm([V2])

    fireEvent.click(submitButton())

    // Nothing travelled. The point is not that the server would have refused it —
    // it would — but that its refusal is invisible in the browser, so this refusal
    // has to happen where it can be read.
    expect(bodies).toHaveLength(0)
  })

  test("the disabled state says what is missing rather than refusing silently", () => {
    renderForm([V2])

    const hint = screen.getByText(
      /Fill in the customer name, revision, note and author/
    )

    expect(hint).toBeTruthy()
    // Announced, because the button's enabled state is otherwise the only change.
    expect(hint.getAttribute("aria-live")).toBe("polite")
  })

  test("the hint clears once all four are filled", () => {
    renderForm([V2])
    fillFrontMatter()

    expect(
      screen.queryByText(
        /Fill in the customer name, revision, note and author/
      )
    ).toBeNull()
  })

  test("a v1 template shows no front-matter hint, having nothing to fill", () => {
    renderForm([V1])

    expect(
      screen.queryByText(
        /Fill in the customer name, revision, note and author/
      )
    ).toBeNull()
    expect(submitButton().disabled).toBe(false)
  })
})
