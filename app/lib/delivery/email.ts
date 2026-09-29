/**
 * The email a customer receives when a report is sent. **Pure**, so its wording is tested
 * without sending anything.
 *
 * One number, and it is a verified one: the figure count the report's verification
 * recorded. The report itself stays behind the link — no attachment — so it expires with
 * the link, and the proof page is named so a forwarded copy can be checked.
 */

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

export function periodName(periodStart: string): string {
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${periodStart}T00:00:00Z`)
  )
}

export function deliveryEmail(input: {
  contactName: string
  customer: string
  periodStart: string
  figureCount: number
  reportUrl: string
  proofUrl: string
  expiresAt: Date
}): { subject: string; text: string; html: string } {
  const period = periodName(input.periodStart)
  const until = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta" }).format(
    input.expiresAt
  )
  const figures = input.figureCount.toLocaleString("en-US")
  const subject = `${input.customer} cloud report, ${period}`
  const text = [
    `Hello ${input.contactName},`,
    "",
    `Your cloud report for ${period} is ready. Every one of its ${figures} figures was checked against the data collected for it before it was sent.`,
    "",
    `View and download it: ${input.reportUrl}`,
    `The link works until ${until}.`,
    "",
    `To check that a copy you receive is genuine: ${input.proofUrl}`,
  ].join("\n")
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f1f1ee;font-family:Arial,Helvetica,sans-serif;color:#17181c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fdfdfc;border:1px solid #e2e2dd;border-radius:10px">
<tr><td style="padding:28px 28px 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#696b73">${escape(input.customer)}</td></tr>
<tr><td style="padding:0 28px;font-size:22px;font-weight:bold;color:#2f3c7e">Your ${escape(period)} cloud report</td></tr>
<tr><td style="padding:16px 28px 0;font-size:15px;line-height:1.55">Hello ${escape(input.contactName)},<br><br>Your cloud report for ${escape(period)} is ready. Every one of its <strong>${escape(figures)}</strong> figures was checked against the data collected for it before it was sent.</td></tr>
<tr><td style="padding:22px 28px"><a href="${escape(input.reportUrl)}" style="display:inline-block;background:#2f3c7e;color:#f4f5fb;text-decoration:none;padding:11px 18px;border-radius:8px;font-size:15px;font-weight:bold">View the report</a></td></tr>
<tr><td style="padding:0 28px 8px;font-size:13px;color:#4b4d55">The link works until ${escape(until)}.</td></tr>
<tr><td style="padding:0 28px 28px;font-size:13px;color:#4b4d55">To check that a copy you receive is genuine: <a href="${escape(input.proofUrl)}" style="color:#2f3c7e">${escape(input.proofUrl)}</a></td></tr>
</table></td></tr></table></body></html>`
  return { subject, text, html }
}
