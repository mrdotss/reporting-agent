/**
 * The pure validation surface — one import for the four boundary modules.
 *
 * **Nothing `server-only` may be re-exported here, ever.** A neutral barrel that
 * launders a server module across the boundary defeats the guard it sits next
 * to: the `server-only` marker in `lib/auth/*` and `lib/db/index.ts` turns a
 * client import into a build error, and a barrel that re-exported one of them
 * would turn that build error back into a runtime secret leak. Everything below
 * is pure — no secret, no database, no clock, no environment.
 *
 * Named re-exports rather than `export *`, so adding a symbol to one of these
 * modules is a decision made here too. `export *` is how a module's next export
 * crosses a boundary nobody chose to open.
 */

export {
  EMAIL_MAX_LENGTH,
  EMAIL_POLICY_MESSAGE,
  emailSchema,
  normalizeEmail,
} from "@/lib/validation/email"

export {
  SUBSCRIPTION_ID_MASK_CHAR,
  SUBSCRIPTION_ID_VISIBLE_CHARS,
  maskSubscriptionId,
} from "@/lib/validation/mask"

export {
  PASSWORD_MAX,
  PASSWORD_MIN,
  PASSWORD_POLICY_MESSAGE,
  isPasswordWithinPolicy,
  passwordCodePointLength,
  passwordSchema,
} from "@/lib/validation/password"

export { DEFAULT_RETURN_TO, safeReturnTo } from "@/lib/validation/return-to"
