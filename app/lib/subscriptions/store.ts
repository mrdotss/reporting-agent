import "server-only"

import { randomUUID } from "node:crypto"

import { and, asc, eq } from "drizzle-orm"
import { z } from "zod"

import { decryptSecret, encryptSecret } from "@/lib/crypto"
import { getDb } from "@/lib/db"
import {
  connectedSubscriptions,
  type ConnectedSubscription,
  type FidelityTier,
  type SubscriptionStatus,
} from "@/lib/db/schema"
import {
  toConnectedSubscriptionView,
  type ConnectedSubscriptionView,
} from "@/lib/db/views"

/**
 * Every read and write of `connected_subscriptions` (Requirements 9.2, 9.3, 9.7,
 * 9.8, 9.9, 9.10, 13.7, 13.9).
 *
 * `import "server-only"` is the first line and stays there. It is not decoration
 * here: this module opens a connection, encrypts and **decrypts** the Azure
 * client secret, and is the one place in `app/` that can hand a caller a
 * plaintext customer credential. A client component importing it should be a
 * build error rather than a review comment.
 *
 * > **On the guard's directory sweeps.** `lib/subscriptions` is deliberately
 * > **not** in `SERVER_ONLY_DIRECTORIES` in `test/boundaries.static.test.ts`, and
 * > adding it would break the other two modules in this directory:
 * > `azure-artifacts.ts` is pure because the wizard's client leaf renders its
 * > output, and `state.ts` is pure because the expiry banner is a client leaf
 * > too. This module is covered instead by the rule that already fits it — any
 * > module importing `@/lib/crypto` must carry the marker (Requirement 6.2) —
 * > which fires on the import three lines above whether or not anybody remembers
 * > to maintain a list. The guard names all three modules so the split is
 * > asserted rather than assumed.
 *
 * ## The two invariants this module exists to hold
 *
 * **Every operation is scoped by `user_id`** (Requirement 9.7). There is no
 * exported function that takes an id without also taking the owner's id, so a
 * caller cannot accidentally reach a row by primary key alone. A row belonging to
 * another user resolves as **not found** (Requirement 9.8) — not as forbidden —
 * with no write applied and no field of it disclosed, the same rule
 * `lib/aws/s3.ts` follows for artifact keys: a "forbidden" answer confirms the
 * row exists, and existence is itself a fact about somebody else's customer.
 *
 * **The plaintext client secret exists here only as an argument.** It goes
 * straight into {@link encryptSecret} and the resulting envelope into
 * `client_secret_enc` and no other column (Requirements 9.2, 9.9). Nothing in
 * this module logs, and every returned value is a
 * {@link ConnectedSubscriptionView} — the one shape allowed to cross to a client
 * — with the single, explicitly named exception of
 * {@link resolveSubscriptionCredentials}, which is what invoke time needs
 * (Requirement 9.3).
 *
 * Write failures are re-thrown **redacted** for the same reason
 * `lib/actions/auth.ts` redacts its own: drizzle wraps a driver failure in a
 * `DrizzleQueryError` whose message carries the statement *and its bound
 * parameters*, and the parameters of the writes below include the ciphertext, the
 * tenant id and the client id. Re-throwing that verbatim writes them into a
 * server log.
 */

// --- Errors -----------------------------------------------------------------

/**
 * No row with that id belongs to that user (Requirement 9.8).
 *
 * One error for two situations that must be **indistinguishable**: the row does
 * not exist, and the row exists and belongs to somebody else. The message names
 * no id, no user and no field, so it is safe to log verbatim and it discloses
 * nothing when it reaches a response.
 */
export class SubscriptionNotFoundError extends Error {
  constructor() {
    super(
      "No connected subscription with that id belongs to the signed-in user."
    )
    this.name = "SubscriptionNotFoundError"
  }
}

/**
 * The `(user_id, subscription_id)` UNIQUE constraint rejected the insert
 * (Requirement 9.10).
 *
 * A distinct type rather than a boolean return, because the caller has to *state*
 * that the subscription is already connected, and no second row was written. The
 * message says exactly that and names no id — the consultant knows which
 * subscription they just submitted.
 */
