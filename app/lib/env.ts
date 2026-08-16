import "server-only"

/**
 * Required configuration, resolved from `process.env` **at call time**
 * (Requirement 5).
 *
 * A missing variable should fail with the variable's name, at the moment
 * something needs it — not as a stack trace from whatever library received
 * `undefined` three frames later, and not as a module-load crash that takes
 * down an unrelated route. So there is no module-level snapshot and no memo:
 * every call reads the environment again (Requirements 5.1, 5.9).
 *
 * There is no `AUTH_SECRET` (Requirement 5.5). Session tokens are random and
 * stored hashed; nothing in this app is signed, and there is no Auth.js.
 */

/**
 * The required set, in declared order. `getEnv` resolves in this order, so a
 * deployment missing several variables is told about the first one here
 * (Requirement 5.8).
 *
 * Exported because `test/boundaries.static.test.ts` diffs `.env.example`
 * against this array (Requirements 5.10, 6.6). A guard holding its own copy of
 * the list is a guard that passes while lying.
 *
 * `RPT_HISTORY_TABLE` and `RPT_TITLE_MODEL_ID` are required and validated here
 * even though no module in this spec reads them: chat history and AI titles are
 * out of scope, and a variable that is declared but unused is cheaper than a
 * deployment that discovers it is absent later.
 */
export const REQUIRED_ENV_VARS = [
  "DATABASE_URL",
  "APP_ENCRYPTION_KEY",
  "AWS_REGION",
  "RPT_RUNTIME_ARN",
  "RPT_ARTIFACT_BUCKET",
  "RPT_HISTORY_TABLE",
  "RPT_TITLE_MODEL_ID",
  "RPT_CRON_SECRET",
  "RPT_APP_BASE_URL",
] as const

export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number]

/**
 * A required variable is absent, empty, or whitespace-only.
 *
 * The constructor takes the variable's **name and nothing else**, so the value
 * is never in scope to be interpolated into a message (Requirement 5.3). Half
 * of this set is a credential — `APP_ENCRYPTION_KEY` and `RPT_CRON_SECRET`
 * above all — and a "malformed value: …" message is how those reach a log
 * aggregator.
 *
 * `variableName` is carried as a field so a caller can branch on which
 * variable is missing without parsing the message.
 */
export class MissingEnvError extends Error {
  readonly variableName: RequiredEnvVar

  constructor(variableName: RequiredEnvVar) {
    super(
      `${variableName} is not set, or is set to an empty or whitespace-only ` +
        `value. Set it in the environment; app/.env.example describes the ` +
        `expected shape. Its value is excluded from this message.`
    )
    this.name = "MissingEnvError"
    this.variableName = variableName
  }
}

/**
 * Resolve one required variable, or throw {@link MissingEnvError}.
 *
 * Absent, the empty string and whitespace-only are all rejected
 * (Requirement 5.2): a shell that exports an unset variable, a `.env` line with
 * nothing after the `=`, and a value that is a stray space are the same
 * deployment mistake, and none of them is a usable connection string or key.
 *
 * The value is returned **verbatim**. Rejecting whitespace-only is a validity
 * gate, not a normalization step — this module has no basis for deciding that
 * a caller's value should be trimmed, and a caller that needs trimming does it
 * where it knows the format (`lib/crypto.ts` trims its own key).
 */
export function requireEnv(name: RequiredEnvVar): string {
  const value = process.env[name]

  if (value === undefined || value.trim().length === 0) {
    throw new MissingEnvError(name)
  }

  return value
}

/**
 * Resolve every required variable at once, for a startup or health check that
 * wants one error instead of nine.
 *
 * Iterates {@link REQUIRED_ENV_VARS} rather than the environment's own key
 * order, so when several variables are missing the error names the first in
 * declared order (Requirement 5.8) and the message is stable across machines.
 *
 * Like {@link requireEnv} this holds nothing between calls: the returned record
 * is fresh each time (Requirement 5.9).
 */
export function getEnv(): Record<RequiredEnvVar, string> {
  const resolved: Record<string, string> = {}

  for (const name of REQUIRED_ENV_VARS) {
    resolved[name] = requireEnv(name)
  }

  return resolved
}
