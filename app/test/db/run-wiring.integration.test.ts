import { randomUUID } from "node:crypto"

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"

import type { AgentInvokeContext, InvokeCommand } from "@/lib/aws/agentcore"
import { STARTER_TEMPLATES } from "@/lib/templates/starters"
import { definitionSha256 } from "@/lib/templates/version"
import { withScratchSchema } from "@/test/db/scratch-schema"

/**
 * Task 14.3, the app half — **one run, end to end, over one real row**
 * (Requirements 36.12, 38.1, 38.12, 38.13, 39.4, 39.6, 40.4, 40.5, 15.6, 15.7).
 *
 * Every piece of this sequence already has a suite. What none of them has is the
 * **seam**: each one mocks its neighbours, so `enqueueRun` has never inserted a row
 * that `claimQueuedRuns` then claimed, the progress route has never written a column
 * the relay then read, and no test has ever watched a `progress_current` land on a
 * row and come back out as a determinate `progress` event. This file is that walk:
 *
 *   `enqueueRun` → `POST /api/cron/tick` (sweep, claim, gate, token, invoke)
 *   → `POST /api/internal/runs/[runId]/progress` × 3 → `report_runs` → the relay
 *
 * with the **production** functions throughout. The only doubles are the three
 * genuine outside edges: AgentCore, S3 and the session cookie.
 *
 * ## The agent's half of this walk is `agent/tests/test_run_wiring.py`
 *
 * A run's other half runs in Python, in a container, so no single process can drive
 * both. The split is by language, not by convenience, and the two files meet at a
 * documented contract:
 *
 *   * this file asserts the twelve-field invoke `context` the runtime is handed, and
 *     that a callback carrying `phase` / `current` / `total` / `label` and then
 *     `phase` / `snapshot_id` / `resource_count` / `gap_count` is accepted and
 *     persisted;
 *   * `test_run_wiring.py` asserts the runtime **produces exactly those bodies**,
 *     from a real collection over faked Azure ports, and emits `snapshot_ready`
 *     before `done` with nothing after it.
 *
 * The callback bodies below are therefore not invented for this test. They are the
 * shapes `agent/src/reporting_agent/progress.py` sends, and if the two ever diverge
 * the Python file fails on the body and this one fails on the schema.
 *
 * ## Binding the production pool to the scratch schema
 *
 * `lib/db/index.ts` opens its own pool from `DATABASE_URL`, which is why
 * `runs-orchestration.integration.test.ts` copies the reaper's SQL instead of calling
 * it. Here the production functions are the point, so the variable is repointed at
 * the harness's schema for the lifetime of this file:
 *
 *   `DATABASE_URL = <TEST_DATABASE_URL>?options=-c search_path=<schema>`
 *
 * `options` reaches the Postgres **startup packet** — `pg-connection-string` copies
 * unknown query parameters onto the config and `pg` sends `options` verbatim — so the
 * session resolves against the scratch schema before it will run a statement. There is
 * no window in which a connection points at `public`, which a `SET search_path` issued
 * after checkout would leave open.
 *
 * `closeDb()` runs in this file's `afterAll`, which Vitest runs **before** the
 * harness's own — registered later, run earlier — so the pool is gone before the
 * schema is dropped. Without that ordering the drop blocks on a live connection and
 * reads as a hang.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

// --- The three outside edges ------------------------------------------------

const { agentcore, s3, guard } = vi.hoisted(() => ({
  agentcore: {
    /** Every invocation, in order, exactly as `lib/runs/invoke.ts` built it. */
    calls: [] as {
      sessionId: string
      context: AgentInvokeContext
      command: InvokeCommand
    }[],
    /** Set to make the next invocation fail, for the not-started case. */
    fail: false,
  },
  s3: {
    /** The snapshot document the agent wrote, by key — the in-memory object store. */
    objects: new Map<string, unknown>(),
    reads: [] as string[],
  },
  guard: { user: undefined as { id: string; email: string } | undefined },
}))

/**
 * AgentCore, captured rather than called.
 *
 * Everything **before** the SDK call is real: the expiry and scope gate, the
 * `client_secret` decryption, the `progress_token` derivation and the construction of
 * the twelve-field context. That is deliberate — the context is what this test
 * asserts against and what it scans for leaked secrets, so it has to be the one the
 * production path builds, not one a fake assembled.
 *
 * The returned stream yields two chunks and ends, so `invoke.ts`'s detached drain has
 * something to consume and release (Requirement 39.6).
 */