export class SubscriptionAlreadyConnectedError extends Error {
  constructor() {
    super("That Azure subscription is already connected to this account.")
    this.name = "SubscriptionAlreadyConnectedError"
  }
}

/**
 * The stored envelope could not be decrypted, so no credential was resolved.
 *
 * Distinct from `CiphertextError` because the caller's remedy is different: this
 * is the run-terminal `SECRET_UNREADABLE` case, and it means the row needs a
 * rotated secret rather than a retry. Carries no `cause`, so the underlying
 * message — which names the algorithm and the failure mode — is not the thing
 * that gets logged next to a subscription id.
 */
export class SubscriptionSecretUnreadableError extends Error {
  constructor() {
    super(
      "The stored Azure client secret could not be decrypted, so no " +
        "credential was resolved. The secret must be rotated."
    )
    this.name = "SubscriptionSecretUnreadableError"
  }
}

// --- Driver errors ----------------------------------------------------------

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505"

/**
 * The constraint drizzle-kit generated for the `(user_id, subscription_id)` pair,
 * as it appears in `lib/db/migrations/0000_low_ogun.sql`.
 *
 * Requirement 9.10 is about **this** constraint. Matching on SQLSTATE alone would
 * map any future unique violation on this table to "already connected", which is
 * a false statement about a different failure.
 */
const SUBSCRIPTION_PAIR_CONSTRAINT =
  "connected_subscriptions_user_id_subscription_id_uq"

/**
 * The two fields read off a node-postgres error. Neither carries a value from the
 * statement, which is why these are the only two.
 */
const driverErrorSchema = z.object({
  code: z.string().optional(),
  constraint: z.string().optional(),
})

/** Just enough of an error to walk one link of the `cause` chain. */
const causeSchema = z.object({ cause: z.unknown() })

/** Depth bound, so a self-referential `cause` cannot spin. */
const MAX_CAUSE_DEPTH = 5

/**
 * The Postgres error code and constraint from a thrown value, or `undefined`.
 *
 * Walks the `cause` chain because drizzle 0.45 wraps every driver failure in a
 * `DrizzleQueryError` and puts the original underneath — the code is never on the
 * frame that is thrown. Structural, via zod, rather than
 * `instanceof DatabaseError`: an `instanceof` against a class imported here fails
 * silently if the driver instance differs, and that failure mode is a UNIQUE
 * violation escaping as a 500.
 *
 * Deliberately a second implementation of the walk in `lib/actions/auth.ts`
 * rather than an import from it: that module carries a file-level `"use server"`
 * directive, so every one of its runtime exports must be an async function and a
 * synchronous helper **cannot** be exported from it. The duplication is imposed
 * by the framework, not chosen.
 */
function driverError(
  thrown: unknown
): { code: string; constraint: string | undefined } | undefined {
  let frame: unknown = thrown

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    const fields = driverErrorSchema.safeParse(frame)
    if (fields.success && fields.data.code !== undefined) {
      return { code: fields.data.code, constraint: fields.data.constraint }
    }

    const wrapper = causeSchema.safeParse(frame)
    if (!wrapper.success) return undefined

    frame = wrapper.data.cause
    if (frame === undefined || frame === null) return undefined
  }

  return undefined
}

/**
 * Requirement 9.10 — the insert lost the race for this `(user, subscription)`
 * pair.
 *
 * Decided from the SQLSTATE code and the constraint name, never from the driver's
 * message text. A message match passes until the driver rewords itself, and it
 * fails *open*: the violation would surface as an unhandled 500 rather than as
 * the already-connected rejection.
 */
function isSubscriptionPairTaken(thrown: unknown): boolean {
  const error = driverError(thrown)

  return (
    error?.code === UNIQUE_VIOLATION &&
    error.constraint === SUBSCRIPTION_PAIR_CONSTRAINT
  )
}

