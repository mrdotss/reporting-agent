import { beforeEach, describe, expect, test, vi } from "vitest"

import type { ApiErrorBody } from "@/lib/api/response"
import type { SubscriptionStatus } from "@/lib/db/schema"
import type { InventoryDimensions } from "@/lib/subscriptions/inventory-cache"
import type { InventoryListing } from "@/lib/subscriptions/inventory"
import type {
  ResolvedAzureCredentials,
  SubscriptionRowState,
} from "@/lib/subscriptions/store"

/**
 * `GET /api/subscriptions/[id]/inventory` (Requirements 9.1–9.4, 9.8, 9.9, 7.7).
 *
 * ## What is faked, and why these three
 *
 * The session guard, the store and `listInventory` — the same three shapes the
 * secret-rotation route's suite fakes, and for the same reason. What is left is
 * exactly what this file is about: the **order** of the three criteria, and what
 * each of them is allowed to disclose. The cache is **not** faked; it is the real
 * module, cleared between cases, because "the cache is consulted only after the
 * ownership check" is a claim about the real thing.
 *
 * `SubscriptionNotFoundError` and `SubscriptionSecretUnreadableError` are the
 * **real** classes, pulled through `importOriginal`: the route branches on
 * `instanceof`, and hand-built stand-ins would assert that this test knows the shape
 * rather than that the route recognises the error.
 *
 * ## The claims worth machine-checking
 *
 *  1. **Ownership first, and byte-identical.** Another user's row and an id that
 *     exists for no row must produce the *same bytes*, because the existence of a
 *     connected subscription is itself a fact about somebody else's customer. And
 *     no Azure query runs for either.
 *  2. **Status before the cache and before any credential.** A non-`active` row
 *     names its status, decrypts nothing, invokes nothing, and — critically —
 *     answers with **no dimensions at all** rather than four empty ones, which a
 *     consultant would read as an empty subscription.
 *  3. **A hit serves from the cache without invoking**, and a write to the row ends
 *     that immediately.
 *  4. **A failed listing writes no cache entry and retries nothing.** Asserted
 *     through the cache's entry count, because reading back a miss cannot
 *     distinguish "nothing was stored" from "something was stored and has already
 *     expired" — and those are different bugs.
 */

const { session, store, inventory } = vi.hoisted(() => ({
  session: { user: undefined as { id: string; email: string } | undefined },
  store: {
    state: undefined as SubscriptionRowState | undefined,
    stateThrows: undefined as unknown,
    stateCalls: [] as { userId: string; id: string }[],
    credentials: undefined as ResolvedAzureCredentials | undefined,
    credentialsThrows: undefined as unknown,
    credentialsCalls: [] as { userId: string; id: string }[],
  },
  inventory: {
    listing: undefined as InventoryListing | undefined,
    thrown: undefined as unknown,
    calls: [] as unknown[],
  },
}))

vi.mock("@/lib/auth/guard", () => ({
  requireSessionForApi: async () => session.user ?? null,
}))

vi.mock("@/lib/subscriptions/store", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/subscriptions/store")>()

  return {
    ...original,
    readSubscriptionRowState: async (userId: string, id: string) => {
      store.stateCalls.push({ userId, id })
      if (store.stateThrows !== undefined) throw store.stateThrows
      return store.state
    },
    resolveSubscriptionCredentials: async (userId: string, id: string) => {
      store.credentialsCalls.push({ userId, id })
      if (store.credentialsThrows !== undefined) throw store.credentialsThrows
      return store.credentials
    },
  }
})

vi.mock("@/lib/subscriptions/inventory", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/subscriptions/inventory")>()

  return {
    ...original,
    listInventory: async (request: unknown) => {
      inventory.calls.push(request)
      if (inventory.thrown !== undefined) throw inventory.thrown
      return inventory.listing
    },
  }
})

import { MissingRuntimeConfigError } from "@/lib/aws/agentcore"
import {
  clearInventoryCache,
  inventoryCacheEntryCount,
} from "@/lib/subscriptions/inventory-cache"
import {
  SubscriptionNotFoundError,
  SubscriptionSecretUnreadableError,
} from "@/lib/subscriptions/store"

import { GET } from "@/app/api/subscriptions/[id]/inventory/route"

// --- Fixtures ---------------------------------------------------------------

const USER = { id: "user-01HZX9", email: "consultant@example.com" }

const ROW_ID = "8f14e45f-ceea-467a-9d9f-b8a4c8e6f1c2"
const ABSENT_ROW_ID = "c9f0f895-fb98-4b17-a4f6-2a8e6f1c2d3e"

const UPDATED_AT = "2026-07-15T09:30:00.000Z"
const LATER_UPDATED_AT = "2026-07-15T09:35:00.000Z"

