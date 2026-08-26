import { beforeEach, describe, expect, test, vi } from "vitest"

import type { ApiErrorBody } from "@/lib/api/response"
import type { ScanView } from "@/lib/db/views"
import type { ScanSubscriptionState } from "@/lib/scans/store"

/**
 * `POST /api/subscriptions/[id]/scan` and `GET /api/subscriptions/[id]/scan`
 * (Requirements 4.4, 4.8).
 *
 * ## Claims tested
 *
 * 1. **Auth first** — unauthenticated requests are refused.
 * 2. **Ownership** — an absent or foreign subscription yields 404.
 * 3. **scope_verified guard** — a `false` yields 422 naming `SCOPE_UNVERIFIED`.
 * 4. **secret expiry guard** — a passed `secret_expires_at` yields 422 naming
 *    `SECRET_EXPIRED`.
 * 5. **Happy path** — a valid POST inserts a row and returns 201.
 * 6. **Body validation** — an extra key on a strict body yields 400.
 */

const { session, store } = vi.hoisted(() => ({
  session: { user: undefined as { id: string; email: string } | undefined },
  store: {
    subscriptionState: undefined as ScanSubscriptionState | undefined,
    subscriptionThrows: undefined as unknown,
    createdScan: undefined as ScanView | undefined,
    latestScan: undefined as ScanView | null | undefined,
    connectedSubscriptionView: undefined as unknown,
    credentials: undefined as unknown,
    executedScan: undefined as ScanView | undefined,
  },
}))

vi.mock("@/lib/auth/guard", () => ({
  requireSessionForApi: async () => session.user ?? null,
}))

vi.mock("@/lib/scans/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/scans/store")>()

  return {
    ...original,
    readSubscriptionForScan: async () => {
      if (store.subscriptionThrows !== undefined) throw store.subscriptionThrows
      return store.subscriptionState
    },
    createScan: async () => {
      return store.createdScan
    },
    readLatestScan: async () => {
      return store.latestScan
    },
  }
})

vi.mock("@/lib/subscriptions/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/subscriptions/store")>()

  return {
    ...original,
    getConnectedSubscription: async () => {
      return store.connectedSubscriptionView
    },
    resolveSubscriptionCredentials: async () => {
      return store.credentials
    },
    SubscriptionNotFoundError: original.SubscriptionNotFoundError,
    SubscriptionSecretUnreadableError: original.SubscriptionSecretUnreadableError,
  }
})

vi.mock("@/lib/scans/execute", () => ({
  executeScan: async () => {
    return store.executedScan
  },
}))

import { ScanSubscriptionNotFoundError } from "@/lib/scans/store"
import { GET, POST } from "@/app/api/subscriptions/[id]/scan/route"

// --- Fixtures ---------------------------------------------------------------

const USER = { id: "user-01", email: "test@example.com" }
const SUBSCRIPTION_ID = "sub-01"
const FUTURE = new Date(Date.now() + 86_400_000 * 30)
const PAST = new Date(Date.now() - 86_400_000)

const VALID_STATE: ScanSubscriptionState = {
  scopeVerified: true,
  secretExpiresAt: FUTURE,
}

const FAKE_SCAN: ScanView = {
  id: "scan-001",
  connectedSubscriptionId: SUBSCRIPTION_ID,
  status: "queued",
  catalogVersion: null,
  sectionsCatalogueVersion: null,
  resourceCount: null,
  typeCounts: null,
  childTypeCounts: null,
  resourceGroups: null,
  regions: null,
  regionCounts: null,
  regionProbes: null,
  truncated: null,
  errorCode: null,
  errorMessage: null,
  completedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
}

function makeContext(id: string = SUBSCRIPTION_ID) {
  return { params: Promise.resolve({ id }) }
}