/**
 * A replacement error carrying the operation and the SQLSTATE code and **nothing
 * else** (Requirements 9.9, 10.8).
 *
 * The original is dropped rather than attached as `cause`, and that is the whole
 * point: `DrizzleQueryError`'s message is `Failed query: <sql> params: <params>`,
 * and the parameters of every write below include the `client_secret_enc`
 * envelope, the tenant id and the client id. The SQLSTATE code names the class of
 * failure (`23502` not-null, `42P01` undefined table, `08006` connection failure)
 * without carrying a value.
 */
function redactedWriteError(operation: string, thrown: unknown): Error {
  const code = driverError(thrown)?.code
  const suffix = code === undefined ? "" : ` (postgres ${code})`

  return new Error(`[subscriptions] ${operation} failed${suffix}`)
}

// --- Status derivation ------------------------------------------------------

/**
 * `status` is **derived** from the preflight result, never passed in
 * (Requirements 9.6, 12.5, 12.14).
 *
 * This is what makes "no `active` row without a `scope_verified: true` preflight"
 * structural instead of a rule every call site has to remember. There is no
 * argument through which a caller can write `status = 'active'` alongside
 * `scope_verified = false`, which is the exact combination Requirement 12.5
 * forbids and the one an over-narrow role assignment would otherwise produce: a
 * connection that looks healthy, returns one resource group's resources, and
 * verifies every figure in a report that is 90% incomplete.
 *
 * `pending` for an unverified result rather than `disabled`: nothing has been
 * *rejected*, the scope was simply never proved. `disabled` is reserved for
 * Azure's own rejection (Requirement 13.9) — see
 * {@link disableConnectedSubscription}.
 */
function statusFor(scopeVerified: boolean): SubscriptionStatus {
  return scopeVerified ? "active" : "pending"
}

// --- Create -----------------------------------------------------------------

/**
 * What connecting a subscription needs.
 *
 * `clientSecret` is the **plaintext** submitted by the consultant, and it is
 * consumed exactly once, by {@link encryptSecret}. Named `clientSecret` rather
 * than `clientSecretEnc` on purpose: the caller holds a plaintext and this module
 * owns the encryption, so there is no call site that can pass a value it
 * encrypted itself under a key it resolved itself.
 *
 * `scopeVerified` and `fidelityTier` come from the Preflight_Service's result and
 * from nowhere else (Requirements 12.4, 12.14) — never from a successful
 * inventory query, which is RBAC-filtered and therefore succeeds for a principal
 * holding Reader on a single resource group.
 */
export type CreateConnectedSubscriptionInput = {
  readonly userId: string
  readonly displayName: string
  /** The customer's Azure subscription GUID, unmasked. */
  readonly subscriptionId: string
  /** **Secret.** */
  readonly tenantId: string
  /** **Secret.** */
  readonly clientId: string
  /** **Secret, plaintext.** Encrypted here; never stored or returned as given. */
  readonly clientSecret: string
  /** As reported by Azure when the secret was issued (Requirement 13.1). */
  readonly secretExpiresAt: Date
  /** From the preflight's permissions assertion only (Requirement 12.14). */
  readonly scopeVerified: boolean
  /** From the preflight's fidelity probe (Requirements 12.8–12.10). */
  readonly fidelityTier: FidelityTier
  /** Set on the `enhanced` tier, absent on `baseline`. */
  readonly logAnalyticsWorkspaceId?: string | null
}

/**
 * Insert one connected subscription and return the browser-safe projection
 * (Requirements 9.2, 9.9, 9.10, 10.2).
 *
 * Throws {@link SubscriptionAlreadyConnectedError} on the
 * `(user_id, subscription_id)` UNIQUE violation, with **no second row written**
 * (Requirement 9.10). There is deliberately no pre-`SELECT` for that case: the
 * constraint is scoped to the user, two submissions of the same subscription can
 * pass any pre-check concurrently, and the database is the only thing that can
 * resolve which one wins. The insert is the first and only write here, so the
 * losing submission has nothing to unwind.
 */
