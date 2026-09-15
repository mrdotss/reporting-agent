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
  test("only the owner changes the team", () => {
    for (const target of ["admin", "editor", "viewer"] as const) {
      expect(canManageMember("owner", target)).toBe(true)
      expect(canManageMember("admin", target)).toBe(false)
      expect(canManageMember("editor", target)).toBe(false)
      expect(canManageMember("viewer", target)).toBe(false)
    }
    expect(canManageMember("owner", "viewer", "admin")).toBe(true)
    expect(canManageMember("admin", "viewer", "editor")).toBe(false)
  })
  test.each(ROLES)("%s cannot directly remove/appoint an owner", (r) => {
    expect(canManageMember(r, "owner")).toBe(false)
    expect(canManageMember(r, "editor", "owner")).toBe(false)
  })
  test("viewer cannot write and editor can author", () => {
    expect(can("viewer", "edit")).toBe(false)
    expect(can("editor", "edit")).toBe(true)
  })
  test("only the owner holds the owner's powers", () => {
    expect(ROLES.filter((r) => can(r, "own"))).toEqual(["owner"])
  })
})
