import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { PreflightResult } from "@/components/subscriptions/preflight-result"

/**
 * The wizard's rejection copy (Requirements 12.7, 12.13).
 *
 * ## What this exists to stop
 *
 * The closing sentence — the one a reader actually acts on — used to be a hardcoded
 * "Nothing was saved. Fix the role assignment and test again." under *every* terminal
 * code. It is correct for exactly one of them.
 *
 * An `AUTH_FAILED` is Azure refusing the credential at the token endpoint, before any
 * permission is evaluated. Telling that reader to fix a role assignment sends them to
 * re-check an RBAC grant that was never the problem, was never examined, and may well
 * be correct — while the actual cause, usually the portal's Secret ID copied in place
 * of the Value, goes unmentioned. A wrong instruction is worse than a missing one,
 * because its specificity reads as diagnosis.
 *
 * So each code owns its action line, and this file asserts the pairing rather than the
 * wording: the role-assignment instruction must appear under `SCOPE_UNVERIFIED` and
 * under no other code.
 */

afterEach(cleanup)

const REJECTED = {
  scopeVerified: false as const,
  code: "AUTH_FAILED",
  message:
    "Azure said: Authentication failed: AADSTS7000215: Invalid client secret provided.",
}

function renderOutcome(code: string, message = REJECTED.message) {
  render(
    <PreflightResult
      outcome={{ ...REJECTED, code, message }}
      onBack={() => {}}
      onConnect={() => {}}
      connecting={false}
      connectError={null}
    />
  )
}

/** The whole panel's text, flattened — the copy spans several elements. */
function panelText(): string {
  return screen.getByRole("heading").closest("section")?.textContent ?? ""
}

describe("Requirement 12.13 — the action line is per code, not one for all", () => {
  test("a credential rejection does not send the reader to the role assignment", () => {
    renderOutcome("AUTH_FAILED")

    const text = panelText()
    expect(text).toContain("Nothing was saved.")
    expect(text).not.toContain("Fix the role assignment")
  })

  test("a credential rejection says the role assignment was not the problem", () => {
    // The positive half. Removing the wrong sentence is not the same as saying the
    // right thing, and the reader's next question is "so is my RBAC wrong too?".
    renderOutcome("AUTH_FAILED")

    expect(panelText()).toContain("was never evaluated")
  })

  test("an unverified scope is the one code that does name the role assignment", () => {
    renderOutcome("SCOPE_UNVERIFIED", "subscription-scope read was not proved")

    expect(panelText()).toContain("Fix the role assignment")
  })

  test("an expired secret is sent to rotate, not to the role assignment", () => {
    // Requirement 12.13's whole point: the remedy differs, and collapsing the two
    // leaves a consultant arguing with an administrator about a correct role.
    renderOutcome("AUTH_EXPIRED", "the client secret has expired")

    const text = panelText()
    expect(text).toContain("Issue a new client secret")
    expect(text).not.toContain("Fix the role assignment")
  })

  test("an unrecognised code still states nothing was saved and what to do", () => {
    // A code from a newer runtime falls to the default. It must not inherit the
    // role-assignment instruction on the strength of being unknown.
    renderOutcome("SOME_FUTURE_CODE", "something this build has no copy for")

    const text = panelText()
    expect(text).toContain("Nothing was saved.")
    expect(text).not.toContain("Fix the role assignment")
  })
})

describe("Requirement 12.7 — the runtime's sentence is evidence, not the explanation", () => {
  test("Azure's own message is shown and attributed", () => {
    renderOutcome("AUTH_FAILED")

    const text = panelText()
    expect(text).toContain("Reported by the preflight:")
    expect(text).toContain("AADSTS7000215")
  })

  test("our own explanation names the cause the message does not", () => {
    // Azure's string says the secret is invalid. It does not say that the portal
    // shows a Secret ID beside the Value and that copying the wrong column is the
    // usual reason — which is the part that resolves the ticket.
    renderOutcome("AUTH_FAILED")

    const text = panelText()
    expect(text).toContain("Secret ID")
    expect(text).toContain("Value")
  })
})