export async function createConnectedSubscription(
  input: CreateConnectedSubscriptionInput
): Promise<ConnectedSubscriptionView> {
  const id = randomUUID()

  try {
    const [row] = await getDb()
      .insert(connectedSubscriptions)
      .values({
        id,
        userId: input.userId,
        displayName: input.displayName,
        subscriptionId: input.subscriptionId,
        tenantId: input.tenantId,
        clientId: input.clientId,
        // Requirement 9.2 — the ciphertext, into this column and no other.
        clientSecretEnc: encryptSecret(input.clientSecret),
        secretExpiresAt: input.secretExpiresAt,
        scopeVerified: input.scopeVerified,
        status: statusFor(input.scopeVerified),
        fidelityTier: input.fidelityTier,
        logAnalyticsWorkspaceId: input.logAnalyticsWorkspaceId ?? null,
      })
      .returning()

    // Unreachable through the driver — an `INSERT ... RETURNING` that raised
    // nothing returned the row — but the projection needs a row rather than a
    // `row!`, and an assertion here would be a claim this module cannot back.
    if (row === undefined) {
      throw new Error("[subscriptions] the insert returned no row")
    }

    return toConnectedSubscriptionView(row)
  } catch (thrown) {
    if (isSubscriptionPairTaken(thrown)) {
      throw new SubscriptionAlreadyConnectedError()
    }

    throw redactedWriteError("connecting a subscription", thrown)
  }
}

// --- Reads ------------------------------------------------------------------

/**
 * One row, scoped to its owner (Requirements 9.7, 9.8).
 *
 * Module-private and the **only** row read in this file, so there is exactly one
 * place where the `user_id` predicate could be forgotten. Both ids are required
 * arguments; there is no overload that resolves a row by primary key alone.
 *
 * Returns `undefined` for "no such row for this user", which the exported
 * functions turn into {@link SubscriptionNotFoundError}. The `AND` is what makes
 * the two cases one answer: another user's id matches no row here, so no field of
 * it is read, let alone returned.
 */
async function readOwnedRow(
  userId: string,
  id: string
): Promise<ConnectedSubscription | undefined> {
  const [row] = await getDb()
    .select()
    .from(connectedSubscriptions)
    .where(
      and(
        eq(connectedSubscriptions.id, id),
        eq(connectedSubscriptions.userId, userId)
      )
    )
    .limit(1)

  return row
}

/**
 * Every connected subscription this user owns, as browser-safe projections
 * (Requirements 9.7, 10.2).
 *
 * Ordered by `created_at` then `id`: `created_at` is the order a consultant added
 * them in, and the id breaks a tie so two rows written in the same transaction do
 * not swap places between renders.
 */
export async function listConnectedSubscriptions(
  userId: string
): Promise<ConnectedSubscriptionView[]> {
  const rows = await getDb()
    .select()
    .from(connectedSubscriptions)
    .where(eq(connectedSubscriptions.userId, userId))
    .orderBy(
      asc(connectedSubscriptions.createdAt),
      asc(connectedSubscriptions.id)
    )

  return rows.map(toConnectedSubscriptionView)
}

/**
 * One connected subscription, as the browser-safe projection.
 *
 * Throws {@link SubscriptionNotFoundError} for an id that is not this user's
 * (Requirement 9.8) — the same error an absent id gets, so a probe learns nothing
 * from the difference.
 */
export async function getConnectedSubscription(
  userId: string,
  id: string
): Promise<ConnectedSubscriptionView> {
  const row = await readOwnedRow(userId, id)
  if (row === undefined) throw new SubscriptionNotFoundError()

  return toConnectedSubscriptionView(row)
}

// --- The two facts the inventory endpoint orders itself by ------------------