vi.mock("@/lib/aws/agentcore", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/aws/agentcore")>()

  return {
    ...original,
    invokeAgentRuntime: async (input: {
      sessionId: string
      context: AgentInvokeContext
      command: InvokeCommand
    }) => {
      agentcore.calls.push(input)

      if (agentcore.fail) throw new Error("the runtime refused the invocation")

      return {
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode('data: {"type":"tool"}\n\n')
          yield new TextEncoder().encode('data: {"type":"heartbeat"}\n\n')
        },
      }
    },
    // Left real in spirit — the ARN is read from `process.env` at call time — but
    // stubbed to a fixed value so this file does not need the variable set.
    resolveRuntimeArn: () => original.resolveRuntimeArn(),
  }
})

/** S3, as the in-memory object store the agent wrote its snapshot into. */
vi.mock("@/lib/aws/s3", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/aws/s3")>()

  return {
    ...original,
    getSnapshotJson: async (key: string) => {
      s3.reads.push(key)
      const found = s3.objects.get(key)
      if (found === undefined) throw new Error(`no object at ${key}`)
      return found
    },
  }
})

/** The signed-in session the relay authorizes against. */
vi.mock("@/lib/auth/guard", () => ({
  requireSessionForApi: async () => guard.user ?? null,
  requireSession: async () => {
    if (guard.user === undefined) throw new Error("no session")
    return guard.user
  },
}))

// --- Imported after the mocks ----------------------------------------------

const { closeDb } = await import("@/lib/db")
const { encryptSecret } = await import("@/lib/crypto")
const { enqueueRun } = await import("@/lib/actions/runs")
const { snapshotArtifactKey, toRunView } = await import("@/lib/db/views")
const { EMPTY_CURSOR, deriveRelayEvents } = await import("@/lib/runs/relay")
const { findOwnedRun } = await import("@/lib/runs/state")
const { deriveProgressToken, progressTokenHash, PROGRESS_TOKEN_HEADER } =
  await import("@/lib/runs/progress-token")
const { deriveDedupeKey } = await import("@/lib/runs/dedupe")
const { loadRunGaps } = await import("@/lib/runs/gaps")
const { PHASE_PROGRESS_UNIT } = await import("@/lib/events")

const { POST: tick } = await import("@/app/api/cron/tick/route")
const { POST: progressCallback } =
  await import("@/app/api/internal/runs/[runId]/progress/route")
const { GET: stream } = await import("@/app/api/runs/[runId]/stream/route")

// --- Fixtures ---------------------------------------------------------------

/**
 * The four values that must not appear in an event, a log line or the run row
 * (Requirements 15.6, 15.7). Distinctive enough that a match could not be a
 * coincidence, and obviously not credentials.
 */
const AZURE = {
  subscriptionId: "3f2b0000-0000-0000-0000-000000000000",
  tenantId: "tenant-0d4f1a2b-not-a-real-tenant-id",
  clientId: "client-9e8d7c6b-not-a-real-client-id",
  clientSecret: "not-a-real-client-secret-Zq7Z~x0LmN4pR8sT2vW6yA9cE3gH5jK",
} as const

const CRON_SECRET = "0123456789abcdef0123456789abcdef"
const APP_BASE_URL = "https://app.test"
const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64")

/**
 * A period entirely in the past, so the resolver accepts it against real `now`.
 *
 * Carried by the fixture template as a `custom` specification rather than
 * submitted: the enqueue resolves the **pinned version's** period (Requirement
 * 4.3), so this constant is what the definition declares and what the row should
 * therefore end up holding. Fixed dates rather than `last_full_month` because
 * this suite asserts the exact window the invoke payload carries, and a relative
 * rule would move it every month.
 */
const PERIOD = { start: "2026-07-01", end: "2026-07-31" } as const

const SCOPE = {
  resource_types: ["Microsoft.Compute/virtualMachines"],
  resource_groups: [],
  tag_filters: {},
} as const

/**
 * The pinned definition: a real starter, with the fixed window above as a
 * `custom` period.
 *
 * A starter rather than a hand-built object, so this fixture cannot drift into a
 * definition the validator would refuse — `catalog.test.ts` asserts every starter
 * validates, and this inherits that. Only the period is replaced, because a
 * relative rule would move the asserted window every month.
 */
const FIXTURE_DEFINITION = {
  ...STARTER_TEMPLATES[0]!.definition,
  period: { kind: "custom", start: PERIOD.start, end: PERIOD.end },
} as const

const SNAPSHOT_ID = "a3f9".repeat(16)
const RESOURCE_COUNT = 200
const GAP_COUNT = 1

/** One `collection_log` entry, in the shape `collect/log.py` writes. */
const SNAPSHOT_GAP = {
  gap_type: "deallocated",
  resource_id:
    "/subscriptions/3f2b0000-0000-0000-0000-000000000000/resourceGroups/" +
    "rg-prod-sea/providers/Microsoft.Compute/virtualMachines/prod-batch-02",
  metric: null,
  message: "PowerState/deallocated",
} as const

