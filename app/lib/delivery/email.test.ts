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