/**
 * A row's `status`, its `updated_at` and its label — and **no credential**
 * (Requirements 9.2, 9.9).
 *
 * Exactly what the Inventory_Endpoint needs before it may go any further, and
 * deliberately not one field more. The endpoint's order is three criteria —
 * ownership, then status, then the cache — and each step must be able to answer
 * without having read what the next one looks at:
 *
 *   * **Ownership** is this read's `WHERE`, so a row belonging to another user
 *     raises {@link SubscriptionNotFoundError} and no field of it is read.
 *   * **Status** is the first field, so a subscription that is not `active`
 *     resolves as unavailable naming that status — and nothing else about the row
 *     has been decrypted, resolved or disclosed by then.
 *   * **The cache** is keyed on the row id and invalidated by `updated_at`, which
 *     is the second field.
 *
 * The absence of the credential is the reason this is its own function rather than
 * two fields read off {@link resolveSubscriptionCredentials}. A row whose stored
 * envelope no longer decrypts raises {@link SubscriptionSecretUnreadableError}
 * there, and a `disabled` row is exactly the row that shape describes — so
 * resolving credentials first would answer "this secret cannot be read" for a
 * request whose correct answer is "this subscription is disabled". Requirement 9.9
 * says name the status, and naming the status means not touching the secret to find
 * it.
 */
export type SubscriptionRowState = {
  readonly status: SubscriptionStatus
  /** ISO 8601, UTC — the cache stores and compares this exact string. */
  readonly updatedAt: string
  /**
   * The consultant's own label for the connection, carried because
   * `AgentInvokeContext.display_name` is a required field of the invoke payload.
   *
   * Read here rather than through a second query, and **never** placed in a
   * response by the endpoint: Requirement 9.9's "disclose no field of that row
   * other than that status" is a rule about the answer, and the answer for a
   * non-`active` row names the status alone. It is already browser-safe —
   * `ConnectedSubscriptionView` carries it — so the rule is about restraint here
   * rather than about secrecy.
   */
  readonly displayName: string
}

/**
 * The `status` and `updated_at` of one of this user's subscriptions.
 *
 * Scoped by `user_id` like every other read here: another user's id resolves as
 * {@link SubscriptionNotFoundError}, disclosing no field (Requirements 9.4, 9.8).
 *
 * `updatedAt` is serialized to a string here for the reason
 * {@link toConnectedSubscriptionView} serializes `secretExpiresAt`: it is compared
 * against a value the cache is holding, and two representations of one instant that
 * compare unequal would make every lookup a miss — a cache that silently never hits
 * is indistinguishable from one that is working.
 */
export async function readSubscriptionRowState(
  userId: string,
  id: string
): Promise<SubscriptionRowState> {
  const row = await readOwnedRow(userId, id)
  if (row === undefined) throw new SubscriptionNotFoundError()

  return {
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    displayName: row.displayName,
  }
}

// --- Credential resolution --------------------------------------------------

/**
 * The Azure credential for one subscription, resolved server-side.
 *
 * **This is the only value in this module that is not browser-safe, and it never
 * leaves the server.** It exists for the moment the invoke payload's `context` is
 * built (Requirements 9.3, 41.5): the runtime is handed `tenant_id`, `client_id`
 * and `client_secret`, and those are resolved for the selected subscription at
 * that instant rather than held anywhere.
 *
 * Never returned from a route handler, never placed in a server-component prop,
 * never logged, never included in an event.
 */
export type ResolvedAzureCredentials = {
  /** The unmasked subscription GUID the run targets. */
  readonly subscriptionId: string
  readonly tenantId: string
  readonly clientId: string
  /** **Plaintext.** Decrypted for this call only. */
  readonly clientSecret: string
  readonly fidelityTier: FidelityTier
  readonly logAnalyticsWorkspaceId: string | null
}

/**
 * Resolve the Azure credential for one of this user's subscriptions, decrypting
 * `client_secret_enc` **at call time** (Requirement 9.3).
 *
 * Scoped by `user_id` like every other read, so another user's id resolves as
 * {@link SubscriptionNotFoundError} rather than as a credential
 * (Requirement 9.8). A stored envelope that fails authentication raises
 * {@link SubscriptionSecretUnreadableError}, distinct from not-found, because the
 * two have different remedies: one is a row that is not yours, the other is a row
 * whose secret must be rotated.
 *
 * This function performs **no expiry check**. That is
 * `subscriptionRunBlocker(view, now)` in `lib/subscriptions/state.ts`, and it is
 * the caller's gate — the enqueue and the reaper both apply it before they get
 * here, and duplicating it would put a second definition of "expired" next to the
 * one that is supposed to be single.
 */
