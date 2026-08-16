import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { ApiErrorBody } from "@/lib/api/response"
import type { ConnectedSubscriptionView } from "@/lib/db/views"
import type {
  CreateConnectedSubscriptionInput,
  SubscriptionAlreadyConnectedError as AlreadyConnected,
} from "@/lib/subscriptions/store"

/**
 * The onboarding route handlers — `POST /api/subscriptions/test`,
 * `POST /api/subscriptions` and `GET /api/subscriptions` (Requirements 7.7, 10.2,
 * 11.9, 12.5, 12.11, 12.12, 12.14).
 *
 * ## What is faked, and why these three
 *
 * The session guard, the preflight and the store. What is left is exactly what
 * these files contain: the guard check, the boundary parse, and the wiring between
 * the preflight's result and the store's arguments. Each fake replaces something
 * that has its own suite — `lib/auth/session.ts` against Postgres,
 * `lib/subscriptions/preflight.ts` against a faked runtime, and
 * `lib/subscriptions/store.ts` against a real Postgres 17 — so nothing here is the
 * only assertion about any of them.
 *
 * `SubscriptionAlreadyConnectedError` is the **real** class, pulled through
 * `importOriginal`: the route branches on `instanceof`, and a hand-built stand-in
 * would assert that the test knows the shape rather than that the route recognises
 * the error.
 *
 * ## What these tests are deliberately not
 *
 * They are not the DB-backed route tests: a `scope_verified: false` submission
 * writing no `active` row, another user's subscription resolving as not found, and
 * a duplicate `(user_id, subscription_id)` rejection are claims about rows, and
 * they belong with a real database.
 */

const { session, preflight, store } = vi.hoisted(() => ({
  session: { user: undefined as { id: string; email: string } | undefined },
  preflight: {
    outcome: undefined as unknown,
    thrown: undefined as unknown,
    calls: [] as unknown[],
  },
  store: {
    created: [] as CreateConnectedSubscriptionInput[],
    createThrows: undefined as unknown,
    listed: [] as ConnectedSubscriptionView[],
  },
}))

vi.mock("@/lib/auth/guard", () => ({
  requireSessionForApi: async () => session.user ?? null,
}))

vi.mock("@/lib/subscriptions/preflight", () => ({
  runPreflight: async (submission: unknown) => {
    preflight.calls.push(submission)
    if (preflight.thrown !== undefined) throw preflight.thrown
    return preflight.outcome
  },
}))

vi.mock("@/lib/subscriptions/store", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/subscriptions/store")>()

  return {
    ...original,
    createConnectedSubscription: async (
      input: CreateConnectedSubscriptionInput
    ) => {
      store.created.push(input)
      if (store.createThrows !== undefined) throw store.createThrows
      return VIEW
    },
    listConnectedSubscriptions: async () => store.listed,
  }
})

import { MissingRuntimeConfigError } from "@/lib/aws/agentcore"
import { SubscriptionAlreadyConnectedError } from "@/lib/subscriptions/store"

import { GET, POST } from "@/app/api/subscriptions/route"
import { POST as POST_TEST } from "@/app/api/subscriptions/test/route"

// --- Fixtures ---------------------------------------------------------------

const USER = { id: "user-01HZX9", email: "consultant@example.com" }

const PLAINTEXT_SECRET = "azure-client-secret-DO-NOT-DISCLOSE-9f13c7"

const SUBSCRIPTION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
const TENANT_ID = "11111111-2222-3333-4444-555555555555"
const CLIENT_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa"

const NOW = new Date("2026-07-15T09:30:00.000Z")

/** What the store returns and the only shape allowed to cross to a client. */
const VIEW: ConnectedSubscriptionView = {
  id: "sub-01HZX9",
  displayName: "Northwind production",
  maskedSubscriptionId: "************************************3301",
  scopeVerified: true,
  secretExpiresAt: "2027-07-15T09:30:00.000Z",
  fidelityTier: "baseline",
  status: "active",
}

function body(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    displayName: "Northwind production",
    subscriptionId: SUBSCRIPTION_ID,
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    clientSecret: PLAINTEXT_SECRET,
    secretExpiresAt: "2027-07-15T09:30:00.000Z",
    logAnalyticsWorkspaceId: null,
    ...overrides,
  }
}