let userId: string
let subscriptionId: string
let templateId: string
/** Every `console.warn` / `console.error` line this walk produced. */
let logLines: string[]

const savedEnv: Record<string, string | undefined> = {}

function setEnv(name: string, value: string): void {
  savedEnv[name] = process.env[name]
  process.env[name] = value
}

beforeAll(async () => {
  if (!db.enabled) return

  // A pool cached on `globalThis` by an earlier file in this worker would otherwise
  // outlive its `DATABASE_URL`.
  await closeDb()

  const base = process.env.TEST_DATABASE_URL as string
  const separator = base.includes("?") ? "&" : "?"

  setEnv(
    "DATABASE_URL",
    `${base}${separator}options=${encodeURIComponent(`-c search_path=${db.schemaName}`)}`
  )
  setEnv("APP_ENCRYPTION_KEY", ENCRYPTION_KEY)
  setEnv("RPT_APP_BASE_URL", APP_BASE_URL)
  setEnv("RPT_CRON_SECRET", CRON_SECRET)
  setEnv("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
  setEnv("AWS_REGION", "us-east-1")
  setEnv(
    "RPT_RUNTIME_ARN",
    "arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/rpt-test"
  )
})

afterAll(async () => {
  if (!db.enabled) return

  // Before the harness drops the schema — this hook was registered later, so Vitest
  // runs it first.
  await closeDb()

  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

beforeEach(async () => {
  agentcore.calls = []
  agentcore.fail = false
  s3.objects = new Map()
  s3.reads = []
  logLines = []

  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "))
  })
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "))
  })

  // Whole-table reads below, so no residue from a sibling test. `CASCADE` reaches
  // `connected_subscriptions` and `report_runs` through their foreign keys.
  await db.query(`TRUNCATE users CASCADE`)

  userId = `user-${randomUUID()}`
  subscriptionId = `sub-${randomUUID()}`
  templateId = `tpl-${randomUUID()}`
  guard.user = { id: userId, email: "ada@example.com" }

  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $3, '$argon2id$fixture')`,
    [userId, `${userId}@Example.com`, `${userId}@example.com`]
  )

  // A **real** envelope, so `resolveSubscriptionCredentials` really decrypts and the
  // plaintext this test scans for is the plaintext the production path handled.
  await db.query(
    `INSERT INTO connected_subscriptions
       (id, user_id, display_name, subscription_id, tenant_id, client_id,
        client_secret_enc, scope_verified, fidelity_tier, secret_expires_at,
        log_analytics_workspace_id, status)
     VALUES ($1, $2, 'Contoso production', $3, $4, $5, $6, true, 'baseline',
             now() + interval '90 days', NULL, 'active')`,
    [
      subscriptionId,
      userId,
      AZURE.subscriptionId,
      AZURE.tenantId,
      AZURE.clientId,
      encryptSecret(AZURE.clientSecret),
    ]
  )

  // The pinned template version this run resolves its period and its scope from
  // (Requirements 3.3, 4.3, 9.6). A real starter definition with its period
  // replaced by the fixed `custom` window above, so the definition is one the
  // validator accepts and the resolved window is the one this suite asserts.
  await db.query(
    `INSERT INTO report_templates (id, user_id, name, description)
     VALUES ($1, $2, 'Wiring fixture', '')`,
    [templateId, userId]
  )

  await db.query(
    `INSERT INTO report_template_versions
       (id, template_id, version, definition, definition_sha256)
     VALUES ($1, $2, 1, $3, $4)`,
    [
      `ver-${randomUUID()}`,
      templateId,
      JSON.stringify(FIXTURE_DEFINITION),
      definitionSha256(FIXTURE_DEFINITION),
    ]
  )

  await db.query(
    `UPDATE report_templates SET current_version_id =
       (SELECT id FROM report_template_versions WHERE template_id = $1)
     WHERE id = $1`,
    [templateId]
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

// --- Driving the walk -------------------------------------------------------

async function enqueue(): Promise<string> {
  const { run } = await enqueueRun(userId, {
    connectedSubscriptionId: subscriptionId,
    templateId,
    timezone: "Asia/Jakarta",
  })

  return run.id
}

type TickBody = {
  swept: number
  claimed: number
  invoked: number
  failed: number
  skipped: number
  notStarted: number
}

async function runTick(): Promise<TickBody> {
  const response = await tick(
    new Request(`${APP_BASE_URL}/api/cron/tick`, {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    })
  )

  expect(response.status, await response.clone().text()).toBe(200)

  return (await response.json()) as TickBody
}

/** One progress callback, presented exactly as `progress.py` presents it. */
async function postCallback(
  runId: string,
  body: Record<string, unknown>,
  token: string = deriveProgressToken(runId)
): Promise<Response> {
  return progressCallback(
    new Request(`${APP_BASE_URL}/api/internal/runs/${runId}/progress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [PROGRESS_TOKEN_HEADER]: token,
      },
      body: JSON.stringify({ run_id: runId, ...body }),
    }),
    { params: Promise.resolve({ runId }) }
  )
}

