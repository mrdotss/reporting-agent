/**
 * The post-login return target (Requirement 7.9).
 *
 * **Pure, and deliberately not `server-only`.** It runs at the boundary of a
 * server action and again in the login page's own render, and a client leaf may
 * need it too — so it holds no secret, opens no connection and reads no
 * environment variable.
 */

/**
 * Where an absent, malformed or off-origin return target resolves to
 * (Requirement 7.9).
 *
 * Exported rather than inlined because three call sites have to agree on it:
 * {@link safeReturnTo}, the login page that reads the query parameter, and
 * `lib/auth/guard.ts`, which omits the parameter entirely when the sanitized
 * target is already this value.
 */
export const DEFAULT_RETURN_TO = "/dashboard"

/**
 * Characters a browser strips or mangles before it parses a URL: the C0
 * controls, space and DEL.
 *
 * This is not a tidiness check. A browser removes tab, LF and CR from a URL
 * *before* parsing it, so `"/\t/evil.com"` is delivered as `"//evil.com"` — a
 * protocol-relative URL pointing at another origin, which passes a naive
 * "starts with one slash" test because the second slash was not adjacent to the
 * first in the string that was tested.
 */
const STRIPPED_BY_BROWSERS = /[\u0000-\u0020\u007f]/

/**
 * Sanitize a post-login return target, or fall back to
 * {@link DEFAULT_RETURN_TO} (Requirement 7.9).
 *
 * Accepts **only** a value beginning with exactly one `/`, so every accepted
 * value is a same-origin path. Rejected, each for its own reason:
 *
 * | input | why it is rejected |
 * |---|---|
 * | absent / `null` / `""` | no target was supplied |
 * | `dashboard` | a bare path; relative to whatever the current URL happens to be |
 * | `https://evil.com` | absolute, another origin |
 * | `//evil.com` | protocol-relative: the browser reads `evil.com` as the host |
 * | `/\evil.com` | the WHATWG URL parser treats `\` as `/` for a special scheme, so this *is* `//evil.com` |
 * | `/ /evil.com`, `/\t/evil.com` | see {@link STRIPPED_BY_BROWSERS} |
 *
 * An allowlist shape — "must start with `/`, must not start with a second
 * separator" — rather than a blocklist of known-bad prefixes. The failure mode
 * of an open-redirect guard is always a form nobody enumerated, so the check is
 * written as "what may pass", and everything else becomes the dashboard.
 *
 * The accepted value is returned **verbatim**, including any query string and
 * fragment, so a deep link survives sign-in intact.
 *
 * Pure: no I/O, no clock, no environment, and no `URL` construction — the
 * result depends on nothing but the argument.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (typeof raw !== "string") return DEFAULT_RETURN_TO

  // A single leading `/` and nothing that reads as a second separator.
  if (!raw.startsWith("/")) return DEFAULT_RETURN_TO
  if (raw.startsWith("//")) return DEFAULT_RETURN_TO
  if (raw.startsWith("/\\")) return DEFAULT_RETURN_TO

  if (STRIPPED_BY_BROWSERS.test(raw)) return DEFAULT_RETURN_TO

  return raw
}
