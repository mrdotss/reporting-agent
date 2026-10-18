import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * `POST /api/report-profiles/[id]/preview` — the builder's Preview PDF.
 *
 * Faked: the session, the preset and connection reads, the snapshot lookup, the runtime
 * and S3. What is left is what the route decides — who may preview what against which
 * connection, what it sends the runtime, how a failed render reads, and which superseded
 * objects it deletes.
 */

const state = vi.hoisted(() => ({
  user: { id: "user-1", email: "user@example.test" } as { id: string; email: string } | null,
  template: { id: "tmpl-1", provider: "aws", workspaceId: "ws-1", projectId: "pr-1" } as Record<string, unknown> | null,
  source: { id: "conn-1", provider: "aws", status: "active", workspaceId: "ws-1", projectId: "pr-1" } as Record<string, unknown> | null,
  snapshot: {
    actorId: "user-1",
    runId: "run-9",
    snapshotId: "snap-9",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    timezone: "Asia/Jakarta",
  } as Record<string, unknown> | null,
  stream: [] as string[],
  invocations: [] as Record<string, unknown>[],
  deleted: [] as string[],
  deferred: [] as (() => Promise<void>)[],
}))

vi.mock("@/lib/auth/guard", () => ({ requireSessionForApi: async () => state.user }))

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<void>) => {
    state.deferred.push(task)
  },
}))

vi.mock("@/lib/templates/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/templates/store")>()
  return {
    ...original,
    getTemplate: async () => {
      if (state.template === null) throw new original.TemplateNotFoundError()
      return state.template
    },
  }
})

vi.mock("@/lib/subscriptions/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/subscriptions/store")>()
  return {
    ...original,
    getConnectedSubscription: async () => {
      if (state.source === null) throw new original.SubscriptionNotFoundError()
      return state.source
    },
  }
})

vi.mock("@/lib/templates/preview", () => ({
  mostRecentSnapshotRun: async () => state.snapshot,
  newPreviewId: () => "pv-new",
}))

vi.mock("@/lib/aws/agentcore", () => ({
  COMMAND_RENDER_PREVIEW: "render_preview",
  invokeAgentRuntime: async (request: Record<string, unknown>) => {
    state.invocations.push(request)
    const encoder = new TextEncoder()
    return (async function* () {
      for (const chunk of state.stream) yield encoder.encode(chunk)
    })()
  },
}))

vi.mock("@/lib/aws/s3", () => ({
  previewKey: (actor: string, id: string) => `${actor}/previews/${id}/preview.pdf`,
  previewHtmlKey: (actor: string, id: string) => `${actor}/previews/${id}/preview.html`,
  presignPreview: async (_actor: string, key: string) => ({ url: `https://signed.example/${key}`, expiresIn: 300 }),
  deleteObject: async (key: string) => {
    state.deleted.push(key)
  },
}))

const { POST } = await import("@/app/api/report-profiles/[id]/preview/route")

const DRAFT = { schema_version: 4, provider: "aws", identity: { name: "Draft" }, sections: [] }