type Row = Record<string, unknown>

async function readRow(runId: string): Promise<Row> {
  const result = await db.query<Row>(
    `SELECT * FROM report_runs WHERE id = $1`,
    [runId]
  )

  expect(result.rows).toHaveLength(1)
  return result.rows[0]
}

/**
 * Every `data:` payload the relay route emitted, reading until it has `expected`
 * events or the budget runs out, then cancelling.
 *
 * Real timers, deliberately: the poll loop awaits real Postgres reads, and faking
 * timers here would also fake the driver's own — a 130-second advance fires
 * `idleTimeoutMillis` on live pooled connections. Cancelling is what lets a case
 * about an **open** stream finish at all, and it models a client navigating away, so
 * the route's abort handling is exercised rather than bypassed.
 */
async function readRelayEvents(
  response: Response,
  expected: number,
  budgetMs = 4_000
): Promise<Record<string, unknown>[]> {
  const body = response.body
  if (body === null) return []

  const reader = body.getReader()
  const decoder = new TextDecoder()
  const events: Record<string, unknown>[] = []
  let buffer = ""
  const deadline = Date.now() + budgetMs

  try {
    while (events.length < expected && Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""

      for (const frame of frames) {
        const line = frame
          .split("\n")
          .find((candidate) => candidate.startsWith("data:"))
        if (line === undefined) continue
        events.push(
          JSON.parse(line.slice("data:".length).trim()) as Record<
            string,
            unknown
          >
        )
      }
    }
  } finally {
    await reader.cancel()
  }

  return events
}

function relayRequest(runId: string): Request {
  return new Request(`${APP_BASE_URL}/api/runs/${runId}/stream`)
}

/** The snapshot object the agent would have written for this run. */
function writeSnapshotObject(runId: string): void {
  s3.objects.set(snapshotArtifactKey(userId, runId), {
    snapshot_id: SNAPSHOT_ID,
    content_hash: SNAPSHOT_ID,
    grain: "PT1H",
    timezone: "Asia/Jakarta",
    utc_offset: "+07:00",
    window: {
      start: PERIOD.start,
      end: PERIOD.end,
      start_utc: "2026-06-30T17:00:00Z",
      end_utc: "2026-07-31T17:00:00Z",
    },
    gaps: [SNAPSHOT_GAP],
    resources: [],
  })
}

/**
 * Walk the whole sequence and return everything it produced.
 *
 * One helper rather than a `beforeEach`, because the assertions below are about
 * *points* in the walk as much as its end: the tests that examine the `claimed` row
 * or the mid-collection row drive it themselves.
 */
async function walkToCompletion(runId: string): Promise<{
  readonly events: Record<string, unknown>[]
  readonly finalRow: Row
}> {
  await runTick()

  // Entry into `collecting`, with the total known and nothing counted yet.
  await postCallback(runId, {
    phase: "collecting",
    current: 0,
    total: RESOURCE_COUNT,
    label: "Metrics",
  })

  // Mid-collection, the callback the determinate bar is fed from.
  await postCallback(runId, {
    phase: "collecting",
    current: 142,
    total: RESOURCE_COUNT,
    label: "Metrics",
  })

  writeSnapshotObject(runId)

  await postCallback(runId, {
    phase: "completed",
    snapshot_id: SNAPSHOT_ID,
    resource_count: RESOURCE_COUNT,
    gap_count: GAP_COUNT,
  })

  const events = await readRelayEvents(
    await stream(relayRequest(runId), {
      params: Promise.resolve({ runId }),
    }),
    2
  )

  return { events, finalRow: await readRow(runId) }
}

// ---------------------------------------------------------------------------

