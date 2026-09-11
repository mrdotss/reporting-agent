import { describe, expect, test } from "vitest"
import { permitsWorkspaceOrigin } from "./input"

describe("workspace mutation origin", () => {
  test("accepts the browser Host even when Next uses an internal localhost URL", () => {
    expect(permitsWorkspaceOrigin("http://127.0.0.1:3100", "127.0.0.1:3100", "same-origin")).toBe(true)
    expect(permitsWorkspaceOrigin("https://reports.example.test", "reports.example.test", "same-origin")).toBe(true)
  })
  test.each(["https://evil.example.test", "null", "https://reports.example.test.evil.test", "https://reports.example.test/path"])("rejects unrelated or malformed origin %s", origin => {
    expect(permitsWorkspaceOrigin(origin, "reports.example.test", "same-origin")).toBe(false)
  })
  test("rejects cross-site requests even when origin is absent", () => {
    expect(permitsWorkspaceOrigin(null, "reports.example.test", "cross-site")).toBe(false)
    expect(permitsWorkspaceOrigin("https://reports.example.test", "reports.example.test", "cross-site")).toBe(false)
  })
})
