import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"

/**
 * `/subscriptions/new` — the onboarding wizard (Requirements 11.3–11.7, 11.10,
 * 12.7).
 *
 * ## What is real here, and why it matters
 *
 * The page, the explainer, the wizard, the artifact steps and the result step are
 * all the production components. The two things doubled are the two things that
 * genuinely leave the browser: `next/navigation`'s router, and `fetch`. So the
 * generated `az` script under test is the one `lib/subscriptions/azure-artifacts.ts`
 * produces, the expiry copy is the one `lib/subscriptions/input.ts` states, and the
 * request bodies asserted below are the ones the wizard would really send.
 *
 * ## Requirement 11.10 is asserted three ways, because it is a structural claim
 *
 * "No control anywhere that saves a connection without a `scope_verified: true`
 * result" cannot be established by checking that one button is disabled. So:
 *
 *   1. **No save control exists before a result.** Walked across all three
 *      pre-result steps, counting `[data-slot="save-connection"]` in the whole
 *      document rather than inside one subtree.
 *   2. **A rejected result renders none either**, and no create request is issued
 *      — asserted on `fetch`, which is the only way a connection could be saved
 *      from a browser at all.
 *   3. **Only one module can issue that request.** A filesystem scan over both
 *      subscription directories: exactly one file contains the create endpoint as a
 *      string literal. That is the assertion a future edit trips over — a second
 *      component growing its own save path fails here even if every rendered
 *      assertion above still passes.
 */