function postRequest(
  payload: unknown,
  url = "https://app.example.com/api/subscriptions"
) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  })
}

function getRequest(query = "") {
  return new Request(`https://app.example.com/api/subscriptions${query}`)
}

async function readJson(response: Response): Promise<unknown> {
  return (await response.json()) as unknown
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)

  session.user = USER
  preflight.outcome = { scopeVerified: true, fidelityTier: "baseline" }
  preflight.thrown = undefined
  preflight.calls.length = 0
  store.created.length = 0
  store.createThrows = undefined
  store.listed = [VIEW]
})

afterEach(() => {
  vi.useRealTimers()
})

// --- The guard -------------------------------------------------------------

describe("Requirement 7.6 — every handler answers 401 without a session", () => {
  test.each([
    [
      "POST /api/subscriptions/test",
      async () => POST_TEST(postRequest(body())),
    ],
    ["POST /api/subscriptions", async () => POST(postRequest(body()))],
    ["GET /api/subscriptions", async () => GET(getRequest())],
  ] as const)("%s", async (_label, call) => {
    session.user = undefined

    const response = await call()

    // A status, not a redirect: a `fetch` following a 307 to `/login` receives that
    // page's HTML with a 200, so a caller expecting JSON sees a parse error instead
    // of "not signed in".
    expect(response.status).toBe(401)
    expect(response.headers.get("Cache-Control")).toBe("no-store")

    // Nothing ran behind the guard.
    expect(preflight.calls).toEqual([])
    expect(store.created).toEqual([])
  })
})

// --- The boundary ----------------------------------------------------------

describe("Requirement 7.7 — the boundary parse", () => {
  test.each([
    ["POST /api/subscriptions/test", POST_TEST],
    ["POST /api/subscriptions", POST],
  ] as const)("%s rejects a body that is not JSON", async (_label, handler) => {
    const response = await handler(postRequest("{not json"))

    expect(response.status).toBe(400)
    expect((await readJson(response)) as ApiErrorBody).toMatchObject({
      error: { code: "MALFORMED_BODY" },
    })
    expect(preflight.calls).toEqual([])
  })

  test.each([
    ["POST /api/subscriptions/test", POST_TEST],
    ["POST /api/subscriptions", POST],
  ] as const)(
    "%s rejects a malformed submission before invoking anything",
    async (_label, handler) => {
      const response = await handler(
        postRequest(body({ subscriptionId: "not-a-guid" }))
      )

      expect(response.status).toBe(400)

      const payload = (await readJson(response)) as ApiErrorBody
      expect(payload.error.code).toBe("INVALID_INPUT")
      expect(payload.error.fields?.[0].path).toBe("subscriptionId")

      // A 30-second preflight is not spent on a submission that cannot be recorded.
      expect(preflight.calls).toEqual([])
      expect(store.created).toEqual([])
    }
  )

  test.each([
    ["absent", undefined],
    ["at the current instant", NOW.toISOString()],
    ["in the past", new Date(NOW.getTime() - 1).toISOString()],
    ["more than 24 months out", "2028-07-15T09:30:00.001Z"],
  ] as const)(
    "Requirement 11.9 — an expiry %s is rejected with the range stated",
    async (_label, secretExpiresAt) => {
      const response = await POST(postRequest(body({ secretExpiresAt })))

      expect(response.status).toBe(400)

      const payload = (await readJson(response)) as ApiErrorBody
      expect(payload.error.message).toContain("after now")
      expect(payload.error.message).toContain("24 months")

      expect(store.created).toEqual([])
    }
  )

  test("Requirement 11.9 — exactly 24 months out is accepted", async () => {
    // The boundary a maximum-lifetime secret lands on. Rejecting it would reject
    // the commonest legitimate maximum.
    const response = await POST(
      postRequest(body({ secretExpiresAt: "2028-07-15T09:30:00.000Z" }))
    )

    expect(response.status).toBe(201)
  })

  test("Requirement 12.14 — a body carrying scopeVerified is rejected", async () => {
    // The structural half of "the Preflight_Service is the only writer of a
    // `scope_verified` value of true": there is no field for a browser to put it in,
    // and `.strict()` makes an attempt a rejection rather than a silently dropped
    // key that looks like it worked.
    const response = await POST(postRequest(body({ scopeVerified: true })))

    expect(response.status).toBe(400)
    expect(store.created).toEqual([])
  })

  test("no rejection body carries the submitted secret", async () => {
    const response = await POST(
      postRequest(body({ secretExpiresAt: "2099-01-01T00:00:00.000Z" }))
    )

    expect(await response.text()).not.toContain(PLAINTEXT_SECRET)
  })
})

