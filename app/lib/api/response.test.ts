import { describe, expect, test } from "vitest"
import { z } from "zod"

import {
  badRequest,
  conflict,
  internalError,
  invalidInput,
  json,
  malformedBody,
  notFound,
  readJsonBody,
  searchParamsObject,
  serviceUnavailable,
  unauthorized,
  unprocessable,
  type ApiErrorBody,
} from "@/lib/api/response"

/**
 * `lib/api/response.ts` — the shape every route handler answers in.
 *
 * Small, and worth asserting for two reasons. `Cache-Control: no-store` is
 * unconditional here so that no handler has to remember it, and the value of that
 * decision is exactly zero unless it is checked. And {@link invalidInput} is the
 * one function in this module that touches untrusted data: it turns a `ZodError`
 * into a body, and the whole point of it is that it copies each issue's **path and
 * message** and never the error itself, whose serialization varies by issue code.
 */

const builders = [
  ["unauthorized", unauthorized(), 401],
  ["notFound", notFound(), 404],
  ["malformedBody", malformedBody(), 400],
  ["badRequest", badRequest("no"), 400],
  ["unprocessable", unprocessable("no"), 422],
  ["conflict", conflict("no"), 409],
  ["serviceUnavailable", serviceUnavailable("no"), 503],
  ["internalError", internalError(), 500],
] as const

describe("every response is JSON and never cached", () => {
  test.each(builders)("%s → %i, no-store", (_label, response, status) => {
    // `no-store` rather than `no-cache`: `no-cache` permits storing and
    // revalidating, and for a body carrying a masked subscription id or a
    // presigned URL that is storage we do not want to have happened.
    expect(response.status).toBe(status)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(response.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8"
    )
  })

  test.each(builders)(
    "%s carries the error envelope",
    async (_label, response) => {
      const payload = (await response.json()) as ApiErrorBody

      // One key distinguishes a success body from a rejection at any status, so a
      // client that mishandles a status code still fails loudly rather than reading
      // `undefined` fields off a rejection.
      expect(payload.error.message.length).toBeGreaterThan(0)
    }
  )

  test("notFound discloses nothing", () => {
    // Not found, not forbidden: a "forbidden" answer confirms the row exists, and
    // its existence is a fact about somebody else's customer.
    expect(notFound().status).toBe(404)
  })
})

describe("json", () => {
  test("serializes the body at the given status", async () => {
    const response = json(201, { subscription: { id: "s1" } })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ subscription: { id: "s1" } })
  })
})

describe("invalidInput", () => {
  const schema = z.object({
    clientSecret: z.string({ error: "The value is excluded." }).min(1),
    nested: z.object({ id: z.string() }),
  })

  test("carries each issue's path and message, and the first as the summary", async () => {
    const parsed = schema.safeParse({ clientSecret: 1, nested: { id: 2 } })
    expect(parsed.success).toBe(false)
    if (parsed.success) return

    const payload = (await invalidInput(parsed.error).json()) as ApiErrorBody

    expect(payload.error.code).toBe("INVALID_INPUT")
    expect(payload.error.fields).toEqual([
      { path: "clientSecret", message: "The value is excluded." },
      {
        path: "nested.id",
        message: "Invalid input: expected string, received number",
      },
    ])
    expect(payload.error.message).toBe("The value is excluded.")
  })

  test("the submitted value is never serialized", async () => {
    // The reason this function copies two fields instead of the error: an issue's
    // shape varies by code, and a route's rejection body is a thing that ends up
    // in a log line.
    const secret = "azure-client-secret-DO-NOT-DISCLOSE-9f13c7"
    const parsed = z
      .object({ clientSecret: z.string().max(4, { error: "Too long." }) })
      .safeParse({ clientSecret: secret })

    expect(parsed.success).toBe(false)
    if (parsed.success) return

    expect(await invalidInput(parsed.error).text()).not.toContain(secret)
  })
})

describe("readJsonBody", () => {
  function post(body: string): Request {
    return new Request("https://app.example.com/x", { method: "POST", body })
  }

  test("returns the parsed value", async () => {
    expect(await readJsonBody(post('{"a":1}'))).toEqual({ a: 1 })
  })

  test.each(["{not json", ""])(
    "returns undefined rather than throwing for %j",
    async (body) => {
      // `undefined` so a handler answers 400 instead of a 500.
      expect(await readJsonBody(post(body))).toBeUndefined()
    }
  )
})

describe("searchParamsObject", () => {
  test("flattens the parameters, last value winning", () => {
    expect(searchParamsObject("https://app.example.com/x?a=1&b=2&a=3")).toEqual(
      { a: "3", b: "2" }
    )
  })

  test("a URL with no query yields an empty object", () => {
    expect(searchParamsObject("https://app.example.com/x")).toEqual({})
  })
})