const { pushSpy, refreshSpy } = vi.hoisted(() => ({
  pushSpy: vi.fn<(href: string) => void>(),
  refreshSpy: vi.fn<() => void>(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushSpy,
    refresh: refreshSpy,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

import NewSubscriptionPage from "./page"

// --- Fixtures ---------------------------------------------------------------

/** A GUID, so the artifact generators accept it rather than throwing. */
const SUBSCRIPTION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
const TENANT_ID = "11111111-2222-3333-4444-555555555555"
const CLIENT_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa"
const CLIENT_SECRET = "not-a-real-azure-secret"
const DISPLAY_NAME = "Northwind Traders"

const PREFLIGHT_ENDPOINT = "/api/subscriptions/test"
const CREATE_ENDPOINT = "/api/subscriptions"

/** A `datetime-local` value about six months out — inside the accepted window. */
function sixMonthsFromNowLocal(): string {
  const target = new Date(Date.now() + 182 * 24 * 60 * 60 * 1000)
  const pad = (value: number): string => String(value).padStart(2, "0")

  return (
    `${target.getFullYear()}-${pad(target.getMonth() + 1)}-` +
    `${pad(target.getDate())}T${pad(target.getHours())}:` +
    `${pad(target.getMinutes())}`
  )
}

type StubbedAnswer = { readonly status: number; readonly body: unknown }

/** The queue `fetch` answers from, in order of request. */
let answers: StubbedAnswer[]
let fetchMock: ReturnType<typeof vi.fn>

/** Every request `fetch` saw, as `[path, parsedBody]`. */
function requests(): readonly [string, unknown][] {
  return fetchMock.mock.calls.map((call) => {
    const [path, init] = call as [string, RequestInit | undefined]
    const raw = typeof init?.body === "string" ? init.body : "null"

    return [path, JSON.parse(raw) as unknown]
  })
}

function requestsTo(path: string): readonly unknown[] {
  return requests()
    .filter(([requestPath]) => requestPath === path)
    .map(([, body]) => body)
}

function saveControls(): readonly Element[] {
  return [...document.querySelectorAll('[data-slot="save-connection"]')]
}

beforeEach(() => {
  answers = []
  pushSpy.mockClear()
  refreshSpy.mockClear()

  fetchMock = vi.fn(() => {
    const answer = answers.shift()
    if (answer === undefined) {
      throw new Error("fetch was called more times than the test stubbed")
    }

    return Promise.resolve({
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: () => Promise.resolve(answer.body),
    } as Response)
  })

  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// --- Navigation helpers -----------------------------------------------------

function renderWizard(): void {
  render(<NewSubscriptionPage />)

  // The flow opens on the source picker now (task 2.4): an Azure subscription, an
  // AWS account and an on-premises estate do not share a form, so choosing between
  // them selects the form rather than being a field inside one. Requirement 11.3-11.5
  // say THE ONBOARDING WIZARD states the four facts, and this is how a consultant
  // reaches it — every test below is about what the wizard does once entered.
  fireEvent.click(screen.getByRole("button", { name: /Microsoft Azure/ }))
}

async function goToArtifacts(): Promise<void> {
  const user = userEvent.setup()

  await user.type(
    screen.getByLabelText("Azure subscription id"),
    SUBSCRIPTION_ID
  )
  await user.click(
    screen.getByRole("button", { name: "Generate the role assignment" })
  )
}

async function goToCredentials(): Promise<void> {
  const user = userEvent.setup()

  await goToArtifacts()
  await user.click(
    screen.getByRole("button", {
      name: "The role is assigned — enter the credentials",
    })
  )
}

/**
 * Fill the credentials step and submit it, resolving the preflight with `answer`.
 *
 * The date field is driven with `fireEvent.change` rather than `userEvent.type`:
 * `datetime-local` has a segmented editor that `userEvent` drives inconsistently
 * across jsdom versions, and what this test needs from it is one committed value,
 * which is exactly what a change event is.
 */
async function submitCredentials(answer: StubbedAnswer): Promise<void> {
  const user = userEvent.setup()

  renderWizard()
  await goToCredentials()

  await user.type(screen.getByLabelText("Connection name"), DISPLAY_NAME)
  await user.type(screen.getByLabelText("Directory (tenant) id"), TENANT_ID)
  await user.type(screen.getByLabelText("Application (client) id"), CLIENT_ID)
  await user.type(screen.getByLabelText("Client secret"), CLIENT_SECRET)

  fireEvent.change(screen.getByLabelText("Client secret expires"), {
    target: { value: sixMonthsFromNowLocal() },
  })

  answers.push(answer)

  await user.click(screen.getByRole("button", { name: "Test the connection" }))

  await waitFor(() => {
    expect(
      document.querySelector('[data-slot="preflight-result"]')
    ).not.toBeNull()
  })
}

// ---------------------------------------------------------------------------

describe("Requirements 11.3, 11.4, 11.5 — the role explainer states all four facts", () => {
  test("Reader is named, at subscription scope", () => {
    renderWizard()

    const explainer = document.querySelector(
      '[data-slot="reader-role-explainer"]'
    )
    expect(explainer).not.toBeNull()

    const copy = explainer?.textContent ?? ""

    expect(copy).toMatch(/\bReader\b/)
    expect(copy).toMatch(/subscription scope/i)
    // The scope path itself, so a customer can compare it with what they assigned.
    expect(copy).toMatch(/\/subscriptions\//)
  })

  test("Monitoring Reader is named as insufficient, with the reason", () => {
    renderWizard()

    const copy =
      document.querySelector('[data-slot="reader-role-explainer"]')
        ?.textContent ?? ""

    // Requirement 11.3's second half, and the statement most likely to be
    // paraphrased away because it reads like an implementation detail. Both halves
    // are asserted: the narrower role does not grant Resource Graph inventory, and
    // inventory is what identifies the resources metrics are collected for.
    expect(copy).toMatch(/Monitoring Reader/)
    expect(copy).toMatch(/Resource Graph/)
    expect(copy).toMatch(/identify the resources metrics are collected for/i)
  })

  test("Reader exposing resource configuration is stated, not buried", () => {
    renderWizard()

    const copy =
      document.querySelector('[data-slot="reader-role-explainer"]')
        ?.textContent ?? ""

    // Requirement 11.4. This is the concession — the thing a customer would
    // otherwise discover for themselves and revoke access over.
    expect(copy).toMatch(/resource configuration/i)
    expect(copy).toMatch(/in addition to metrics/i)
  })

  test("the connection is stated to be read-only, with no write-capable role", () => {
    renderWizard()

    const copy =
      document.querySelector('[data-slot="reader-role-explainer"]')
        ?.textContent ?? ""

    // Requirement 11.5, both halves.
    expect(copy).toMatch(/read-only/i)
    expect(copy).toMatch(/No role permitting a write is requested/i)
  })

  test("nothing in the explainer is styled as an error", () => {
    renderWizard()

    const explainer = document.querySelector(
      '[data-slot="reader-role-explainer"]'
    )

    // `--destructive` is reserved for a refused connection and a hard failure
    // (Requirement 13.6's rule, applied wherever the token could appear). An
    // access explanation is neither.
    expect(explainer?.innerHTML ?? "").not.toMatch(/destructive/)
  })
})

describe("Requirements 11.1, 11.2, 11.6 — the generated artifacts as rendered", () => {
  test("both artifacts appear, targeting the supplied subscription id", async () => {
    renderWizard()
    await goToArtifacts()

    const script =
      document.querySelector('[data-slot="az-script-step"] pre')?.textContent ??
      ""
    const template =
      document.querySelector('[data-slot="arm-template-step"] pre')
        ?.textContent ?? ""

    // Requirement 11.6 — the id the script targets is visible in what is rendered,
    // so a consultant forwarding it and a customer running it can both check.
    expect(script).toContain(SUBSCRIPTION_ID)
    expect(template).toContain(SUBSCRIPTION_ID)
  })

  test("the rendered script makes exactly one role assignment, Reader, at subscription scope", async () => {
    renderWizard()
    await goToArtifacts()

    const script =
      document.querySelector('[data-slot="az-script-step"] pre')?.textContent ??
      ""

    // Asserted on the *rendered* text rather than on the generator's return value,
    // because this is the string the copy button places on the clipboard. A
    // component that post-processed the artifact would pass the generator's own
    // property test and fail here.
    expect(script.match(/az role assignment create/g)).toHaveLength(1)
    expect(script).toContain(`SCOPE='/subscriptions/${SUBSCRIPTION_ID}'`)
    expect(script).toContain("ROLE='Reader'")
    // Nothing that grants a write, and nothing that deletes.
    expect(script).not.toMatch(
      /az role assignment delete|--role (Owner|Contributor)/
    )
  })

  test("the rendered ARM template parses and holds exactly one Reader assignment", async () => {
    renderWizard()
    await goToArtifacts()

    const template =
      document.querySelector('[data-slot="arm-template-step"] pre')
        ?.textContent ?? ""

    // Parsed rather than grepped: "exactly one role assignment" is a fact about the
    // template's `resources` array, and a substring count would be satisfied by a
    // comment.
    const parsed = JSON.parse(template) as {
      resources: { type: string; properties: { roleDefinitionId: string } }[]
      variables: { targetScope: string }
    }

    expect(parsed.resources).toHaveLength(1)
    expect(parsed.resources[0].type).toBe(
      "Microsoft.Authorization/roleAssignments"
    )
    expect(parsed.variables.targetScope).toBe(
      `/subscriptions/${SUBSCRIPTION_ID}`
    )
  })

  test("a non-GUID subscription id does not advance, and is explained", async () => {
    const user = userEvent.setup()
    renderWizard()

    // Non-vacuity for everything above, and the gate that keeps the artifact
    // generators from being handed a value they would throw on — which is their
    // shell-injection defence, not input tidiness.
    await user.type(
      screen.getByLabelText("Azure subscription id"),
      "not-a-guid"
    )
    await user.click(
      screen.getByRole("button", { name: "Generate the role assignment" })
    )

    expect(document.querySelector('[data-slot="az-script-step"]')).toBeNull()
    expect(screen.getByRole("alert").textContent ?? "").toMatch(/GUID/)
  })
})

describe("Requirement 11.7 — the credentials step states the secret's lifetime", () => {
  test("the 24-month maximum and the common 6-to-12-month issuance are both stated", async () => {
    renderWizard()
    await goToCredentials()

    const field = document.querySelector('[data-slot="secret-expiry-field"]')
    expect(field).not.toBeNull()

    const copy = field?.textContent ?? ""

    expect(copy).toMatch(/maximum lifetime of 24 months/i)
    expect(copy).toMatch(/commonly issued for 6 to 12 months/i)
  })

  test("the accepted range is stated as after now and at most 24 months out", async () => {
    renderWizard()
    await goToCredentials()

    const copy =
      document.querySelector('[data-slot="secret-expiry-field"]')
        ?.textContent ?? ""

    // Requirement 11.9's sentence, said before the submission rather than only
    // after it is refused.
    expect(copy).toMatch(/after now and at most 24 months from now/i)
  })

  test("an expiry beyond the accepted range is refused without a request", async () => {
    const user = userEvent.setup()
    renderWizard()
    await goToCredentials()

    await user.type(screen.getByLabelText("Connection name"), DISPLAY_NAME)
    await user.type(screen.getByLabelText("Directory (tenant) id"), TENANT_ID)
    await user.type(screen.getByLabelText("Application (client) id"), CLIENT_ID)
    await user.type(screen.getByLabelText("Client secret"), CLIENT_SECRET)

    // Three years out. `withinSecretLifetime` is the predicate the route enforces,
    // so this is the same rejection stated one round trip earlier.
    const tooFar = new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000)
    fireEvent.change(screen.getByLabelText("Client secret expires"), {
      target: { value: `${tooFar.toISOString().slice(0, 16)}` },
    })

    await user.click(
      screen.getByRole("button", { name: "Test the connection" })
    )

    expect(screen.getByRole("alert").textContent ?? "").toMatch(/24 months/)
    // The 30-second preflight is not spent on a submission that could not be
    // recorded anyway.
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("Requirement 11.10 — no control saves a connection without a verified preflight", () => {
  test("the announcer is mounted from the first paint, and starts silent", () => {
    renderWizard()

    const announcer = document.querySelector('[data-slot="wizard-announcer"]')

    // Mounted before there is anything to say, which is the only arrangement in
    // which a later change to its text is announced at all.
    expect(announcer).not.toBeNull()
    expect(announcer?.getAttribute("aria-live")).toBe("polite")
    // Silent on step 1 — there is nothing to announce about a page that has just
    // been read out.
    expect(announcer?.textContent).toBe("")
  })

  test("no save control exists on any step before a result", async () => {
    renderWizard()

    // Step 1.
    expect(saveControls()).toHaveLength(0)

    await goToArtifacts()
    expect(saveControls()).toHaveLength(0)

    const user = userEvent.setup()
    await user.click(
      screen.getByRole("button", {
        name: "The role is assigned — enter the credentials",
      })
    )

    // Step 3 — the step that holds the whole credential. Still nothing that saves.
    expect(saveControls()).toHaveLength(0)
    expect(requestsTo(CREATE_ENDPOINT)).toHaveLength(0)
  })

  test("a rejected preflight renders no save control and issues no create request", async () => {
    await submitCredentials({
      status: 200,
      body: {
        scopeVerified: false,
        code: "SCOPE_UNVERIFIED",
        message: "Read at subscription scope was not proved.",
      },
    })

    expect(saveControls()).toHaveLength(0)

    // No button of any name saves it either — a rename could not smuggle one past
    // the `data-slot` assertion above.
    expect(
      screen.queryByRole("button", { name: /connect this subscription/i })
    ).toBeNull()

    expect(requestsTo(PREFLIGHT_ENDPOINT)).toHaveLength(1)
    expect(requestsTo(CREATE_ENDPOINT)).toHaveLength(0)
  })

  test("a verified preflight renders exactly one save control, and it creates", async () => {
    const user = userEvent.setup()

    // Non-vacuity for both tests above: a wizard that never rendered a save
    // control would satisfy them.
    await submitCredentials({
      status: 200,
      body: { scopeVerified: true, fidelityTier: "baseline" },
    })

    expect(saveControls()).toHaveLength(1)

    answers.push({ status: 201, body: { subscription: { id: "row-1" } } })

    await user.click(
      screen.getByRole("button", { name: "Connect this subscription" })
    )

    await waitFor(() => {
      expect(requestsTo(CREATE_ENDPOINT)).toHaveLength(1)
    })

    // The credential travelled, and nothing the browser decided did: no
    // `scopeVerified`, no `fidelityTier`. The create route runs its own preflight
    // and reads both off that result (Requirement 12.14).
    const [body] = requestsTo(CREATE_ENDPOINT) as [Record<string, unknown>]

    expect(Object.keys(body).sort()).toEqual([
      "clientId",
      "clientSecret",
      "displayName",
      "logAnalyticsWorkspaceId",
      "secretExpiresAt",
      "subscriptionId",
      "tenantId",
    ])
    expect(body.subscriptionId).toBe(SUBSCRIPTION_ID)

    await waitFor(() => {
      expect(pushSpy).toHaveBeenCalledWith("/subscriptions")
    })
  })

  test("only one module in the subscription surfaces names the create endpoint", () => {
    // The structural half, and the one a future edit trips over. A second component
    // growing its own save path fails here even though every rendered assertion
    // above would still pass.
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      ".."
    )

    const scanned = [
      path.join("components", "subscriptions"),
      path.join("app", "(app)", "subscriptions"),
    ]

    const sources: string[] = []

    const walk = (relative: string): void => {
      for (const entry of readdirSync(path.join(root, relative), {
        withFileTypes: true,
      })) {
        const next = path.join(relative, entry.name)

        if (entry.isDirectory()) {
          walk(next)
          continue
        }

        if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts"))
          continue
        if (entry.name.includes(".test.")) continue

        sources.push(next)
      }
    }

    scanned.forEach(walk)

    // The scan is asserted before it is trusted: an empty file list would make the
    // rule below pass by checking nothing.
    expect(sources.length).toBeGreaterThan(5)

    const naming = sources.filter((relative) =>
      readFileSync(path.join(root, relative), "utf8").includes(
        `"${CREATE_ENDPOINT}"`
      )
    )

    expect(naming).toEqual([
      path.join("components", "subscriptions", "connect-wizard.tsx"),
    ])
  })
})

describe("Requirement 12.7 — SCOPE_UNVERIFIED explains the requirement and the rejection", () => {
  beforeEach(async () => {
    await submitCredentials({
      status: 200,
      body: {
        scopeVerified: false,
        code: "SCOPE_UNVERIFIED",
        message: "The permissions response carried no subscription-scope read.",
      },
    })
  })

  test("the subscription-scope Reader requirement is stated", () => {
    const result =
      document.querySelector('[data-slot="preflight-result"]')?.textContent ??
      ""

    expect(result).toMatch(
      /Reader role must be assigned at subscription scope/i
    )
    expect(result).toMatch(/\/subscriptions\//)
  })

  test("the reason a resource-group-scoped assignment is rejected is stated", () => {
    const result =
      document.querySelector('[data-slot="preflight-result"]')?.textContent ??
      ""

    // The half that matters, because the narrower assignment *works*: inventory
    // succeeds, metrics succeed, every figure verifies, and the document is missing
    // most of the estate with nothing in the data to say so.
    expect(result).toMatch(/resource group/i)
    expect(result).toMatch(/rejected/i)
    expect(result).toMatch(/returns that group's resources/i)
    expect(result).toMatch(/missing most of the subscription/i)
    expect(result).toMatch(/nothing in the data to say so/i)
  })

  test("the copy is ours, and the runtime's message is attributed separately", () => {
    const result =
      document.querySelector('[data-slot="preflight-result"]')?.textContent ??
      ""

    // Both present, and distinguishable. A UI that only echoed the runtime's
    // sentence would satisfy Requirement 12.7 for exactly as long as the runtime
    // kept sending it.
    expect(result).toMatch(/Reported by the preflight:/)
    expect(result).toContain(
      "The permissions response carried no subscription-scope read."
    )
    expect(result).toMatch(/Nothing was saved/i)
  })

  test("the terminal code is shown, and the rejection is announced", () => {
    const result = document.querySelector('[data-slot="preflight-result"]')

    expect(result?.textContent ?? "").toContain("SCOPE_UNVERIFIED")
    expect(result?.getAttribute("aria-live")).toBe("polite")

    // The section's own live region cannot carry this: a region mounted *with* its
    // content announces nothing, because the assistive technology was not
    // observing the node when the change happened. The wizard's persistent
    // announcer is what makes a replaced step audible, so the rejection has to
    // reach it.
    const announcer = document.querySelector('[data-slot="wizard-announcer"]')

    expect(announcer?.getAttribute("aria-live")).toBe("polite")
    expect(announcer?.textContent ?? "").toContain("SCOPE_UNVERIFIED")
    expect(announcer?.textContent ?? "").toMatch(/Nothing was saved/i)
  })

  test("AUTH_EXPIRED is answered differently, because the remedy differs", async () => {
    cleanup()

    await submitCredentials({
      status: 200,
      body: {
        scopeVerified: false,
        code: "AUTH_EXPIRED",
        message: "Azure rejected the secret as expired.",
      },
    })

    const result =
      document.querySelector('[data-slot="preflight-result"]')?.textContent ??
      ""

    // Requirement 12.13 — distinct from SCOPE_UNVERIFIED. One is a role assignment
    // the customer changes; the other is a credential the consultant reissues, and
    // saying "fix the role" would send them to argue about a correct assignment.
    expect(result).toContain("AUTH_EXPIRED")
    expect(result).toMatch(/rejected the client secret as expired/i)
    expect(result).toMatch(/does not need to be made again/i)
    expect(saveControls()).toHaveLength(0)
  })
})