/** Distinctive enough that a substring scan cannot match it by accident. */
const PLAINTEXT_SECRET = "azure-client-secret-ROUTE-DO-NOT-DISCLOSE-3d90bb"

const CREDENTIALS: ResolvedAzureCredentials = {
  subscriptionId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  tenantId: "11111111-2222-3333-4444-555555555555",
  clientId: "66666666-7777-8888-9999-aaaaaaaaaaaa",
  clientSecret: PLAINTEXT_SECRET,
  fidelityTier: "baseline",
  logAnalyticsWorkspaceId: null,
}

function rowState(
  overrides: Partial<SubscriptionRowState> = {}
): SubscriptionRowState {
  return {
    status: "active",
    updatedAt: UPDATED_AT,
    displayName: "Northwind production",
    ...overrides,
  }
}

function dimensions(): InventoryDimensions {
  return {
    resource_types: {
      values: ["Microsoft.Compute/virtualMachines"],
      truncated: false,
    },
    resource_groups: { values: ["rg-prod-sea"], truncated: false },
    tag_keys: { values: ["env", "owner"], truncated: false },
    tag_values: { values: ["prod"], truncated: false },
  }
}

function getRequest(rowId = ROW_ID, search = ""): Request {
  return new Request(
    `https://reporting.example.com/api/subscriptions/${rowId}/inventory${search}`,
    { method: "GET" }
  )
}

function routeContext(rowId = ROW_ID) {
  return { params: Promise.resolve({ id: rowId }) }
}

async function call(
  rowId = ROW_ID,
  search = ""
): Promise<{ status: number; body: unknown; text: string }> {
  const response = await GET(getRequest(rowId, search), routeContext(rowId))
  const text = await response.text()

  return {
    status: response.status,
    body: text.length === 0 ? undefined : (JSON.parse(text) as unknown),
    text,
  }
}

beforeEach(() => {
  session.user = USER
  store.state = rowState()
  store.stateThrows = undefined
  store.stateCalls.length = 0
  store.credentials = CREDENTIALS
  store.credentialsThrows = undefined
  store.credentialsCalls.length = 0
  inventory.listing = { available: true, dimensions: dimensions() }
  inventory.thrown = undefined
  inventory.calls.length = 0
  clearInventoryCache()
})

// --- The guard --------------------------------------------------------------

describe("Requirement 7.6 — no session, no answer", () => {
  test("an unauthenticated request is 401 and reads no row", async () => {
    session.user = undefined

    const { status, body } = await call()

    expect(status).toBe(401)
    expect((body as ApiErrorBody).error.code).toBe("UNAUTHENTICATED")
    expect(store.stateCalls).toEqual([])
    expect(inventory.calls).toEqual([])
  })
})

// --- Step 1: ownership ------------------------------------------------------

describe("Requirements 9.4, 9.8 — ownership first", () => {
  test("the row is read scoped to the signed-in user", async () => {
    await call()

    // The `user_id` predicate lives in the statement, and this is what asserts the
    // route passes the session's id into it rather than trusting the path.
    expect(store.stateCalls).toEqual([{ userId: USER.id, id: ROW_ID }])
  })

  test("another user's row is not found, with no Azure query", async () => {
    store.stateThrows = new SubscriptionNotFoundError()

    const { status, body } = await call()

    expect(status).toBe(404)
    expect((body as ApiErrorBody).error.code).toBe("NOT_FOUND")
    // Requirement 9.4 — no query, and no field of that row disclosed.
    expect(inventory.calls).toEqual([])
    expect(store.credentialsCalls).toEqual([])
  })

  test("an id that exists for no row answers with the same bytes", async () => {
    // Byte-identical, not merely the same status. A caller that could tell the two
    // apart could enumerate which subscriptions exist for other users, and the
    // existence of one is itself a fact about somebody else's customer.
    store.stateThrows = new SubscriptionNotFoundError()
    const somebodyElses = await call(ROW_ID)

    store.stateThrows = new SubscriptionNotFoundError()
    const noSuchRow = await call(ABSENT_ROW_ID)

    expect(somebodyElses.status).toBe(noSuchRow.status)
    expect(somebodyElses.text).toBe(noSuchRow.text)
  })

  test("the cache is not consulted before ownership is decided", async () => {
    // A hit staged for this row, then a not-found on the read. If the cache were
    // consulted first, the listing would be served to somebody who does not own it.
    inventory.listing = { available: true, dimensions: dimensions() }
    await call()
    expect(inventoryCacheEntryCount()).toBe(1)

    store.stateThrows = new SubscriptionNotFoundError()
    const { status, body } = await call()

    expect(status).toBe(404)
    expect(JSON.stringify(body)).not.toContain("Microsoft.Compute")
  })
})

// --- Step 2: status ---------------------------------------------------------

