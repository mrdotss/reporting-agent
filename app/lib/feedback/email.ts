/**
 * The email the team receives for one Send feedback message. **Pure**, so its wording is
 * tested without sending anything.
 *
 * The subject leads with the kind and the message's first line, so an inbox reads as a
 * list of what people said. When the sender agreed to a reply, Reply-To is their address
 * and pressing Reply answers them; otherwise it stays the app's sender.
 */

import { FEEDBACK_KIND_LABEL, type FeedbackKind } from "@/lib/feedback/input"

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

const SUBJECT_LINE_MAX = 80

/** The message's first non-empty line, cut to fit a subject. */
export function subjectLine(message: string): string {
  const first = message.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? ""
  return first.length > SUBJECT_LINE_MAX ? `${first.slice(0, SUBJECT_LINE_MAX - 1).trimEnd()}…` : first
}

export type FeedbackEmailInput = {
  readonly id: string
  readonly kind: FeedbackKind
  readonly message: string
  readonly userEmail: string
  readonly canReply: boolean
  readonly workspaceName: string | null
  readonly role: string | null
  readonly pagePath: string | null
  readonly createdAt: Date
  /** The app's public address, no trailing slash: the page link and the inbox link. */
  readonly baseUrl: string
}

export function feedbackEmail(input: FeedbackEmailInput): {
  subject: string
  text: string
  html: string
  replyTo?: string
} {
  const kind = FEEDBACK_KIND_LABEL[input.kind]
  const subject = `[Feedback · ${kind}] ${subjectLine(input.message)}`
  const sent =
    new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta",
    }).format(input.createdAt) + " WIB"
  const pageUrl = input.pagePath === null ? null : `${input.baseUrl}${input.pagePath}`
  const inboxUrl = `${input.baseUrl}/admin?tab=feedback`
  const workspace =
    input.workspaceName === null ? "—" : input.role ? `${input.workspaceName} (${input.role})` : input.workspaceName

  const facts: [string, string][] = [
    ["From", input.userEmail],
    ["Can reply", input.canReply ? "Yes" : "No"],
    ["Workspace", workspace],
    ["Page", pageUrl ?? "Not attached"],
    ["Sent", sent],
    ["Reference", input.id],
  ]

  const text = [
    `${kind} from ${input.userEmail}`,
    "",
    input.message,
    "",
    ...facts.map(([label, value]) => `${label}: ${value}`),
    "",
    `Feedback inbox: ${inboxUrl}`,
    input.canReply ? "Press Reply to answer them directly." : "They asked not to be replied to.",
  ].join("\n")

  const rows = facts
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;font-size:13px;color:#696b73;white-space:nowrap;vertical-align:top">${escape(label)}</td>` +
        `<td style="padding:4px 0;font-size:13px;color:#17181c;word-break:break-all">${
          label === "Page" && pageUrl !== null
            ? `<a href="${escape(pageUrl)}" style="color:#2f3c7e">${escape(pageUrl)}</a>`
            : escape(value)
        }</td></tr>`
    )
    .join("")

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f1f1ee;font-family:Arial,Helvetica,sans-serif;color:#17181c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fdfdfc;border:1px solid #e2e2dd;border-radius:10px">
<tr><td style="padding:28px 28px 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#696b73">Utilize Space · ${escape(kind)}</td></tr>
<tr><td style="padding:0 28px;font-size:20px;font-weight:bold;color:#2f3c7e">Feedback from ${escape(input.userEmail)}</td></tr>
<tr><td style="padding:16px 28px 0"><div style="background:#f7f7f4;border:1px solid #e2e2dd;border-radius:8px;padding:14px 16px;font-size:15px;line-height:1.55;white-space:pre-wrap">${escape(input.message)}</div></td></tr>
<tr><td style="padding:16px 28px 0"><table role="presentation" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
<tr><td style="padding:22px 28px"><a href="${escape(inboxUrl)}" style="display:inline-block;background:#2f3c7e;color:#f4f5fb;text-decoration:none;padding:11px 18px;border-radius:8px;font-size:15px;font-weight:bold">Open the Feedback inbox</a></td></tr>
<tr><td style="padding:0 28px 28px;font-size:13px;color:#4b4d55">${
    input.canReply ? "Press Reply to answer them directly." : "They asked not to be replied to."
  }</td></tr>
</table></td></tr></table></body></html>`

  return { subject, text, html, ...(input.canReply ? { replyTo: input.userEmail } : {}) }
}
