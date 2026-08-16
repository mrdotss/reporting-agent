import { describe, expect, test } from "vitest"
import fc from "fast-check"

import {
  READER_ROLE_DEFINITION_GUID,
  READER_ROLE_NAME,
  ROLE_ASSIGNMENT_API_VERSION,
  azureOnboardingArtifacts,
  isSubscriptionId,
} from "@/lib/subscriptions/azure-artifacts"

/**
 * Properties for `lib/subscriptions/azure-artifacts.ts` — the generated role
 * assignment, over every subscription id rather than the two named ones.
 *
 * **Validates: Requirements 11.1, 11.2, 11.6, 11.8, 42.1**
 *
 * Requirement 11.8 is written as a universal quantifier — *for all* generated
 * `az` scripts and *all* generated ARM templates, exactly one role assignment,
 * role `Reader`, scope the supplied subscription's scope path, no write action —
 * so it is generated rather than exemplified. `azure-artifacts.ts` is pure, which
 * is what makes that statement checkable: a subscription id in, two strings out,
 * no clock, no environment, no I/O.
 *
 * `azure-artifacts.test.ts` covers what a property cannot — the template's actual
 * structure, the script's actual commands, and the rejection of a non-GUID id.
 * What this file adds is the class of ids: **the module rejects a non-GUID with
 * `InvalidSubscriptionIdError` as a shell-injection gate**, so an
 * arbitrary-string generator would prove nothing but that the gate is reachable.
 * The generator therefore produces GUID-shaped ids and varies what actually
 * varies about them — the hex across its whole space, and the case of every
 * letter independently, since `isSubscriptionId` accepts upper, lower and mixed
 * and the id is interpolated into **both** a shell script and a JSON document.
 *
 * Implementations that pass the named-example test and fail here:
 *
 * - **A template that ignores its argument.** Any assertion that only says "the
 *   scope path is well-formed" passes against a hard-coded id. The cross-check
 *   below extracts *every* GUID from both artifacts and requires each one to be
 *   either the generated id or the Reader role definition id.
 * - **An id normalized on the way in.** A `toLowerCase()` anywhere on the path
 *   makes the script's scope and the template's scope disagree with the id the
 *   preflight later verifies, character for character. The artifacts must carry
 *   the id verbatim.
 */

/** The subscription's own scope path — the scope both artifacts assign at. */
function scopePath(subscriptionId: string): string {
  return `/subscriptions/${subscriptionId}`
}

/**
 * Every GUID-shaped run in a string.
 *
 * Deliberately unanchored, unlike the module's own pattern: the point is to find
 * ids *inside* an artifact, and then to account for all of them. A hard-coded id
 * left in a template is an extra match, not a malformed one.
 */
const GUID_PATTERN =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g

