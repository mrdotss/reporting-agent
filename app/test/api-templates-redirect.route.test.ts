import { describe, expect, test } from "vitest"

import {
  DELETE as deleteById,
  GET as getById,
  PATCH as patchById,
  POST as postById,
} from "@/app/api/templates/[id]/route"
import { GET as getCatalog } from "@/app/api/templates/catalog/route"
import { POST as postPreview } from "@/app/api/templates/[id]/preview/route"
import { GET as getList, POST as postList } from "@/app/api/templates/route"

/**
 * Redirects from the former `/api/templates*` routes (task 3.14, "so a
 * bookmark or an open tab resolves rather than 404s").
 *
 * 308 (permanent, method-preserving) is asserted specifically — not just "some
 * redirect status" — because a 302/303/307 lets a client silently retry a
 * `POST` as a `GET` on the hop, which would turn a stale client's attempt to
 * publish a version into a silent no-op read instead of a loud failure.
 */

describe("the former /api/templates routes redirect to /api/report-profiles", () => {
  test("GET /api/templates -> /api/report-profiles, 308", async () => {
    const response = await getList(
      new Request("http://localhost/api/templates")
    )
    expect(response.status).toBe(308)
    expect(response.headers.get("location")).toBe(
      "http://localhost/api/report-profiles"
    )
  })

  test("POST /api/templates -> /api/report-profiles, 308", async () => {
    const response = await postList(
      new Request("http://localhost/api/templates", { method: "POST" })
    )
    expect(response.status).toBe(308)
    expect(response.headers.get("location")).toBe(
      "http://localhost/api/report-profiles"
    )
  })

  test("every /api/templates/[id] method redirects to /api/report-profiles/[id], 308", async () => {
    const url = "http://localhost/api/templates/tpl-001"
    const expected = "http://localhost/api/report-profiles/tpl-001"

    for (const handler of [getById, patchById, postById, deleteById]) {
      const response = await handler(new Request(url))
      expect(response.status).toBe(308)
      expect(response.headers.get("location")).toBe(expected)
    }
  })

  test("POST /api/templates/[id]/preview -> /api/report-profiles/[id]/preview, 308", async () => {
    const response = await postPreview(
      new Request("http://localhost/api/templates/tpl-001/preview", {
        method: "POST",
      })
    )
    expect(response.status).toBe(308)
    expect(response.headers.get("location")).toBe(
      "http://localhost/api/report-profiles/tpl-001/preview"
    )
  })

  test("GET /api/templates/catalog -> /api/report-profiles/catalog, 308", async () => {
    const response = await getCatalog(
      new Request("http://localhost/api/templates/catalog")
    )
    expect(response.status).toBe(308)
    expect(response.headers.get("location")).toBe(
      "http://localhost/api/report-profiles/catalog"
    )
  })

  test("query strings survive the redirect", async () => {
    const response = await getList(
      new Request("http://localhost/api/templates?foo=bar")
    )
    expect(response.headers.get("location")).toBe(
      "http://localhost/api/report-profiles?foo=bar"
    )
  })
})
