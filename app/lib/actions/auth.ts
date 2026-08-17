"use server"

import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"
import { redirect } from "next/navigation"
import { z } from "zod"

import { LOGIN_PATH, RETURN_TO_PARAM, requireSession } from "@/lib/auth/guard"
import { isLockedOut, recordLoginAttempt } from "@/lib/auth/lockout"
import {
  burnDecoyVerification,
  hashPassword,
  verifyPassword,
} from "@/lib/auth/password"
import {
  createSession,
  destroySession,
  revokeAllSessionsForUser,
} from "@/lib/auth/session"
import { getDb } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { seedStarterTemplates } from "@/lib/templates/seed"
import {
  DEFAULT_RETURN_TO,
  EMAIL_POLICY_MESSAGE,
  emailSchema,
  passwordSchema,
  safeReturnTo,
} from "@/lib/validation"

/**
 * The authentication server actions (Requirements 1.7–1.9, 1.13, 3.3, 3.6,
 * 7.1–7.5, 7.7, 7.10–7.12).
 *
 * ## Why the directive is arranged this way
 *
 * `"use server"` sits at the **top of the file**, and there is no
 * `import "server-only"`. The two markers are not alternatives to each other and
 * only one of them applies here:
 *
 *   * `import "server-only"` makes a module *unimportable* from the client. That
 *     is exactly right for `lib/auth/*`, `lib/db/*` and `lib/crypto.ts`
 *     (Requirement 6.1), and exactly wrong for this module: the login and
 *     register forms are `"use client"` leaves, and Next 16 requires a Server
 *     Function reached from a Client Component to live in a file carrying the
 *     directive at the top — see `use-server.md`, "Using Server Functions in a
 *     Client Component". A `"use server"` module is already never bundled for
 *     the browser: the client import is rewritten to a server reference, so the
 *     module body, the argon2 binding and the Postgres pool never enter the
 *     client graph. Adding `server-only` would guard a boundary the directive
 *     already closes, at the cost of the import the forms need.
 *   * The file-level directive means **every runtime export must be an async
 *     function**. That is why the four zod schemas below are module constants
 *     rather than exports, and why only *types* are exported — a type is not a
 *     value, so `export type` survives the rule. The schemas are named
 *     (Requirement 7.7) and each is parsed at its action's boundary; naming them
 *     is what makes the boundary reviewable, exporting them is not.
 *
 * The `lib/actions/` directory is deliberately outside the boundary guard's
 * `server-only` sweeps for the same reason.
 *
 * There is no `export const runtime = "nodejs"` here either — that declaration
 * belongs to route handlers, and in this file it would be an illegal non-async
 * export. Server Actions already run in the Node runtime alongside the page that
 * invoked them.
 *
 * ## Wire contract with the forms
 *
 * Each action has the `useActionState` signature — `(previousState, formData)` —
 * so a form can render a rejection without a client-side fetch. `undefined` is
 * the initial state, so the form needs no exported constant to start from.
 *
 * | Action | `FormData` fields |
 * |---|---|
 * | `registerAction` | `email`, `password` |
 * | `loginAction` | `email`, `password`, `returnTo` (optional) |
 * | `logoutAction` | — |
 * | `changePasswordAction` | `currentPassword`, `newPassword` |
 *
 * Every field is read with `formData.get(...)` and handed **unparsed** to a zod
 * schema whose leaf is `z.string()`. `FormData.get` returns
 * `string | File | null`, so a missing field and an uploaded file both arrive as
 * ordinary parse failures instead of an `as string` that typechecks and lies.
 *
 * ## What never appears in a return value or a log line
 *
 * No password, no `users.password_hash` and no session token (Requirement 1.12).
 * That constraint reaches further than it looks: drizzle wraps a driver failure
 * in a `DrizzleQueryError` whose message carries the statement **and its bound
 * parameters**, and the parameters of the two writes in this module include the
 * argon2 hash. So neither of those errors is logged or re-thrown as-is — see
 * {@link redactedWriteError}.
 */

