import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { ApiErrorBody } from "@/lib/api/response"
import type { ConnectedSubscriptionView } from "@/lib/db/views"
import type {
  RotateClientSecretInput,
  SubscriptionIdentity,
  SubscriptionNotFoundError as NotFound,
} from "@/lib/subscriptions/store"

/**
 * `POST /api/subscriptions/[id]/secret` — the secret rotation route
 * (Requirements 13.7, 13.8, 9.2, 9.7, 7.7).
 *
 * ## What is faked, and why these three
 *
 * The session guard, the preflight and the store — the same three the create and
 * probe routes fake, for the same reason. What is left is exactly what this file
 * contains: the guard check, the path-parameter and body parses, the order of the
 * three steps, and which value from the preflight reaches which store argument.
 * Each fake stands in for something with its own suite: `lib/auth/session.ts`
 * against Postgres, `lib/subscriptions/preflight.ts` against a faked runtime, and
 * `lib/subscriptions/store.ts` against a real Postgres 17 — where
 * `rotateClientSecret`'s own claims (fresh ciphertext, no earlier ciphertext
 * retained, `status` derived, another user's row untouched) already live.
 *
 * `SubscriptionNotFoundError` is the **real** class, pulled through
 * `importOriginal`: the route branches on `instanceof`, and a hand-built stand-in
 * would assert that the test knows the shape rather than that the route recognises
 * the error.
 *
 * ## The claim this file exists for
 *
 * That a **rejected** re-run preflight still records the rotation, at `422`, with
 * `scopeVerified: false` and no tier — the decision the route documents. It is
 * asserted here rather than against a database because it is a claim about which
 * arguments the handler passes, not about what SQL does with them.
 */

const { session, preflight, store } = vi.hoisted(() => ({
  session: { user: undefined as { id: string; email: string } | undefined },
  preflight: {
    outcome: undefined as unknown,
    thrown: undefined as unknown,
    calls: [] as unknown[],
  },
  store: {
    identity: undefined as SubscriptionIdentity | undefined,
    identityThrows: undefined as unknown,
    identityCalls: [] as { userId: string; id: string }[],
    rotated: [] as {
      userId: string
      id: string
      input: RotateClientSecretInput
    }[],
    rotateThrows: undefined as unknown,
    view: undefined as ConnectedSubscriptionView | undefined,
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
    resolveSubscriptionIdentity: async (userId: string, id: string) => {
      store.identityCalls.push({ userId, id })
      if (store.identityThrows !== undefined) throw store.identityThrows
      return store.identity
    },
    rotateClientSecret: async (
      userId: string,
      id: string,
      input: RotateClientSecretInput
    ) => {
      store.rotated.push({ userId, id, input })
      if (store.rotateThrows !== undefined) throw store.rotateThrows
      return store.view
    },
  }
})

import { MissingRuntimeConfigError } from "@/lib/aws/agentcore"
import { SubscriptionNotFoundError } from "@/lib/subscriptions/store"

import { POST } from "@/app/api/subscriptions/[id]/secret/route"

// --- Fixtures ---------------------------------------------------------------

const USER = { id: "user-01HZX9", email: "consultant@example.com" }

/** Distinctive enough that a substring scan cannot match it by accident. */
const ROTATED_SECRET = "azure-client-secret-ROTATED-DO-NOT-DISCLOSE-4b81ea"

const SUBSCRIPTION_ROW_ID = "8f14e45f-ceea-467a-9d9f-b8a4c8e6f1c2"

const SUBSCRIPTION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
const TENANT_ID = "11111111-2222-3333-4444-555555555555"
const CLIENT_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa"
const WORKSPACE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

const NOW = new Date("2026-07-15T09:30:00.000Z")

const ROTATED_EXPIRES_AT = "2027-07-15T09:30:00.000Z"

/** What the stored row identifies, with no credential in it. */
const IDENTITY: SubscriptionIdentity = {
  displayName: "Northwind production",
  subscriptionId: SUBSCRIPTION_ID,
  tenantId: TENANT_ID,
  clientId: CLIENT_ID,
  logAnalyticsWorkspaceId: WORKSPACE_ID,
}

/** What the store returns, and the only shape allowed to cross to a client. */
const VIEW: ConnectedSubscriptionView = {
  id: SUBSCRIPTION_ROW_ID,
  displayName: "Northwind production",
  maskedSubscriptionId: "************************************3301",
  scopeVerified: true,
  secretExpiresAt: ROTATED_EXPIRES_AT,
  fidelityTier: "baseline",
  status: "active",
}

function body(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    clientSecret: ROTATED_SECRET,
    secretExpiresAt: ROTATED_EXPIRES_AT,
    ...overrides,
  }
}

