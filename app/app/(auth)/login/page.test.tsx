import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

/**
 * `/login` — Requirement 7.5: a rejected submission renders **one** message, and
 * that message identifies neither the email nor the password as the failing
 * field.
 *
 * ## The submission is real, and that is the point
 *
 * Nothing here hand-feeds a rejection into the form. The page is rendered, the
 * form is submitted, and the **real** `loginAction` answers it — so the message
 * on screen is the module's own constant rather than a copy of it that a test
 * author kept in agreement. A seeded action state, or a `loginAction` mocked to
 * return `{ status: "error", message: "…" }`, would only assert that the
 * component can render a string it was handed. That is a tautology, and it would
 * keep passing after the action started naming the failing field.
 *
 * That this one message is *also* what an unmatched email, a failed verification
 * and a locked-out email produce is established in `lib/actions/auth.test.ts`,
 * which compares all of those paths as serialized values and as one frozen
 * object. This file's job is the surface: **one** region, carrying it,
 * attributing nothing. Together they cover Requirement 7.5 without either file
 * needing a database — so both run in every `pnpm test`, docker or not.
 *
 * ## Why the driver is an empty submission
 *
 * A malformed address cannot be used to provoke the rejection, and finding out
 * why is worth recording: the email field is `type="email"` with no `required`,
 * so **native constraint validation refuses to submit a malformed value at all**
 * and the action is never reached. An *empty* value, by contrast, is valid to the
 * browser and rejected by `loginInputSchema` — which is precisely the split the
 * form was built for. Its docstring declines `required`/`minLength` because
 * native validation answers with a bubble attached to a *named* field, so an
 * empty submission would get a field-specific refusal while a wrong one gets a
 * generic one, and the difference is observable. The empty submission is
 * therefore both the reachable driver and the case that rule exists to protect.
 *
 * Being a schema rejection, it also reaches no database and burns no argon2 —
 * `getDb` is doubled with a throw, so a submission that *did* reach the database
 * fails loudly here rather than in CI.
 */

vi.mock("next/navigation", async () => {
  const { redirect } = await import("@/test/next-doubles")
  return { redirect }
})

vi.mock("next/headers", async () => {
  const { FakeCookieStore } = await import("@/test/next-doubles")
  const store = new FakeCookieStore()
  return { cookies: () => Promise.resolve(store) }
})

vi.mock("@/lib/db", () => ({
  getDb: () => {
    throw new Error(
      "A submission rejected by the boundary schema must not reach the database."
    )
  },
}))

import LoginPage from "./page"

/**
 * The generic rejection, restated. It cannot be imported — a `"use server"`
 * module may only export async functions, so the constant is module-private by
 * construction — and restating it is the right shape anyway: a test that read
 * the sentence out of the module could not notice the module changing it.
 */
const INVALID_CREDENTIALS_MESSAGE =
  "Those sign-in details were not accepted. Check them and try again."

function errorRegions(): readonly Element[] {
  return [...document.querySelectorAll('[data-slot="field-error"]')]
}

async function renderLoginPage(): Promise<void> {
  // `searchParams` is a Promise in Next 16 — synchronous access was removed.
  render(await LoginPage({ searchParams: Promise.resolve({}) }))
}

/**
 * Submit the form as it renders, and wait for the server's answer to arrive.
 *
 * The wait is deliberately weaker than the assertions that follow it — "at least
 * one" rather than "exactly one" — so a form that grew a second error region
 * fails in the test that counts them rather than here, in shared setup. A helper
 * that asserted the real claim would report every test in this file as broken and
 * name none of them.
 */
async function submitRejectedSubmission(): Promise<void> {
  const user = userEvent.setup()

  await user.click(screen.getByRole("button", { name: "Sign in" }))

  await waitFor(() => {
    expect(screen.getAllByRole("alert").length).toBeGreaterThanOrEqual(1)
  })
}

