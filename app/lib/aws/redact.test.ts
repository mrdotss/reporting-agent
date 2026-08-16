import { describe, expect, test } from "vitest"

import { isRedactedFieldName, redactForBrowser } from "@/lib/aws/redact"

/**
 * Unit coverage for the browser-facing redaction pass (Requirement 15.6). The
 * generated half — the same four names in mixed casings at depth 1–4 — is
 * Property 5's web half and lives with the redaction property test.
 */

describe("Requirement 15.6 — the redacted field names", () => {
  test.each([
    ["client_secret", true],
    ["clientSecret", true],
    ["CLIENT_SECRET", true],
    ["Client_Secret", true],
    ["ClientSecret", true],
    ["progress_token", true],
    ["progressToken", true],
    ["tenant_id", true],
    ["tenantId", true],
    ["client_id", true],
    ["clientId", true],
    // Whole-name matching: these are not credentials and must survive.
    ["client_id_hash", false],
    ["subscription_id", false],
    ["progress_total", false],
    ["secret", false],
    ["", false],
  ] as const)("%s → %s", (name, expected) => {
    expect(isRedactedFieldName(name)).toBe(expected)
  })
})

describe("Requirement 15.6 — redactForBrowser removes at every depth", () => {
  test("a top-level field is removed rather than masked", () => {
    const redacted = redactForBrowser({
      type: "done",
      progress_token: "t0k3n-value",
    })

    expect(redacted).toEqual({ type: "done" })
  })

  test("a nested field is removed, and its casing does not matter", () => {
    const redacted = redactForBrowser({
      type: "error",
      context: {
        actor_id: "u_1",
        clientSecret: "s3cret-value",
        tenant_id: "11111111-1111-1111-1111-111111111111",
        nested: { CLIENT_ID: "app-id", subscription_id: "sub-1" },
      },
    })

    expect(redacted).toEqual({
      type: "error",
      context: { actor_id: "u_1", nested: { subscription_id: "sub-1" } },
    })
  })

  test("fields inside arrays are removed at every depth", () => {
    const redacted = redactForBrowser({
      items: [
        { id: "a", client_secret: "one" },
        [{ deeper: { progressToken: "two", keep: 1 } }],
      ],
    })

    expect(redacted).toEqual({
      items: [{ id: "a" }, [{ deeper: { keep: 1 } }]],
    })
  })

  test("the input is not mutated", () => {
    const event = { context: { client_secret: "s3cret-value" } }

    redactForBrowser(event)

    expect(event.context.client_secret).toBe("s3cret-value")
  })

  test("primitives and non-plain objects pass through", () => {
    const date = new Date(0)

    expect(redactForBrowser("delta")).toBe("delta")
    expect(redactForBrowser(7)).toBe(7)
    expect(redactForBrowser(null)).toBe(null)
    expect(redactForBrowser(undefined)).toBe(undefined)
    expect(redactForBrowser({ at: date })).toEqual({ at: date })
  })

  test("a cyclic reference terminates and is still redacted", () => {
    // Not representable in a JSON-parsed event, but a stack overflow is a bad
    // way to find that out.
    const event: Record<string, unknown> = { client_id: "app-id", keep: 1 }
    event.self = event

    const redacted = redactForBrowser(event) as Record<string, unknown>

    expect(Object.keys(redacted).sort()).toEqual(["keep", "self"])
    expect(redacted.self).toBe(redacted)
  })
})
