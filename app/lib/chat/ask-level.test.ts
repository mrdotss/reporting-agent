import { describe, expect, test } from "vitest"

import { askAllows, askLevel } from "@/lib/chat/ask-level"
import { ROLES } from "@/lib/workspaces/policy"

/** Who gets Ask where (roles-and-ask-access Req 6). */

const NOT_OWNER = ["admin", "editor", "viewer"] as const

describe("askLevel", () => {
  test("in a platform admin's workspace, members use Ask by role", () => {
    expect(ROLES.map((role) => askLevel({ role, granted: false, adminHome: true }))).toEqual([
      "chat",
      "chat",
      "chat",
      "read",
    ])
  })

  test("a member the admin has granted Ask no longer sees the admin's", () => {
    for (const role of NOT_OWNER) {
      expect(askLevel({ role, granted: true, adminHome: true })).toBe("none")
    }
  })

  test("a granted account uses Ask in the workspaces it owns", () => {
    expect(askLevel({ role: "owner", granted: true, adminHome: false })).toBe("chat")
  })

  test("the people a granted account invites do not get Ask", () => {
    for (const role of NOT_OWNER) {
      expect(askLevel({ role, granted: false, adminHome: false })).toBe("none")
    }
  })

  test("an owner with no grant, a granted non-owner elsewhere, and a non-member get none", () => {
    expect(askLevel({ role: "owner", granted: false, adminHome: false })).toBe("none")
    for (const role of NOT_OWNER) {
      expect(askLevel({ role, granted: true, adminHome: false })).toBe("none")
    }
    expect(askLevel({ role: null, granted: true, adminHome: true })).toBe("none")
  })
})

describe("askAllows", () => {
  test("chat includes reading; reading is not chatting; none allows nothing", () => {
    expect(askAllows("chat", "chat")).toBe(true)
    expect(askAllows("chat", "read")).toBe(true)
    expect(askAllows("read", "read")).toBe(true)
    expect(askAllows("read", "chat")).toBe(false)
    expect(askAllows("none", "read")).toBe(false)
  })
})
