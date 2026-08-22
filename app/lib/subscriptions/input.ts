import { z } from "zod"

import { isSubscriptionId } from "@/lib/subscriptions/azure-artifacts"

/**
 * The named boundary schemas for the subscription routes (Requirements 7.7,
 * 11.9).
 *
 * **Pure, and deliberately not `server-only`.** No I/O, no database, no
 * environment, no secret held: a request body in, a parsed value out. The
 * onboarding wizard's credentials step is a client leaf and has to be able to
 * state the same accepted expiry range the route enforces — Requirement 11.7
 * requires the wizard to say "24 months maximum", and Requirement 11.9 requires
 * the rejection to state the accepted range. A policy the browser cannot name is
 * a policy the form re-implements slightly differently, which is how a field hint
 * and a route come to disagree about the same date.
 *
 * The one thing these schemas read from ambient state is the **clock**, inside
 * {@link secretExpiresAtSchema}: "after the current instant" has no meaning
 * without one, and reading it at parse time makes the instant the request's own.
 * The arithmetic itself is factored into the pure, injectable
 * {@link maxSecretExpiry} and {@link withinSecretLifetime}, so the boundary cases
 * are testable at an instant a test chooses rather than only at "now".
 *
 * ## What is deliberately absent
 *
 * **No `scopeVerified` field, on any schema here.** Requirement 12.14 reserves
 * writing a `scope_verified` value of true to the Preflight_Service, and the
 * cheapest way to honour that is to leave the browser no field to put it in: the
 * create route runs the preflight itself and reads the flag off that result. A
 * schema that accepted it — even "only for convenience" — would make the browser
 * a writer of the one flag that decides whether a 90%-incomplete report is
 * deliverable.
 *
 * **No `fidelityTier` field either**, for the same reason: it is *probed* by the
 * preflight (Requirements 12.8–12.10), not asserted by the submitter.
 */

// --- Azure identifiers ------------------------------------------------------

/**
 * The GUID shape check, reused for the subscription, tenant, client and
 * workspace ids.
 *
 * Aliased from `azure-artifacts.ts` rather than re-written, because that module
 * needs the same predicate as a **shell-injection gate** — its `az` script
 * interpolates the subscription id into a privileged command line — and two
 * implementations of "is this a GUID" is how the gate and the boundary come to
 * admit different strings. The name is neutral here because a tenant id is not a
 * subscription id, but the shape is identical: 8-4-4-4-12 hexadecimal.
 */
const isAzureGuid = isSubscriptionId

/** States the accepted shape and quotes no value — an id is customer data. */
const GUID_MESSAGE =
  "Enter an Azure identifier as a GUID in 8-4-4-4-12 hyphenated form, " +
  "for example 3f2504e0-4f89-11d3-9a0c-0305e82c3301."

const azureGuidSchema = z
  .string({ error: GUID_MESSAGE })
  .refine(isAzureGuid, { error: GUID_MESSAGE })

// --- The client secret ------------------------------------------------------

/**
 * An upper bound on the submitted plaintext, generous by an order of magnitude.
 *
 * An Azure service-principal secret is around 40 characters. The bound exists so
 * a multi-megabyte body cannot be pushed through the encryption path and into a
 * column, not to police the format — the only authority on whether the value is
 * correct is Azure, and the preflight is where it finds out.
 */
export const CLIENT_SECRET_MAX_LENGTH = 1_000

/**
 * The rejection message for the secret field.
 *
 * States the accepted length and **carries nothing drawn from the value**, the
 * same rule `EMAIL_POLICY_MESSAGE` and `MissingEnvError` follow. This is the one
 * field on these schemas whose value is a customer credential, and a validation
 * message is a thing that ends up in a log line.
 */
export const CLIENT_SECRET_MESSAGE =
  `Paste the client secret Azure printed when the credential was created, ` +
  `at most ${CLIENT_SECRET_MAX_LENGTH} characters. The submitted value is ` +
  `excluded from this message.`

const clientSecretSchema = z
  .string({ error: CLIENT_SECRET_MESSAGE })
  .min(1, { error: CLIENT_SECRET_MESSAGE })
  .max(CLIENT_SECRET_MAX_LENGTH, { error: CLIENT_SECRET_MESSAGE })

// --- The display name -------------------------------------------------------

/** A label a consultant chooses, so it is bounded rather than validated. */
export const DISPLAY_NAME_MAX_LENGTH = 200

export const DISPLAY_NAME_MESSAGE =
  `Enter a name for this connection, from 1 to ${DISPLAY_NAME_MAX_LENGTH} ` +
  `characters.`