function call(body: Record<string, unknown> = { connectedSubscriptionId: "conn-1", definition: DRAFT }) {
  return POST(
    new Request("http://localhost/api/report-profiles/tmpl-1/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "tmpl-1" }) }
  )
}

beforeEach(() => {
  state.user = { id: "user-1", email: "user@example.test" }
  state.template = { id: "tmpl-1", provider: "aws", workspaceId: "ws-1", projectId: "pr-1" }
  state.source = { id: "conn-1", provider: "aws", status: "active", workspaceId: "ws-1", projectId: "pr-1" }
  state.snapshot = {
    actorId: "user-1",
    runId: "run-9",
    snapshotId: "snap-9",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    timezone: "Asia/Jakarta",
  }
  state.stream = ['{"type":"step","status":"done"}\n']
  state.invocations = []
  state.deleted = []
  state.deferred = []
})

describe("who may preview what", () => {
  test("a request with no session is refused before anything is read", async () => {
    state.user = null
    expect((await call()).status).toBe(401)
    expect(state.invocations).toEqual([])
  })

  test("another user's preset or connection is not found", async () => {
    state.template = null
    expect((await call()).status).toBe(404)
    state.template = { id: "tmpl-1", provider: "aws", workspaceId: "ws-1", projectId: "pr-1" }
    state.source = null
    expect((await call()).status).toBe(404)
    expect(state.invocations).toEqual([])
  })

  test("a connection in another project is not found", async () => {
    state.source = { id: "conn-1", provider: "aws", status: "active", workspaceId: "ws-1", projectId: "pr-2" }
    expect((await call()).status).toBe(404)
    expect(state.invocations).toEqual([])
  })

  test("an AWS preset is not previewed against an Azure connection, or the reverse", async () => {
    state.source = { id: "conn-1", provider: "azure", status: "active", workspaceId: "ws-1", projectId: "pr-1" }
    const response = await call()
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("PROVIDER_MISMATCH")
    expect(body.error.message).toContain("AWS")

    state.template = { id: "tmpl-1", provider: "azure", workspaceId: "ws-1", projectId: "pr-1" }
    state.source = { id: "conn-1", provider: "aws", status: "active", workspaceId: "ws-1", projectId: "pr-1" }
    expect(((await (await call()).json()) as { error: { code: string } }).error.code).toBe("PROVIDER_MISMATCH")
    expect(state.invocations).toEqual([])
  })

  test("an inactive connection is refused", async () => {
    state.source = { id: "conn-1", provider: "aws", status: "disabled", workspaceId: "ws-1", projectId: "pr-1" }
    expect(((await (await call()).json()) as { error: { code: string } }).error.code).toBe("CONNECTION_INACTIVE")
  })

  test("a connection with no completed report says so, and renders nothing", async () => {
    state.snapshot = null
    const response = await call()
    expect(response.status).toBe(422)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("NO_SNAPSHOT")
    expect(state.invocations).toEqual([])
  })
})

describe("the render", () => {
  test("sends the draft inline against the connection's latest run and answers with a URL", async () => {
    const response = await call()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      previewId: "pv-new",
      url: "https://signed.example/user-1/previews/pv-new/preview.pdf",
      expiresIn: 300,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      timezone: "Asia/Jakarta",
    })
    expect(state.invocations).toHaveLength(1)
    const [invocation] = state.invocations
    expect(invocation!.context).toEqual({ actor_id: "user-1", run_id: "pv-new" })
    expect(invocation!.command).toMatchObject({
      command: "render_preview",
      preview_id: "pv-new",
      snapshot_run_id: "run-9",
      definition: { schema_version: 4, provider: "aws" },
    })
  })

  test.each([
    ["PDF_CONVERSION_FAILED", "PREVIEW_PDF"],
    ["RENDER_FAILED", "PREVIEW_DOCX"],
    ["COMPILE_FAILED", "PREVIEW_COMPILATION"],
  ])("a runtime %s reads as %s", async (runtimeCode, code) => {
    state.stream = [`{"type":"error","code":"${runtimeCode}"}\n`]
    const response = await call()
    expect(response.status).toBe(422)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code)
  })

  test("the preview it replaces is deleted after the response, and only that one", async () => {
    await call({ connectedSubscriptionId: "conn-1", definition: DRAFT, supersedes: "pv-old" })
    expect(state.deleted).toEqual([])
    await Promise.all(state.deferred.map((task) => task()))
    expect(state.deleted.sort()).toEqual([
      "user-1/previews/pv-old/preview.html",
      "user-1/previews/pv-old/preview.pdf",
    ])
  })

  test("a superseded id that could climb out of the prefix is refused by the schema", async () => {
    const response = await call({ connectedSubscriptionId: "conn-1", definition: DRAFT, supersedes: "../reports" })
    expect(response.status).toBe(400)
    expect(state.invocations).toEqual([])
  })
})
