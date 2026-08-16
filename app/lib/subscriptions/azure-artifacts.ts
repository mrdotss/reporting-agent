/**
 * The onboarding wizard's generated artifacts — an `az` CLI script and an ARM
 * template that grant **Reader at subscription scope** and nothing else
 * (Requirements 11.1, 11.2, 11.6, 11.8).
 *
 * **Pure, and deliberately not `server-only`.** No I/O, no clock, no
 * environment, no randomness, no SDK: a subscription id in, two strings out. The
 * wizard's copy button is a client leaf and renders these directly, and purity
 * is what turns "exactly one Reader assignment" into a property over generated
 * subscription ids rather than a review item somebody has to remember.
 *
 * Nothing here is a secret, and nothing here may become one. The artifacts are
 * shown to the consultant and forwarded to their customer, so they carry the
 * **target subscription id** and **no client secret value** (Requirement 11.6).
 * The client secret does not exist yet when these are generated — the `az`
 * script is what creates it, on the customer's own machine, printed to their own
 * terminal.
 *
 * These are read by a customer who will push back on Reader, so they are written
 * to be **read**: literal scope paths instead of nested ARM functions, one step
 * per command, and a comment saying what each step does. A cleverer template
 * that a reviewer cannot audit does not get approved.
 */

// --- What is granted --------------------------------------------------------

/**
 * The only role either artifact assigns (Requirements 11.1, 11.2, 11.8).
 *
 * Azure's built-in Reader. `Monitoring Reader` is deliberately **not** used: it
 * does not grant Azure Resource Graph inventory, and inventory is what
 * identifies the resources metrics are collected for (Requirement 11.3).
 */
export const READER_ROLE_NAME = "Reader"

/**
 * The GUID of the built-in Reader role definition, identical in every Azure
 * tenant.
 *
 * The `az` CLI accepts the role's display name, but an ARM template's
 * `roleDefinitionId` requires the id, so the constant has to exist. It is
 * hard-coded rather than looked up because this module performs no I/O — and
 * because a built-in role definition id is a documented, stable Azure fact, not
 * a value that varies per customer.
 */
export const READER_ROLE_DEFINITION_GUID =
  "acdd72a7-3385-48ef-bd42-f606fba81ae7"

/**
 * The display name the `az` script gives the app registration it creates.
 *
 * A fixed literal, so the script stays deterministic. The customer may rename it
 * before running the script; nothing downstream reads this name.
 */
export const APP_REGISTRATION_DISPLAY_NAME = "rpt-utilization-reader"

/**
 * The `Microsoft.Authorization/roleAssignments` api-version the ARM template
 * pins. Named rather than inlined so the pin is visible as a decision.
 */
export const ROLE_ASSIGNMENT_API_VERSION = "2022-04-01"

// --- The subscription id ----------------------------------------------------

/**
 * An Azure subscription id: a GUID in the canonical 8-4-4-4-12 hyphenated form.
 *
 * Anchored at both ends, so nothing precedes or follows the id.
 */
const SUBSCRIPTION_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Is this string an Azure subscription id?
 *
 * Exported so the wizard can gate its own generate control on a shape check
 * instead of catching {@link InvalidSubscriptionIdError} to decide whether to
 * render a button.
 */
export function isSubscriptionId(value: string): boolean {
  return SUBSCRIPTION_ID_PATTERN.test(value)
}

/**
 * The supplied subscription id is not a GUID, so no artifact was generated.
 *
 * **This is a shell-injection gate, not input tidiness.** The `az` artifact is a
 * script an administrator runs with rights to create an app registration and
 * assign a role across a whole subscription. Interpolating an unvalidated string
 * into it is interpolating into a privileged command line. Rejecting anything
 * that is not a GUID makes an injected `$(…)`, backtick, newline or quote
 * **unrepresentable** rather than escaped — the two artifacts additionally quote
 * and JSON-encode the id, but a shape gate that admits only 32 hex digits and
 * four hyphens is the guarantee that holds without depending on the quoting
 * being right.
 *
 * The message states the accepted shape and **excludes the supplied value**, the
 * same rule `MissingEnvError` follows: a wizard field is a place a consultant can
 * paste a client secret by mistake, and a "not a GUID: …" message is how that
 * reaches a log aggregator.
 */