describe("Requirement 9.9 — then status, naming it and nothing else", () => {
  test.each(["pending", "disabled"] as const)(
    "a %s subscription is unavailable naming that status",
    async (status: SubscriptionStatus) => {
      store.state = rowState({ status })

      const { status: httpStatus, body } = await call()

      expect(httpStatus).toBe(422)
      const error = (body as ApiErrorBody).error
      expect(error.code).toBe("SUBSCRIPTION_NOT_ACTIVE")
      expect(error.message).toContain(status)
    }
  )

  test("a non-active status decrypts nothing and invokes nothing", async () => {
    store.state = rowState({ status: "disabled" })

    await call()

    // The reason `readSubscriptionRowState` exists without a credential in it: a
    // `disabled` row is exactly the row whose stored envelope may no longer decrypt,
    // and resolving credentials first would answer "this secret cannot be read" for
    // a request whose correct answer is "this subscription is disabled".
    expect(store.credentialsCalls).toEqual([])
    expect(inventory.calls).toEqual([])
  })

  test("a non-active status returns no dimensions at all", async () => {
    store.state = rowState({ status: "pending" })

    const { body } = await call()

    // The failure this criterion exists to prevent: four empty dimensions read as an
    // empty subscription, and an expired secret is precisely what produces one.
    // Checked structurally rather than by substring, because the prose legitimately
    // uses the word "inventory" to say the listing did not happen.
    expect(Object.keys(body as object)).toEqual(["error"])
    expect(JSON.stringify(body)).not.toContain("resource_types")
    expect(JSON.stringify(body)).not.toContain("truncated")
  })

  test("a non-active status discloses no other field of the row", async () => {
    store.state = rowState({
      status: "disabled",
      displayName: "Northwind production",
    })

    const { text } = await call()

    expect(text).not.toContain("Northwind")
    expect(text).not.toContain(UPDATED_AT)
  })

  test("no cache entry is written for a status refusal", async () => {
    store.state = rowState({ status: "pending" })

    await call()

    expect(inventoryCacheEntryCount()).toBe(0)
  })
})

// --- Step 3: the cache ------------------------------------------------------

describe("Requirement 9.2 — then the cache", () => {
  test("a miss invokes the runtime and the answer is marked uncached", async () => {
    const { status, body } = await call()

    expect(status).toBe(200)
    expect(body).toEqual({ inventory: dimensions(), cached: false })
    expect(inventory.calls).toHaveLength(1)
  })

  test("the credentials and the actor reach the listing request", async () => {
    await call()

    expect(inventory.calls[0]).toEqual({
      actorId: USER.id,
      displayName: "Northwind production",
      credentials: CREDENTIALS,
    })
  })

  test("a second request within the window serves the cache and invokes nothing", async () => {
    await call()
    inventory.calls.length = 0

    const { status, body } = await call()

    expect(status).toBe(200)
    expect(body).toEqual({ inventory: dimensions(), cached: true })
    expect(inventory.calls).toEqual([])
    // A hit never touches the stored envelope either.
    expect(store.credentialsCalls).toHaveLength(1)
  })

  test("a written row lists again rather than serving the previous answer", async () => {
    await call()
    inventory.calls.length = 0

    // The rotation. The listing is seconds old and must not be served, because the
    // credential that produced it is not the one on the row any more.
    store.state = rowState({ updatedAt: LATER_UPDATED_AT })

    const { body } = await call()

    expect(body).toEqual({ inventory: dimensions(), cached: false })
    expect(inventory.calls).toHaveLength(1)
  })

  test("the cache is keyed per row, so one subscription's answer is not another's", async () => {
    await call(ROW_ID)
    inventory.calls.length = 0
    inventory.listing = {
      available: true,
      dimensions: {
        ...dimensions(),
        resource_types: { values: ["Microsoft.Sql/servers"], truncated: false },
      },
    }

    const { body } = await call(ABSENT_ROW_ID)

    expect(inventory.calls).toHaveLength(1)
    expect(JSON.stringify(body)).toContain("Microsoft.Sql/servers")
  })
})

// --- Step 4: the bound ------------------------------------------------------