// --- POST /api/subscriptions/test ------------------------------------------

describe("Requirements 12.11, 12.12 — POST /api/subscriptions/test", () => {
  test("the submission reaches the preflight, with the actor from the session", async () => {
    const response = await POST_TEST(postRequest(body()))

    expect(response.status).toBe(200)
    expect(await readJson(response)).toEqual({
      scopeVerified: true,
      fidelityTier: "baseline",
    })

    // `actorId` comes from the session and not from the body, and the expiry — which
    // the runtime has no use for — is not forwarded.
    expect(preflight.calls).toEqual([
      {
        actorId: USER.id,
        displayName: "Northwind production",
        subscriptionId: SUBSCRIPTION_ID,
        tenantId: TENANT_ID,
        clientId: CLIENT_ID,
        clientSecret: PLAINTEXT_SECRET,
        logAnalyticsWorkspaceId: null,
      },
    ])
  })

  test("an actorId in the body cannot override the session's", async () => {
    // `.strict()` refuses it outright, which is stronger than ignoring it: a client
    // attempting to preflight as another user is told no rather than silently
    // preflighting as itself.
    const response = await POST_TEST(
      postRequest(body({ actorId: "someone-else" }))
    )

    expect(response.status).toBe(400)
    expect(preflight.calls).toEqual([])
  })

  test("this route persists nothing", async () => {
    await POST_TEST(postRequest(body()))

    expect(store.created).toEqual([])
  })

  test("a rejected preflight is this endpoint's answer, at 200", async () => {
    // The probe ran; the result is that the scope could not be proved. The wizard
    // renders that as a result step (Requirement 12.7), which it can only do if it
    // received a parsed body rather than an error it has to interpret.
    preflight.outcome = {
      scopeVerified: false,
      code: "SCOPE_UNVERIFIED",
      message: "Read at subscription scope was not proved.",
    }

    const response = await POST_TEST(postRequest(body()))

    expect(response.status).toBe(200)
    expect(await readJson(response)).toEqual(preflight.outcome)
  })

  test("an unconfigured runtime is a 503 that blames no role assignment", async () => {
    preflight.thrown = new MissingRuntimeConfigError("RPT_RUNTIME_ARN")

    const response = await POST_TEST(postRequest(body()))
    const text = await response.text()

    expect(response.status).toBe(503)
    expect(text).toContain("not configured")

    // The variable's name is a fact about our deployment; the consultant reading
    // this can act on neither it nor its absence.
    expect(text).not.toContain("RPT_RUNTIME_ARN")
  })
})

// --- POST /api/subscriptions ----------------------------------------------