const displayNameSchema = z
  .string({ error: DISPLAY_NAME_MESSAGE })
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, { error: DISPLAY_NAME_MESSAGE })
      .max(DISPLAY_NAME_MAX_LENGTH, { error: DISPLAY_NAME_MESSAGE })
  )

// --- `secret_expires_at` ----------------------------------------------------

/**
 * Azure's hard cap on a service-principal secret's lifetime (Requirement 11.9).
 *
 * This is a fact about Azure, not a policy of ours: the portal and the CLI both
 * refuse to issue a credential valid for longer, and secrets are commonly issued
 * for 6 to 12 months. A submitted date beyond it is therefore not a long-lived
 * secret — it is a typo, or a date read off the wrong field, and accepting it
 * would silence the expiry warning for the entire life of the real credential.
 */
export const SECRET_MAX_LIFETIME_MONTHS = 24

/**
 * The rejection message, stating the accepted range as Requirement 11.9 demands:
 * after the current instant, and at most 24 months after it.
 *
 * One message for absent, malformed, past and too-distant, on purpose. They are
 * the same answer to the consultant — "that is not an expiry we can record" —
 * and the wizard's own copy is where the 6-to-12-month norm is explained
 * (Requirement 11.7).
 */
export const SECRET_EXPIRY_MESSAGE =
  `Enter the expiry Azure reported for this client secret, as an ISO 8601 ` +
  `instant that is after now and at most ${SECRET_MAX_LIFETIME_MONTHS} months ` +
  `from now. Azure caps a service-principal secret at ` +
  `${SECRET_MAX_LIFETIME_MONTHS} months and commonly issues one for 6 to 12.`

/**
 * The latest expiry acceptable at instant `now` — `now` plus 24 **calendar**
 * months, clamped to the target month's last day.
 *
 * Calendar months rather than a fixed day count, because that is what Azure's cap
 * is expressed in and a 730-day approximation would reject a legitimately issued
 * secret near the boundary. The clamp matters on exactly one class of date: from
 * 29 February a naive `setUTCMonth` rolls forward into 1 March, so the bound
 * would drift by a day depending on which day of which year the request landed
 * on. Clamping keeps it a function of the calendar rather than of the
 * implementation.
 *
 * Pure: `now` in, a bound out, no clock read.
 */
export function maxSecretExpiry(now: Date): Date {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() + SECRET_MAX_LIFETIME_MONTHS

  // Day 0 of the following month is the last day of the target month, and
  // `Date.UTC` normalizes a month index past 11 into the following year.
  const lastDayOfTargetMonth = new Date(
    Date.UTC(year, month + 1, 0)
  ).getUTCDate()

  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(now.getUTCDate(), lastDayOfTargetMonth),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds()
    )
  )
}

/**
 * Is this expiry inside the accepted window at `now` (Requirement 11.9)?
 *
 * **Strictly after `now`** and **at or before** the 24-month bound. Both
 * boundaries are chosen rather than incidental: an expiry equal to `now` is
 * already expired — recording it would create a connection that
 * `subscriptionRunBlocker` refuses on its first run — while an expiry exactly 24
 * months out is precisely what a secret issued for the maximum lifetime looks
 * like, so rejecting it would reject the commonest legitimate maximum.
 *
 * An unparseable date is rejected: `NaN` fails both comparisons, and failing
 * **closed** is the right direction for a field whose whole purpose is to make an
 * expired credential visible before it produces a clean, fully-verified, empty
 * report.
 */
export function withinSecretLifetime(expiresAt: Date, now: Date): boolean {
  const at = expiresAt.getTime()
  if (Number.isNaN(at)) return false

  return at > now.getTime() && at <= maxSecretExpiry(now).getTime()
}

/**
 * `secret_expires_at` at the boundary: an ISO 8601 instant, inside the accepted
 * window at the instant the request is parsed (Requirement 11.9).
 *
 * `z.iso.datetime({ offset: true })` accepts both `…Z` and `…+07:00`, because a
 * consultant reading an expiry out of the Azure portal may well hand it over in
 * their own offset, and both forms name the same instant unambiguously. A
 * *local* datetime with no offset is refused — it names no instant at all, and
 * guessing an offset for it is how a secret appears to expire seven hours from
 * when it does.
 *
 * The window check reads the clock **at parse time**, so the "current instant" is
 * the request's own. The arithmetic it defers to is pure and separately tested,
 * which is what makes the two boundaries assertable at an instant a test picks.
 */
