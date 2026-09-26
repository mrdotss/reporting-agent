import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
    provider: "azure",
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
    provider: "azure",
    hasIncidentReport: false,
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

/** The captured **submission** bodies, in order. */
let bodies: Record<string, unknown>[] = []
/** The reuse lookups asked, as URLs, in order. */
let lookups: string[] = []

beforeEach(() => {
  bodies = []
  lookups = []

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      // The form asks `GET /api/runs/reusable` as soon as a subscription and a profile
      // are both chosen, to learn whether this period was already collected. Answered
      // here rather than recorded: it carries no body, and counting it among `bodies`
      // made every assertion about what the form *submits* off by one.
      if (String(url).startsWith("/api/runs/reusable")) {
        lookups.push(String(url))
        return {
          ok: true,
          json: async () => ({ candidate: null }),
        } as unknown as Response
      }

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

/** Fill the three front-matter inputs with valid values (Requirement 12.8 —
 * `customerName` is no longer collected here). */
function fillFrontMatter(values?: {
  revision?: string
  note?: string
  author?: string
}) {
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
  test("submits a revisionHistoryRow of exactly revision, note and author, and no customerName", async () => {
    renderForm([V2])
    fillFrontMatter()

    fireEvent.click(submitButton())

    await waitFor(() => expect(bodies).toHaveLength(1))

    // The assertion the missing test would have made. Not "the inputs rendered" —
    // they did, in the shipped defect too; the body is what was wrong.
    //
    // Requirement 12.8, 12.9 — `customerName` is absent, not merely empty: the
    // form no longer collects it at all, and `enqueueRun` now sources it from
    // the pinned version's `identity.customer_name` at schema_version >= 3.
    expect(bodies[0]).toEqual({
      connectedSubscriptionId: "sub-0001",
      templateId: "tmpl-v2",
      timezone: "Asia/Jakarta",
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
      revision: " 1.0 ",
      note: "  First issue ",
      author: " A. Consultant  ",
    })
    fireEvent.click(submitButton())

    await waitFor(() => expect(bodies).toHaveLength(1))

    expect(bodies[0]!.revisionHistoryRow).toEqual({
      revision: "1.0",
      note: "First issue",
      author: "A. Consultant",
    })
  })

  test("the three inputs appear", () => {
    renderForm([V2])

    expect(screen.getByLabelText("Revision")).toBeTruthy()
    expect(screen.getByLabelText("Revision note")).toBeTruthy()
    expect(screen.getByLabelText("Author")).toBeTruthy()
  })

  test("each input carries the bound its schema declares", () => {
    renderForm([V2])

    // The bounds come from `lib/runs/input.ts`, which is why they are the same
    // numbers the route validates against rather than a second set written here.
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
  test("the three inputs do not appear", () => {
    renderForm([V1])

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

/**
 * Choose a report profile from the registry Select.
 *
 * The control used to be a native `<select>`, which a test drove with one
 * `fireEvent.change`. It is a button plus a portalled listbox now — the native popup
 * painted its own colours from the OS and inverted on a theme change, which is the one
 * thing this app's palette could not reach. Driving it the way a person does is also
 * the only way to find out that the listbox actually opens.
 */
function chooseProfile(name: string) {
  fireEvent.click(screen.getByLabelText("Report profile"))

  // Matched on the option's own name line, exactly. `textContent.includes` would
  // resolve "Monthly utilization" to whichever of the two profiles React rendered
  // first, and the whole point of these tests is which one is selected.
  const option = screen
    .getAllByRole("option")
    .find((element) => within(element).queryByText(name) !== null)

  if (option === undefined) {
    throw new Error(`No profile option whose name is exactly "${name}"`)
  }

  // Committed with Enter rather than a click. The listbox opens and the options are in
  // the tree either way, but a synthetic `click` on one is not what the control listens
  // for — it commits on a real pointer sequence that jsdom does not produce, and on the
  // keyboard. Enter on the focused option is a path a person actually uses, and it is
  // the one that works here.
  fireEvent.keyDown(option, { key: "Enter" })
}

describe("RunForm — the controls name things, not identify them", () => {
  test("each trigger shows the name it stands for, never the id", () => {
    // The registry's Select renders the item's *value* by default, and both values here
    // are uuids — so the two controls a consultant chooses with read
    // `1e43c9d7-b90c-4c49-…`, which is the one string on the page nobody can act on.
    // The option markup is two lines, so there is no single text node to lift either;
    // the trigger has to be told how to resolve a value to a label.
    renderForm([V1, V2])

    const connection = screen.getByLabelText("Connection")
    const profile = screen.getByLabelText("Report profile")

    expect(connection.textContent).toContain("Contoso production")
    expect(profile.textContent).toContain(V1.name)

    for (const trigger of [connection, profile]) {
      expect(trigger.textContent ?? "").not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i
      )
      expect(trigger.textContent ?? "").not.toContain("tmpl-")
      expect(trigger.textContent ?? "").not.toContain("sub-")
    }
  })

  test("the chosen name follows the selection", () => {
    renderForm([V1, V2])
    chooseProfile(V2.name)
    expect(screen.getByLabelText("Report profile").textContent).toContain(
      V2.name
    )
  })
})

describe("RunForm — changing the selected template", () => {
  test("v1 to v2 reveals the inputs, and back hides them", () => {
    renderForm([V1, V2])

    expect(screen.queryByLabelText("Revision")).toBeNull()

    chooseProfile(V2.name)
    expect(screen.getByLabelText("Revision")).toBeTruthy()

    chooseProfile(V1.name)
    expect(screen.queryByLabelText("Revision")).toBeNull()
  })

  test("switching to v1 after filling the fields sends a v1 body, not a stale v2 one", async () => {
    renderForm([V1, V2])

    chooseProfile(V2.name)
    fillFrontMatter()

    // The values are deliberately retained in state so a consultant who looks away
    // does not lose their typing. What must not happen is them *travelling* on a run
    // whose template has no front matter to print them on.
    chooseProfile(V1.name)
    fireEvent.click(submitButton())

    await waitFor(() => expect(bodies).toHaveLength(1))

    expect("customerName" in bodies[0]!).toBe(false)
    expect("revisionHistoryRow" in bodies[0]!).toBe(false)
  })

  test("switching back to v2 keeps the typed values rather than clearing them", () => {
    renderForm([V1, V2])

    chooseProfile(V2.name)
    fillFrontMatter({ revision: "1.0" })

    chooseProfile(V1.name)
    chooseProfile(V2.name)

    expect(
      (screen.getByLabelText("Revision") as HTMLInputElement).value
    ).toBe("1.0")
  })
})

describe("RunForm — an incomplete v2 submission is refused here, not by the server", () => {
  test("the submit button is disabled while any of the three is empty", () => {
    renderForm([V2])

    expect(submitButton().disabled).toBe(true)

    fillFrontMatter()
    expect(submitButton().disabled).toBe(false)
  })

  test.each([
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
      /Fill in the revision, note and author/
    )

    expect(hint).toBeTruthy()
    // Announced, because the button's enabled state is otherwise the only change.
    expect(hint.getAttribute("aria-live")).toBe("polite")
  })

  test("the hint clears once all three are filled", () => {
    renderForm([V2])
    fillFrontMatter()

    expect(
      screen.queryByText(
        /Fill in the revision, note and author/
      )
    ).toBeNull()
  })

  test("a v1 template shows no front-matter hint, having nothing to fill", () => {
    renderForm([V1])

    expect(
      screen.queryByText(
        /Fill in the revision, note and author/
      )
    ).toBeNull()
    expect(submitButton().disabled).toBe(false)
  })
})

describe("presets narrow to the selected connector's source", () => {
  // A preset is written for one source, and a run pairs a connector only with presets
  // for the same one. The enqueue refuses a mismatched pair; the form never offers one.
  test("an AWS connector offers only AWS presets", () => {
    render(
      <RunForm
        subscriptions={[
          subscription({ id: "sub-aws", displayName: "AWS production", provider: "aws" }),
        ]}
        templates={[
          template({ id: "tmpl-azure", name: "Azure monthly", provider: "azure" }),
          template({ id: "tmpl-aws", name: "AWS monthly", provider: "aws" }),
        ]}
        nowIso={NOW_ISO}
      />
    )

    expect(screen.getByText(/Showing Amazon Web Services presets/)).toBeInTheDocument()
    expect(screen.queryByText("Azure monthly")).toBeNull()
    expect(screen.getAllByText("AWS monthly").length).toBeGreaterThan(0)
  })

  test("a connector whose source has no preset says so rather than offering another", () => {
    render(
      <RunForm
        subscriptions={[
          subscription({ id: "sub-aws", displayName: "AWS production", provider: "aws" }),
        ]}
        templates={[template({ id: "tmpl-azure", name: "Azure monthly", provider: "azure" })]}
        nowIso={NOW_ISO}
      />
    )

    expect(screen.getByText(/No Amazon Web Services preset yet/)).toBeInTheDocument()
    expect(screen.queryByText("Azure monthly")).toBeNull()
  })
})

describe("RunForm — incidents this period", () => {
  const WITH_INCIDENTS = template({ id: "tmpl-v3", schemaVersion: 3, hasIncidentReport: true })

  test("offered only for a preset whose report has an incident table", () => {
    renderForm([template({ id: "tmpl-v3", schemaVersion: 3, hasIncidentReport: false })])
    expect(screen.queryByText("Incidents this period")).toBeNull()
    cleanup()

    renderForm([WITH_INCIDENTS])
    expect(screen.getByText("Incidents this period")).toBeInTheDocument()
  })

  test("a filled incident travels, and an untouched one does not", async () => {
    renderForm([WITH_INCIDENTS])

    fireEvent.click(screen.getByRole("button", { name: "Add incident" }))
    fireEvent.click(screen.getByRole("button", { name: "Add incident" }))
    fireEvent.change(screen.getAllByLabelText("Case")[0]!, { target: { value: " Disk full " } })
    fireEvent.change(screen.getAllByLabelText("Date")[0]!, { target: { value: "12 Aug 2026" } })
    fireEvent.change(screen.getAllByLabelText("What happened")[0]!, { target: { value: "/var filled" } })

    fireEvent.click(submitButton())
    await waitFor(() => expect(bodies).toHaveLength(1))

    expect(bodies[0]!["incidents"]).toEqual([
      { case: "Disk full", date: "12 Aug 2026", description: "/var filled", solution: "" },
    ])
  })

  test("a removed incident is gone, and none at all sends no key", async () => {
    renderForm([WITH_INCIDENTS])

    fireEvent.click(screen.getByRole("button", { name: "Add incident" }))
    fireEvent.change(screen.getByLabelText("Case"), { target: { value: "Temporary" } })
    fireEvent.click(screen.getByRole("button", { name: "Remove incident 1" }))

    fireEvent.click(submitButton())
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect("incidents" in bodies[0]!).toBe(false)
  })
})

describe("RunForm — the regions an AWS run covers", () => {
  const AWS_PRESET = template({ id: "tmpl-aws", name: "AWS monthly", provider: "aws" })
  const ENABLED = ["ap-southeast-1", "ap-southeast-3", "us-east-1"]

  function renderAws(regions: readonly string[] = ENABLED) {
    return render(
      <RunForm
        subscriptions={[
          subscription({ id: "sub-aws", displayName: "AWS production", provider: "aws", regions }),
          subscription({ id: "sub-azure", displayName: "Contoso production", regions: [] }),
        ]}
        templates={[AWS_PRESET, template({ provider: "azure" })]}
        nowIso={NOW_ISO}
      />
    )
  }

  test("every enabled region is the default, and sends no regions key", async () => {
    renderAws()

    expect(screen.getByRole("radio", { name: /All enabled regions/ })).toBeChecked()
    expect(screen.getByText(/The 3 regions this account/)).toBeInTheDocument()
    expect(screen.queryByRole("checkbox")).toBeNull()

    fireEvent.click(submitButton())
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect("regions" in bodies[0]!).toBe(false)
  })

  test("the chosen regions travel sorted, and the reuse lookup asks for the same choice", async () => {
    renderAws()

    fireEvent.click(screen.getByRole("radio", { name: /Only the regions I choose/ }))
    fireEvent.click(screen.getByRole("checkbox", { name: /us-east-1/ }))
    fireEvent.click(screen.getByRole("checkbox", { name: /ap-southeast-3\s*·\s*Jakarta/ }))
    expect(screen.getByText("2 of 3 regions chosen.")).toBeInTheDocument()

    await waitFor(() =>
      expect(lookups.at(-1)).toContain(`regions=${encodeURIComponent("ap-southeast-3,us-east-1")}`)
    )

    fireEvent.click(submitButton())
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]!["regions"]).toEqual(["ap-southeast-3", "us-east-1"])
  })

  test("choosing without ticking any is refused here, and says why", () => {
    renderAws()

    fireEvent.click(screen.getByRole("radio", { name: /Only the regions I choose/ }))

    expect(submitButton()).toBeDisabled()
    expect(
      screen.getAllByText("Choose at least one region, or cover all enabled regions.").length
    ).toBeGreaterThan(0)
    fireEvent.click(submitButton())
    expect(bodies).toHaveLength(0)
  })

  test("going back to every region sends none, even with regions ticked", async () => {
    renderAws()

    fireEvent.click(screen.getByRole("radio", { name: /Only the regions I choose/ }))
    fireEvent.click(screen.getByRole("checkbox", { name: /us-east-1/ }))
    fireEvent.click(screen.getByRole("radio", { name: /All enabled regions/ }))

    fireEvent.click(submitButton())
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect("regions" in bodies[0]!).toBe(false)
  })

  test("offered only for an AWS connector with more than one region", () => {
    renderAws(["us-east-1"])
    expect(screen.queryByText("Regions")).toBeNull()
    cleanup()

    renderForm([V1])
    expect(screen.queryByText("Regions")).toBeNull()
  })
})