function postRequest(body: unknown = {}): Request {
  return new Request("http://localhost/api/subscriptions/sub-01/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function getRequest(query: string = ""): Request {
  return new Request(
    `http://localhost/api/subscriptions/sub-01/scan${query}`,
    { method: "GET" }
  )
}

// --- Setup ------------------------------------------------------------------

beforeEach(() => {
  session.user = USER
  store.subscriptionState = VALID_STATE
  store.subscriptionThrows = undefined
  store.createdScan = FAKE_SCAN
  store.latestScan = FAKE_SCAN
  store.connectedSubscriptionView = { displayName: "Test Subscription" }
  store.credentials = {
    subscriptionId: "sub-guid",
    tenantId: "t",
    clientId: "c",
    clientSecret: "s",
    fidelityTier: "baseline",
    logAnalyticsWorkspaceId: null,
  }
  store.executedScan = FAKE_SCAN
})

// --- POST tests -------------------------------------------------------------

describe("POST /api/subscriptions/[id]/scan", () => {
  test("401 when unauthenticated", async () => {
    session.user = undefined
    const res = await POST(postRequest(), makeContext())
    expect(res.status).toBe(401)
  })

  test("400 when path param is invalid", async () => {
    const res = await POST(postRequest(), makeContext(""))
    expect(res.status).toBe(400)
  })

  test("404 when subscription not found", async () => {
    store.subscriptionThrows = new ScanSubscriptionNotFoundError()
    const res = await POST(postRequest(), makeContext())
    expect(res.status).toBe(404)
  })

  test("422 SCOPE_UNVERIFIED when scope_verified is false", async () => {
    store.subscriptionState = { ...VALID_STATE, scopeVerified: false }
    const res = await POST(postRequest(), makeContext())
    expect(res.status).toBe(422)
    const body = (await res.json()) as ApiErrorBody
    expect(body.error.code).toBe("SCOPE_UNVERIFIED")
    expect(body.error.message).toContain("scope")
  })

  test("422 SECRET_EXPIRED when secret has expired", async () => {
    store.subscriptionState = { ...VALID_STATE, secretExpiresAt: PAST }
    const res = await POST(postRequest(), makeContext())
    expect(res.status).toBe(422)
    const body = (await res.json()) as ApiErrorBody
    expect(body.error.code).toBe("SECRET_EXPIRED")
    expect(body.error.message).toContain("expired")
  })

  test("400 when body has unexpected keys (strict schema)", async () => {
    const res = await POST(postRequest({ unexpected: "value" }), makeContext())
    expect(res.status).toBe(400)
    const body = (await res.json()) as ApiErrorBody
    expect(body.error.code).toBe("INVALID_INPUT")
  })

  test("201 happy path — returns the scan", async () => {
    const res = await POST(postRequest(), makeContext())
    expect(res.status).toBe(201)
    const body = (await res.json()) as { scan: ScanView }
    expect(body.scan).toEqual(FAKE_SCAN)
  })

  test("400 when body is not JSON", async () => {
    const req = new Request("http://localhost/api/subscriptions/sub-01/scan", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json",
    })
    const res = await POST(req, makeContext())
    expect(res.status).toBe(400)
  })
})

// --- GET tests --------------------------------------------------------------

describe("GET /api/subscriptions/[id]/scan", () => {
  test("401 when unauthenticated", async () => {
    session.user = undefined
    const res = await GET(getRequest(), makeContext())
    expect(res.status).toBe(401)
  })

  test("404 when subscription not found", async () => {
    store.subscriptionThrows = new ScanSubscriptionNotFoundError()
    const res = await GET(getRequest(), makeContext())
    expect(res.status).toBe(404)
  })

  test("200 with null scan when none exists", async () => {
    store.latestScan = null
    const res = await GET(getRequest(), makeContext())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scan: null }
    expect(body.scan).toBeNull()
  })

  test("200 with the latest scan", async () => {
    const res = await GET(getRequest(), makeContext())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scan: ScanView }
    expect(body.scan).toEqual(FAKE_SCAN)
  })

  test("400 when query has unexpected keys", async () => {
    const res = await GET(getRequest("?unexpected=true"), makeContext())
    expect(res.status).toBe(400)
  })
})