export const secretExpiresAtSchema = z
  .string({ error: SECRET_EXPIRY_MESSAGE })
  .pipe(z.iso.datetime({ offset: true, error: SECRET_EXPIRY_MESSAGE }))
  .transform((value) => new Date(value))
  .refine((expiresAt) => withinSecretLifetime(expiresAt, new Date()), {
    error: SECRET_EXPIRY_MESSAGE,
  })

// --- The Log Analytics workspace -------------------------------------------

/**
 * The workspace id, when the customer opted into the enhanced tier.
 *
 * Absent, `null` and the empty string all normalize to `null` — a form that
 * submits an untouched optional field as `""` is stating the same thing as one
 * that omits it, and `null` is the value the `log_analytics_workspace_id` column
 * takes for the `baseline` tier. Normalizing here keeps `""` out of the column,
 * where it would read as "a workspace, whose id is nothing" and send the
 * fidelity probe after it.
 */
const logAnalyticsWorkspaceIdSchema = z
  .union([z.literal(""), z.null(), azureGuidSchema])
  .optional()
  .transform((value) =>
    value === undefined || value === null || value === "" ? null : value
  )

// --- The submitted credential ----------------------------------------------

/**
 * The fields a consultant submits for a connection, shared by the routes that
 * need them.
 *
 * Written once and spread into each schema below rather than composed with
 * `.extend`, so every schema is a plain object literal a reader can see the whole
 * of, and so `.strict()` is applied at each use rather than inherited.
 */
const submittedCredentialShape = {
  displayName: displayNameSchema,
  subscriptionId: azureGuidSchema,
  tenantId: azureGuidSchema,
  clientId: azureGuidSchema,
  clientSecret: clientSecretSchema,
  secretExpiresAt: secretExpiresAtSchema,
  logAnalyticsWorkspaceId: logAnalyticsWorkspaceIdSchema,
} as const

/**
 * `POST /api/subscriptions/test` — the preflight probe (Requirement 7.7).
 *
 * `.strict()` throughout this module: an unrecognized key is a **rejection**, not
 * something to drop quietly. A body carrying `scopeVerified: true` is the exact
 * mistake Requirement 12.14 exists to prevent, and silently ignoring it would
 * make a client that tried it look like it had succeeded.
 */
export const subscriptionTestInputSchema = z
  .object({ ...submittedCredentialShape })
  .strict()

export type SubscriptionTestInput = z.output<typeof subscriptionTestInputSchema>

/**
 * `POST /api/subscriptions` — create a connection (Requirement 7.7).
 *
 * Structurally identical to {@link subscriptionTestInputSchema} today, and named
 * separately because the two are separate contracts: this one's fields are
 * *persisted*, so a field that later becomes creation-only must be able to appear
 * here without widening what the probe accepts.
 *
 * It carries the full credential rather than a reference to a previous probe
 * because **this route runs the preflight itself**. A "the wizard already tested
 * it" token would either be a claim the browser makes about `scope_verified` —
 * which Requirement 12.14 forbids — or a server-side cache of a plaintext Azure
 * secret between two requests, which is worse than sending it twice over TLS.
 */
export const subscriptionCreateInputSchema = z
  .object({ ...submittedCredentialShape })
  .strict()

export type SubscriptionCreateInput = z.output<
  typeof subscriptionCreateInputSchema
>

/**
 * `GET /api/subscriptions` — no query parameters (Requirement 7.7).
 *
 * Requirement 7.7 counts search parameters as input, so the route parses them
 * rather than ignoring them, and this states positively that the accepted set is
 * empty. `.strict()` makes an unexpected parameter a rejection: a caller passing
 * `?userId=…` is expressing an expectation this route does not honour — every
 * read is scoped to the signed-in user — and answering it with somebody's own
 * subscriptions would look like the filter had been applied.
 */
export const subscriptionListQuerySchema = z.object({}).strict()

// --- The dynamic segment ----------------------------------------------------

/**
 * An upper bound on a path segment, so a pathological URL is refused before it
 * becomes a bound parameter.
 *
 * Generous by two orders of magnitude against the 36 characters
 * `crypto.randomUUID()` produces. It exists to bound the input, not to describe
 * the id.
 */
export const SUBSCRIPTION_ID_PARAM_MAX_LENGTH = 200

export const SUBSCRIPTION_ID_PARAM_MESSAGE =
  "The connected subscription id is missing from the request path."