export async function resolveSubscriptionCredentials(
  userId: string,
  id: string
): Promise<ResolvedAzureCredentials> {
  const row = await readOwnedRow(userId, id)
  if (row === undefined) throw new SubscriptionNotFoundError()

  let clientSecret: string
  try {
    clientSecret = decryptSecret(row.clientSecretEnc)
  } catch {
    // The original is dropped rather than chained: `CiphertextError`'s message is
    // safe on its own, but a caller logging `cause` chains next to a
    // subscription id is how the two end up in one log line.
    throw new SubscriptionSecretUnreadableError()
  }

  return {
    subscriptionId: row.subscriptionId,
    tenantId: row.tenantId,
    clientId: row.clientId,
    clientSecret,
    fidelityTier: row.fidelityTier,
    logAnalyticsWorkspaceId: row.logAnalyticsWorkspaceId,
  }
}

// --- Identity resolution ----------------------------------------------------

/**
 * Who a connected subscription *is*, with no credential in it.
 *
 * The subset of {@link ResolvedAzureCredentials} that identifies the service
 * principal and the subscription without carrying the secret that authenticates
 * as it. Still server-side only — `tenant_id` and `client_id` are secrets under
 * Requirement 10.3 and are excluded from every browser payload — but it holds no
 * plaintext credential, so nothing in it needs decrypting to produce.
 */
export type SubscriptionIdentity = {
  readonly displayName: string
  /** The unmasked subscription GUID. */
  readonly subscriptionId: string
  /** **Secret.** */
  readonly tenantId: string
  /** **Secret.** */
  readonly clientId: string
  readonly logAnalyticsWorkspaceId: string | null
}

/**
 * The identity of one of this user's subscriptions, **without decrypting
 * anything** (Requirements 9.7, 9.8).
 *
 * It exists for secret rotation, and the absence of the decryption is the whole
 * reason it is a separate function rather than a caller reading two fields off
 * {@link resolveSubscriptionCredentials}. Rotation needs the three identifiers so
 * the preflight can re-assert the *same* service principal with the *new* secret
 * — it has no use for the old one, and going through the credential resolver
 * would make a row whose stored envelope no longer decrypts raise
 * {@link SubscriptionSecretUnreadableError} on the one request that repairs it.
 * That error's own remedy is "the secret must be rotated", so the rotation path
 * must not be the path it blocks.
 *
 * Scoped by `user_id` like every other read here: another user's id resolves as
 * {@link SubscriptionNotFoundError}, disclosing no field (Requirement 9.8).
 */
export async function resolveSubscriptionIdentity(
  userId: string,
  id: string
): Promise<SubscriptionIdentity> {
  const row = await readOwnedRow(userId, id)
  if (row === undefined) throw new SubscriptionNotFoundError()

  return {
    displayName: row.displayName,
    subscriptionId: row.subscriptionId,
    tenantId: row.tenantId,
    clientId: row.clientId,
    logAnalyticsWorkspaceId: row.logAnalyticsWorkspaceId,
  }
}

// --- Rotation ---------------------------------------------------------------

/**
 * A rotated client secret and the preflight result it was re-verified with
 * (Requirements 13.7, 13.8).
 */
export type RotateClientSecretInput = {
  /** **Secret, plaintext.** Encrypted here. */
  readonly clientSecret: string
  /** The expiry Azure reported for the *new* secret. */
  readonly secretExpiresAt: Date
  /** From the re-run permissions assertion (Requirement 13.8). */
  readonly scopeVerified: boolean
  /** From the re-run fidelity probe, when the caller probed it again. */
  readonly fidelityTier?: FidelityTier
}

