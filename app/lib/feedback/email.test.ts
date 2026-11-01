import { describe, expect, test } from "vitest"

import { feedbackEmail, subjectLine } from "@/lib/feedback/email"
import { feedbackInputSchema } from "@/lib/feedback/input"

const BASE = {
  id: "fb_1",
  kind: "problem" as const,
  message: "The PDF is missing the backup page.\nIt jumps from Costs to Actions.",
  userEmail: "dana@acme.co",
  canReply: true,
  workspaceName: "Acme MSP",
  role: "Owner",
  pagePath: "/reports/run_8f2c",
  createdAt: new Date("2026-10-29T11:52:00Z"),
  baseUrl: "https://reporting.example.com",
}

describe("feedback email", () => {
  test("the subject names the kind and the first line; Reply-To is the sender when they agreed", () => {
    const email = feedbackEmail(BASE)
    expect(email.subject).toBe("[Feedback · Problem] The PDF is missing the backup page.")
    expect(email.replyTo).toBe("dana@acme.co")
    expect(email.text).toContain("Page: https://reporting.example.com/reports/run_8f2c")
    expect(email.text).toContain("Workspace: Acme MSP (Owner)")
    expect(email.text).toContain("Sent: 29 Oct 2026, 18:52 WIB")
    expect(email.html).toContain("https://reporting.example.com/admin?tab=feedback")
  })

  test("no Reply-To when they asked not to be replied to, and no page when none was attached", () => {
    const email = feedbackEmail({ ...BASE, canReply: false, pagePath: null })
    expect(email.replyTo).toBeUndefined()
    expect(email.text).toContain("Page: Not attached")
    expect(email.text).toContain("They asked not to be replied to.")
  })

  test("what a member wrote is escaped in the HTML", () => {
    const email = feedbackEmail({ ...BASE, message: `<script>alert("x")</script> & more` })
    expect(email.html).not.toContain("<script>")
    expect(email.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more")
  })

  test("a long or blank-led first line is cut to fit a subject", () => {
    expect(subjectLine("\n\n  hello  \nworld")).toBe("hello")
    const long = subjectLine("x".repeat(200))
    expect(long).toHaveLength(80)
    expect(long.endsWith("…")).toBe(true)
  })
})

describe("feedback input", () => {
  test("takes a kind, a message and the two choices; refuses an empty message or a full URL as the page", () => {
    expect(feedbackInputSchema.safeParse({ kind: "idea", message: "  more charts ", pagePath: "/dashboard", canReply: true }).data)
      .toEqual({ kind: "idea", message: "more charts", pagePath: "/dashboard", canReply: true })
    expect(feedbackInputSchema.safeParse({ kind: "idea", message: "   ", canReply: true }).success).toBe(false)
    expect(feedbackInputSchema.safeParse({ kind: "rant", message: "x", canReply: true }).success).toBe(false)
    expect(feedbackInputSchema.safeParse({ kind: "idea", message: "x", pagePath: "https://evil.example/", canReply: true }).success).toBe(false)
    expect(feedbackInputSchema.safeParse({ kind: "idea", message: "x".repeat(4001), canReply: true }).success).toBe(false)
  })
})
