import { describe, test, expect } from "vitest"
import { can, canManageMember, ROLES } from "./policy"
describe("workspace role boundaries", () => {
  test.each(ROLES)("%s can read", (r) => expect(can(r, "read")).toBe(true))
  test.each(["editor", "viewer"] as const)(
    "%s cannot administer credentials or members",
    (r) => {
      expect(can(r, "connect")).toBe(false)
      expect(can(r, "manage")).toBe(false)
    }
  )
  test("only owners can manage admins", () => {
    expect(canManageMember("admin", "admin", "editor")).toBe(false)
    expect(canManageMember("admin", "editor", "admin")).toBe(false)
    expect(canManageMember("owner", "admin", "editor")).toBe(true)
  })
  test.each(ROLES)("%s cannot directly remove/appoint an owner", (r) => {
    expect(canManageMember(r, "owner")).toBe(false)
    expect(canManageMember(r, "editor", "owner")).toBe(false)
  })
  test("viewer cannot write and editor can author", () => {
    expect(can("viewer", "edit")).toBe(false)
    expect(can("editor", "edit")).toBe(true)
  })
})
