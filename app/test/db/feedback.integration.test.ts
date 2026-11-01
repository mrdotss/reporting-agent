import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * Send feedback against a real Postgres: a message is saved before it is emailed, a
 * refused email is recorded and can be sent again, the hourly limit holds, and only a
 * platform admin reads or changes the inbox.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

vi.mock("@/lib/db", () => ({
  getDb: () => currentDb(),
  getPool: () => db.pool(),
}))

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"

import * as schema from "@/lib/db/schema"
import {
  DEFAULT_FEEDBACK_TO,
  FEEDBACK_HOURLY_LIMIT,
  FeedbackLimitError,
  feedbackRecipient,
  listFeedback,
  openFeedbackCount,
  resendFeedback,
  setFeedbackDone,
  submitFeedback,
} from "@/lib/feedback/store"
import { MailNotConfiguredError, type MailMessage, type MailResult } from "@/lib/mail/mailtrap"
import { WorkspaceAccessError } from "@/lib/workspaces/access"

let drizzleDb: NodePgDatabase<typeof schema> | undefined
function currentDb(): NodePgDatabase<typeof schema> {
  if (drizzleDb === undefined) throw new Error("The scratch-schema Drizzle client is not open.")
  return drizzleDb
}

const ADMIN = { email: "admin@example.com" }
const savedAdmins = process.env.RPT_PLATFORM_ADMIN_EMAILS
let member: { id: string; email: string }

function recorder(result: MailResult = { ok: true, messageId: "m-1" }) {
  const sent: MailMessage[] = []
  return {
    sent,
    send: async (message: MailMessage): Promise<MailResult> => {
      sent.push(message)
      return result
    },
  }
}

const INPUT = { kind: "problem" as const, message: "The export button does nothing.", pagePath: "/reports", canReply: true }
const WORKSPACE = { id: "", name: "Acme MSP", role: "owner" }
const OPTIONS = { baseUrl: "https://reporting.example.com", env: { RPT_FEEDBACK_TO: "team@example.com" } as unknown as NodeJS.ProcessEnv }

beforeAll(() => {
  process.env.RPT_PLATFORM_ADMIN_EMAILS = ADMIN.email
  if (!db.enabled) return
  drizzleDb = drizzle(db.pool(), { schema })
})

afterAll(() => {
  if (savedAdmins === undefined) delete process.env.RPT_PLATFORM_ADMIN_EMAILS
  else process.env.RPT_PLATFORM_ADMIN_EMAILS = savedAdmins
})