afterEach(cleanup)

describe("Requirement 7.5 — one message, attributing nothing", () => {
  test("the unsubmitted form renders no error region", async () => {
    // Non-vacuity for everything below: a form that always rendered one alert
    // would satisfy the count assertion, and a form that never rendered one
    // would satisfy every "names no field" assertion.
    await renderLoginPage()

    expect(screen.queryAllByRole("alert")).toHaveLength(0)
    expect(errorRegions()).toHaveLength(0)
  })

  test("a rejected submission renders exactly one error region", async () => {
    await renderLoginPage()
    await submitRejectedSubmission()

    // Counted two ways, because they fail for different reasons. The role count
    // is what a screen reader hears; the `data-slot` count is what the form is
    // built from — a second `FieldError` rendered empty is invisible to the
    // first and a `role` override is invisible to the second.
    expect(screen.getAllByRole("alert")).toHaveLength(1)
    expect(errorRegions()).toHaveLength(1)
  })

  test("the message names neither the email nor the password", async () => {
    await renderLoginPage()
    await submitRejectedSubmission()

    const [alert] = screen.getAllByRole("alert")
    const message = alert.textContent ?? ""

    expect(message).toBe(INVALID_CREDENTIALS_MESSAGE)

    // Not "email", not "password", and not the pair either — a message naming
    // the pair still tells an enumerator that the pair was the gate. It is one
    // sentence about the submission as a whole.
    expect(message).not.toMatch(/email/i)
    expect(message).not.toMatch(/password/i)
    expect(message).not.toMatch(/address/i)
    expect(message).not.toMatch(/account/i)
    expect(message).not.toMatch(/missing|empty|blank|required/i)
  })

  test("no field carries an error slot, an invalid state, or a native constraint", async () => {
    await renderLoginPage()
    await submitRejectedSubmission()

    // The structural half of Requirement 7.5. A per-field error slot is a slot
    // somebody eventually fills in, and the moment one is filled in the form has
    // told an enumerator which half of the submission was wrong. There is exactly
    // one region and it sits **outside** both fields.
    expect(
      document.querySelectorAll('[data-slot="field"] [data-slot="field-error"]')
    ).toHaveLength(0)

    expect(document.querySelectorAll("[aria-invalid]")).toHaveLength(0)

    // And no native constraint, for the same reason: constraint validation
    // refuses a submission with a bubble attached to a *named* field, so an
    // empty submission would be answered field-specifically while a wrong one is
    // answered generically. This is also what let the submission above reach the
    // server at all.
    expect(document.querySelectorAll("[required]")).toHaveLength(0)
    expect(document.querySelectorAll("[minlength]")).toHaveLength(0)
    expect(document.querySelectorAll("[maxlength]")).toHaveLength(0)
    expect(document.querySelectorAll("[pattern]")).toHaveLength(0)
  })

  test("the one region is the one the form points at", async () => {
    await renderLoginPage()
    await submitRejectedSubmission()

    const [alert] = screen.getAllByRole("alert")
    const form = screen.getByRole("form", { name: "Sign in" })

    // So the message is announced as the form's description rather than merely
    // appearing near it — and so the single region and the single
    // `aria-describedby` cannot drift into disagreement.
    expect(alert.id).not.toBe("")
    expect(form.getAttribute("aria-describedby")).toBe(alert.id)
  })

  test("both fields survive the rejection, ready for a retry", async () => {
    await renderLoginPage()
    await submitRejectedSubmission()

    // The rejection is rendered *in* the form, not in place of it, and the
    // submit control comes back. React resets an uncontrolled form once its
    // action resolves — correct for the password, and a re-type for the email,
    // which the action's closed `{ status, message }` result deliberately does
    // not carry back.
    expect(screen.getByLabelText("Email")).toHaveValue("")
    expect(screen.getByLabelText("Password")).toHaveValue("")
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled()
  })
})