// --- Returned state ---------------------------------------------------------

/**
 * A rejection, as a form renders it: one message, no field identification
 * (Requirement 7.5).
 *
 * Deliberately not a per-field error map. The login form's whole job is to
 * present one outcome for three internal paths, and a shape with an `email` slot
 * and a `password` slot is a shape that invites filling one of them in.
 */
export type AuthActionError = {
  readonly status: "error"
  readonly message: string
}

/**
 * What every action in this module returns.
 *
 * `undefined` is the initial state and the successful state — success never
 * returns, it redirects, so there is no "ok" variant to render and no chance of
 * a form showing a stale success next to a fresh error.
 */
export type AuthActionState = AuthActionError | undefined

/**
 * Frozen, because {@link INVALID_CREDENTIALS} and {@link EMAIL_UNAVAILABLE} are
 * shared module constants returned by reference. A caller that mutated one
 * would change every later response.
 */
function errorState(message: string): AuthActionError {
  return Object.freeze({ status: "error" as const, message })
}

// --- Messages ---------------------------------------------------------------

/**
 * Requirement 7.2 — the email is unavailable. It says nothing about *why*, so
 * the pre-existing-row path and the UNIQUE-violation path below are the same
 * answer, and neither confirms that the address is registered rather than
 * reserved.
 */
const EMAIL_UNAVAILABLE_MESSAGE = "That email address is not available."

/**
 * The single sign-in rejection (Requirements 1.7, 1.8, 3.6, 7.5).
 *
 * Names **neither** field: not "unknown email", not "wrong password", not "email
 * or password" — a message that names the pair still tells an enumerator that
 * the pair was the gate. It is one sentence about the submission as a whole.
 */
const INVALID_CREDENTIALS_MESSAGE =
  "Those sign-in details were not accepted. Check them and try again."

/** The change-password rejection. */
const CURRENT_PASSWORD_REJECTED_MESSAGE =
  "The current password was not accepted."

/**
 * Structural fallback for a parse failure carrying no issue, which zod does not
 * produce. Present so the message is never `undefined` in a rendered form.
 */
const INPUT_REJECTED_MESSAGE = "Check the details and try again."

// --- The generic outcome ----------------------------------------------------

/**
 * **One object, three paths** (Requirements 1.7, 1.8, 3.6).
 *
 * A locked-out email, an email matching no user and a password that fails
 * verification all `return INVALID_CREDENTIALS` — the same frozen reference, so
 * the three responses are byte-identical by construction rather than by three
 * copies of the same sentence agreeing today. Three constructions of one string
 * is how a whitespace edit to one of them becomes a registration oracle, which
 * is why this is a constant and not a call in each branch.
 */
const INVALID_CREDENTIALS = errorState(INVALID_CREDENTIALS_MESSAGE)

/** Requirements 7.2 and 7.12 return this same rejection. */
const EMAIL_UNAVAILABLE = errorState(EMAIL_UNAVAILABLE_MESSAGE)

const CURRENT_PASSWORD_REJECTED = errorState(CURRENT_PASSWORD_REJECTED_MESSAGE)

// --- Boundary schemas (Requirement 7.7) -------------------------------------

/**
 * Registration input.
 *
 * The submitted address is parsed **twice**, from one `FormData` entry:
 *
 *   * `displayEmail` keeps the visitor's own casing for `users.email`, trimmed —
 *     surrounding whitespace is a paste artifact, not how anyone types their
 *     address;
 *   * `email` is {@link emailSchema}'s output, which is the normalized form that
 *     `users.email_normalized` holds under its UNIQUE constraint, with the
 *     format and ≤254 checks applied to *that* form (Requirements 7.3, 7.11).
 *
 * Two keys rather than one transform, because the two values have genuinely
 * different destinations and both have to be validated. Both carry
 * {@link EMAIL_POLICY_MESSAGE}, so whichever issue lands first states the
 * accepted format and length.
 */