describe("Requirement 37.1 — the enqueue inserts one queued row and returns", () => {
  test("the row carries the derived dedupe key, the token hash and a deadline", async () => {
    const before = Date.now()
    const runId = await enqueue()
    const elapsed = Date.now() - before

    // Requirement 37.4 — it awaits nothing but its own validation and write.
    expect(elapsed).toBeLessThan(2_000)

    const row = await readRow(runId)

    expect(row.status).toBe("queued")
    expect(row.user_id).toBe(userId)
    expect(row.connected_subscription_id).toBe(subscriptionId)
    expect(row.claimed_by).toBeNull()
    expect(row.phase_deadline).not.toBeNull()

    // Requirement 37.3 — only the hash is stored, and it is the hash of the token the
    // *invoking* request will re-derive.
    expect(row.progress_token_hash).toBe(
      progressTokenHash(deriveProgressToken(runId))
    )

    // The key is the pure derivation, not a random value.
    expect(row.dedupe_key).toBe(
      deriveDedupeKey({
        userId,
        connectedSubscriptionId: subscriptionId,
        periodStart: PERIOD.start,
        periodEnd: PERIOD.end,
        timezone: "Asia/Jakarta",
        resourceTypes: [...SCOPE.resource_types],
        resourceGroups: [],
        enqueuedAtMs: (row.created_at as Date).getTime(),
      })
    )

    // Nothing was invoked. The enqueue is not the invoker.
    expect(agentcore.calls).toEqual([])
  })

  test("no in-flight progress is recorded yet", async () => {
    const row = await readRow(await enqueue())

    expect(row.progress_current).toBeNull()
    expect(row.progress_total).toBeNull()
    expect(row.progress_label).toBeNull()
  })
})

describe("Requirements 39.4, 39.6, 41.5 — the tick claims, gates and invokes", () => {
  test("one queued row is swept past, claimed, and invoked once", async () => {
    const runId = await enqueue()

    const body = await runTick()

    // The sweep runs first and finds nothing due — the row's deadline is 900 seconds
    // out — so the claim sees it (Requirement 39.11).
    expect(body).toMatchObject({
      swept: 0,
      claimed: 1,
      invoked: 1,
      failed: 0,
      skipped: 0,
      notStarted: 0,
    })

    const row = await readRow(runId)

    expect(row.status).toBe("claimed")
    expect(row.claimed_by).not.toBeNull()
    expect(row.claimed_at).not.toBeNull()

    expect(agentcore.calls).toHaveLength(1)
  })

  test("the invoke context is the closed twelve-field shape", async () => {
    const runId = await enqueue()

    await runTick()

    const { context, command, sessionId } = agentcore.calls[0]

    expect(Object.keys(context).sort()).toEqual(
      [
        "actor_id",
        "client_id",
        "client_secret",
        "display_name",
        "fidelity_tier",
        "log_analytics_workspace_id",
        "progress_token",
        "progress_url",
        "run_id",
        "subscription_id",
        "tenant_id",
        "timezone",
      ].sort()
    )

    // Requirement 41.11 — the actor prefix the runtime writes artifacts under is the
    // run's `user_id`, which is what the download authorization compares against.
    expect(context.actor_id).toBe(userId)
    expect(context.run_id).toBe(runId)
    expect(context.subscription_id).toBe(AZURE.subscriptionId)
    expect(context.timezone).toBe("Asia/Jakarta")
    expect(context.fidelity_tier).toBe("baseline")
    expect(context.log_analytics_workspace_id).toBeNull()

    // The gate really decrypted the stored envelope.
    expect(context.client_secret).toBe(AZURE.clientSecret)
    expect(context.tenant_id).toBe(AZURE.tenantId)
    expect(context.client_id).toBe(AZURE.clientId)

    // Requirement 37.3 — recomputed from the run id, not read from a column. The
    // column holds only the hash, so this is the one path that can produce it.
    expect(context.progress_token).toBe(deriveProgressToken(runId))
    expect(context.progress_url).toBe(
      `${APP_BASE_URL}/api/internal/runs/${runId}/progress`
    )
    // Requirement 38.2 — the token is in the header, never in the URL.
    expect(context.progress_url).not.toContain(context.progress_token)

    // Requirement 41.8 — a deterministic command, and the type has no `prompt`
    // member, so the pipeline is reachable without a model decision.
    //
    // The pinned version travels **with its definition inline**. The runtime reads no
    // database, and its contract states that a payload carrying no `definition` is a
    // *snapshot-only* run — so a command naming only the version id would collect a
    // snapshot and never render, verify or deliver anything, on every run, without
    // failing. `test/db/report-run-end-to-end.integration.test.ts` walks the
    // consequence; this asserts the shape.
    expect(command).toEqual({
      command: "generate_report",
      template_version_id: expect.any(String),
      definition: FIXTURE_DEFINITION,
      period: PERIOD,
      scope: SCOPE,
      // Requirement 18.4 — the historical-trend candidates travel in the command
      // payload, never in `context`, which stays closed at the twelve fields
      // asserted above. This fixture has no prior completed run for the template,
      // so the list is empty rather than absent: a missing key and an empty list
      // are different claims, and the runtime reads the latter as "asked, none
      // eligible" rather than "not asked".
      historical_candidates: [],
    })
    expect(command).not.toHaveProperty("prompt")

    // 33–128 characters, stable per run.
    expect(sessionId.length).toBeGreaterThanOrEqual(33)
    expect(sessionId.length).toBeLessThanOrEqual(128)
  })

  test("a second tick invokes nothing, because the row is no longer queued", async () => {
    await enqueue()

    await runTick()
    const second = await runTick()

    expect(second).toMatchObject({ claimed: 0, invoked: 0 })
    expect(agentcore.calls).toHaveLength(1)
  })

  test("a failed start leaves the row claimed for the sweep and invokes nothing further", async () => {
    // Requirement 39.13 — the row is left `claimed`, the tick continues, and the
    // reaper is the backstop. Nothing is written to the row here.
    const runId = await enqueue()
    agentcore.fail = true

    const body = await runTick()

    expect(body).toMatchObject({ claimed: 1, invoked: 0, notStarted: 1 })
    expect((await readRow(runId)).status).toBe("claimed")
  })
})

