import "server-only"

/**
 * Sending email through Mailtrap's Email Sending API — one HTTPS POST per message.
 *
 * No SMTP and no mail library: the API takes JSON with a Bearer token and answers with the
 * message ids it accepted. The token and the sender come from the service's settings file
 * (`RPT_MAILTRAP_TOKEN`, `RPT_MAIL_FROM`); neither is ever logged, and the token only ever
 * travels in the `Authorization` header.
 *
 * Every message carries the category `report-delivery`, so Mailtrap's logs and stats group
 * the report emails apart from anything else sent from the domain.
 */

export const MAILTRAP_SEND_URL = "https://send.api.mailtrap.io/api/send"
export const MAIL_CATEGORY = "report-delivery"

export class MailNotConfiguredError extends Error {
  constructor() {
    super("Email is not set up on this server: RPT_MAILTRAP_TOKEN and RPT_MAIL_FROM are both needed.")
    this.name = "MailNotConfiguredError"
  }
}

export type MailAddress = { readonly email: string; readonly name?: string }

export type MailMessage = {
  readonly to: MailAddress
  readonly subject: string
  readonly text: string
  readonly html: string
}

export type MailResult = { readonly ok: true; readonly messageId: string } | { readonly ok: false; readonly error: string }

/** `Name <address>` or a bare address, as `RPT_MAIL_FROM` may be written. **Pure.** */
export function parseSender(raw: string): MailAddress | null {
  const value = raw.trim()
  const named = /^(.*?)\s*<([^<>\s@]+@[^<>\s@]+)>$/.exec(value)
  if (named) {
    const name = named[1]!.trim().replace(/^"|"$/g, "")
    return name ? { email: named[2]!, name } : { email: named[2]! }
  }
  return /^[^<>\s@]+@[^<>\s@]+$/.test(value) ? { email: value } : null
}

export function mailSettings(env: NodeJS.ProcessEnv = process.env): { token: string; from: MailAddress } {
  const token = env.RPT_MAILTRAP_TOKEN?.trim()
  const from = parseSender(env.RPT_MAIL_FROM ?? "")
  if (!token || from === null) throw new MailNotConfiguredError()
  return { token, from }
}

/**
 * Send one message. Never throws for a refusal: the result says why, so a delivery with
 * several recipients records each one. Throws only when email is not configured.
 */
export async function sendMail(
  message: MailMessage,
  { fetchImpl = fetch, env = process.env }: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}
): Promise<MailResult> {
  const { token, from } = mailSettings(env)
  let response: Response
  try {
    response = await fetchImpl(MAILTRAP_SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
        category: MAIL_CATEGORY,
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (thrown) {
    return { ok: false, error: `Mailtrap could not be reached (${thrown instanceof Error ? thrown.name : "error"}).` }
  }

  const body = (await response.json().catch(() => null)) as { message_ids?: unknown; errors?: unknown } | null
  if (!response.ok) {
    const errors = Array.isArray(body?.errors) ? body.errors.filter((e): e is string => typeof e === "string") : []
    const reason =
      response.status === 401 || response.status === 403
        ? "Mailtrap refused the API token. Check RPT_MAILTRAP_TOKEN."
        : response.status === 429
          ? "Mailtrap's sending limit was reached. Try again later."
          : errors.join("; ") || `Mailtrap answered ${response.status}.`
    return { ok: false, error: reason.slice(0, 500) }
  }
  const ids = Array.isArray(body?.message_ids) ? body.message_ids.filter((id): id is string => typeof id === "string") : []
  return { ok: true, messageId: ids[0] ?? "" }
}