const registerInputSchema = z.object({
  displayEmail: z.string({ error: EMAIL_POLICY_MESSAGE }).trim(),
  email: emailSchema,
  password: passwordSchema,
})

/**
 * Sign-in input.
 *
 * The password is **any string**, not {@link passwordSchema}. The length policy
 * is a registration gate (Requirements 1.3, 1.4); applying it here would mean a
 * future tightening of the policy locks out every account that predates it,
 * and the stored hash is the only thing entitled to decide a sign-in anyway.
 *
 * Every message in this schema is the generic one, because
 * {@link loginAction} returns {@link INVALID_CREDENTIALS} for a parse failure
 * too — a malformed submission is a submission that does not authenticate, and
 * it must not be distinguishable from one that merely fails.
 *
 * `returnTo` never fails the parse: `.catch(null)` turns anything that is not a
 * string into an absent target, which {@link safeReturnTo} resolves to the
 * dashboard (Requirement 7.9). A crafted non-string in a hidden field should
 * cost the visitor their deep link, not their sign-in.
 */
const loginInputSchema = z.object({
  email: emailSchema,
  password: z.string({ error: INVALID_CREDENTIALS_MESSAGE }),
  returnTo: z.string().nullish().catch(null),
})

/**
 * Change-password input. The current password is any string — it is checked
 * against the stored hash, not against the policy — and the new one must satisfy
 * the policy (Requirements 1.3, 1.4).
 */
const changePasswordInputSchema = z.object({
  currentPassword: z.string({ error: CURRENT_PASSWORD_REJECTED_MESSAGE }),
  newPassword: passwordSchema,
})

/** The first issue's message, which is the one a form shows. */
function firstIssueMessage(error: z.ZodError): string {
  return error.issues.at(0)?.message ?? INPUT_REJECTED_MESSAGE
}

// --- Driver errors ----------------------------------------------------------

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505"

/**
 * The constraint drizzle-kit generated for `users.email_normalized`, as it
 * appears in `lib/db/migrations/0000_low_ogun.sql`.
 *
 * Requirement 7.12 is about **this** constraint. Matching on the code alone
 * would map any future unique violation on `users` — a second UNIQUE column, a
 * partial index — to "that email address is not available", which is a false
 * statement about a different failure.
 */
const EMAIL_NORMALIZED_CONSTRAINT = "users_email_normalized_unique"

/**
 * The two fields this module reads off a node-postgres error. Neither carries a
 * value from the statement, which is why these are the only two it reads.
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
 * `DrizzleQueryError` and puts the original underneath — the code is never on
 * the frame that is thrown. The top frame is inspected first, so a driver error
 * that arrives unwrapped resolves too.
 *
 * Structural, via zod, rather than `instanceof DatabaseError`: an `instanceof`
 * check against a class imported here fails silently if the driver instance
 * differs, and the failure mode is a UNIQUE violation escaping as a 500.
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
 * Requirement 7.12 — the insert lost the race for this normalized email.
 *
 * Decided from the SQLSTATE code and the constraint name, never from the
 * driver's message text. A message match is a check that passes until the
 * driver rewords itself, and it fails *open*: the violation would surface as an
 * unhandled 500 rather than as the email-unavailable rejection.
 */
function isEmailNormalizedTaken(thrown: unknown): boolean {
  const error = driverError(thrown)

  return (
    error?.code === UNIQUE_VIOLATION &&
    error.constraint === EMAIL_NORMALIZED_CONSTRAINT
  )
}