export class InvalidSubscriptionIdError extends Error {
  constructor() {
    super(
      `The subscription id is not an Azure subscription id. Expected a GUID ` +
        `in 8-4-4-4-12 hyphenated form, for example ` +
        `3f2504e0-4f89-11d3-9a0c-0305e82c3301. The supplied value is ` +
        `excluded from this message.`
    )
    this.name = "InvalidSubscriptionIdError"
  }
}

function assertSubscriptionId(subscriptionId: string): string {
  if (!isSubscriptionId(subscriptionId)) throw new InvalidSubscriptionIdError()
  return subscriptionId
}

/**
 * The subscription's scope path, `/subscriptions/<id>` — the scope both
 * artifacts assign at (Requirement 11.8).
 *
 * One function rather than a template literal per artifact, because the `az`
 * script, the ARM template and the preflight that later proves the assignment
 * must name the **same** path character for character. Three copies of a scope
 * template is how a script grants at one scope and a check verifies another.
 */
export function subscriptionScope(subscriptionId: string): string {
  return `/subscriptions/${assertSubscriptionId(subscriptionId)}`
}

/**
 * The fully qualified Reader role definition id under one subscription.
 *
 * Written as a literal path rather than ARM's
 * `subscriptionResourceId('Microsoft.Authorization/roleDefinitions', …)`, so a
 * customer reviewing the template reads the role and the subscription it applies
 * to without evaluating a template function.
 */
function readerRoleDefinitionId(subscriptionId: string): string {
  return (
    `${subscriptionScope(subscriptionId)}/providers/Microsoft.Authorization` +
    `/roleDefinitions/${READER_ROLE_DEFINITION_GUID}`
  )
}

// --- The `az` CLI script ----------------------------------------------------

/**
 * The `az` CLI script: create one app registration with a service principal and
 * a client secret, then assign **one** role — Reader — at subscription scope
 * (Requirements 11.1, 11.8).
 *
 * The three creation steps are spelled out rather than folded into
 * `az ad sp create-for-rbac --role Reader --scopes …`. That one-liner would work,
 * but it creates its role assignment as a side effect of creating the principal,
 * which leaves the artifact's central promise — exactly one assignment, at one
 * scope — implicit in a flag. Here the assignment is its own visible command, and
 * `az ad app credential reset` is the only step that emits a credential.
 *
 * The script text contains no secret (Requirement 11.6): the secret is generated
 * by Azure when the customer runs step 3, and printed once to their terminal.
 */
export function readerRoleAzCliScript(subscriptionId: string): string {
  const scope = subscriptionScope(subscriptionId)

  return `#!/usr/bin/env bash
#
# Grant read-only access to Azure subscription ${subscriptionId}.
#
# Run this with the Azure CLI signed in to the tenant that owns the
# subscription ("az login"), as someone who may create an app registration and
# assign a role at subscription scope.
#
# What it does, in full:
#   1. creates one app registration
#   2. creates its service principal
#   3. issues one client secret for it, printed once, below
#   4. assigns one role to it: ${READER_ROLE_NAME}, at ${scope}
#
# ${READER_ROLE_NAME} grants read access. No other role and no other scope is
# requested, and nothing in this script modifies a resource in the
# subscription. Review it before you run it.
#
set -euo pipefail

SUBSCRIPTION_ID='${subscriptionId}'
SCOPE='${scope}'
ROLE='${READER_ROLE_NAME}'
APP_NAME='${APP_REGISTRATION_DISPLAY_NAME}'

az account set --subscription "\${SUBSCRIPTION_ID}"

# 1. The app registration. Its application id is the "client id" the reporting
#    app asks for.
APP_ID="\$(az ad app create \\
  --display-name "\${APP_NAME}" \\
  --query appId \\
  --output tsv)"

# 2. The service principal — the identity that actually holds the role. Its
#    object id is what step 4 assigns to.
PRINCIPAL_ID="\$(az ad sp create \\
  --id "\${APP_ID}" \\
  --query id \\
  --output tsv)"

# 3. The client secret. Azure prints it once and cannot show it again, so copy
#    it into the wizard now, together with the expiry it reports. Azure caps a
#    service-principal secret at 24 months.
az ad app credential reset \\
  --id "\${APP_ID}" \\
  --years 1 \\
  --output json

# 4. The one role grant this script makes.
az role assignment create \\
  --assignee-object-id "\${PRINCIPAL_ID}" \\
  --assignee-principal-type ServicePrincipal \\
  --role "\${ROLE}" \\
  --scope "\${SCOPE}"

echo "Tenant id:      \$(az account show --query tenantId --output tsv)"
echo "Client id:      \${APP_ID}"
echo "Subscription:   \${SUBSCRIPTION_ID}"
echo "Role granted:   \${ROLE} at \${SCOPE}"
`
}

