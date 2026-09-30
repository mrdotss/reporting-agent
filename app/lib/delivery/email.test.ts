import { describe, expect, test } from "vitest"

import { deliveryEmail } from "@/lib/delivery/email"

describe("the delivery email", () => {
  const email = deliveryEmail({
    contactName: "Budi <script>",
    customer: "Nusantara Logistik",
    periodStart: "2026-08-01",
    figureCount: 1204,
    reportUrl: "https://reporting.fatechid.com/r/tok",
    proofUrl: "https://reporting.fatechid.com/v/run-1",
    expiresAt: new Date("2026-10-03T02:00:00Z"),
  })

  test("names the customer and period, the verified figure count, the link, its expiry and the proof page", () => {
    expect(email.subject).toBe("Nusantara Logistik cloud report, August 2026")
    expect(email.text).toContain("Every one of its 1,204 figures was checked")
    expect(email.text).toContain("https://reporting.fatechid.com/r/tok")
    expect(email.text).toContain("until 3 October 2026")
    expect(email.text).toContain("https://reporting.fatechid.com/v/run-1")
  })

  test("the HTML escapes what it did not write", () => {
    expect(email.html).toContain("Budi &lt;script&gt;")
    expect(email.html).not.toContain("<script>")
  })
})

describe("At a glance in the delivery email", () => {
  const base = {
    contactName: "Budi",
    customer: "Nusantara Logistik",
    periodStart: "2026-08-01",
    figureCount: 409,
    reportUrl: "https://reporting.fatechid.com/r/tok",
    proofUrl: "https://reporting.fatechid.com/v/run-1",
    expiresAt: new Date("2026-10-03T02:00:00Z"),
  }
  const glance = {
    decisionsTitle: "Decisions for you",
    figures: [
      { label: "Resources", value: "58" },
      { label: "Resources to tidy up", value: "9" },
      { label: "Resources with no backup", value: "24" },
      { label: "Stopped machines", value: "7" },
    ],
    decisions: ["Review the resources listed under Housekeeping.", "Add a backup plan <now>."],
  }

  test("quotes the figures and decisions as the report printed them, in both parts", () => {
    const email = deliveryEmail({ ...base, glance })
    for (const { label, value } of glance.figures) {
      expect(email.text).toContain(`- ${label}: ${value}`)
      expect(email.html).toContain(`>${value}</div>`)
    }
    expect(email.text).toContain("Decisions for you\n- Review the resources listed under Housekeeping.")
    expect(email.html).toContain("Add a backup plan &lt;now&gt;.")
  })

  test("a report without the section sends the email without it", () => {
    const email = deliveryEmail({ ...base, glance: null })
    expect(email.text).not.toContain("At a glance")
    expect(email.html).not.toContain("At a glance")
  })
})
