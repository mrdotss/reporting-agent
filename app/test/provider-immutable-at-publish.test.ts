/**
 * Task 3.6 — a profile's `provider` is locked once a version exists.
 *
 * `checkProviderImmutable` is the decision `publishTemplateVersion` calls before
 * writing a new version. Extracted as a pure function for the same reason
 * `pinNumberFormat` is: the publish path around it only runs against a real Postgres,
 * so a test driving the whole path would not run in ordinary development. This one runs
 * everywhere.
 */

import { describe, expect, test } from "vitest"

import { checkProviderImmutable } from "@/lib/actions/templates"

describe("checkProviderImmutable", () => {
  test("no existing version — never a conflict, whatever the incoming provider is", () => {
    expect(checkProviderImmutable(null, { provider: "azure" })).toBeNull()
    expect(checkProviderImmutable(undefined, { provider: "aws" })).toBeNull()
  })

  test("existing and incoming providers agree — no conflict", () => {
    expect(
      checkProviderImmutable({ provider: "azure" }, { provider: "azure" })
    ).toBeNull()
  })

  test("existing and incoming providers differ — refused, naming the locked value", () => {
    const issue = checkProviderImmutable(
      { provider: "azure" },
      { provider: "aws" }
    )

    expect(issue).not.toBeNull()
    expect(issue?.path).toEqual(["provider"])
    expect(issue?.message).toContain("azure")
  })

  test("v1/v2 definitions declare no provider — never enforced either side", () => {
    // A v1/v2 existing version has no `provider` field at all, and a v1/v2 incoming
    // definition likewise. Enforcing here would refuse every v1/v2 republish.
    expect(
      checkProviderImmutable({ schema_version: 1 }, { schema_version: 1 })
    ).toBeNull()
    expect(
      checkProviderImmutable({ provider: "azure" }, { schema_version: 1 })
    ).toBeNull()
    expect(
      checkProviderImmutable({ schema_version: 1 }, { provider: "azure" })
    ).toBeNull()
  })

  test("a non-object either side is never a conflict rather than throwing", () => {
    for (const value of [null, undefined, 42, "definition", true]) {
      expect(checkProviderImmutable(value, { provider: "azure" })).toBeNull()
      expect(checkProviderImmutable({ provider: "azure" }, value)).toBeNull()
    }
  })
})
