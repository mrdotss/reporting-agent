import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * Resolving a profile's cover logo URL into stored bytes (`lib/templates/logo.ts`).
 *
 * `logoKey`, `sniffImageFormat` and the byte ceiling are the **real**
 * implementations; the only things faked are the S3 write and `fetch` — the same
 * split `report-profiles.signature.route.test.ts` makes, for the same reason.
 * What is under test is the ordering: that nothing reaches storage that was not
 * fetched over http(s), sniffed by content and inside the ceiling, and that a
 * URL which fails any of those leaves the save intact.
 */

const { s3 } = vi.hoisted(() => ({
  s3: { puts: 0, keys: [] as string[], types: [] as string[] },
}))

vi.mock("@/lib/aws/s3", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/aws/s3")>()
  return {
    ...original,
    putLogo: async (key: string, _bytes: Uint8Array, contentType: string) => {
      s3.puts += 1
      s3.keys.push(key)
      s3.types.push(contentType)
    },
  }
})

const { LOGO_MAX_BYTES, resolveLogo, resolveLogoIntoDefinition } = await import(
  "@/lib/templates/logo"
)

const PNG_HEADER = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const JPEG_HEADER = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)
const USER = "alice"

function imageOf(header: Uint8Array, length = 64): Uint8Array {
  const out = new Uint8Array(length)
  out.set(header)
  return out
}

/** A `fetch` that answers every request with one response, and records the
 * requests it was given — so a test can assert a URL was never requested at
 * all, which is the whole point of the scheme check. */
function stubFetch(
  responder: (url: string) => Response | Promise<Response> | never
): { readonly urls: string[] } {
  const urls: string[] = []
  vi.stubGlobal("fetch", async (input: unknown) => {
    urls.push(String(input))
    return await responder(String(input))
  })
  return { urls }
}

function ok(bytes: Uint8Array, contentType = "image/png"): Response {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: { "content-type": contentType },
  })
}

function definitionWith(logo: unknown): Record<string, unknown> {
  return {
    version: 3,
    sections: [{ type: "azure_subscription" }],
    front_matter: {
      cover: { enabled: true, subtitle: "Monthly", logo },
      document_control: { document_name: "Report" },
    },
  }
}

function logoKeyOf(definition: Record<string, unknown>): unknown {
  const front = definition["front_matter"] as Record<string, unknown>
  const cover = front["cover"] as Record<string, unknown>
  return cover["logo_key"]
}

beforeEach(() => {
  s3.puts = 0
  s3.keys = []
  s3.types = []
  vi.unstubAllGlobals()
})

describe("resolveLogo", () => {
  test("a reachable PNG is stored under an owner-prefixed logos key", async () => {
    stubFetch(() => ok(imageOf(PNG_HEADER)))

    const result = await resolveLogo("https://cdn.example/logo.png", USER)

    expect(result).toEqual({ ok: true, key: expect.any(String) })
    expect(s3.puts).toBe(1)
    expect(s3.keys[0]).toMatch(/^alice\/logos\/[0-9a-f-]{36}\.png$/)
    expect(s3.types[0]).toBe("image/png")
  })

  test("a JPEG is stored as one, from its magic number", async () => {
    // Content-Type deliberately lies. The extension follows the bytes.
    stubFetch(() => ok(imageOf(JPEG_HEADER), "image/png"))

    await resolveLogo("https://cdn.example/logo.png", USER)

    expect(s3.keys[0]).toMatch(/\.jpg$/)
    expect(s3.types[0]).toBe("image/jpeg")
  })

  test("a non-http(s) scheme is refused without ever being requested", async () => {
    // The point is the *absence* of the request: `file:` and `gopher:` are not
    // things to catch downstream after the app has already opened them.
    const calls = stubFetch(() => {
      throw new Error("fetch must not be called")
    })

    for (const url of ["file:///etc/passwd", "gopher://x/", "data:image/png;base64,AA"]) {
      const result = await resolveLogo(url, USER)
      expect(result.ok).toBe(false)
    }

    expect(calls.urls).toEqual([])
    expect(s3.puts).toBe(0)
  })

  test("an unparseable URL is refused without being requested", async () => {
    const calls = stubFetch(() => ok(imageOf(PNG_HEADER)))

    expect((await resolveLogo("not a url", USER)).ok).toBe(false)

    expect(calls.urls).toEqual([])
    expect(s3.puts).toBe(0)
  })

  test("a non-2xx answer stores nothing", async () => {
    stubFetch(() => new Response("nope", { status: 404 }))

    const result = await resolveLogo("https://cdn.example/gone.png", USER)

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("404") })
    expect(s3.puts).toBe(0)
  })

  test("bytes over the ceiling store nothing", async () => {
    stubFetch(() => ok(imageOf(PNG_HEADER, LOGO_MAX_BYTES + 1)))

    const result = await resolveLogo("https://cdn.example/huge.png", USER)

    expect(result.ok).toBe(false)
    expect(s3.puts).toBe(0)
  })

  test("bytes that are not a recognised image store nothing", async () => {
    // An HTML error page served with `Content-Type: image/png` is the ordinary
    // way this happens, and it must not land under a key a renderer will decode.
    stubFetch(() => ok(new TextEncoder().encode("<!doctype html><h1>404</h1>")))

    const result = await resolveLogo("https://cdn.example/logo.png", USER)

    expect(result.ok).toBe(false)
    expect(s3.puts).toBe(0)
  })

  test("a fetch that throws is a refusal, not an exception", async () => {
    stubFetch(() => {
      throw new DOMException("timed out", "TimeoutError")
    })

    const result = await resolveLogo("https://cdn.example/slow.png", USER)

    expect(result.ok).toBe(false)
    expect(s3.puts).toBe(0)
  })
})