describe("Requirements 38.1, 38.13 — a progress callback lands on the row", () => {
  test("entering collecting persists the phase, the counts and the label", async () => {
    const runId = await enqueue()
    await runTick()

    const response = await postCallback(runId, {
      phase: "collecting",
      current: 0,
      total: RESOURCE_COUNT,
      label: "Metrics",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, status: "collecting" })

    const row = await readRow(runId)

    expect(row.status).toBe("collecting")
    expect(row.progress_current).toBe(0)
    expect(row.progress_total).toBe(RESOURCE_COUNT)
    expect(row.progress_label).toBe("Metrics")
    expect(row.phase_deadline).not.toBeNull()
  })

  test("a same-phase callback refreshes the count without changing the status", async () => {
    const runId = await enqueue()
    await runTick()
    await postCallback(runId, {
      phase: "collecting",
      current: 0,
      total: RESOURCE_COUNT,
      label: "Metrics",
    })

    // Requirement 38.13 — idempotent with respect to `status` only. The progress
    // columns are written on every such callback, which is the whole point: a run
    // reports many counts inside one phase.
    await postCallback(runId, {
      phase: "collecting",
      current: 142,
      total: RESOURCE_COUNT,
      label: "Metrics",
    })

    const row = await readRow(runId)

    expect(row.status).toBe("collecting")
    expect(row.progress_current).toBe(142)
  })

  test("an out-of-order lower count leaves all three columns unchanged", async () => {
    const runId = await enqueue()
    await runTick()
    await postCallback(runId, {
      phase: "collecting",
      current: 142,
      total: RESOURCE_COUNT,
      label: "Metrics",
    })

    // Requirement 38.14 — a retried callback arriving late must not move the bar
    // backwards, and the **row** rather than the caller is what preserves that.
    await postCallback(runId, {
      phase: "collecting",
      current: 12,
      total: RESOURCE_COUNT,
      label: "Inventory",
    })

    const row = await readRow(runId)

    expect(row.progress_current).toBe(142)
    expect(row.progress_label).toBe("Metrics")
  })

  test("a callback presenting a token for another run is refused, and writes nothing", async () => {
    const runId = await enqueue()
    await runTick()

    const response = await postCallback(
      runId,
      { phase: "collecting", current: 5, total: 200 },
      deriveProgressToken("some-other-run")
    )

    expect(response.status).toBe(404)
    expect((await readRow(runId)).status).toBe("claimed")
  })
})

describe("Requirements 36.12, 38.12 — the terminal callback completes the row", () => {
  test("the row carries the snapshot facts and no stale in-flight count", async () => {
    const runId = await enqueue()

    const { finalRow } = await walkToCompletion(runId)

    expect(finalRow.status).toBe("completed")
    expect(finalRow.snapshot_id).toBe(SNAPSHOT_ID)
    expect(finalRow.resource_count).toBe(RESOURCE_COUNT)
    expect(finalRow.gap_count).toBe(GAP_COUNT)
    expect(finalRow.error_code).toBeNull()

    // Requirement 36.12 — cleared together with the deadline, so a terminal row
    // carries no count a reconnecting client could render as still in flight.
    expect(finalRow.phase_deadline).toBeNull()
    expect(finalRow.progress_current).toBeNull()
    expect(finalRow.progress_total).toBeNull()
    expect(finalRow.progress_label).toBeNull()
  })

  test("a further callback on the completed row is refused", async () => {
    const runId = await enqueue()
    await walkToCompletion(runId)

    // Every transition on a terminal row is rejected, including a repeat of its own
    // terminal status.
    const repeat = await postCallback(runId, {
      phase: "completed",
      snapshot_id: SNAPSHOT_ID,
      resource_count: RESOURCE_COUNT,
      gap_count: GAP_COUNT,
    })
    const reopen = await postCallback(runId, {
      phase: "collecting",
      current: 1,
      total: 2,
    })

    expect(repeat.status).toBe(404)
    expect(reopen.status).toBe(404)
    expect((await readRow(runId)).status).toBe("completed")
  })

  test("TIMEOUT is not a code the agent may present", async () => {
    // The reaper is the only `TIMEOUT` writer — by definition the agent may already
    // be gone when a run times out, so a callback claiming it would be a caller
    // asserting something it cannot know.
    const runId = await enqueue()
    await runTick()

    const response = await postCallback(runId, {
      phase: "failed",
      error_code: "TIMEOUT",
      error_message: "gave up",
    })

    expect(response.status).toBe(404)
    expect((await readRow(runId)).status).toBe("claimed")
  })
})