/**
 * A replacement error for a failed write to `users`, carrying the operation and
 * the SQLSTATE code and **nothing else** (Requirement 1.12).
 *
 * The original is dropped rather than attached as `cause`, and that is the whole
 * point of this function: `DrizzleQueryError`'s message is
 * `Failed query: <sql> params: <params>`, and the parameters of both writes here
 * include the argon2 hash. Re-throwing it — or logging it — writes a stored
 * password hash into the server log, which Requirement 1.12 forbids as plainly
 * as it forbids returning one. The SQLSTATE code names the class of failure
 * (`23502` not-null, `42P01` undefined table, `08006` connection failure)
 * without carrying a value.
 */
function redactedWriteError(operation: string, thrown: unknown): Error {
  const code = driverError(thrown)?.code
  const suffix = code === undefined ? "" : ` (postgres ${code})`

  return new Error(`[auth] ${operation} failed${suffix}`)
}

/**
 * Record a rejected sign-in attempt without letting the write fail the
 * rejection (Requirements 3.7, 3.8).
 *
 * `recordLoginAttempt` propagates a write failure by design, and on a rejection
 * path that failure must not escape. Two reasons, and the second is the binding
 * one:
 *
 *   * Requirement 3.8 *mandates* the generic outcome when `login_attempts` is
 *     unreadable. `isLockedOut` fails closed and reports "locked", so the very
 *     next thing this path does is try to write to the table it just could not
 *     read. An escaping error there would replace the outcome the requirement
 *     names with an error page.
 *   * The three rejection paths have to be **byte-identical**. If one of them
 *     could throw while another returns a message, a degraded database becomes
 *     the oracle that the shared {@link INVALID_CREDENTIALS} constant exists to
 *     prevent.
 *
 * Only the SQLSTATE code is logged: this insert's parameters carry the
 * normalized email, and a log line is not a place to put one.
 */
async function recordRejectedAttempt(emailNormalized: string): Promise<void> {
  try {
    await recordLoginAttempt(emailNormalized, false)
  } catch (thrown) {
    console.error(
      "[auth] a rejected sign-in attempt was not recorded",
      driverError(thrown)?.code ?? "unknown driver error"
    )
  }
}

// --- Actions ----------------------------------------------------------------

/**
 * Create an account, sign the visitor in, and land them on the dashboard
 * (Requirement 7.1).
 *
 * Both duplicate-email gates are here on purpose, and they are not redundant:
 *
 *   * the `SELECT` covers Requirement 7.2 — a normalized email that already
 *     exists is rejected before a hash is computed or a row is written;
 *   * the UNIQUE-violation catch covers Requirement 7.12 — two submissions of
 *     the same address can pass that `SELECT` concurrently, and the database is
 *     the only thing that can resolve which one wins. Both return the same
 *     {@link EMAIL_UNAVAILABLE} rejection, and the losing submission creates
 *     **no user row and no session**: the insert is the first write in this
 *     action, so there is nothing to unwind.
 *
 * `redirect` is the last statement and sits outside every `try` — it signals
 * through a thrown `NEXT_REDIRECT`, so a `catch` in its path swallows the
 * navigation and returns a rejection for a registration that actually
 * succeeded.
 */