function postRequest(payload: unknown) {
  return new Request(
    `https://app.example.com/api/subscriptions/${SUBSCRIPTION_ROW_ID}/secret`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }
  )
}

/** The awaited-params shape Next 16 hands a dynamic route handler. */
function routeContext(id: string = SUBSCRIPTION_ROW_ID) {
  return { params: Promise.resolve({ id }) }
}

async function readJson(response: Response): Promise<unknown> {
  return (await response.json()) as unknown
}

/** The handler, with the two arguments Next passes it. */
async function rotate(
  payload: unknown = body(),
  id: string = SUBSCRIPTION_ROW_ID
): Promise<Response> {
  return await POST(postRequest(payload), routeContext(id))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)

  session.user = USER
  preflight.outcome = { scopeVerified: true, fidelityTier: "baseline" }
  preflight.thrown = undefined
  preflight.calls.length = 0
  store.identity = IDENTITY
  store.identityThrows = undefined
  store.identityCalls.length = 0
  store.rotated.length = 0
  store.rotateThrows = undefined
  store.view = VIEW
})

afterEach(() => {
  vi.useRealTimers()
})

// --- The guard -------------------------------------------------------------

describe("Requirement 7.6 — no session, no rotation", () => {
  test("answers 401 and reads nothing", async () => {
    session.user = undefined

    const response = await rotate()

    expect(response.status).toBe(401)
    expect(response.headers.get("Cache-Control")).toBe("no-store")

    // Nothing behind the guard ran — not even the row read.
    expect(store.identityCalls).toEqual([])
    expect(preflight.calls).toEqual([])
    expect(store.rotated).toEqual([])
  })
})

// --- The boundary ----------------------------------------------------------

describe("Requirement 7.7 — the path parameter and the body are both input", () => {
  test.each([
    ["an empty segment", ""],
    ["a whitespace-only segment", "   "],
  ] as const)("%s is rejected before any read", async (_label, id) => {
    const response = await rotate(body(), id)

    expect(response.status).toBe(400)
    expect((await readJson(response)) as ApiErrorBody).toMatchObject({
      error: { code: "INVALID_INPUT" },
    })

    expect(store.identityCalls).toEqual([])
    expect(store.rotated).toEqual([])
  })

  test("a body that is not JSON is rejected", async () => {
    const response = await rotate("{not json")

    expect(response.status).toBe(400)
    expect((await readJson(response)) as ApiErrorBody).toMatchObject({
      error: { code: "MALFORMED_BODY" },
    })
    expect(store.rotated).toEqual([])
  })

  test("an absent clientSecret is rejected without echoing anything", async () => {
    const response = await rotate({ secretExpiresAt: ROTATED_EXPIRES_AT })

    expect(response.status).toBe(400)

    const payload = (await readJson(response)) as ApiErrorBody
    expect(payload.error.fields?.[0].path).toBe("clientSecret")

    expect(preflight.calls).toEqual([])
    expect(store.rotated).toEqual([])
  })

  test.each([
    ["absent", undefined],
    ["at the current instant", NOW.toISOString()],
    ["in the past", new Date(NOW.getTime() - 1).toISOString()],
    ["more than 24 months out", "2028-07-15T09:30:00.001Z"],
  ] as const)(
    "Requirement 11.9 — a rotated expiry %s is rejected with the range stated",
    async (_label, secretExpiresAt) => {
      // The cap applies to a rotated secret exactly as it does to a new one: a
      // rotated secret is a freshly issued secret.
      const response = await rotate(body({ secretExpiresAt }))

      expect(response.status).toBe(400)

      const payload = (await readJson(response)) as ApiErrorBody
      expect(payload.error.message).toContain("after now")
      expect(payload.error.message).toContain("24 months")

      expect(store.rotated).toEqual([])
    }
  )

  test("Requirement 11.9 — exactly 24 months out is accepted", async () => {
    const response = await rotate(
      body({ secretExpiresAt: "2028-07-15T09:30:00.000Z" })
    )

    expect(response.status).toBe(200)
  })

  test("Requirement 12.14 — a body carrying scopeVerified is rejected", async () => {
    const response = await rotate(body({ scopeVerified: true }))

    expect(response.status).toBe(400)
    expect(preflight.calls).toEqual([])
    expect(store.rotated).toEqual([])
  })

  test.each([
    ["tenantId", TENANT_ID],
    ["clientId", CLIENT_ID],
    ["subscriptionId", SUBSCRIPTION_ID],
    ["fidelityTier", "enhanced"],
  ] as const)(
    "a body supplying %s is rejected rather than ignored",
    async (field, value) => {
      // A rotation replaces the credential, not the connection. `rotateClientSecret`
      // has no argument that could write these, so accepting one would mean
      // preflighting against an identity the row will still not have afterwards.
      const response = await rotate(body({ [field]: value }))

      expect(response.status).toBe(400)
      expect(preflight.calls).toEqual([])
      expect(store.rotated).toEqual([])
    }
  )

  test("no rejection body carries the submitted secret", async () => {
    const response = await rotate(
      body({ secretExpiresAt: "2099-01-01T00:00:00.000Z" })
    )

    expect(await response.text()).not.toContain(ROTATED_SECRET)
  })
})