// --- The ARM template -------------------------------------------------------

/**
 * The ARM template: one `Microsoft.Authorization/roleAssignments` resource
 * granting Reader at subscription scope (Requirements 11.2, 11.8).
 *
 * A subscription-scope deployment template, because the assignment's scope *is*
 * the subscription. Built as an object and serialized with `JSON.stringify`
 * rather than assembled as a string: the output is then valid JSON by
 * construction, the subscription id is JSON-encoded rather than pasted, and a
 * test can `JSON.parse` the result and count `resources` structurally instead of
 * matching a substring.
 *
 * The customer supplies only `principalId` — the **object id** of the service
 * principal, which is what `az ad sp create` printed as `id` in the script
 * above. The template holds no credential of any kind.
 */
export function readerRoleArmTemplate(subscriptionId: string): string {
  const scope = subscriptionScope(subscriptionId)

  const template = {
    $schema:
      "https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#",
    contentVersion: "1.0.0.0",
    metadata: {
      description:
        `Grants the built-in ${READER_ROLE_NAME} role to one service ` +
        `principal at the scope of Azure subscription ${subscriptionId}. ` +
        `Read-only: no other role and no other scope is requested.`,
    },
    parameters: {
      principalId: {
        type: "string",
        metadata: {
          description:
            "Object id of the service principal that will read this " +
            "subscription. This is the service principal's own id, not the " +
            "app registration's application (client) id.",
        },
      },
    },
    variables: {
      targetSubscriptionId: subscriptionId,
      targetScope: scope,
      readerRoleDefinitionId: readerRoleDefinitionId(subscriptionId),
    },
    resources: [
      {
        type: "Microsoft.Authorization/roleAssignments",
        apiVersion: ROLE_ASSIGNMENT_API_VERSION,
        // Deterministic in the scope, the principal and the role, so
        // redeploying this template is idempotent rather than a second grant.
        name: "[guid(variables('targetScope'), parameters('principalId'), variables('readerRoleDefinitionId'))]",
        properties: {
          roleDefinitionId: "[variables('readerRoleDefinitionId')]",
          principalId: "[parameters('principalId')]",
          principalType: "ServicePrincipal",
        },
      },
    ],
    // So the deployment states what it granted, where, and to which
    // subscription — the same three facts the script echoes.
    outputs: {
      roleGranted: { type: "string", value: READER_ROLE_NAME },
      grantedAtScope: { type: "string", value: "[variables('targetScope')]" },
      targetSubscriptionId: {
        type: "string",
        value: "[variables('targetSubscriptionId')]",
      },
    },
  }

  return `${JSON.stringify(template, null, 2)}\n`
}

// --- Both, together ---------------------------------------------------------

/**
 * The wizard's second step renders all of this, so it is returned as one object:
 * the two artifacts plus the facts the surrounding copy states, resolved from
 * the same subscription id in one call.
 */
export type AzureOnboardingArtifacts = {
  /** The supplied subscription id, verbatim (Requirement 11.6). */
  readonly subscriptionId: string
  /** `/subscriptions/<id>` — the scope both artifacts assign at. */
  readonly scope: string
  /** `Reader`, the only role either artifact assigns. */
  readonly roleName: string
  /** A `bash` script for the Azure CLI (Requirement 11.1). */
  readonly azCliScript: string
  /** A subscription-scope ARM template, as pretty-printed JSON (Req 11.2). */
  readonly armTemplate: string
}

/**
 * Generate both artifacts for one subscription id (Requirements 11.1, 11.2,
 * 11.6, 11.8).
 *
 * Throws {@link InvalidSubscriptionIdError} if the id is not a GUID, before any
 * string is built.
 */
export function azureOnboardingArtifacts(
  subscriptionId: string
): AzureOnboardingArtifacts {
  const scope = subscriptionScope(subscriptionId)

  return {
    subscriptionId,
    scope,
    roleName: READER_ROLE_NAME,
    azCliScript: readerRoleAzCliScript(subscriptionId),
    armTemplate: readerRoleArmTemplate(subscriptionId),
  }
}