export async function registerAction(
  _previousState: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const submittedEmail = formData.get("email")

  const parsed = registerInputSchema.safeParse({
    displayEmail: submittedEmail,
    email: submittedEmail,
    password: formData.get("password"),
  })

  // Requirements 1.4, 7.11 — the accepted email format and length, or the
  // accepted password range, stated by the schema that rejected it.
  if (!parsed.success) return errorState(firstIssueMessage(parsed.error))

  const { displayEmail, email, password } = parsed.data

  const [existing] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.emailNormalized, email))
    .limit(1)

  if (existing !== undefined) return EMAIL_UNAVAILABLE

  // Cannot raise `PasswordPolicyError`: the schema above applied the same
  // predicate and the same bounds this call re-checks.
  const passwordHash = await hashPassword(password)
  const userId = randomUUID()

  try {
    await getDb().insert(users).values({
      id: userId,
      email: displayEmail,
      emailNormalized: email,
      passwordHash,
    })
  } catch (thrown) {
    if (isEmailNormalizedTaken(thrown)) return EMAIL_UNAVAILABLE

    // Thrown rather than returned. An unwritable `users` table is not a
    // validation outcome, and presenting a database outage in the form's error
    // slot would tell the visitor their details were wrong when they were not.
    throw redactedWriteError("registering a user", thrown)
  }

  await createSession(userId)

  /**
   * Requirement 10.2 — the three starter templates, seeded **only** here, at
   * account creation.
   *
   * Placed after the `users` insert has committed and after the session exists,
   * and outside every `try`, because it can fail neither of them:
   * `seedStarterTemplates` never throws and returns its outcome instead
   * (Requirement 10.6). All three starters go in one transaction, so a failure
   * leaves no partially inserted starter or version row and leaves this account
   * able to author a template through the wizard.
   *
   * The outcome is not returned to the form. This action redirects on success,
   * and after a redirect there is no form left to render an `AuthActionState` —
   * so Requirement 10.6's "state that the starter templates could not be
   * initialized" is served by the seeder's own `[starters]` log line plus
   * `readSeededStarterKeys`, which lets the `/templates` surface state the
   * shortfall from the row. See `lib/templates/seed.ts` for that reasoning in
   * full.
   */
  await seedStarterTemplates(userId)

  // Requirement 7.1 — the dashboard, not `returnTo`: registration is not the
  // resumption of an interrupted request.
  redirect(DEFAULT_RETURN_TO)
}

/**
 * Sign in (Requirements 3.3, 3.6, 7.4, 7.5, 7.9, 7.10, 1.7, 1.8, 1.11).
 *
 * Four ways this can be refused, and every one of them returns the *same*
 * {@link INVALID_CREDENTIALS} reference:
 *
 * | path | requirement | verification? |
 * |---|---|---|
 * | the submission fails the schema | 7.5 | no |
 * | the email is locked out | 3.3, 3.6 | **no — forbidden** |
 * | the email matches no user | 1.7 | a decoy burn (1.11) |
 * | the password does not verify | 1.8 | yes |
 *
 * The locked-out path returns before `users` is even read: Requirement 3.3 says
 * no verification, and `isLockedOut` fails closed, so an unreadable
 * `login_attempts` lands here too (Requirement 3.8). The unmatched-email path
 * burns one real argon2id verification against the decoy hash, so it costs what
 * the failed-verification path costs and the elapsed time discloses nothing
 * (Requirement 1.11).
 *
 * A schema failure records no attempt. There is no normalized email to key one
 * on — the submission may not be an address at all — and `login_attempts` rows
 * exist to measure a window per email.
 *
 * No `try` block in this function, so the closing `redirect` is safe by
 * construction rather than by placement.
 */
export async function loginAction(
  _previousState: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const parsed = loginInputSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    returnTo: formData.get(RETURN_TO_PARAM),
  })

  if (!parsed.success) return INVALID_CREDENTIALS

  const { email, password, returnTo } = parsed.data

  // Sanitized here, at the point the target is chosen, rather than trusted to
  // have been sanitized by whatever put it in the hidden field (Req 7.9).
  const target = safeReturnTo(returnTo)

  if (await isLockedOut(email, new Date())) {
    await recordRejectedAttempt(email)
    return INVALID_CREDENTIALS
  }

  const [account] = await getDb()
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.emailNormalized, email))
    .limit(1)

  if (account === undefined) {
    await burnDecoyVerification(password)
    await recordRejectedAttempt(email)
    return INVALID_CREDENTIALS
  }

  if (!(await verifyPassword(account.passwordHash, password))) {
    await recordRejectedAttempt(email)
    return INVALID_CREDENTIALS
  }

  /**
   * Recorded **before** the session is granted, and this one is not
   * best-effort (Requirement 3.1): if the attempt counter cannot be written,
   * the credential check must not be allowed to hand out a session. A broken
   * counter that still grants sessions is the state in which failures go
   * uncounted, lockout never fires, and a guessed password is eventually
   * rewarded. Failing the sign-in instead costs availability and gives up
   * nothing.
   */
  await recordLoginAttempt(email, true)

  /**
   * Requirement 7.10 — rotate, and the order is the requirement.
   *
   * `destroySession` first: it reads the presented cookie, deletes **that**
   * `sessions` row and clears the cookie. `createSession` then writes the new
   * row and sets the new cookie. Reversed, this silently does the wrong thing —
   * `createSession` has already written the new token into the request's cookie
   * store, so `destroySession` would read the *new* value back and delete the
   * row it had just created, leaving the presented row alive.
   *
   * A no-op when no cookie was presented (Requirement 2.13), which is why it is
   * called unconditionally: "rotate an existing session" and "sign in fresh"
   * are one path. Should `createSession` fail after the old row is gone, the
   * visitor is signed out rather than holding a session they were meant to have
   * replaced — the safe direction, and one retry away from resolved.
   */
  await destroySession()
  await createSession(account.id)

  redirect(target)
}