describe("Requirement 9.8 — an unavailable listing", () => {
  test.each(["unreachable", "rejected", "no_response"] as const)(
    "a %s listing is 422 naming that reason",
    async (reason) => {
      inventory.listing = {
        available: false,
        reason,
        message: "The reporting runtime did not list this inventory.",
      }

      const { status, body } = await call()

      expect(status).toBe(422)
      const error = (body as ApiErrorBody).error
      // The reason travels as a field: the three are not interchangeable, and the
      // picker's statement of why differs for each.
      expect(error.fields).toEqual([{ path: "reason", message: reason }])
      expect(error.code).toBe("INVENTORY_UNAVAILABLE")
    }
  )

  test("the runtime's own code travels where it named one", async () => {
    inventory.listing = {
      available: false,
      reason: "rejected",
      message: "The service principal was refused.",
      code: "AUTH_FAILED",
    }

    const { body } = await call()

    // An expired credential has a remedy and a rate limit has a wait, so the code
    // has to survive rather than flatten into one undifferentiated failure.
    expect((body as ApiErrorBody).error.code).toBe("AUTH_FAILED")
  })

  test("no cache entry is written and no retry is issued", async () => {
    inventory.listing = {
      available: false,
      reason: "no_response",
      message: "no answer",
    }

    await call()

    expect(inventoryCacheEntryCount()).toBe(0)
    // Exactly one attempt. Three pickers on one screen retrying a throttled
    // subscription would turn one rate limit into a queue of them.
    expect(inventory.calls).toHaveLength(1)
  })

  test("a subsequent request after a failure lists again rather than serving nothing", async () => {
    inventory.listing = {
      available: false,
      reason: "unreachable",
      message: "no route",
    }
    await call()

    inventory.listing = { available: true, dimensions: dimensions() }
    const { status, body } = await call()

    expect(status).toBe(200)
    expect(body).toEqual({ inventory: dimensions(), cached: false })
  })
})

// --- The boundary -----------------------------------------------------------

describe("Requirement 9.3 — the boundary is parsed with named schemas", () => {
  test("an unrecognized search parameter is refused", async () => {
    const { status, body } = await call(ROW_ID, "?dimension=tag_keys")

    expect(status).toBe(400)
    expect((body as ApiErrorBody).error.code).toBe("INVALID_INPUT")
    // Refused rather than ignored: every accepted parameter would be part of the
    // answer and therefore part of the cache key, and the key is the row id alone.
    expect(store.stateCalls).toEqual([])
    expect(inventory.calls).toEqual([])
  })

  test("no search parameters at all is the accepted case", async () => {
    const { status } = await call(ROW_ID, "")

    expect(status).toBe(200)
  })

  test("a whitespace-only path parameter is refused before any read", async () => {
    const response = await GET(getRequest("%20"), {
      params: Promise.resolve({ id: "   " }),
    })

    expect(response.status).toBe(400)
    expect(store.stateCalls).toEqual([])
  })

  test("the path parameter is trimmed rather than looked up as written", async () => {
    await GET(getRequest(ROW_ID), {
      params: Promise.resolve({ id: ` ${ROW_ID} ` }),
    })

    expect(store.stateCalls).toEqual([{ userId: USER.id, id: ROW_ID }])
  })
})

// --- Failures that are ours -------------------------------------------------

describe("the failures that are not the subscription's fault", () => {
  test("an unconfigured runtime is 503 and names no variable", async () => {
    inventory.thrown = new MissingRuntimeConfigError("RPT_RUNTIME_ARN")

    const { status, body } = await call()

    expect(status).toBe(503)
    const error = (body as ApiErrorBody).error
    expect(error.code).toBe("RUNTIME_UNCONFIGURED")
    // The variable's name is a fact about our deployment, and the consultant reading
    // this can act on neither it nor its absence.
    expect(JSON.stringify(body)).not.toContain("RPT_RUNTIME_ARN")
    expect(inventoryCacheEntryCount()).toBe(0)
  })

  test("an active row whose secret no longer decrypts is unavailable, not a 500", async () => {
    store.credentialsThrows = new SubscriptionSecretUnreadableError()

    const { status, body } = await call()

    expect(status).toBe(422)
    expect((body as ApiErrorBody).error.code).toBe("SECRET_UNREADABLE")
    expect(inventory.calls).toEqual([])
  })

  test("an unexpected failure is a 500 that carries nothing from the thrown value", async () => {
    store.stateThrows = new Error(`connection failed for ${PLAINTEXT_SECRET}`)

    const { status, body } = await call()

    expect(status).toBe(500)
    expect((body as ApiErrorBody).error.code).toBe("INTERNAL_ERROR")
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT_SECRET)
  })
})

// --- What crosses to the browser --------------------------------------------

describe("Requirement 9.5 — the response carries no identifier", () => {
  test("a successful answer names no subscription, tenant, client or secret", async () => {
    const { text } = await call()

    for (const identifier of [
      CREDENTIALS.subscriptionId,
      CREDENTIALS.tenantId,
      CREDENTIALS.clientId,
      PLAINTEXT_SECRET,
    ]) {
      expect(text).not.toContain(identifier)
    }
    // And no fully qualified resource id, which is what `/subscriptions/` would open.
    expect(text).not.toContain("/subscriptions/")
  })

  test("every response is uncacheable by an intermediary", async () => {
    const response = await GET(getRequest(), routeContext())

    // The body is one customer's inventory. An intermediary holding it would serve
    // it to the next requester.
    expect(response.headers.get("Cache-Control")).toBe("no-store")
  })
})
