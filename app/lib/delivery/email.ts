/**
 * The email a customer receives when a report is sent. **Pure**, so its wording is tested
 * without sending anything.
 *
 * Every number in it is a verified one: the figure count the report's verification
 * recorded, and — when the report has an At a glance section — that section's figures and
 * decisions exactly as the report printed them (`glance.json`). The report itself stays
 * behind the link — no attachment — so it expires with the link, and the proof page is
 * named so a forwarded copy can be checked.
 */

import type { Glance } from "@/lib/delivery/glance"

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

export function periodName(periodStart: string): string {
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${periodStart}T00:00:00Z`)
  )
}

/** Whether a period is a short one (at most 7 days), which the email names as a week. */
export function isWeekPeriod(periodStart: string, periodEnd: string | undefined): boolean {
  if (periodEnd === undefined) return false
  const days = (Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${periodStart}T00:00:00Z`)) / 86_400_000 + 1
  return Number.isFinite(days) && days >= 1 && days <= 7
}

/**
 * The period as a reader says it: "August 2026" for a month, "17–23 November 2026" for a
 * week, "28 December 2026 – 3 January 2027" for a week across a year.
 */
export function periodLabel(periodStart: string, periodEnd?: string): string {
  if (periodEnd === undefined || !isWeekPeriod(periodStart, periodEnd)) return periodName(periodStart)
  const [start, end] = [new Date(`${periodStart}T00:00:00Z`), new Date(`${periodEnd}T00:00:00Z`)]
  const full = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
  if (start.getUTCFullYear() !== end.getUTCFullYear()) return `${full.format(start)} – ${full.format(end)}`
  if (start.getUTCMonth() !== end.getUTCMonth()) {
    const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })
    return `${dayMonth.format(start)} – ${full.format(end)}`
  }
  return `${start.getUTCDate()}–${full.format(end)}`
}

/** "weekly ownership report", "weekly cloud report" or "cloud report", for the subject and heading. */
export function reportKind(input: { periodStart: string; periodEnd?: string; glance?: Glance | null }): string {
  const weekly = isWeekPeriod(input.periodStart, input.periodEnd)
  const ownership = input.glance?.focus === "ownership"
  return `${weekly ? "weekly " : ""}${ownership ? "ownership" : "cloud"} report`
}

export function deliveryEmail(input: {
  contactName: string
  customer: string
  periodStart: string
  /** The period's last day; a period of 7 days or fewer is named as a week. */
  periodEnd?: string
  figureCount: number
  reportUrl: string
  proofUrl: string
  expiresAt: Date
  glance?: Glance | null
}): { subject: string; text: string; html: string } {
  const period = periodLabel(input.periodStart, input.periodEnd)
  const kind = reportKind(input)
  const forPeriod = isWeekPeriod(input.periodStart, input.periodEnd) ? `the week of ${period}` : period
  const until = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta" }).format(
    input.expiresAt
  )
  const figures = input.figureCount.toLocaleString("en-US")
  const subject = `${input.customer} ${kind}, ${period}`
  const glance = input.glance ?? null
  const text = [
    `Hello ${input.contactName},`,
    "",
    `Your ${kind} for ${forPeriod} is ready. Every one of its ${figures} figures was checked against the data collected for it before it was sent.`,
    "",
    ...(glance === null
      ? []
      : [
          "At a glance",
          ...(glance.headline ? [glance.headline] : []),
          ...glance.figures.map((f) => `- ${f.label}: ${f.value}`),
          ...(glance.decisions.length > 0 ? ["", glance.decisionsTitle, ...glance.decisions.map((d) => `- ${d}`)] : []),
          "",
        ]),
    `View and download it: ${input.reportUrl}`,
    `The link works until ${until}.`,
    "",
    `To check that a copy you receive is genuine: ${input.proofUrl}`,
  ].join("\n")
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f1f1ee;font-family:Arial,Helvetica,sans-serif;color:#17181c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fdfdfc;border:1px solid #e2e2dd;border-radius:10px">
<tr><td style="padding:28px 28px 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#696b73">${escape(input.customer)}</td></tr>
<tr><td style="padding:0 28px;font-size:22px;font-weight:bold;color:#2f3c7e">Your ${escape(kind)}, ${escape(period)}</td></tr>
<tr><td style="padding:16px 28px 0;font-size:15px;line-height:1.55">Hello ${escape(input.contactName)},<br><br>Your ${escape(kind)} for ${escape(forPeriod)} is ready. Every one of its <strong>${escape(figures)}</strong> figures was checked against the data collected for it before it was sent.</td></tr>
${glance === null ? "" : glanceHtml(glance)}
<tr><td style="padding:22px 28px"><a href="${escape(input.reportUrl)}" style="display:inline-block;background:#2f3c7e;color:#f4f5fb;text-decoration:none;padding:11px 18px;border-radius:8px;font-size:15px;font-weight:bold">View the report</a></td></tr>
<tr><td style="padding:0 28px 8px;font-size:13px;color:#4b4d55">The link works until ${escape(until)}.</td></tr>
<tr><td style="padding:0 28px 28px;font-size:13px;color:#4b4d55">To check that a copy you receive is genuine: <a href="${escape(input.proofUrl)}" style="color:#2f3c7e">${escape(input.proofUrl)}</a></td></tr>
</table></td></tr></table></body></html>`
  return { subject, text, html }
}

/** At a glance as two rows of two figures, then the decisions. Table layout, inline styles:
 * what every mail client renders the same. */
function glanceHtml(glance: Glance): string {
  const cells = glance.figures.map(
    (f) =>
      `<td width="50%" style="padding:10px 12px;border:1px solid #e2e2dd;border-radius:8px;background:#f7f7f4;vertical-align:top">` +
      `<div style="font-size:20px;font-weight:bold;color:#17181c;font-family:Arial,Helvetica,sans-serif">${escape(f.value)}</div>` +
      `<div style="font-size:12px;color:#696b73;padding-top:2px">${escape(f.label)}</div></td>`
  )
  const rows: string[] = []
  for (let i = 0; i < cells.length; i += 2) {
    rows.push(`<tr>${cells[i]}${cells[i + 1] ?? '<td width="50%"></td>'}</tr>`)
  }
  const decisions =
    glance.decisions.length === 0
      ? ""
      : `<p style="margin:16px 0 6px;font-size:14px;font-weight:bold;color:#2f3c7e">${escape(glance.decisionsTitle)}</p>` +
        `<ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.5;color:#33343a">${glance.decisions
          .map((d) => `<li style="margin:0 0 4px">${escape(d)}</li>`)
          .join("")}</ul>`
  return `<tr><td style="padding:20px 28px 0">
<p style="margin:0 0 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#696b73">At a glance</p>
${glance.headline ? `<p style="margin:0 0 10px;font-size:17px;line-height:1.35;font-weight:bold;color:#17181c">${escape(glance.headline)}</p>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="border-collapse:separate;margin:0 -6px">${rows.join("")}</table>
${decisions}</td></tr>`
}