/**
 * Sign out (Requirements 2.12, 2.13).
 *
 * The row and the cookie both go, through `destroySession`, which is a no-op
 * when no cookie is presented — a sign-out from a stale tab is an ordinary
 * request, not an error. A failed row deletion propagates from there by design:
 * clearing the cookie while the token still authenticates elsewhere is the one
 * outcome database-backed sessions exist to prevent.
 *
 * No input, so no schema (Requirement 7.7 has nothing to parse). Usable
 * directly as `<form action={logoutAction}>`; the `FormData` such a form passes
 * is ignored, which is why no parameter is declared to receive it.
 */
export async function logoutAction(): Promise<void> {
  await destroySession()

  redirect(LOGIN_PATH)
}

/**
 * Change the signed-in user's password (Requirements 1.9, 1.13).
 *
 * The new hash and the deletion of **every** `sessions` row for this user
 * happen inside one `db.transaction`, with the transaction handle passed to
 * `revokeAllSessionsForUser`. That is what Requirement 1.13 buys: a failure at
 * either statement rolls back both, so the account keeps its previous
 * `password_hash` *and* every previous session row. Two sequential statements
 * would have a window in which the password has changed and the old sessions
 * are still live — the precise state a password change exists to end.
 *
 * The revoked set includes the row backing this very request (Requirement 1.9),
 * so the redirect below lands on the login page as an unauthenticated visitor.
 * The stale cookie is left to expire rather than cleared: clearing it means
 * another `DELETE` through `destroySession`, whose failure would surface as an
 * error page *after* the password had already been changed. It authenticates
 * nothing — `readSession` finds no row for it and performs no write
 * (Requirement 2.18).
 *
 * `requireSession` runs first and outside every `try`, both because a Server
 * Action is reachable by direct POST and must authorize itself, and because it
 * redirects by throwing.
 */
export async function changePasswordAction(
  _previousState: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const user = await requireSession()

  const parsed = changePasswordInputSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
  })

  if (!parsed.success) return errorState(firstIssueMessage(parsed.error))

  const { currentPassword, newPassword } = parsed.data

  const [account] = await getDb()
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)

  // The session resolved but the user row did not: the account was deleted
  // mid-request. Rejected rather than raised — there is nothing to change.
  if (account === undefined) return CURRENT_PASSWORD_REJECTED

  if (!(await verifyPassword(account.passwordHash, currentPassword))) {
    return CURRENT_PASSWORD_REJECTED
  }

  const passwordHash = await hashPassword(newPassword)

  try {
    await getDb().transaction(async (tx) => {
      await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id))

      await revokeAllSessionsForUser(user.id, tx)
    })
  } catch (thrown) {
    throw redactedWriteError("changing a password", thrown)
  }

  redirect(LOGIN_PATH)
}
