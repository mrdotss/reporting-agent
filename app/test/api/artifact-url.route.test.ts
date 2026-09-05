import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { ReportRun } from "@/lib/db/schema"

/**
 * `GET /api/artifact-url` (Requirements 37.8, 37.12).
 *
 * ## Two independent checks, both before any AWS call
 *
 * Requirement 37.8 requires the key's `actor_id` prefix to equal the signed-in user's id
 * **and** the named run to be that user's. Neither implies the other, and this file asserts
 * each one separately with the other satisfied:
 *
 *   * a key carrying somebody else's actor prefix, for a run that *is* mine;
 *   * a key carrying my own prefix, for a run that is **not** mine.
 *
 * Both must resolve as not found with **no URL minted** — asserted through a presigner fake
 * that counts its calls, so "no URL was minted" is a fact about the code rather than about
 * the absence of a string in a response body.
 *
 * The `alice-evil/…` near-miss is the specific bug Requirement 37.12 exists to rule out: a
 * `startsWith` implementation authorizes it for `alice`. `keyBelongsToActor` is the **real**
 * function here, and its own exhaustive suite is in `lib/aws/s3.test.ts` — this file asserts
 * that the route actually consults it, and that it does so before reaching S3.
 */

const { guard, runs, s3 } = vi.hoisted(() => ({
  guard: { user: undefined as { id: string; email: string } | undefined },
  runs: { row: undefined as ReportRun | undefined, reads: [] as string[] },
  s3: { presigns: 0, keys: [] as string[] },
}))

vi.mock("@/lib/auth/guard", () => ({
  requireSessionForApi: async () => guard.user ?? null,
}))

vi.mock("@/lib/runs/state", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/runs/state")>()

  return {
    ...original,
    findOwnedRun: async (_userId: string, runId: string) => {
      runs.reads.push(runId)
      return runs.row
    },
  }
})

/**
 * `presignArtifact` is faked and **counted**; `parseArtifactKey` and `keyBelongsToActor`
 * are the real implementations, pulled through `importOriginal`.
 *
 * That split is the whole design of this file: the authorization primitive under test must
 * be genuine, and the only thing worth replacing is the AWS call — which is also the thing
 * whose absence is the assertion.
 */
vi.mock("@/lib/aws/s3", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/aws/s3")>()

  return {
    ...original,
    presignArtifact: async (_actorId: string, key: string) => {
      s3.presigns += 1
      s3.keys.push(key)
      return { url: `https://s3.test/${key}?signed`, expiresIn: 300 }
    },
  }
})

/**
 * The verification gate (Requirement 40.2), faked and **switchable**.
 *
 * Requirement 40.2 makes a passing verification one of the four assertions the
 * route performs before any storage call, so every case in this file now runs
 * against a stated verification status rather than against an implicit one. The
 * default is `pass`, so the pre-existing cases still assert what they were
 * written to assert; the cases below that set it to something else are the new
 * ones.
 */
vi.mock("@/lib/verifications/store", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/verifications/store")>()

  return {
    ...original,
    readLatestVerificationStatus: async (runId: string) => {
      verifications.reads.push(runId)
      return verifications.status
    },
  }
})

const verifications: {
  status: "pass" | "fail" | null
  reads: string[]
} = { status: "pass", reads: [] }

const { GET } = await import("@/app/api/artifact-url/route")

// --- Fixtures ---------------------------------------------------------------

const USER = { id: "alice", email: "alice@example.com" }
const RUN_ID = "run-1"

/** The key layout `lib/db/views.ts#snapshotArtifactKey` writes. */
const OWN_KEY = `${USER.id}/snapshots/${RUN_ID}/snapshot.json`

function row(over: Partial<ReportRun> = {}): ReportRun {
  return {
    id: RUN_ID,
    userId: USER.id,
    connectedSubscriptionId: "sub-1",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    timezone: "Asia/Jakarta",
    scope: {
      resource_types: ["Microsoft.Compute/virtualMachines"],
      resource_groups: [],
      tag_filters: {},
    },
    status: "completed",
    dedupeKey: "dedupe-1",
    claimedAt: null,
    claimedBy: null,
    updatedAt: new Date("2026-08-15T10:00:00Z"),
    phaseDeadline: null,
    errorCode: null,
    errorMessage: null,
    progressTokenHash: "hash",
    progressCurrent: null,
    progressTotal: null,
    progressLabel: null,
    snapshotId: "a".repeat(64),
    resourceCount: 200,
    gapCount: 0,
    templateVersionId: null,
    createdAt: new Date("2026-08-15T09:50:00Z"),
    customerName: null,
    revisionHistoryRow: null,
    reuseSnapshotRunId: null,
    ...over,
  }
}