describe("Requirements 40.4, 40.5 — the relay reconstructs the run from the row", () => {
  test("a mid-collection row renders a determinate count", async () => {
    const runId = await enqueue()
    await runTick()
    await postCallback(runId, {
      phase: "collecting",
      current: 142,
      total: RESOURCE_COUNT,
      label: "Metrics",
    })

    // The production read and the production derivation, over the row the callback
    // above wrote. This is the seam: a count that went in through the callback comes
    // back out as a determinate `progress` event, with `unit` from the per-phase
    // constant rather than from run state.
    const row = await findOwnedRun(userId, runId)
    expect(row).toBeDefined()

    const { events } = deriveRelayEvents(EMPTY_CURSOR, row!, [])

    expect(events.map((event) => event.type)).toEqual(["tool", "progress"])
    expect(events[1]).toEqual({
      type: "progress",
      id: "collecting",
      done: 142,
      total: RESOURCE_COUNT,
      unit: PHASE_PROGRESS_UNIT.collecting,
      label: "Metrics",
    })
  })

  test("the count the relay renders is the one the callback wrote, not a constant", async () => {
    const runId = await enqueue()
    await runTick()

    const seen: number[] = []
    let cursor = EMPTY_CURSOR

    for (const current of [0, 42, 142, RESOURCE_COUNT]) {
      await postCallback(runId, {
        phase: "collecting",
        current,
        total: RESOURCE_COUNT,
        label: "Metrics",
      })

      const row = await findOwnedRun(userId, runId)
      const derived = deriveRelayEvents(cursor, row!, [])
      cursor = derived.cursor

      for (const event of derived.events) {
        if (event.type === "progress") seen.push(event.done as number)
      }
    }

    expect(seen).toEqual([0, 42, 142, RESOURCE_COUNT])
  })

  test("a claimed row emits its step but no progress bar", async () => {
    // Requirement 40.14 — `PHASE_PROGRESS_UNIT` describes `collecting` only, and the
    // row carries no counts yet, so there is no honest determinate bar to render.
    const runId = await enqueue()
    await runTick()

    const row = await findOwnedRun(userId, runId)
    const { events } = deriveRelayEvents(EMPTY_CURSOR, row!, [])

    expect(events.map((event) => event.type)).toEqual(["tool"])
  })

  test("the completed row's stream emits snapshot_ready then done and closes", async () => {
    const runId = await enqueue()

    const { events } = await walkToCompletion(runId)

    // The real route, over the real row, with the gap list read from the snapshot
    // object the agent wrote. It closes on its own — a terminal row needs no timer
    // advancement and no idle window.
    expect(events.map((event) => event.type)).toEqual([
      "snapshot_ready",
      "done",
    ])

    expect(events[0]).toMatchObject({
      snapshot_id: SNAPSHOT_ID,
      resource_count: RESOURCE_COUNT,
      gap_count: GAP_COUNT,
      window: {
        start: PERIOD.start,
        end: PERIOD.end,
        timezone: "Asia/Jakarta",
      },
    })
    expect(events[1]).toEqual({ type: "done", status: "completed" })

    // The gap list came from the snapshot rather than from a column or a table.
    //
    // `intervalStart` is `null` because `SNAPSHOT_GAP` is a `deallocated` entry,
    // which is about a resource rather than about one interval. The field was added
    // to the projection with the interval-level gap types and this expectation went
    // stale, unnoticed, because every suite in this directory is skipped unless
    // `TEST_DATABASE_URL` is set — the same way the `run_error_code` count in
    // `schema.integration.test.ts` did. Stated rather than silently corrected.
    expect(events[0].gaps).toEqual([
      {
        gapType: SNAPSHOT_GAP.gap_type,
        resourceId: SNAPSHOT_GAP.resource_id,
        metric: null,
        message: SNAPSHOT_GAP.message,
        intervalStart: null,
      },
    ])
    expect(s3.reads).toContain(snapshotArtifactKey(userId, runId))
  })

  test("the relay never emits verification or report_file, and nothing follows done", async () => {
    const runId = await enqueue()

    const { events, finalRow } = await walkToCompletion(runId)
    const types = events.map((event) => event.type)

    // Requirement 14.11 as the app sees it: this spec compiles, renders and verifies
    // nothing, so neither event has an emitter — which is what makes "a `report_file`
    // never arrives without a passing `verification`" impossible to violate here.
    expect(types).not.toContain("verification")
    expect(types).not.toContain("report_file")

    // `done` is last, and one more poll of the same terminal row adds nothing.
    expect(types.indexOf("done")).toBe(types.length - 1)

    const terminal = await findOwnedRun(userId, runId)
    const again = deriveRelayEvents(
      { openStep: null, lastDone: {}, lastProgress: null, finished: true },
      terminal!,
      await loadRunGaps(terminal!)
    )

    expect(again.events).toEqual([])
    expect(finalRow.status).toBe("completed")
  })

  test("another user's run resolves as not found with no stream opened", async () => {
    const runId = await enqueue()
    await walkToCompletion(runId)

    guard.user = { id: `user-${randomUUID()}`, email: "eve@example.com" }

    const response = await stream(relayRequest(runId), {
      params: Promise.resolve({ runId }),
    })

    expect(response.status).toBe(404)
    expect(
      ((await response.json()) as { error: { message: string } }).error.message
    ).toBe("Not found.")
  })
})

