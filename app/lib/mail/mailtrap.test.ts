import { describe, expect, test, vi } from "vitest"

import { MAILTRAP_SEND_URL, MailNotConfiguredError, mailProblem, parseSender, sendMail } from "@/lib/mail/mailtrap"

const ENV = { RPT_MAILTRAP_TOKEN: "tok-fixture-123", RPT_MAIL_FROM: "FATechID Reports <reports@fatechid.com>" } as unknown as NodeJS.ProcessEnv
const MESSAGE = { to: { email: "budi@customer.co.id", name: "Budi" }, subject: "S", text: "T", html: "<p>H</p>" }

function answering(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))
}

describe("Mailtrap", () => {
  test("the sender reads as a name and an address, or an address alone", () => {
    expect(parseSender("FATechID Reports <reports@fatechid.com>")).toEqual({ email: "reports@fatechid.com", name: "FATechID Reports" })
    expect(parseSender(" reports@fatechid.com ")).toEqual({ email: "reports@fatechid.com" })
    expect(parseSender("not an address")).toBeNull()
  })

  test("one POST with the token as a Bearer header, the sender, one recipient and the category", async () => {
    const fetchImpl = answering(200, { success: true, message_ids: ["m-1"] })
    const result = await sendMail(MESSAGE, { fetchImpl: fetchImpl as unknown as typeof fetch, env: ENV })

    expect(result).toEqual({ ok: true, messageId: "m-1" })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(MAILTRAP_SEND_URL)
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-fixture-123")
    expect(JSON.parse(String(init.body))).toEqual({
      from: { email: "reports@fatechid.com", name: "FATechID Reports" },
      to: [{ email: "budi@customer.co.id", name: "Budi" }],
      subject: "S",
      text: "T",
      html: "<p>H</p>",
      category: "report-delivery",
    })
  })

  test("a refusal is a result naming why, never a throw", async () => {
    const env = { env: ENV }
    expect(await sendMail(MESSAGE, { ...env, fetchImpl: answering(401, { errors: ["Unauthorized"] }) as unknown as typeof fetch })).toEqual({
      ok: false,
      error: "Mailtrap refused the API token. Check RPT_MAILTRAP_TOKEN.",
    })
    expect(await sendMail(MESSAGE, { ...env, fetchImpl: answering(429, {}) as unknown as typeof fetch })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/sending limit/),
    })
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed")
    })
    expect(await sendMail(MESSAGE, { ...env, fetchImpl: offline as unknown as typeof fetch })).toMatchObject({ ok: false })
  })

  test("without a token or sender, nothing is sent", async () => {
    await expect(sendMail(MESSAGE, { env: {} as unknown as NodeJS.ProcessEnv })).rejects.toBeInstanceOf(MailNotConfiguredError)
  })
})

describe("mailProblem", () => {
  const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv

  test("names each missing setting, never a value", () => {
    expect(mailProblem(env({}))).toBe("RPT_MAILTRAP_TOKEN and RPT_MAIL_FROM are not set in the running service.")
    expect(mailProblem(env({ RPT_MAILTRAP_TOKEN: "secret-token" }))).toBe("RPT_MAIL_FROM is not set in the running service.")
    expect(mailProblem(env({ RPT_MAIL_FROM: "reports@fatechid.com", RPT_MAILTRAP_TOKEN: "  " }))).toBe(
      "RPT_MAILTRAP_TOKEN is not set in the running service."
    )
  })

  test("a sender that is not an address is named as such", () => {
    const problem = mailProblem(env({ RPT_MAILTRAP_TOKEN: "secret-token", RPT_MAIL_FROM: "FATechID Reports" }))
    expect(problem).toMatch(/^RPT_MAIL_FROM is not an email address/)
    expect(problem).not.toContain("FATechID Reports")
    expect(problem).not.toContain("secret-token")
  })

  test("usable settings report no problem", () => {
    expect(mailProblem(env({ RPT_MAILTRAP_TOKEN: "t", RPT_MAIL_FROM: "FATechID Reports <reports@fatechid.com>" }))).toBeNull()
  })
})