// --- The three steps, in order ---------------------------------------------

describe("Requirements 13.7, 13.8 — the identity, the preflight, then the write", () => {
  test("the stored identity is re-asserted with the new secret", async () => {
    const response = await rotate()

    expect(response.status).toBe(200)

    // Read scoped to the signed-in user (Requirement 9.7) …
    expect(store.identityCalls).toEqual([
      { userId: USER.id, id: SUBSCRIPTION_ROW_ID },
    ])

    // … and the preflight re-runs against the *stored* principal with the
    // *submitted* secret (Requirement 13.8). `actorId` comes from the session.
    expect(preflight.calls).toEqual([
      {
        actorId: USER.id,
        displayName: IDENTITY.displayName,
        subscriptionId: SUBSCRIPTION_ID,
        tenantId: TENANT_ID,
        clientId: CLIENT_ID,
        clientSecret: ROTATED_SECRET,
        logAnalyticsWorkspaceId: WORKSPACE_ID,
      },
    ])
  })

  test("the write carries the new secret, the submitted expiry, and the preflight's flags", async () => {
    preflight.outcome = { scopeVerified: true, fidelityTier: "enhanced" }

    const response = await rotate()

    expect(response.status).toBe(200)
    expect(store.rotated).toHaveLength(1)

    const { userId, id, input } = store.rotated[0]

    expect(userId).toBe(USER.id)
    expect(id).toBe(SUBSCRIPTION_ROW_ID)
    expect(input.clientSecret).toBe(ROTATED_SECRET)
    expect(input.secretExpiresAt).toEqual(new Date(ROTATED_EXPIRES_AT))

    // From the preflight and nowhere else (Requirements 13.8, 12.8–12.10).
    expect(input.scopeVerified).toBe(true)
    expect(input.fidelityTier).toBe("enhanced")

    // `status` is not among the arguments at all: the store derives it, which is
    // what keeps `active` alongside `scope_verified: false` unrepresentable rather
    // than merely unwritten.
    expect(Object.keys(input)).not.toContain("status")
  })

  test("the row is read before the preflight, so another user's id spends no 30 seconds", async () => {
    store.identityThrows = new SubscriptionNotFoundError()

    const response = await rotate()

    expect(response.status).toBe(404)
    expect(preflight.calls).toEqual([])
    expect(store.rotated).toEqual([])
  })

  test("Requirement 10.2 — the response carries only the browser-safe projection", async () => {
    const response = await rotate()
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
      ROTATED_SECRET,
      TENANT_ID,
      CLIENT_ID,
      WORKSPACE_ID,
      SUBSCRIPTION_ID,
    ]) {
      expect(text).not.toContain(secret)
    }

    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })
})

// --- A rejected re-run preflight ------------------------------------------