describe("Requirements 15.6, 15.7 — no secret survives the walk", () => {
  /** The four values, as one list, so a new one cannot be added to only half the scan. */
  const secretValues = (
    runId: string
  ): readonly { name: string; value: string }[] => [
    { name: "client_secret", value: AZURE.clientSecret },
    { name: "tenant_id", value: AZURE.tenantId },
    { name: "client_id", value: AZURE.clientId },
    { name: "progress_token", value: deriveProgressToken(runId) },
  ]

  test("no event, log line or run-row column carries one", async () => {
    const runId = await enqueue()

    const { events, finalRow } = await walkToCompletion(runId)

    // Serialized rather than inspected field by field, so a value nested at any depth
    // is caught — which is the failure mode a top-level key check misses.
    const serializedEvents = JSON.stringify(events)
    const serializedRow = JSON.stringify(finalRow)
    const serializedView = JSON.stringify(
      // The browser-facing projection of the same row, so the scan covers the shape
      // that actually crosses to a client rather than only the row behind it.
      toRunView((await findOwnedRun(userId, runId))!, {
        templateName: null,
        templateVersion: null,
        verificationStatus: null,
      })
    )
    const serializedLogs = logLines.join("\n")

    for (const { name, value } of secretValues(runId)) {
      expect(serializedEvents, `${name} reached an event`).not.toContain(value)
      expect(
        serializedRow,
        `${name} was persisted on the run row`
      ).not.toContain(value)
      expect(serializedView, `${name} survived into RunView`).not.toContain(
        value
      )
      expect(serializedLogs, `${name} reached a log line`).not.toContain(value)
    }

    // The scan is not vacuous: the walk really produced events, and the row really
    // carries the hash of the token whose plaintext is absent above.
    expect(events.length).toBeGreaterThan(0)
    expect(finalRow.progress_token_hash).toBe(
      progressTokenHash(deriveProgressToken(runId))
    )
  })

  test("the values really were handled, so their absence above means something", async () => {
    // Without this the assertions above would also pass on a walk that never
    // decrypted anything. The invoke context is the one place these values legitimately
    // appear — it goes to the runtime over the SDK, not to a browser or a log.
    const runId = await enqueue()
    await runTick()

    const serializedContext = JSON.stringify(agentcore.calls[0].context)

    for (const { value } of secretValues(runId)) {
      expect(serializedContext).toContain(value)
    }
  })

  test("a refused callback logs the refusal without the token", async () => {
    const runId = await enqueue()
    await runTick()

    await postCallback(
      runId,
      { phase: "collecting", current: 1, total: 2 },
      deriveProgressToken("not-this-run")
    )

    const refusals = logLines.filter((line) =>
      line.includes("refused a callback")
    )

    expect(refusals.length).toBeGreaterThan(0)
    // Not even as a presence marker: the marker would still distinguish "absent" from
    // "present but wrong" in a log a wider audience reads than the row does.
    for (const line of refusals) {
      expect(line).not.toContain(deriveProgressToken("not-this-run"))
      expect(line).not.toContain(deriveProgressToken(runId))
    }
  })
})