/** A report artifact key for the fixture run. */
function reportKey(leaf: string): string {
  return `${USER.id}/reports/${RUN_ID}/${leaf}`
}

function request(key: string): Request {
  return new Request(
    `https://app.test/api/artifact-url?key=${encodeURIComponent(key)}`
  )
}

beforeEach(() => {
  guard.user = USER
  runs.row = row()
  runs.reads = []
  s3.presigns = 0
  s3.keys = []
  // Requirement 40.2 — every case runs against a stated verification status.
  // `pass` by default, so a case that does not set it is asserting something
  // other than the gate.
  verifications.status = "pass"
  verifications.reads = []

  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------

describe("Requirement 37.8 — the happy path", () => {
  test("a key that is this user's, for a completed run of theirs, is presigned", async () => {
    const response = await GET(request(OWN_KEY))

    expect(response.status).toBe(200)

    const body = (await response.json()) as { url: string; expiresIn: number }

    expect(body.url).toContain(OWN_KEY)
    // At most 300 seconds: long enough for a browser to follow a download and short
    // enough that a URL copied out of a history entry is useless by the time anybody
    // reads it.
    expect(body.expiresIn).toBeLessThanOrEqual(300)
    expect(s3.presigns).toBe(1)
  })

  test("the response is never cached", async () => {
    // The single response body in the app that carries a credential. `no-store` rather
    // than `no-cache`: `no-cache` permits *storing* and revalidating, which for a
    // presigned URL is storage we do not want to have happened.
    const response = await GET(request(OWN_KEY))

    expect(response.headers.get("cache-control")).toBe("no-store")
    // And the answer depends on the session, so an intermediary that ignored `no-store`
    // must at least not serve one user's URL to another.
    expect(response.headers.get("vary")).toBe("Cookie")
  })
})

describe("Requirement 37.12 — a foreign key prefix mints nothing", () => {
  test("`alice-evil/…` is refused for `alice`", async () => {
    // The specific bug this requirement exists to rule out: `"alice-evil/…".startsWith("alice")`
    // is true, so a prefix check authorizes it. An exact segment match does not.
    const response = await GET(
      request(`alice-evil/snapshots/${RUN_ID}/snapshot.json`)
    )

    expect(response.status).toBe(404)
    expect(s3.presigns).toBe(0)
    // Not even a database read: the pure check runs first, so a probe for another user's
    // key costs nothing.
    expect(runs.reads).toEqual([])
  })

  test("`other/alice/…` is refused for `alice`", async () => {
    const response = await GET(
      request(`other/alice/snapshots/${RUN_ID}/snapshot.json`)
    )

    expect(response.status).toBe(404)
    expect(s3.presigns).toBe(0)
  })

  test.each([
    ["a prefix rather than an object", `${USER.id}/snapshots/${RUN_ID}`],
    ["a different second segment", `${USER.id}/ledgers/${RUN_ID}/x.json`],
    ["an empty segment", `${USER.id}//${RUN_ID}/snapshot.json`],
    ["a leading slash", `/${USER.id}/snapshots/${RUN_ID}/snapshot.json`],
    ["a differently-cased segment", `${USER.id}/Snapshots/${RUN_ID}/x.json`],
  ] as const)("%s is refused", async (_label, key) => {
    const response = await GET(request(key))

    expect(response.status).toBe(404)
    expect(s3.presigns).toBe(0)
  })
})

describe("Requirement 37.8 — the run must be this user's too", () => {
  test("a well-formed key of mine for a run that is not mine mints nothing", async () => {
    // The check the key prefix cannot make: a key can carry a correct actor prefix for a
    // run that was never this user's — a run id guessed, or one from a deleted
    // connection. The read is scoped by `user_id`, so it matches no row.
    runs.row = undefined

    const response = await GET(request(OWN_KEY))

    expect(response.status).toBe(404)
    expect(s3.presigns).toBe(0)
    // The database *was* consulted — the key passed check 1 — which is what makes this a
    // test of check 2 rather than a repeat of the one above.
    expect(runs.reads).toEqual([RUN_ID])
  })

  test("a run that produced no artifact mints nothing", async () => {
    // Minting a URL for an object that does not exist would hand the browser a link to a
    // 404 it cannot explain.
    for (const status of [
      "queued",
      "claimed",
      "collecting",
      "failed",
    ] as const) {
      s3.presigns = 0
      runs.row = row({
        status,
        errorCode: status === "failed" ? "EMPTY_SCOPE" : null,
        snapshotId: status === "failed" ? null : "a".repeat(64),
      })

      const response = await GET(request(OWN_KEY))

      expect(response.status).toBe(404)
      expect(s3.presigns).toBe(0)
    }
  })
})

describe("Requirement 7.7 — the query is parsed at the boundary", () => {
  test("no session mints nothing", async () => {
    guard.user = undefined

    const response = await GET(request(OWN_KEY))

    expect(response.status).toBe(401)
    expect(s3.presigns).toBe(0)
  })

  test("an absent key is a rejection", async () => {
    const response = await GET(new Request("https://app.test/api/artifact-url"))

    expect(response.status).toBe(400)
    expect(s3.presigns).toBe(0)
  })

  test("an unrecognized parameter is a rejection", async () => {
    // `.strict()`. A caller passing `?expiresIn=3600` is expressing an expectation this
    // route does not honour — the 300-second cap is the one number it exists to decide —
    // and answering with a 300-second URL would look like the request had been honoured.
    const response = await GET(
      new Request(
        `https://app.test/api/artifact-url?key=${encodeURIComponent(OWN_KEY)}&expiresIn=3600`
      )
    )

    expect(response.status).toBe(400)
    expect(s3.presigns).toBe(0)
  })

  test("an over-long key is a rejection", async () => {
    const response = await GET(
      request(`${USER.id}/snapshots/${RUN_ID}/${"x".repeat(600)}.json`)
    )

    expect(response.status).toBe(400)
    expect(s3.presigns).toBe(0)
  })
})

// --- Requirement 40.2, 40.5 — the two checks task 13.8 added ----------------

describe("Requirement 40.2 — a download needs a passing verification", () => {
  test("a run whose verification failed mints nothing", async () => {
    // The gate the whole product turns on. `completed` says the pipeline
    // finished; only the verification says the document was *proven*, and a
    // download depends on the second.
    verifications.status = "fail"

    const response = await GET(request(reportKey("report.pdf")))

    expect(response.status).toBe(404)
    expect(s3.presigns).toBe(0)
  })

  test("a run with no verification at all mints nothing", async () => {
    verifications.status = null

    const response = await GET(request(reportKey("report.pdf")))

    expect(response.status).toBe(404)
    expect(s3.presigns).toBe(0)
  })

  test("the refusal is byte-identical to every other not-found", async () => {
    // Requirement 40.6 — "disclose no indication of whether the named artifact
    // exists". A distinguishable body would let a caller tell "unverified" from
    // "not yours", and the first is a fact about a real report of theirs.
    verifications.status = "fail"
    const unverified = await GET(request(reportKey("report.pdf")))

    verifications.status = "pass"
    const foreign = await GET(request("mallory/reports/run-1/report.pdf"))

    expect(await unverified.text()).toBe(await foreign.text())
    expect(unverified.status).toBe(foreign.status)
  })
})

describe("Requirement 40.5 — only a key the run recorded", () => {
  test("a well-formed key the run never wrote mints nothing", async () => {
    // Right prefix, right run, right shape — and a leaf the pipeline does not
    // write. Without this check the route is a bucket probe for anybody holding
    // one valid run, answering "does this object exist" through latency.
    verifications.status = "pass"

    const response = await GET(request(reportKey("invented.json")))

    expect(response.status).toBe(404)
    expect(s3.presigns).toBe(0)
  })

  test("the two recorded report artifacts are served", async () => {
    verifications.status = "pass"

    for (const leaf of ["report.docx", "report.pdf"]) {
      s3.presigns = 0
      const response = await GET(request(reportKey(leaf)))

      expect(response.status, leaf).toBe(200)
      expect(s3.presigns, leaf).toBe(1)
    }
  })

  test("the verification is read only after the cheap checks", async () => {
    // Ordering, asserted: a foreign key must cost neither a database read of the
    // verification nor a storage call. Checking the expensive thing first would
    // make a probe measurable.
    verifications.status = "pass"
    verifications.reads.length = 0

    await GET(request("mallory/reports/run-1/report.pdf"))

    expect(verifications.reads).toEqual([])
    expect(s3.presigns).toBe(0)
  })
})