describe("Requirements 10.2, 12.5, 12.14 — POST /api/subscriptions", () => {
  test("the preflight's result is what reaches the store", async () => {
    preflight.outcome = { scopeVerified: true, fidelityTier: "enhanced" }

    const response = await POST(postRequest(body()))

    expect(response.status).toBe(201)
    expect(store.created).toHaveLength(1)

    const input = store.created[0]

    // Both flags from the preflight and from nowhere else (Requirements 12.14,
    // 12.8–12.10) …
    expect(input.scopeVerified).toBe(true)
    expect(input.fidelityTier).toBe("enhanced")

    // … and `status` is not among the arguments at all: the store derives it, which
    // is what makes `active` alongside `scope_verified: false` unrepresentable
    // rather than merely unwritten (Requirement 12.5).
    expect(Object.keys(input)).not.toContain("status")

    expect(input.userId).toBe(USER.id)
    expect(input.subscriptionId).toBe(SUBSCRIPTION_ID)
    expect(input.clientSecret).toBe(PLAINTEXT_SECRET)
    expect(input.secretExpiresAt).toEqual(new Date("2027-07-15T09:30:00.000Z"))
  })

  test("Requirement 10.2 — the response carries only the browser-safe projection", async () => {
    const response = await POST(postRequest(body()))
    const text = await response.text()
    const payload = JSON.parse(text) as {
      subscription: Record<string, unknown>
    }

    expect(Object.keys(payload.subscription).sort()).toEqual([
      "displayName",
      "fidelityTier",
      "id",
      "maskedSubscriptionId",
      "scopeVerified",
      "secretExpiresAt",
      "status",
    ])

    // Nothing secret survives the serialization, including the unmasked id.
    for (const secret of [
      PLAINTEXT_SECRET,
      TENANT_ID,
      CLIENT_ID,
      SUBSCRIPTION_ID,
    ]) {
      expect(text).not.toContain(secret)
    }
  })

  test("a store rejection for an already-connected subscription is a 409", async () => {
    // Requirement 9.10's *response*; that no second row is written is asserted
    // against a real database, where the constraint lives.
    store.createThrows = new SubscriptionAlreadyConnectedError()

    const response = await POST(postRequest(body()))
    const payload = (await readJson(response)) as ApiErrorBody

    expect(response.status).toBe(409)
    expect(payload.error.code).toBe("ALREADY_CONNECTED")
    expect(payload.error.message).toContain("already connected")
  })

  test("the real error class is the one the route recognises", () => {
    // Guards the fake above: if `importOriginal` stopped supplying the class, the
    // 409 branch would silently become a 500.
    const error: AlreadyConnected = new SubscriptionAlreadyConnectedError()

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("SubscriptionAlreadyConnectedError")
  })

  test("an unconfigured runtime saves nothing and says so", async () => {
    preflight.thrown = new MissingRuntimeConfigError("RPT_RUNTIME_ARN")

    const response = await POST(postRequest(body()))
    const text = await response.text()

    expect(response.status).toBe(503)
    expect(text).toContain("nothing was saved")
    expect(text).not.toContain("RPT_RUNTIME_ARN")
    expect(store.created).toEqual([])
  })
})

// --- GET /api/subscriptions -----------------------------------------------

describe("Requirements 7.7, 10.2 — GET /api/subscriptions", () => {
  test("the list is projections only, and is never cached", async () => {
    const response = await GET(getRequest())

    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await readJson(response)).toEqual({ subscriptions: [VIEW] })
  })

  test("an empty list is a 200, not a 404", async () => {
    store.listed = []

    const response = await GET(getRequest())

    expect(response.status).toBe(200)
    expect(await readJson(response)).toEqual({ subscriptions: [] })
  })

  test("an unexpected search parameter is rejected", async () => {
    // Requirement 7.7 counts search parameters as input. `?userId=…` expresses an
    // expectation this route does not honour, and answering it with the caller's own
    // subscriptions would look like the filter had been applied.
    const response = await GET(getRequest("?userId=someone-else"))

    expect(response.status).toBe(400)
    expect((await readJson(response)) as ApiErrorBody).toMatchObject({
      error: { code: "INVALID_INPUT" },
    })
  })
})

// --- The Node runtime declaration ----------------------------------------

describe("Requirement 6.7 — both route modules declare the Node runtime", () => {
  test.each([
    "app/api/subscriptions/route.ts",
    "app/api/subscriptions/test/route.ts",
  ])("%s", async (relativePath) => {
    // Read from disk rather than imported, because the assertion is about the
    // module-level export a bundler reads, and a re-export through a barrel would
    // satisfy an import-based check while leaving the file itself silent.
    const { readFileSync } = await import("node:fs")
    const path = await import("node:path")
    const { fileURLToPath } = await import("node:url")

    const projectRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../.."
    )

    expect(
      readFileSync(path.join(projectRoot, relativePath), "utf8")
    ).toContain('export const runtime = "nodejs"')
  })
})