/**
 * Replace one subscription's `client_secret_enc` with fresh ciphertext and record
 * the submitted expiry (Requirement 13.7).
 *
 * `UPDATE ... SET client_secret_enc = <new>` retains **no earlier ciphertext**:
 * there is no history column, no audit copy and no second row, so the previous
 * envelope is gone the moment this returns. That is deliberate — a retained
 * envelope is a retained credential, and the whole point of rotating is that the
 * old one stops existing.
 *
 * `scope_verified` is set from the re-run preflight (Requirement 13.8) and
 * `status` is derived from it by {@link statusFor}, so a rotation that failed the
 * assertion cannot leave the row `active`. A rotation that *passed* clears a
 * previous `disabled`, which is the point of the rotate CTA that state renders.
 *
 * Scoped by `user_id`: another user's id applies **no write** and raises
 * {@link SubscriptionNotFoundError} (Requirement 9.8). The `AND` in the `WHERE`
 * is what makes that structural — the statement matches no row, so there is no
 * ordering in which a check passes and a write lands anyway.
 */
export async function rotateClientSecret(
  userId: string,
  id: string,
  input: RotateClientSecretInput
): Promise<ConnectedSubscriptionView> {
  let rows: ConnectedSubscription[]

  try {
    rows = await getDb()
      .update(connectedSubscriptions)
      .set({
        clientSecretEnc: encryptSecret(input.clientSecret),
        secretExpiresAt: input.secretExpiresAt,
        scopeVerified: input.scopeVerified,
        status: statusFor(input.scopeVerified),
        // Requirement 9.2 — a rotated credential must list the subscription again
        // rather than serve the listing the previous credential produced.
        updatedAt: new Date(),
        ...(input.fidelityTier === undefined
          ? {}
          : { fidelityTier: input.fidelityTier }),
      })
      .where(
        and(
          eq(connectedSubscriptions.id, id),
          eq(connectedSubscriptions.userId, userId)
        )
      )
      .returning()
  } catch (thrown) {
    throw redactedWriteError("rotating a client secret", thrown)
  }

  const [row] = rows
  if (row === undefined) throw new SubscriptionNotFoundError()

  return toConnectedSubscriptionView(row)
}

// --- Azure rejected the credential ------------------------------------------

/**
 * Set `status = 'disabled'` because Azure rejected the credential as expired
 * while the recorded `secret_expires_at` is still in the future
 * (Requirement 13.9).
 *
 * The recorded date is **consultant-entered** and can therefore present a
 * rejected credential as usable. This is the write that records Azure's own
 * evidence, and it is why `disabled` takes precedence over the date in
 * `resolveSubscriptionState` — a row whose typed-in expiry is months away but
 * whose secret Azure will not accept has to read as expired, or the consultant
 * keeps requesting runs against it.
 *
 * `scope_verified` is left alone: the scope assertion was true when it was made,
 * and the reason this row is unusable is the credential, not the role. Setting it
 * false here would also make this a second writer of that flag, which
 * Requirement 12.14 reserves to the preflight.
 *
 * Idempotent, and scoped by `user_id` — another user's id applies no write and
 * raises {@link SubscriptionNotFoundError}.
 */
export async function disableConnectedSubscription(
  userId: string,
  id: string
): Promise<ConnectedSubscriptionView> {
  let rows: ConnectedSubscription[]

  try {
    rows = await getDb()
      .update(connectedSubscriptions)
      // Requirement 9.2 — a changed status invalidates the cached listing, so this
      // write moves `updated_at` even though it is idempotent in every other field.
      .set({ status: "disabled", updatedAt: new Date() })
      .where(
        and(
          eq(connectedSubscriptions.id, id),
          eq(connectedSubscriptions.userId, userId)
        )
      )
      .returning()
  } catch (thrown) {
    throw redactedWriteError("disabling a subscription", thrown)
  }

  const [row] = rows
  if (row === undefined) throw new SubscriptionNotFoundError()

  return toConnectedSubscriptionView(row)
}