describe("resolveLogoIntoDefinition", () => {
  test("writes the key into the cover and leaves the rest of the definition alone", async () => {
    stubFetch(() => ok(imageOf(PNG_HEADER)))
    const definition = definitionWith("https://cdn.example/logo.png")

    const resolved = await resolveLogoIntoDefinition(definition, USER, {})

    expect(logoKeyOf(resolved)).toBe(s3.keys[0])
    expect(resolved["sections"]).toEqual(definition["sections"])
    const front = resolved["front_matter"] as Record<string, unknown>
    expect(front["document_control"]).toEqual({ document_name: "Report" })
    const cover = front["cover"] as Record<string, unknown>
    expect(cover["subtitle"]).toBe("Monthly")
    expect(cover["logo"]).toBe("https://cdn.example/logo.png")
  })

  test("does not mutate the definition it was given", async () => {
    stubFetch(() => ok(imageOf(PNG_HEADER)))
    const definition = definitionWith("https://cdn.example/logo.png")

    await resolveLogoIntoDefinition(definition, USER, {})

    expect(logoKeyOf(definition)).toBeUndefined()
  })

  test("an unchanged URL reuses the previous version's key and fetches nothing", async () => {
    // Five saves of one profile must not mean five fetches and five stored
    // copies of the same image — and the version that did not change its logo
    // must keep showing the identical bytes.
    const calls = stubFetch(() => ok(imageOf(PNG_HEADER)))
    const definition = definitionWith("https://cdn.example/logo.png")

    const resolved = await resolveLogoIntoDefinition(definition, USER, {
      logo: "https://cdn.example/logo.png",
      logoKey: "alice/logos/prior.png",
    })

    expect(logoKeyOf(resolved)).toBe("alice/logos/prior.png")
    expect(calls.urls).toEqual([])
    expect(s3.puts).toBe(0)
  })

  test("a changed URL is fetched again and gets a new key", async () => {
    stubFetch(() => ok(imageOf(PNG_HEADER)))
    const definition = definitionWith("https://cdn.example/new.png")

    const resolved = await resolveLogoIntoDefinition(definition, USER, {
      logo: "https://cdn.example/old.png",
      logoKey: "alice/logos/prior.png",
    })

    expect(s3.puts).toBe(1)
    expect(logoKeyOf(resolved)).toBe(s3.keys[0])
    expect(logoKeyOf(resolved)).not.toBe("alice/logos/prior.png")
  })

  test("a previous URL with no previous key is fetched rather than trusted", async () => {
    stubFetch(() => ok(imageOf(PNG_HEADER)))
    const definition = definitionWith("https://cdn.example/logo.png")

    const resolved = await resolveLogoIntoDefinition(definition, USER, {
      logo: "https://cdn.example/logo.png",
      logoKey: null,
    })

    expect(s3.puts).toBe(1)
    expect(logoKeyOf(resolved)).toBe(s3.keys[0])
  })

  test("a URL that cannot be resolved leaves the definition saveable and key-free", async () => {
    // Req 13.9's shape: losing a profile edit because an image host was down
    // would be a far worse trade than a cover that reserves its space and draws
    // nothing — which is what a profile naming no logo already does.
    stubFetch(() => new Response("nope", { status: 500 }))
    const definition = definitionWith("https://cdn.example/logo.png")

    const resolved = await resolveLogoIntoDefinition(definition, USER, {})

    expect(resolved).toEqual(definition)
    expect(logoKeyOf(resolved)).toBeUndefined()
  })

  test.each([
    ["no logo at all", definitionWith(undefined)],
    ["an empty logo", definitionWith("   ")],
    ["a non-string logo", definitionWith(42)],
    ["no cover", { version: 3, front_matter: { document_control: {} } }],
    ["no front matter", { version: 3, sections: [] }],
  ])("%s is returned untouched and fetches nothing", async (_name, definition) => {
    const calls = stubFetch(() => ok(imageOf(PNG_HEADER)))

    const resolved = await resolveLogoIntoDefinition(
      definition as Record<string, unknown>,
      USER,
      {}
    )

    expect(resolved).toBe(definition)
    expect(calls.urls).toEqual([])
    expect(s3.puts).toBe(0)
  })
})