/**
 * `[id]` in `/api/subscriptions/[id]/secret` — a path parameter is input
 * (Requirement 7.7).
 *
 * **A bounded non-empty string, deliberately not `z.uuid()`.** The store mints
 * this id with `randomUUID()` today, so a UUID check would pass on everything the
 * app writes — but `connected_subscriptions.id` is a `text` primary key, and a
 * boundary that asserts more than the column does is a boundary that starts
 * rejecting valid rows the day an id is minted any other way.
 *
 * Leaving the shape unasserted also keeps the refusal **uniform**: every id that
 * is not this user's — absent, junk, or somebody else's — resolves as the one
 * not-found answer that Requirement 9.8 requires, decided by the `AND user_id`
 * predicate in the statement rather than split across a 400 here and a 404 there.
 * A caller learns nothing from the difference because there is no difference.
 *
 * Trimmed before the length check, so a segment of spaces is the same rejection
 * as an empty one rather than a lookup for a row whose id is whitespace.
 */
export const subscriptionIdParamSchema = z
  .object({
    id: z
      .string({ error: SUBSCRIPTION_ID_PARAM_MESSAGE })
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .min(1, { error: SUBSCRIPTION_ID_PARAM_MESSAGE })
          .max(SUBSCRIPTION_ID_PARAM_MAX_LENGTH, {
            error: SUBSCRIPTION_ID_PARAM_MESSAGE,
          })
      ),
  })
  .strict()

export type SubscriptionIdParam = z.output<typeof subscriptionIdParamSchema>

// --- The inventory endpoint's boundary --------------------------------------

/**
 * `GET /api/subscriptions/[id]/inventory` — the path parameter (Requirement 9.3).
 *
 * Deliberately **the same schema object** as {@link subscriptionIdParamSchema},
 * exported under the name that endpoint's boundary uses. One rule, two names, and
 * the aliasing is the point: an id is an id, and two independently written schemas
 * over the same column would eventually disagree about trimming or about a length
 * bound, which is a difference a caller could probe.
 */
export const inventoryParamsSchema = subscriptionIdParamSchema

export type InventoryParams = z.output<typeof inventoryParamsSchema>

/**
 * `GET /api/subscriptions/[id]/inventory` — the search parameters, of which there
 * are none (Requirement 9.3).
 *
 * `.strict()` over an empty object rather than no schema at all, and that is a
 * statement rather than a formality: this endpoint's answer is a property of the
 * subscription alone, so there is nothing to filter, page or narrow by. A caller
 * that sends `?dimension=tag_keys` is a caller working from a different idea of what
 * this route does, and a 400 naming the unrecognized key says so — where ignoring it
 * would return the full listing and let that idea survive.
 *
 * It is also what keeps the cache honest. Every accepted search parameter would be
 * part of the answer and therefore part of the cache key, and the key is the row id
 * alone (Requirement 9.2). Refusing parameters is how that stays true.
 */
export const inventoryQuerySchema = z.object({}).strict()

export type InventoryQuery = z.output<typeof inventoryQuerySchema>

// --- Rotation ---------------------------------------------------------------

/**
 * `POST /api/subscriptions/[id]/secret` — a rotated client secret
 * (Requirements 13.7, 13.8, 7.7).
 *
 * **Two fields, and the shortest schema in this module is the point.** A rotation
 * replaces the *credential*, not the connection: the app registration keeps its
 * `tenant_id` and its `client_id`, and the subscription keeps its id. So there is
 * no field here for any of them, and `.strict()` refuses a body that supplies one
 * — which matters because `rotateClientSecret` has no argument that could write
 * them, so accepting a `tenantId` would mean quietly running the preflight
 * against an identity the row will still not have afterwards.
 *
 * The three identifiers the re-run preflight needs come off the stored row
 * instead, through `resolveSubscriptionIdentity`. The browser cannot influence
 * which service principal is re-asserted.
 *
 * `secretExpiresAt` reuses {@link secretExpiresAtSchema} unchanged, so the
 * accepted range Requirement 11.9 states for a new connection is the same range a
 * rotation states — a rotated secret is a freshly issued secret, and Azure's
 * 24-month cap applies to it identically. As with the create route, there is no
 * `scopeVerified` and no `fidelityTier` field: both come from the preflight
 * (Requirements 12.14, 12.8–12.10).
 */
export const rotateSecretInputSchema = z
  .object({
    clientSecret: clientSecretSchema,
    secretExpiresAt: secretExpiresAtSchema,
  })
  .strict()

export type RotateSecretInput = z.output<typeof rotateSecretInputSchema>