beforeEach(async () => {
  if (!db.enabled) return
  await db.query(`TRUNCATE users CASCADE`)
  await db.query(`TRUNCATE feedback`)
  member = { id: randomUUID(), email: "dana@acme.co" }
  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash) VALUES ($1, $2, $2, '$argon2id$fixture-never-verified')`,
    [member.id, member.email]
  )
  WORKSPACE.id = `imported-${member.id}`
})

describe("feedback recipient", () => {
  test("RPT_FEEDBACK_TO when it is an address, otherwise the default", () => {
    expect(feedbackRecipient({ RPT_FEEDBACK_TO: " team@example.com " } as unknown as NodeJS.ProcessEnv)).toBe("team@example.com")
    expect(feedbackRecipient({ RPT_FEEDBACK_TO: "nope" } as unknown as NodeJS.ProcessEnv)).toBe(DEFAULT_FEEDBACK_TO)
    expect(feedbackRecipient({} as unknown as NodeJS.ProcessEnv)).toBe(DEFAULT_FEEDBACK_TO)
  })
})

describe.skipIf(!db.enabled)("Send feedback", () => {
  test("is saved, then emailed to the team from the report sender with the member as Reply-To", async () => {
    const mail = recorder()
    const saved = await submitFeedback(member, WORKSPACE, INPUT, { ...OPTIONS, send: mail.send })

    expect(saved).toMatchObject({ kind: "problem", userEmail: member.email, workspaceName: "Acme MSP", role: "Owner", emailStatus: "sent" })
    expect(mail.sent).toHaveLength(1)
    expect(mail.sent[0]).toMatchObject({ to: { email: "team@example.com" }, category: "feedback", replyTo: member.email })
    expect(mail.sent[0]!.subject).toBe("[Feedback · Problem] The export button does nothing.")
    const { rows } = await db.query<{ workspace_id: string; email_status: string }>(`SELECT workspace_id, email_status FROM feedback`)
    expect(rows).toEqual([{ workspace_id: WORKSPACE.id, email_status: "sent" }])
  })

  test("a refused or unconfigured email is recorded, kept, and can be sent again", async () => {
    const refused = await submitFeedback(member, WORKSPACE, INPUT, {
      ...OPTIONS,
      send: recorder({ ok: false, error: "Mailtrap's sending limit was reached. Try again later." }).send,
    })
    expect(refused).toMatchObject({ emailStatus: "failed", emailError: expect.stringMatching(/sending limit/) })

    const unconfigured = await submitFeedback(member, null, { ...INPUT, canReply: false, pagePath: null }, {
      ...OPTIONS,
      send: async () => {
        throw new MailNotConfiguredError("RPT_MAILTRAP_TOKEN is not set in the running service.")
      },
    })
    expect(unconfigured).toMatchObject({ emailStatus: "failed", workspaceName: null })

    const mail = recorder()
    expect(await resendFeedback(ADMIN, refused.id, { ...OPTIONS, send: mail.send })).toMatchObject({ emailStatus: "sent", emailError: null })
    expect(mail.sent).toHaveLength(1)
  })

  test("one account sends at most the hourly limit", async () => {
    const mail = recorder()
    for (let i = 0; i < FEEDBACK_HOURLY_LIMIT; i += 1) await submitFeedback(member, WORKSPACE, INPUT, { ...OPTIONS, send: mail.send })
    await expect(submitFeedback(member, WORKSPACE, INPUT, { ...OPTIONS, send: mail.send })).rejects.toBeInstanceOf(FeedbackLimitError)
    // An hour on, it is open again.
    await expect(
      submitFeedback(member, WORKSPACE, INPUT, { ...OPTIONS, send: mail.send, now: new Date(Date.now() + 61 * 60 * 1000) })
    ).resolves.toMatchObject({ emailStatus: "sent" })
  })

  test("the inbox: only a platform admin lists it or marks a message done", async () => {
    const mail = recorder()
    const first = await submitFeedback(member, WORKSPACE, INPUT, { ...OPTIONS, send: mail.send })
    await submitFeedback(member, WORKSPACE, { ...INPUT, kind: "praise", message: "Lovely." }, { ...OPTIONS, send: mail.send })

    await expect(listFeedback(member)).rejects.toBeInstanceOf(WorkspaceAccessError)
    await expect(setFeedbackDone(member, first.id, true)).rejects.toBeInstanceOf(WorkspaceAccessError)
    await expect(resendFeedback(member, first.id, { ...OPTIONS, send: mail.send })).rejects.toBeInstanceOf(WorkspaceAccessError)

    expect(await openFeedbackCount(ADMIN)).toBe(2)
    expect((await setFeedbackDone(ADMIN, first.id, true)).resolvedAt).not.toBeNull()
    expect((await listFeedback(ADMIN, "open")).map((f) => f.kind)).toEqual(["praise"])
    expect((await listFeedback(ADMIN, "done")).map((f) => f.id)).toEqual([first.id])
    expect(await openFeedbackCount(ADMIN)).toBe(1)
    expect((await setFeedbackDone(ADMIN, first.id, false)).resolvedAt).toBeNull()
    await expect(setFeedbackDone(ADMIN, "fb_missing", true)).rejects.toBeInstanceOf(WorkspaceAccessError)
  })
})