function guidsIn(text: string): string[] {
  return text.match(GUID_PATTERN) ?? []
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * Strings that would mean an artifact grants more than read access.
 *
 * The vocabulary of `azure-artifacts.test.ts`, restated rather than imported
 * because a test file exports nothing. Action patterns and role names both,
 * because either widens the grant: an action pattern reaches a custom role
 * definition, a role name reaches a built-in one. None of these is spellable in
 * hex, so no generated id can make one of them appear — every failure here would
 * be the module's.
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

/**
 * A subscription id: 32 hex nibbles drawn independently, each letter
 * independently upper- or lower-cased, grouped 8-4-4-4-12.
 *
 * Two axes, because the module has two consumers of the id's exact bytes. The
 * nibbles cover the hex space, so no assertion can be passing on the digits of
 * one canonical id. The case mask covers what `isSubscriptionId` admits — a
 * generator emitting only lower-case hex would leave the upper-case and mixed
 * paths through the shell script and the JSON encoder untested. `toString(16)`
 * on 0–9 has no case, so the mask only bites on `a`–`f`; the declared cases below
 * pin the all-upper, all-lower and digits-only extremes.
 */
const subscriptionIdArbitrary: fc.Arbitrary<string> = fc
  .tuple(
    fc.array(fc.integer({ min: 0, max: 15 }), {
      minLength: 32,
      maxLength: 32,
    }),
    fc.array(fc.boolean(), { minLength: 32, maxLength: 32 })
  )
  .map(([nibbles, upperCase]) => {
    const digits = nibbles.map((nibble, index) => {
      const digit = nibble.toString(16)
      return upperCase[index] ? digit.toUpperCase() : digit
    })

    const group = (start: number, end: number): string =>
      digits.slice(start, end).join("")

    return [
      group(0, 8),
      group(8, 12),
      group(12, 16),
      group(16, 20),
      group(20, 32),
    ].join("-")
  })

/**
 * Declared cases, retained per Requirement 42.8, each chosen for what it kills.
 *
 * fast-check draws declared examples from the same budget as generated ones — the
 * examples are yielded first and at most `numRuns` values are taken — so every
 * property below declares `numRuns: 100 + EXAMPLES.length`, keeping at least 100
 * *generated* cases (Requirement 42.1) with the declared ones on top. The global
 * floor in `test/setup.ts` stays 100; nothing here lowers it.
 */
const EXAMPLES: [string][] = [
  // All lower-case letters, and all upper-case: the two extremes the per-letter
  // mask reaches only probabilistically.
  ["abcdefab-cdef-abcd-efab-cdefabcdefab"],
  ["ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB"],
  // Mixed case in every group — the shape a customer pastes out of the portal
  // after editing it by hand.
  ["aBcDeFaB-cDeF-AbCd-EfAb-CdEfAbCdEfAb"],
  // Digits only: no letter for a case bug to show up in, so an artifact that
  // normalizes case still passes here. It is in the list as the floor case, not
  // as a discriminating one.
  ["12345678-9012-3456-7890-123456789012"],
  // The numeric extremes of the hex space.
  ["00000000-0000-0000-0000-000000000000"],
  ["ffffffff-ffff-ffff-ffff-ffffffffffff"],
  // The Reader role definition id, used as a subscription id. Adversarial on
  // purpose: it makes "every GUID in the artifact is the id or the role id"
  // degenerate, so an implementation that mixed the two up cannot hide behind a
  // set membership check that happens to hold.
  [READER_ROLE_DEFINITION_GUID],
  [READER_ROLE_DEFINITION_GUID.toUpperCase()],
]

const NUM_RUNS = 100 + EXAMPLES.length

type ArmTemplate = {
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

test("every generated subscription id passes the module's own gate", () => {
  // Without this, a generator drifting off the GUID shape would make every
  // property below fail with InvalidSubscriptionIdError, and the reason would sit
  // one layer away from the failure.
  fc.assert(
    fc.property(subscriptionIdArbitrary, (subscriptionId) => {
      expect(isSubscriptionId(subscriptionId)).toBe(true)
    }),
    { numRuns: NUM_RUNS, examples: EXAMPLES }
  )
})

describe("Requirement 11.8 — exactly one role assignment, in both artifacts", () => {
  test("the ARM template declares one resource, and it is that assignment", () => {
    fc.assert(
      fc.property(subscriptionIdArbitrary, (subscriptionId) => {
        const { armTemplate } = azureOnboardingArtifacts(subscriptionId)

        // Structural, not by substring: a second assignment is a second array
        // entry, and a substring count would also match a mention in a comment.
        // Parsing additionally proves the id survived JSON encoding for every
        // case mixture the generator produced (Requirement 11.2).
        const template = JSON.parse(armTemplate) as ArmTemplate

        expect(template.resources).toHaveLength(1)
        expect(template.resources[0].type).toBe(
          "Microsoft.Authorization/roleAssignments"
        )
        expect(template.resources[0].apiVersion).toBe(
          ROLE_ASSIGNMENT_API_VERSION
        )
        expect(occurrences(armTemplate, "roleAssignments")).toBe(1)

        // A `newGuid()` name grants a *second* assignment on redeployment — the
        // one way this template emits one assignment and still ends up with two.
        expect(template.resources[0].name).toContain("[guid(")
        expect(template.resources[0].name).not.toContain("newGuid")
      }),
      { numRuns: NUM_RUNS, examples: EXAMPLES }
    )
  })

  test("the az script issues one role assignment command", () => {
    fc.assert(
      fc.property(subscriptionIdArbitrary, (subscriptionId) => {
        const { azCliScript } = azureOnboardingArtifacts(subscriptionId)

        expect(occurrences(azCliScript, "az role assignment create")).toBe(1)
        expect(occurrences(azCliScript, "role assignment")).toBe(1)

        // `az ad sp create-for-rbac --role … --scopes …` creates an assignment as
        // a side effect of creating the principal, which would make the count
        // above wrong while it still read as 1 (Requirement 11.1).
        expect(azCliScript).not.toContain("create-for-rbac")
        expect(azCliScript).not.toContain("--scopes")
      }),
      { numRuns: NUM_RUNS, examples: EXAMPLES }
    )
  })
})

describe("Requirement 11.8 — that assignment's role is Reader", () => {
  test("both artifacts assign Reader, and neither assigns Monitoring Reader", () => {
    fc.assert(
      fc.property(subscriptionIdArbitrary, (subscriptionId) => {
        const { armTemplate, azCliScript, roleName } =
          azureOnboardingArtifacts(subscriptionId)
        const template = JSON.parse(armTemplate) as ArmTemplate

        expect(roleName).toBe(READER_ROLE_NAME)
        expect(READER_ROLE_NAME).toBe("Reader")

        expect(azCliScript).toContain(`ROLE='${READER_ROLE_NAME}'`)
        expect(azCliScript).toContain(`--role "\${ROLE}"`)

        expect(template.resources[0].properties.roleDefinitionId).toBe(
          "[variables('readerRoleDefinitionId')]"
        )
        expect(template.variables.readerRoleDefinitionId).toContain(
          `/providers/Microsoft.Authorization/roleDefinitions/${READER_ROLE_DEFINITION_GUID}`
        )
        expect(template.resources[0].properties.principalType).toBe(
          "ServicePrincipal"
        )

        // Monitoring Reader alone does not grant Resource Graph inventory
        // (Requirement 11.3), so it is not what either artifact assigns.
        expect(azCliScript).not.toContain("Monitoring Reader")
        expect(armTemplate).not.toContain("Monitoring Reader")
      }),
      { numRuns: NUM_RUNS, examples: EXAMPLES }
    )
  })
})

describe("Requirement 11.8 — that assignment's scope is the subscription's own", () => {
  test("both artifacts assign at /subscriptions/<id>", () => {
    fc.assert(
      fc.property(subscriptionIdArbitrary, (subscriptionId) => {
        const { armTemplate, azCliScript, scope } =
          azureOnboardingArtifacts(subscriptionId)
        const template = JSON.parse(armTemplate) as ArmTemplate
        const expected = scopePath(subscriptionId)

        expect(scope).toBe(expected)

        expect(azCliScript).toContain(`SCOPE='${expected}'`)
        expect(azCliScript).toContain(`--scope "\${SCOPE}"`)

        expect(template.variables.targetScope).toBe(expected)
        expect(template.variables.targetSubscriptionId).toBe(subscriptionId)
        expect(template.variables.readerRoleDefinitionId).toBe(
          `${expected}/providers/Microsoft.Authorization/roleDefinitions/` +
            READER_ROLE_DEFINITION_GUID
        )

        // A resource-group-scoped assignment is the failure the preflight exists
        // to catch, so neither artifact may narrow the scope path.
        expect(azCliScript).not.toContain("/resourceGroups/")
        expect(armTemplate).not.toContain("/resourceGroups/")
      }),
      { numRuns: NUM_RUNS, examples: EXAMPLES }
    )
  })

  test("the generated id appears in both artifacts, and no other id does", () => {
    fc.assert(
      fc.property(subscriptionIdArbitrary, (subscriptionId) => {
        const { armTemplate, azCliScript } =
          azureOnboardingArtifacts(subscriptionId)

        // Requirement 11.6 — the artifacts show the subscription they target,
        // verbatim. A template that ignored its argument, or normalized its case,
        // fails here.
        expect(azCliScript).toContain(subscriptionId)
        expect(armTemplate).toContain(subscriptionId)

        // And account for every other GUID-shaped run. Only two ids may appear
        // anywhere: this subscription's, and the built-in Reader role definition
        // id in the template. Compared case-insensitively, so the check is about
        // *which* id it is; the verbatim assertions above own the casing.
        const permitted = [
          subscriptionId.toLowerCase(),
          READER_ROLE_DEFINITION_GUID.toLowerCase(),
        ]

        for (const guid of guidsIn(azCliScript)) {
          expect(permitted).toContain(guid.toLowerCase())
        }
        for (const guid of guidsIn(armTemplate)) {
          expect(permitted).toContain(guid.toLowerCase())
        }

        // The script names no role definition id at all — it uses the display
        // name — so its only GUID is the subscription id, once per mention.
        expect(guidsIn(azCliScript).length).toBeGreaterThan(0)
        expect(guidsIn(armTemplate).length).toBeGreaterThan(0)
      }),
      { numRuns: NUM_RUNS, examples: EXAMPLES }
    )
  })
})

describe("Requirement 11.8 — no emitted action grants a write", () => {
  test.each(WRITE_CAPABLE_TOKENS)("neither artifact contains %s", (token) => {
    fc.assert(
      fc.property(subscriptionIdArbitrary, (subscriptionId) => {
        const { armTemplate, azCliScript } =
          azureOnboardingArtifacts(subscriptionId)

        expect(azCliScript).not.toContain(token)
        expect(armTemplate).not.toContain(token)
      }),
      { numRuns: NUM_RUNS, examples: EXAMPLES }
    )
  })
})

describe("Requirement 11.6 — no secret-shaped value appears", () => {
  test.each(SECRET_BEARING_TOKENS)("neither artifact contains %s", (token) => {
    fc.assert(
      fc.property(subscriptionIdArbitrary, (subscriptionId) => {
        const { armTemplate, azCliScript } =
          azureOnboardingArtifacts(subscriptionId)

        // The secret does not exist when these are generated: the script is what
        // creates it, on the customer's machine, printed once to their terminal.
        expect(azCliScript).not.toContain(token)
        expect(armTemplate).not.toContain(token)
      }),
      { numRuns: NUM_RUNS, examples: EXAMPLES }
    )
  })

  test("the template takes the principal object id as its only parameter", () => {
    fc.assert(
      fc.property(subscriptionIdArbitrary, (subscriptionId) => {
        const { armTemplate } = azureOnboardingArtifacts(subscriptionId)
        const template = JSON.parse(armTemplate) as ArmTemplate

        // So there is nowhere for a customer to paste a credential into.
        expect(Object.keys(template.parameters)).toEqual(["principalId"])
        expect(template.resources[0].properties.principalId).toBe(
          "[parameters('principalId')]"
        )
      }),
      { numRuns: NUM_RUNS, examples: EXAMPLES }
    )
  })
})
