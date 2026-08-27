import { describe, expect, test } from "vitest"

import { resolveCustomerName } from "@/lib/actions/runs"

/**
 * `resolveCustomerName` (Requirement 12.2, 12.8, 12.9, task 4.4).
 *
 * A pure unit test, for the reason `provider-immutable-at-publish.test.ts` gives for
 * `checkProviderImmutable`: `enqueueRun` around this function is only reachable
 * against a real Postgres, and — as of this task — also depends on `unionScope`
 * accepting a v3 `sections` definition, which it does not yet (a separate, real gap
 * this task's own integration testing surfaced, recorded in `tasks.md`). A test
 * driving the whole action would not exercise this resolution today. This function
 * is where the actual decision lives, so this is the seam the guard needs.
 */

describe("schema_version >= 3 — sourced from identity.customer_name", () => {
  test("a v3 definition with identity.customer_name resolves it, missing field is null", () => {
    const result = resolveCustomerName(
      { schema_version: 3, identity: { customer_name: "Contoso Ltd" } },
      undefined
    )
    expect(result).toEqual({
      customerName: "Contoso Ltd",
      missingCustomerNameField: null,
    })
  })

  test("a v3 definition with no identity.customer_name reports the profile-side missing field", () => {
    const result = resolveCustomerName(
      { schema_version: 3, identity: { name: "Test" } },
      undefined
    )
    expect(result).toEqual({
      customerName: null,
      missingCustomerNameField: "identity.customer_name",
    })
  })

  test("a submitted customerName is IGNORED at v3 — the profile's value wins", () => {
    // Requirement 12.8 — the form no longer collects this at all, but a
    // stale or hand-crafted request carrying it must not let it leak
    // through as if it were the answer.
    const result = resolveCustomerName(
      { schema_version: 3, identity: { customer_name: "Real Customer" } },
      "Attacker-Submitted Name"
    )
    expect(result.customerName).toBe("Real Customer")
  })

  test("a submitted customerName does NOT fill the gap when identity has none — still missing, not substituted", () => {
    // The vulnerable path a naive `?? submittedCustomerName` fallback would
    // take: identity carries no customer_name, but the request still has
    // one. The profile is still missing what it should have collected, and
    // a submitted value must not silently cover for it.
    const result = resolveCustomerName(
      { schema_version: 3, identity: { name: "Test" } },
      "Attacker-Submitted Name"
    )
    expect(result).toEqual({
      customerName: null,
      missingCustomerNameField: "identity.customer_name",
    })
  })

  test("a v3 definition with no identity object at all reports the missing field", () => {
    const result = resolveCustomerName({ schema_version: 3 }, undefined)
    expect(result).toEqual({
      customerName: null,
      missingCustomerNameField: "identity.customer_name",
    })
  })

  test("identity.customer_name of a non-string type is treated as absent", () => {
    const result = resolveCustomerName(
      { schema_version: 3, identity: { customer_name: 12345 } },
      undefined
    )
    expect(result).toEqual({
      customerName: null,
      missingCustomerNameField: "identity.customer_name",
    })
  })

  test("a higher schema_version than 3 still resolves from identity", () => {
    const result = resolveCustomerName(
      { schema_version: 4, identity: { customer_name: "Future Co" } },
      undefined
    )
    expect(result.customerName).toBe("Future Co")
  })
})

describe("schema_version < 3 — sourced from the submitted value", () => {
  test("schema_version 2 resolves from the submitted customerName", () => {
    const result = resolveCustomerName(
      { schema_version: 2, identity: { customer_name: "Ignored At V2" } },
      "Submitted Name"
    )
    expect(result).toEqual({
      customerName: "Submitted Name",
      missingCustomerNameField: null,
    })
  })

  test("schema_version 2 with no submitted value reports the form-side missing field", () => {
    const result = resolveCustomerName({ schema_version: 2 }, undefined)
    expect(result).toEqual({
      customerName: null,
      missingCustomerNameField: "customerName",
    })
  })

  test("schema_version 1 (or absent) also resolves from the submitted value", () => {
    const result = resolveCustomerName({}, "Submitted Name")
    expect(result).toEqual({
      customerName: "Submitted Name",
      missingCustomerNameField: null,
    })
  })

  test("identity.customer_name is never read below schema_version 3, even if present", () => {
    const result = resolveCustomerName(
      { schema_version: 2, identity: { customer_name: "Should Not Win" } },
      undefined
    )
    // Missing at v2 means the submitted value was absent — the identity value
    // is not silently substituted for it.
    expect(result.missingCustomerNameField).toBe("customerName")
  })
})
