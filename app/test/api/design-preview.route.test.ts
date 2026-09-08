import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { themeDefaults } from "@/lib/design-preview/settings"
const mocks = vi.hoisted(() => ({ session: vi.fn(), render: vi.fn() }))
vi.mock("@/lib/auth/guard", () => ({ requireSessionForApi: mocks.session }))
vi.mock("@/lib/design-preview/render", () => ({
  renderPreview: mocks.render,
  PreviewRenderError: class extends Error {
    constructor(
      public stage: string,
      message: string
    ) {
      super(message)
    }
  },
}))
import { POST } from "@/app/api/report-profiles/design-preview/route"
import { PreviewRenderError } from "@/lib/design-preview/render"
function request(body: unknown = themeDefaults("corporate")) {
  return new Request("http://localhost/api/report-profiles/design-preview", {
    method: "POST",
    body: JSON.stringify(body),
  })
}
describe("development design preview", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("REPORT_DESIGN_PREVIEW", "1")
    mocks.session.mockResolvedValue({ id: "sample-user" })
    mocks.render.mockResolvedValue({ pdf: Buffer.from("%PDF-sample") })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })
  it.each(["production", "test"])(
    "is unavailable in %s even when enabled",
    async (environment) => {
      vi.stubEnv("NODE_ENV", environment)
      expect((await POST(request())).status).toBe(404)
      expect(mocks.session).not.toHaveBeenCalled()
      expect(mocks.render).not.toHaveBeenCalled()
    }
  )
  it("requires the explicit flag", async () => {
    vi.stubEnv("REPORT_DESIGN_PREVIEW", "0")
    expect((await POST(request())).status).toBe(404)
  })
  it("requires authentication before rendering", async () => {
    mocks.session.mockResolvedValue(null)
    expect((await POST(request())).status).toBe(401)
    expect(mocks.render).not.toHaveBeenCalled()
  })
  it.each([
    { ...themeDefaults("corporate"), accent_color: "red;url(x)" },
    { ...themeDefaults("corporate"), variant: "overflow" },
    { ...themeDefaults("corporate"), chart_style: "sparkline" },
  ])("rejects invalid input", async (body) => {
    const response = await POST(request(body))
    expect(response.status).toBe(400)
    expect((await response.json()).error.stage).toBe("validation")
    expect(mocks.render).not.toHaveBeenCalled()
  })
  it("rejects malformed JSON", async () => {
    expect(
      (
        await POST(
          new Request("http://localhost", { method: "POST", body: "{" })
        )
      ).status
    ).toBe(400)
  })
  it("returns uncached PDF bytes", async () => {
    const response = await POST(request())
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toBe("%PDF-sample")
    expect(mocks.render).toHaveBeenCalledWith(
      themeDefaults("corporate"),
      expect.any(AbortSignal)
    )
  })
  it.each(["compilation", "chart", "pdf"] as const)(
    "identifies %s failures",
    async (stage) => {
      mocks.render.mockRejectedValue(
        new PreviewRenderError(stage, "Sample failure")
      )
      const response = await POST(request())
      expect(response.status).toBe(503)
      expect((await response.json()).error).toEqual({
        stage,
        message: "Sample failure",
      })
    }
  )
})
