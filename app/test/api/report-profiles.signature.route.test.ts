import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

/**
 * `POST /api/report-profiles/signature` (Requirements 13.5, 13.6).
 *
 * `validateSignatureUpload` and `signatureKey` are the **real**
 * implementations, pulled through `importOriginal` — the only thing faked is
 * the actual S3 write, matching `artifact-url.route.test.ts`'s split for the
 * same reason: the thing under test here is that the route actually calls
 * validation before ever reaching storage, and the only way to observe that
 * without a bucket is to fake the storage call and count it.
 */

const { guard, s3 } = vi.hoisted(() => ({
  guard: { user: undefined as { id: string; email: string } | undefined },
  s3: { puts: 0, keys: [] as string[], bytes: [] as Uint8Array[] },
}))

vi.mock("@/lib/auth/guard", () => ({
  requireSessionForApi: async () => guard.user ?? null,
}))

vi.mock("@/lib/aws/s3", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/aws/s3")>()

  return {
    ...original,
    putSignature: async (key: string, bytes: Uint8Array) => {
      s3.puts += 1
      s3.keys.push(key)
      s3.bytes.push(bytes)
    },
  }
})

const { POST } = await import("@/app/api/report-profiles/signature/route")

const USER = { id: "alice", email: "alice@example.com" }
const PNG_HEADER = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const JPEG_HEADER = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)

function bytesOf(length: number, header: Uint8Array): Uint8Array {
  const out = new Uint8Array(length)
  out.set(header)
  return out
}

function request(body: Uint8Array): Request {
  return new Request("https://app.test/api/report-profiles/signature", {
    method: "POST",
    body,
  })
}

beforeEach(() => {
  guard.user = USER
  s3.puts = 0
  s3.keys = []
  s3.bytes = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("the happy path", () => {
  test("a valid PNG upload is written and its key returned", async () => {
    const response = await POST(request(bytesOf(1024, PNG_HEADER)))

    expect(response.status).toBe(201)
    const body = (await response.json()) as { key: string }
    expect(body.key).toMatch(/^alice\/signatures\/.+\.png$/)
    expect(s3.puts).toBe(1)
    expect(s3.keys[0]).toBe(body.key)
  })

  test("a valid JPEG upload is written with a .jpg key", async () => {
    const response = await POST(request(bytesOf(1024, JPEG_HEADER)))

    expect(response.status).toBe(201)
    const body = (await response.json()) as { key: string }
    expect(body.key).toMatch(/^alice\/signatures\/.+\.jpg$/)
  })

  test("the key's first segment is the signed-in user's id, never a client-supplied one", async () => {
    const response = await POST(request(bytesOf(1024, PNG_HEADER)))
    const body = (await response.json()) as { key: string }
    expect(body.key.split("/")[0]).toBe(USER.id)
  })

  test("the response is never cached", async () => {
    const response = await POST(request(bytesOf(1024, PNG_HEADER)))
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})

describe("Requirement 13.6 — content rejections happen before any S3 call", () => {
  test("a non-image file is rejected and nothing is written", async () => {
    const pdfHeader = Uint8Array.from(
      Array.from("%PDF-1.4", (c) => c.charCodeAt(0))
    )
    const response = await POST(request(bytesOf(1024, pdfHeader)))

    expect(response.status).toBe(400)
    expect(s3.puts).toBe(0)

    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain("not a recognised raster image")
  })

  test("an oversized file is rejected and nothing is written", async () => {
    const response = await POST(request(bytesOf(2 * 1024 * 1024 + 1, PNG_HEADER)))

    expect(response.status).toBe(400)
    expect(s3.puts).toBe(0)
  })

  test("an empty body is rejected and nothing is written", async () => {
    const response = await POST(request(new Uint8Array()))

    expect(response.status).toBe(400)
    expect(s3.puts).toBe(0)
  })
})

describe("Requirement 7.6 — no session, no upload", () => {
  test("an unauthenticated request is refused before any validation or S3 call", async () => {
    guard.user = undefined

    const response = await POST(request(bytesOf(1024, PNG_HEADER)))

    expect(response.status).toBe(401)
    expect(s3.puts).toBe(0)
  })
})