describe("Requirement 13.7 — a rejected preflight still records the rotation", () => {
  beforeEach(() => {
    preflight.outcome = {
      scopeVerified: false,
      code: "SCOPE_UNVERIFIED",
      message: "Read at subscription scope was not proved.",
    }
    store.view = { ...VIEW, scopeVerified: false, status: "pending" }
  })

  test("the write lands, with scopeVerified false and no tier", async () => {
    const response = await rotate()

    expect(response.status).toBe(422)
    expect(store.rotated).toHaveLength(1)

    const { input } = store.rotated[0]

    // Requirement 13.7 names no precondition: the ciphertext is replaced and the
    // expiry recorded. The consultant reached this route from an expired or
    // `disabled` row, so the previous envelope encrypts a credential Azure has
    // already stopped accepting — refusing the write would retain it and leave no
    // path back to working.
    expect(input.clientSecret).toBe(ROTATED_SECRET)
    expect(input.secretExpiresAt).toEqual(new Date(ROTATED_EXPIRES_AT))
    expect(input.scopeVerified).toBe(false)

    // A rejection carries no tier at all, and leaving the field absent keeps the
    // recorded one rather than resetting it.
    expect(Object.keys(input)).not.toContain("fidelityTier")
  })

  test("the answer says both facts, and relays the preflight's code", async () => {
    const response = await rotate()
    const payload = (await readJson(response)) as ApiErrorBody

    expect(payload.error.code).toBe("SCOPE_UNVERIFIED")
    expect(payload.error.message).toContain("was recorded")
    expect(payload.error.message).toContain("cannot start a run")
    expect(payload.error.message).toContain(
      "Read at subscription scope was not proved."
    )
  })

  test("Requirement 12.13 — AUTH_EXPIRED survives distinct from SCOPE_UNVERIFIED", async () => {
    // Different remedies: one is a role the customer fixes, the other a secret
    // Azure would not accept even freshly pasted.
    preflight.outcome = {
      scopeVerified: false,
      code: "AUTH_EXPIRED",
      message: "Azure rejected the client secret as expired.",
    }

    const response = await rotate()
    const payload = (await readJson(response)) as ApiErrorBody

    expect(response.status).toBe(422)
    expect(payload.error.code).toBe("AUTH_EXPIRED")
  })

  test("the 422 body carries neither the secret nor the identity", async () => {
    const text = await (await rotate()).text()

    for (const secret of [ROTATED_SECRET, TENANT_ID, CLIENT_ID]) {
      expect(text).not.toContain(secret)
    }
  })
})

// --- Failures --------------------------------------------------------------

describe("the failure answers", () => {
  test("Requirements 9.7, 9.8 — a rotation that matched no row is a 404", async () => {
    // The row went away between the read and the write, or the `AND user_id`
    // predicate matched nothing. Not found, never forbidden: a "forbidden" answer
    // confirms the row exists, and its existence is a fact about somebody else's
    // customer.
    store.rotateThrows = new SubscriptionNotFoundError()

    const response = await rotate()
    const payload = (await readJson(response)) as ApiErrorBody

    expect(response.status).toBe(404)
    expect(payload.error.code).toBe("NOT_FOUND")
    expect(payload.error.message).toBe("Not found.")
  })

  test("the real error class is the one the route recognises", () => {
    // Guards the fake above: if `importOriginal` stopped supplying the class, the
    // 404 branch would silently become a 500.
    const error: NotFound = new SubscriptionNotFoundError()

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("SubscriptionNotFoundError")
  })

  test("an unconfigured runtime changes nothing and names no variable", async () => {
    preflight.thrown = new MissingRuntimeConfigError("RPT_RUNTIME_ARN")

    const response = await rotate()
    const text = await response.text()

    expect(response.status).toBe(503)
    expect(text).toContain("nothing was changed")

    // The variable's name is a fact about our deployment; the consultant reading
    // this can act on neither it nor its absence.
    expect(text).not.toContain("RPT_RUNTIME_ARN")

    expect(store.rotated).toEqual([])
  })

  test("an unexpected store failure is a 500 that logs no submitted value", async () => {
    const logged: string[] = []
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "))
      })

    // What the store actually throws for a driver failure: the operation and the
    // SQLSTATE, and nothing drawn from the statement's parameters.
    store.rotateThrows = new Error(
      "[subscriptions] rotating a client secret failed (postgres 08006)"
    )

    const response = await rotate()

    expect(response.status).toBe(500)
    expect((await readJson(response)) as ApiErrorBody).toMatchObject({
      error: { code: "INTERNAL_ERROR" },
    })

    expect(logged.join("\n")).not.toContain(ROTATED_SECRET)
    expect(logged.join("\n")).toContain("postgres 08006")

    spy.mockRestore()
  })
})

// --- The Node runtime declaration ----------------------------------------

describe("Requirement 6.7 — the route module declares the Node runtime", () => {
  test("app/api/subscriptions/[id]/secret/route.ts", async () => {
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
      readFileSync(
        path.join(projectRoot, "app/api/subscriptions/[id]/secret/route.ts"),
        "utf8"
      )
    ).toContain('export const runtime = "nodejs"')
  })
})
