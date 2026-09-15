/**
 * An invitation the visitor has agreed to join but has not joined yet
 * (roles-and-ask-access Req 9).
 *
 * Browser helpers, pure and deliberately not `server-only`: the accept page and
 * the app shell are client leaves. The token is a bearer credential, so it lives
 * only in this tab's `sessionStorage` — never in a server-rendered URL, a query
 * string or a cookie — and it is stored only after the visitor pressed Accept.
 * That press is what makes finishing the acceptance later, without a second
 * press, the visitor's own decision.
 */

export const PENDING_INVITATION_KEY = "reporting-pending-invitation"

/** The page that accepts an invitation. */
export const INVITATION_PATH = "/invitations/accept"

const TOKEN = /^[A-Za-z0-9_-]{43}$/

export function isInvitationToken(value: string | null | undefined): value is string {
  return typeof value === "string" && TOKEN.test(value)
}

/** The token waiting in this tab, if a well-formed one is. Unusable storage holds none. */
export function pendingInvitation(): string | null {
  try {
    const token = sessionStorage.getItem(PENDING_INVITATION_KEY)
    return isInvitationToken(token) ? token : null
  } catch {
    return null
  }
}

export function rememberInvitation(token: string): void {
  try {
    sessionStorage.setItem(PENDING_INVITATION_KEY, token)
  } catch {
    // Nothing is kept, so sign-in returns to a page that asks for the link again.
  }
}

export function forgetInvitation(): void {
  try {
    sessionStorage.removeItem(PENDING_INVITATION_KEY)
  } catch {
    // Nothing was stored.
  }
}

/**
 * A full page load, not a router navigation.
 *
 * Accepting sets the workspace cookie, and the whole shell — sidebar, customers,
 * close — renders from it. A document load is the one navigation that cannot keep
 * the previous workspace's shell or be superseded by a refresh racing it.
 */
export function loadPage(path: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.location.replace(path)
  else window.location.assign(path)
}
