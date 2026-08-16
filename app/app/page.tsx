import { redirect } from "next/navigation"

import { LOGIN_PATH } from "@/lib/auth/guard"
import { readSession } from "@/lib/auth/session"
import { DEFAULT_RETURN_TO } from "@/lib/validation"

/**
 * `/` — a signpost, never a page (Requirement 7.6).
 *
 * The product has no public landing page in this spec: a visitor either has a
 * session and belongs in the shell, or does not and belongs on `/login`. So this
 * route resolves the session once and forwards.
 *
 * ## `readSession`, not `requireSession`
 *
 * Deliberate. `requireSession()` would redirect an unauthenticated visitor to
 * `/login` too, but it builds that URL from a `returnTo` — and the only target
 * available here is `/`, which would send the visitor straight back to this
 * redirect after signing in. Branching on `readSession()` keeps the two
 * destinations explicit and leaves the login page's own default
 * ({@link DEFAULT_RETURN_TO}) to decide where a successful sign-in lands.
 *
 * Both destinations are imported rather than written as literals, so this file
 * cannot drift from the guard that redirects to `/login` or from the validator
 * that resolves an absent return target to `/dashboard` (Requirement 7.9).
 *
 * `readSession` awaits `cookies()`, which makes this route dynamic — correct,
 * and it also means the build never tries to prerender a session-dependent
 * redirect.
 *
 * `/dashboard` is built by a later task, so an authenticated visitor lands on a
 * 404 for now. That is the plan's ordering, not a defect in this route.
 */
export default async function RootPage(): Promise<never> {
  const user = await readSession()

  redirect(user === null ? LOGIN_PATH : DEFAULT_RETURN_TO)
}
