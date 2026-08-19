import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

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
 * Task 15.3, the app half — **one full report run, over one real row**
 * (Requirements 25.2, 25.3, 40.1, 40.2, 40.3, 40.4, 41.1, 42.12, 42.13, 43.1).
 *
 * `run-wiring.integration.test.ts` walks the **collection** half of this sequence:
 * enqueue, tick, three `collecting` callbacks, `completed`, relay. This file walks
 * the half this spec adds, and it is the half where the product's one promise lives:
 *
 *   `enqueueRun` (pins `template_version_id`) → `POST /api/cron/tick`
 *   → `collecting` → `compiling` → `rendering` → `verifying`
 *   → `POST /api/internal/runs/[runId]/verification`
 *   → `verifying → completed` → the download gate → the relay
 *
 * with the **production** functions throughout. The only doubles are the three genuine
 * outside edges: AgentCore, S3 and the session cookie.
 *
 * ## The four assertions this file exists for
 *
 * Each is a statement about SQL or about ordering that no fake can make:
 *
 *  1. **`completed` is written only with a stored passing verification** (41.1). The
 *     precondition is a `SELECT` and an `UPDATE` in one transaction, and the case that
 *     matters is the callback arriving *before* the proof does — which is the ordinary
 *     race, not an exotic one. Driven here as the real sequence rather than as two
 *     statements a test wrote itself.
 *  2. **Exactly two download controls, each minting a fresh short-lived URL at
 *     activation** (40.1, 40.3). The set of controls is the run row's recorded keys, so
 *     it is a fact about the row; the freshness is a fact about the route.
 *  3. **No route returns a URL for a run whose verification is fail or absent** (25.3,
 *     40.4). Both states are driven against the **real** `report_verifications` table and
 *     the real `readLatestVerificationStatus`, because "absent" and "fail" are different
 *     rows and a stubbed status would assert its own stub.
 *  4. **The relay reconstructs the document phases from the row plus the stored
 *     verification alone** (42.12, 42.13), and closing it mid-phase changes no outcome.
 *
 * ## The agent's half of this walk is `agent/tests/test_report_run_end_to_end.py`
 *
 * A run's other half runs in Python, in a container, so no single process drives both.
 * The two files meet at two contracts, and the fixtures below are that contract written
 * down rather than invented here:
 *
 *   * the **verification callback body** — `run_id`, `attempt_id`, `status`,
 *     `figure_count`, the three digests and `artifact_key`. The Python file asserts the
 *     runtime produces exactly those eight keys; this file asserts the endpoint accepts
 *     and persists them.
 *   * the **verification-result artifact**, which is read here straight out of
 *     `agent/tests/fixtures/verification/` — the corpus the Python suite writes. So the
 *     object this walk parses is one the agent's own builder produced, not a hand-rolled
 *     approximation of it.
 *
 * ## Binding the production pool to the scratch schema
 *
 * Identical to `run-wiring.integration.test.ts`, and for the reason that file records at
 * length: `lib/db/index.ts` opens its own pool from `DATABASE_URL`, and the production
 * functions are the point here, so the variable is repointed at the harness's schema
 * through `options=-c search_path=<schema>` for the lifetime of this file.
 *
 * Skipped, loudly, when `TEST_DATABASE_URL` is unset — see the harness.
 */

const db = withScratchSchema(import.meta.url)

// --- The three outside edges ------------------------------------------------

const { agentcore, s3, guard } = vi.hoisted(() => ({
  agentcore: {
    calls: [] as {
      sessionId: string
      context: AgentInvokeContext
      command: InvokeCommand
    }[],
  },
  s3: {
    /** The objects the agent wrote, by key — the in-memory object store. */
    objects: new Map<string, unknown>(),
    reads: [] as string[],
    /** Every presigned URL minted, in order, so freshness is countable. */
    presigns: [] as { key: string; url: string; expiresIn: number }[],
  },
  guard: { user: undefined as { id: string; email: string } | undefined },
}))

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
      return {
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode('data: {"type":"tool"}\n\n')
        },
      }
    },
  }
})

/**
 * S3: the object reads are the in-memory store, and `presignArtifact` is **counted**.
 *
 * Counted rather than merely faked, because "no URL was minted" is the assertion in half
 * the cases below — and an assertion about the absence of a string in a response body
 * would also hold for a route that minted one and forgot to return it.
 *
 * `keyBelongsToActor`, `parseArtifactKey` and `MAX_PRESIGN_SECONDS` stay real: the first
 * two are the authorization primitives under test, and the third is the expiry ceiling
 * Requirement 40.3 states, so it has to be the module's own number rather than one this
 * file chose.
 */
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
    presignArtifact: async (actorId: string, key: string) => {
      if (!original.keyBelongsToActor(actorId, key)) {
        throw new original.ArtifactAccessError("not this actor's key")
      }
      // A nonce, so two mints for one key are distinguishable — which is what makes
      // "a fresh URL on each activation" assertable at all.
      const url = `https://s3.test/${key}?signature=${randomUUID()}`
      const minted = {
        key,
        url,
        expiresIn: original.MAX_PRESIGN_SECONDS,
      }
      s3.presigns.push(minted)
      return { url, expiresIn: minted.expiresIn }
    },
  }
})

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
const { snapshotArtifactKey, toRunView, toVerificationView } =
  await import("@/lib/db/views")
const { MAX_PRESIGN_SECONDS } = await import("@/lib/aws/s3")
const { DOWNLOADABLE_LEAF_NAMES, recordedArtifactKeys, reportArtifactKey } =
  await import("@/lib/runs/artifacts")
const { EMPTY_CURSOR, deriveRelayEvents } = await import("@/lib/runs/relay")
const { findOwnedRun } = await import("@/lib/runs/state")
const { deriveProgressToken, PROGRESS_TOKEN_HEADER } =
  await import("@/lib/runs/progress-token")
const { loadRunGaps } = await import("@/lib/runs/gaps")
const { resolveRunExtras } = await import("@/lib/runs/detail")
const { latestForRun, readLatestVerificationStatus } =
  await import("@/lib/verifications/store")
const { RUN_STATUS_PRESENTATION, runFailurePresentation } =
  await import("@/lib/runs/presentation")
const { POST: tick } = await import("@/app/api/cron/tick/route")
const { POST: progressCallback } =
  await import("@/app/api/internal/runs/[runId]/progress/route")
const { POST: verificationCallback } =
  await import("@/app/api/internal/runs/[runId]/verification/route")
const { GET: artifactUrl } = await import("@/app/api/artifact-url/route")
const { GET: stream } = await import("@/app/api/runs/[runId]/stream/route")

// --- Fixtures ---------------------------------------------------------------

/** The four values Requirements 15.6 and 15.7 keep off every browser-facing shape. */
const AZURE = {
  subscriptionId: "3f2b0000-0000-0000-0000-000000000000",
  tenantId: "tenant-0d4f1a2b-not-a-real-tenant-id",
  clientId: "client-9e8d7c6b-not-a-real-client-id",
  clientSecret: "not-a-real-client-secret-Zq7Z~x0LmN4pR8sT2vW6yA9cE3gH5jK",
} as const

const CRON_SECRET = "0123456789abcdef0123456789abcdef"
const APP_BASE_URL = "https://app.test"
const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64")

const PERIOD = { start: "2026-07-01", end: "2026-07-31" } as const

const FIXTURE_DEFINITION = {
  ...STARTER_TEMPLATES[0]!.definition,
  period: { kind: "custom", start: PERIOD.start, end: PERIOD.end },
} as const

const RESOURCE_COUNT = 200
const BLOCK_COUNT = 7

/**
 * The passing verification-result artifact, **read from the agent's own corpus**.
 *
 * `agent/tests/test_verify_findings.py` writes `agent/tests/fixtures/verification/`
 * on every run of the Python suite, and `test/verification-result-corpus.static.test.ts`
 * already asserts every file in it parses with `verificationResultSchema`. Reading one
 * here is what makes this walk's stored object a real cross-language artifact rather
 * than a shape this file guessed at — a field the writer adds and this endpoint rejects
 * fails here at commit time, not during a run whose document is already rendered.
 */
const CORPUS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "agent",
  "tests",
  "fixtures",
  "verification"
)

function corpusResult(name: string): Record<string, unknown> {
  const raw = readFileSync(path.join(CORPUS_DIR, name), "utf8")
  return JSON.parse(raw) as Record<string, unknown>
}

const PASSING_TEMPLATE = corpusResult("pass-no-findings.json")
const FAILING_TEMPLATE = corpusResult("fail-single-blocking.json")

let userId: string
let subscriptionId: string
let templateId: string
let templateVersionId: string
let logLines: string[]

const savedEnv: Record<string, string | undefined> = {}

function setEnv(name: string, value: string): void {
  savedEnv[name] = process.env[name]
  process.env[name] = value
}

beforeAll(async () => {
  if (!db.enabled) return

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
  // Before the harness drops the schema — registered later, so Vitest runs it first.
  await closeDb()
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

beforeEach(async () => {
  if (!db.enabled) return

  agentcore.calls = []
  s3.objects = new Map()
  s3.reads = []
  s3.presigns = []
  logLines = []

  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "))
  })
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "))
  })

  await db.query(`TRUNCATE users CASCADE`)

  userId = `user-${randomUUID()}`
  subscriptionId = `sub-${randomUUID()}`
  templateId = `tpl-${randomUUID()}`
  templateVersionId = `ver-${randomUUID()}`
  guard.user = { id: userId, email: "ada@example.com" }

  await db.query(
    `INSERT INTO users (id, email, email_normalized, password_hash)
     VALUES ($1, $2, $3, '$argon2id$fixture')`,
    [userId, `${userId}@Example.com`, `${userId}@example.com`]
  )

  // A real envelope, so the tick's `resolveSubscriptionCredentials` really decrypts.
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

  await db.query(
    `INSERT INTO report_templates (id, user_id, name, description)
     VALUES ($1, $2, 'Monthly utilization', '')`,
    [templateId, userId]
  )
  await db.query(
    `INSERT INTO report_template_versions
       (id, template_id, version, definition, definition_sha256)
     VALUES ($1, $2, 1, $3, $4)`,
    [
      templateVersionId,
      templateId,
      JSON.stringify(FIXTURE_DEFINITION),
      definitionSha256(FIXTURE_DEFINITION),
    ]
  )
  await db.query(
    `UPDATE report_templates SET current_version_id = $2 WHERE id = $1`,
    [templateId, templateVersionId]
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

async function runTick(): Promise<Record<string, number>> {
  const response = await tick(
    new Request(`${APP_BASE_URL}/api/cron/tick`, {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    })
  )
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()) as Record<string, number>
}

/** One progress callback, presented exactly as `progress.py` presents it. */
async function postPhase(
  runId: string,
  body: Record<string, unknown>
): Promise<Response> {
  return progressCallback(
    new Request(`${APP_BASE_URL}/api/internal/runs/${runId}/progress`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [PROGRESS_TOKEN_HEADER]: deriveProgressToken(runId),
      },
      body: JSON.stringify({ run_id: runId, ...body }),
    }),
    { params: Promise.resolve({ runId }) }
  )
}

/**
 * The stored verification artifact for a run, and the callback that points at it.
 *
 * The artifact is written into the object store **first**, because that is the order the
 * runtime uses (Requirement 25.10): the result exists before anything names it, on both
 * the passing and the failing path.
 */
type StagedVerification = {
  readonly result: Record<string, unknown>
  readonly key: string
}

function stageVerification(
  runId: string,
  status: "pass" | "fail",
  attemptId = `${runId}-1`
): StagedVerification {
  const template = status === "pass" ? PASSING_TEMPLATE : FAILING_TEMPLATE
  const result = {
    ...template,
    run_id: runId,
    attempt_id: attemptId,
    template_version_id: templateVersionId,
    status,
  }
  // The key layout `agent/.../artifacts.py#verification_key` writes, which is also the
  // one the endpoint's actor-prefix predicate authorizes.
  const key = `${userId}/reports/${runId}/verification-${attemptId}.json`
  s3.objects.set(key, result)
  return { result, key }
}

async function postVerification(
  runId: string,
  status: "pass" | "fail",
  attemptId = `${runId}-1`
): Promise<Response> {
  const staged = stageVerification(runId, status, attemptId)
  const body = {
    run_id: runId,
    attempt_id: attemptId,
    status,
    figure_count: staged.result.figure_count,
    snapshot_sha256: staged.result.snapshot_sha256,
    docx_sha256: staged.result.docx_sha256,
    pdf_sha256: staged.result.pdf_sha256,
    artifact_key: staged.key,
  }
  return verificationCallback(
    new Request(`${APP_BASE_URL}/api/internal/runs/${runId}/verification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [PROGRESS_TOKEN_HEADER]: deriveProgressToken(runId),
      },
      body: JSON.stringify(body),
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

/** The snapshot object the agent would have written for this run. */
function writeSnapshotObject(runId: string): void {
  s3.objects.set(snapshotArtifactKey(userId, runId), {
    snapshot_id: "a3f9".repeat(16),
    content_hash: "a3f9".repeat(16),
    grain: "PT1H",
    timezone: "Asia/Jakarta",
    utc_offset: "+07:00",
    window: {
      start: PERIOD.start,
      end: PERIOD.end,
      start_utc: "2026-06-30T17:00:00Z",
      end_utc: "2026-07-31T17:00:00Z",
    },
    gaps: [],
    resources: [],
  })
}

/**
 * The whole sequence, in the order the runtime drives it, returning the statuses the row
 * held after each step.
 *
 * One helper rather than a `beforeEach`, because half the assertions below are about
 * *points* in the walk — the row mid-render, the download gate at `verifying` — and those
 * tests drive it themselves.
 */
async function walkToCompletion(runId: string): Promise<readonly string[]> {
  const seen: string[] = []
  const record = async (): Promise<void> => {
    seen.push(String((await readRow(runId)).status))
  }

  await runTick()
  await record()

  await postPhase(runId, {
    phase: "collecting",
    current: 0,
    total: RESOURCE_COUNT,
    label: "Metrics",
  })
  await record()

  writeSnapshotObject(runId)

  for (const [phase, label] of [
    ["compiling", "Compiling"],
    ["rendering", "Rendering"],
    ["verifying", "Verifying"],
  ] as const) {
    const response = await postPhase(runId, {
      phase,
      current: 0,
      total: BLOCK_COUNT,
      label,
    })
    expect(response.status, `${phase} was refused`).toBe(200)
    await record()
  }

  // The proof, then the completion. In that order, because the other order is the case
  // Requirement 41.1's precondition exists to refuse — asserted on its own below.
  expect((await postVerification(runId, "pass")).status).toBe(200)

  const completed = await postPhase(runId, {
    phase: "completed",
    snapshot_id: "a3f9".repeat(16),
    resource_count: RESOURCE_COUNT,
    gap_count: 0,
  })
  expect(completed.status, await completed.clone().text()).toBe(200)
  await record()

  return seen
}

async function requestDownload(key: string): Promise<Response> {
  return artifactUrl(
    new Request(
      `${APP_BASE_URL}/api/artifact-url?key=${encodeURIComponent(key)}`
    )
  )
}

// ---------------------------------------------------------------------------
// Requirement 41.1 — the row advances, and `completed` needs its proof
// ---------------------------------------------------------------------------

describe.skipIf(!db.enabled)(
  "Requirement 41.1 — the row advances through the document phases",
  () => {
    test("one walk drives collecting → compiling → rendering → verifying → completed", async () => {
      const runId = await enqueue()

      // The enqueue pinned the version and inserted `queued` — asserted here rather than
      // assumed, because every later status is a transition *from* that row.
      const queued = await readRow(runId)
      expect(queued.status).toBe("queued")
      expect(queued.template_version_id).toBe(templateVersionId)
      // Through the projection, because the `date` columns come back as `Date`
      // objects from the driver and the local calendar dates are what the run means.
      const queuedView = toRunView(
        (await findOwnedRun(userId, runId))!,
        await resolveRunExtras((await findOwnedRun(userId, runId))!)
      )
      expect(queuedView.periodStart).toBe(PERIOD.start)
      expect(queuedView.periodEnd).toBe(PERIOD.end)
      expect(queuedView.timezone).toBe("Asia/Jakarta")

      expect(await walkToCompletion(runId)).toEqual([
        "claimed",
        "collecting",
        "compiling",
        "rendering",
        "verifying",
        "completed",
      ])

      const final = await readRow(runId)
      expect(final.error_code).toBeNull()
      // A terminal row carries no deadline and no in-flight count: the reaper has nothing
      // left to sweep and the timeline has nothing left to animate.
      expect(final.phase_deadline).toBeNull()
      expect(final.progress_current).toBeNull()
      expect(final.progress_total).toBeNull()
      expect(final.snapshot_id).toBe("a3f9".repeat(16))
      expect(final.resource_count).toBe(RESOURCE_COUNT)
    })

    test("the tick claimed it with SKIP LOCKED, gated it, and invoked once", async () => {
      const runId = await enqueue()
      const body = await runTick()

      expect(body).toMatchObject({ claimed: 1, invoked: 1, failed: 0 })
      expect(agentcore.calls).toHaveLength(1)

      // A deterministic command, never a prompt: the pipeline must be reachable without
      // a model deciding to call a tool.
      const command = agentcore.calls[0].command as Record<string, unknown>
      expect(command.command).toBe("generate_report")
      expect(command).not.toHaveProperty("prompt")

      // The pinned version **and its definition, inline** — the two together are what
      // make this a report run. The runtime reads no database, and its contract is
      // explicit that a payload with no `definition` is a snapshot-only run, so a
      // command carrying only the id would collect a snapshot and never render, verify
      // or deliver anything, on every run, without failing.
      expect(command.template_version_id).toBe(templateVersionId)
      expect(command.definition).toEqual(FIXTURE_DEFINITION)
      expect(command.period).toEqual({ start: PERIOD.start, end: PERIOD.end })

      // Exactly these five keys, as an **exact set**: the payload crosses a language
      // boundary, so a sixth field added here is a field the runtime has never read, and
      // a fifth removed is one it silently misses. `agent/AGENTCORE_INTEGRATION.md` is
      // the authority; this is that authority asserted from the sending side.
      expect(Object.keys(command).sort()).toEqual([
        "command",
        "definition",
        "period",
        "scope",
        "template_version_id",
      ])

      // A second tick finds nothing: the row is no longer `queued`.
      expect(await runTick()).toMatchObject({ claimed: 0, invoked: 0 })
      expect(agentcore.calls).toHaveLength(1)
      expect((await readRow(runId)).status).toBe("claimed")
    })

    test("each document phase refreshes the deadline its own budget declares", async () => {
      // A phase with no refreshed deadline is a row the reaper has no deadline for, which
      // is a row that sits in that phase forever when its container dies.
      const runId = await enqueue()
      await runTick()
      await postPhase(runId, { phase: "collecting", current: 0, total: 1 })

      const deadlines: (Date | null)[] = []
      for (const phase of ["compiling", "rendering", "verifying"] as const) {
        await postPhase(runId, { phase })
        const row = await readRow(runId)
        deadlines.push(row.phase_deadline as Date | null)
      }

      for (const deadline of deadlines) {
        expect(deadline).not.toBeNull()
        expect((deadline as Date).getTime()).toBeGreaterThan(Date.now())
      }
      // Rendering and verifying are budgeted longer than compiling, so the refreshed
      // deadlines are not one constant repeated.
      expect(new Set(deadlines.map((d) => (d as Date).getTime())).size).toBe(3)
    })

    test("verifying → completed is refused while no verification is stored", async () => {
      const runId = await enqueue()
      await runTick()
      await postPhase(runId, { phase: "collecting", current: 0, total: 1 })
      for (const phase of ["compiling", "rendering", "verifying"] as const) {
        await postPhase(runId, { phase })
      }

      // The ordinary race: the completion callback arrives before the verification one.
      const early = await postPhase(runId, {
        phase: "completed",
        snapshot_id: "a3f9".repeat(16),
        resource_count: RESOURCE_COUNT,
        gap_count: 0,
      })
      expect(early.status).toBe(404)
      expect((await readRow(runId)).status).toBe("verifying")
      expect(await readLatestVerificationStatus(runId)).toBeUndefined()

      // And once the proof lands, the identical callback is accepted.
      await postVerification(runId, "pass")
      const accepted = await postPhase(runId, {
        phase: "completed",
        snapshot_id: "a3f9".repeat(16),
        resource_count: RESOURCE_COUNT,
        gap_count: 0,
      })
      expect(accepted.status).toBe(200)
      expect((await readRow(runId)).status).toBe("completed")
    })

    test("a failing verification completes nothing and reaches failed with its own code", async () => {
      const runId = await enqueue()
      await runTick()
      await postPhase(runId, { phase: "collecting", current: 0, total: 1 })
      for (const phase of ["compiling", "rendering", "verifying"] as const) {
        await postPhase(runId, { phase })
      }

      await postVerification(runId, "fail")
      expect(await readLatestVerificationStatus(runId)).toBe("fail")

      // Requirement 25.2 — the row is `failed` with `VERIFICATION_FAILED`, and a stored
      // failing result never unlocks `completed`.
      const refused = await postPhase(runId, {
        phase: "completed",
        snapshot_id: "a3f9".repeat(16),
        resource_count: 1,
        gap_count: 0,
      })
      expect(refused.status).toBe(404)

      await postPhase(runId, {
        phase: "failed",
        error_code: "VERIFICATION_FAILED",
        error_message: "one figure could not be traced to the snapshot",
      })
      const row = await readRow(runId)
      expect(row.status).toBe("failed")
      expect(row.error_code).toBe("VERIFICATION_FAILED")
      expect(
        runFailurePresentation({
          status: "failed",
          errorCode: "VERIFICATION_FAILED",
        })?.artifactProduced
      ).toBe(false)
    })

    test("a callback for a phase the table does not admit moves nothing", async () => {
      // `collecting → verifying` skips two phases, which would leave a run reporting a
      // verification of a document nothing rendered.
      const runId = await enqueue()
      await runTick()
      await postPhase(runId, { phase: "collecting", current: 0, total: 1 })

      expect((await postPhase(runId, { phase: "verifying" })).status).toBe(404)
      expect((await readRow(runId)).status).toBe("collecting")
    })
  }
)

// ---------------------------------------------------------------------------
// Requirement 43.1 — the artifacts the walk recorded
// ---------------------------------------------------------------------------

describe.skipIf(!db.enabled)(
  "Requirements 43.1, 43.4 — the recorded keys and the projection",
  () => {
    test("the completed run records exactly two downloadable keys", async () => {
      const runId = await enqueue()
      await walkToCompletion(runId)

      const run = (await findOwnedRun(userId, runId))!
      const recorded = recordedArtifactKeys(run)

      const downloadable = [...recorded].filter((key) =>
        DOWNLOADABLE_LEAF_NAMES.some((leaf) => key.endsWith(`/${leaf}`))
      )
      expect(downloadable.sort()).toEqual(
        [
          reportArtifactKey(userId, runId, "report.docx"),
          reportArtifactKey(userId, runId, "report.pdf"),
        ].sort()
      )

      // The key shape the agent writes and this app authorizes: actor, `reports`, run id.
      for (const key of downloadable) {
        const segments = key.split("/")
        expect(segments[0]).toBe(userId)
        expect(segments[1]).toBe("reports")
        expect(segments[2]).toBe(runId)
      }
    })

    test("RunView carries the keys, the pinned version and the verification status", async () => {
      const runId = await enqueue()
      await walkToCompletion(runId)

      const run = (await findOwnedRun(userId, runId))!
      const view = toRunView(run, await resolveRunExtras(run))

      expect(view.verificationStatus).toBe("pass")
      expect(view.templateVersion).toBe(1)
      expect(view.templateName).toBe("Monthly utilization")

      // Keys, never URLs — Requirement 40.3. A run payload has to be renderable and
      // cacheable without carrying a credential.
      const serialized = JSON.stringify(view)
      expect(serialized).not.toContain("signature=")
      expect(serialized).not.toContain("X-Amz-")
      for (const key of view.artifactKeys) {
        expect(key.startsWith("https://")).toBe(false)
      }
    })

    test("no secret and no run-scoped credential survives into a browser-facing shape", async () => {
      const runId = await enqueue()
      await walkToCompletion(runId)

      const run = (await findOwnedRun(userId, runId))!
      const view = JSON.stringify(toRunView(run, await resolveRunExtras(run)))
      const verification = await latestForRun(runId)
      const panel = JSON.stringify(toVerificationView(verification.latest!))
      const row = JSON.stringify(await readRow(runId))
      const logs = logLines.join("\n")

      for (const [name, value] of [
        ["client_secret", AZURE.clientSecret],
        ["tenant_id", AZURE.tenantId],
        ["client_id", AZURE.clientId],
        ["progress_token", deriveProgressToken(runId)],
      ] as const) {
        expect(view, `${name} survived into RunView`).not.toContain(value)
        expect(panel, `${name} survived into the panel`).not.toContain(value)
        expect(row, `${name} was persisted on the run row`).not.toContain(value)
        expect(logs, `${name} reached a log line`).not.toContain(value)
      }

      // Not vacuous: the values really were handled on the way to the runtime.
      const context = JSON.stringify(agentcore.calls[0].context)
      expect(context).toContain(AZURE.clientSecret)
      expect(context).toContain(deriveProgressToken(runId))
    })

    test("every quoted excerpt in a stored finding is at most 200 characters", async () => {
      // Requirement 43.7's app-side half. The agent truncates; this asserts the artifact
      // the panel renders from really is bounded, over a result read from the agent's own
      // corpus rather than one this file composed.
      const runId = await enqueue()
      await runTick()
      await postPhase(runId, { phase: "collecting", current: 0, total: 1 })
      for (const phase of ["compiling", "rendering", "verifying"] as const) {
        await postPhase(runId, { phase })
      }
      await postVerification(runId, "fail")

      const { latest } = await latestForRun(runId)
      const findings = latest!.findings as readonly Record<string, unknown>[]
      expect(findings.length).toBeGreaterThan(0)

      for (const finding of findings) {
        for (const field of ["observed", "expected", "message", "detail"]) {
          const value = finding[field]
          if (typeof value === "string") {
            expect(
              value.length,
              `${field}: ${value.length}`
            ).toBeLessThanOrEqual(200)
          }
        }
      }
    })
  }
)

// ---------------------------------------------------------------------------
// Requirements 40.1 to 40.4, 25.3 — the delivery gate from the browser's side
// ---------------------------------------------------------------------------

describe.skipIf(!db.enabled)("Requirement 40 — the download gate", () => {
  test("exactly two controls, each minting a fresh short-lived URL at activation", async () => {
    const runId = await enqueue()
    await walkToCompletion(runId)

    const run = (await findOwnedRun(userId, runId))!
    const view = toRunView(run, await resolveRunExtras(run))

    // The set of controls the surface renders — `DownloadCard` filters the row's recorded
    // keys by the two downloadable leaf names, so this is that filter over the real row.
    const controls = view.artifactKeys.filter((key) =>
      DOWNLOADABLE_LEAF_NAMES.some((leaf) => key.endsWith(`/${leaf}`))
    )
    expect(controls).toHaveLength(2)

    // Requirement 40.1 — nothing was minted at surface render. The page read the row, the
    // extras and the verification, and made no storage call.
    expect(s3.presigns).toEqual([])

    for (const key of controls) {
      const response = await requestDownload(key)
      expect(response.status, await response.clone().text()).toBe(200)
      const body = (await response.json()) as {
        url: string
        expiresIn: number
      }
      expect(body.url).toContain(key)
      // Requirement 40.3 — at most 300 seconds, from the module's own ceiling.
      expect(body.expiresIn).toBe(MAX_PRESIGN_SECONDS)
      expect(body.expiresIn).toBeLessThanOrEqual(300)
      // And never cached: this is the one response body in the app that is a credential.
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("vary")).toBe("Cookie")
    }

    expect(s3.presigns.map((minted) => minted.key).sort()).toEqual(
      [...controls].sort()
    )

    // Requirement 40.3's other half — a **fresh** URL per activation rather than a reused
    // one. Two activations of the same control, two distinct signatures.
    const first = await (await requestDownload(controls[0])).json()
    const second = await (await requestDownload(controls[0])).json()
    expect((first as { url: string }).url).not.toBe(
      (second as { url: string }).url
    )
    expect(s3.presigns).toHaveLength(4)
  })

  test("a run whose verification failed returns no URL and makes no storage call", async () => {
    const runId = await enqueue()
    await runTick()
    await postPhase(runId, { phase: "collecting", current: 0, total: 1 })
    for (const phase of ["compiling", "rendering", "verifying"] as const) {
      await postPhase(runId, { phase })
    }
    await postVerification(runId, "fail")
    await postPhase(runId, {
      phase: "failed",
      error_code: "VERIFICATION_FAILED",
      error_message: "withheld",
    })

    const key = reportArtifactKey(userId, runId, "report.docx")
    const response = await requestDownload(key)

    expect(response.status).toBe(404)
    expect(s3.presigns).toEqual([])
    // Requirement 25.3 — and no field of the run is disclosed either.
    const body = await response.text()
    expect(body).not.toContain(runId)
    expect(body).not.toContain("VERIFICATION_FAILED")
  })

  test("a completed run with no verification at all returns no URL", async () => {
    // The state the precondition normally prevents, forced directly: the row says the
    // pipeline finished and only the verification says the document was *proven*, and a
    // download depends on the second.
    const runId = await enqueue()
    await walkToCompletion(runId)
    await db.query(`DELETE FROM report_verifications WHERE run_id = $1`, [
      runId,
    ])

    expect(await readLatestVerificationStatus(runId)).toBeUndefined()

    const response = await requestDownload(
      reportArtifactKey(userId, runId, "report.pdf")
    )
    expect(response.status).toBe(404)
    expect(s3.presigns).toEqual([])
  })

  test("a run still verifying returns no URL, whatever key is named", async () => {
    const runId = await enqueue()
    await runTick()
    await postPhase(runId, { phase: "collecting", current: 0, total: 1 })
    for (const phase of ["compiling", "rendering", "verifying"] as const) {
      await postPhase(runId, { phase })
    }
    await postVerification(runId, "pass")

    // A passing verification is stored, so this isolates the run's own status: the
    // artifacts do not exist yet, because the upload happens after the pass.
    expect(await readLatestVerificationStatus(runId)).toBe("pass")
    expect(
      recordedArtifactKeys((await findOwnedRun(userId, runId))!).size
    ).toBe(0)

    for (const leaf of DOWNLOADABLE_LEAF_NAMES) {
      const response = await requestDownload(
        reportArtifactKey(userId, runId, leaf)
      )
      expect(response.status).toBe(404)
    }
    expect(s3.presigns).toEqual([])
  })

  test("a key this run never recorded is not found, and neither is another user's", async () => {
    const runId = await enqueue()
    await walkToCompletion(runId)

    // A well-formed key, under my own prefix, for a run of mine, naming an object the run
    // never wrote. Requirement 40.5 — otherwise this route is a bucket probe.
    expect(
      (await requestDownload(`${userId}/reports/${runId}/ledger.json`)).status
    ).toBe(404)

    // The near miss Requirement 43.3 exists to rule out: a `startsWith` predicate
    // authorizes a first segment that merely *begins* with the signed-in user's id.
    expect(
      (await requestDownload(`${userId}-evil/reports/${runId}/report.pdf`))
        .status
    ).toBe(404)

    guard.user = { id: `user-${randomUUID()}`, email: "eve@example.com" }
    expect(
      (await requestDownload(reportArtifactKey(userId, runId, "report.docx")))
        .status
    ).toBe(404)

    expect(s3.presigns).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Requirements 42.12, 42.13 — the relay is a view of the row
// ---------------------------------------------------------------------------

describe.skipIf(!db.enabled)(
  "Requirements 42.12, 42.13 — the relay reconstructs from the row",
  () => {
    test("each document phase is reconstructed from the row alone, on a fresh cursor", async () => {
      const runId = await enqueue()
      await runTick()
      await postPhase(runId, { phase: "collecting", current: 0, total: 1 })

      // A **fresh** cursor each time, which is what a reconnecting client has. So each
      // iteration is the reconstruction Requirement 42.12 requires "before rendering",
      // not an incremental update on top of what a previous connection had seen.
      for (const phase of ["compiling", "rendering", "verifying"] as const) {
        await postPhase(runId, { phase, current: 3, total: BLOCK_COUNT })
        const row = (await findOwnedRun(userId, runId))!

        expect(row.status).toBe(phase)

        // The displayed state, reconstructed from the row alone: the badge's label and
        // the "still working" sentence both come from `status` through one vocabulary.
        // This is what Requirement 42.12 requires "before rendering", and it is why
        // `TIMEOUT` — which arrives with no event at all — is not a hole.
        const view = toRunView(row, await resolveRunExtras(row))
        expect(view.status).toBe(phase)
        expect(RUN_STATUS_PRESENTATION[view.status].inFlight).toBe(true)
        expect(RUN_STATUS_PRESENTATION[view.status].label).toBe(
          {
            compiling: "Compiling",
            rendering: "Rendering",
            verifying: "Verifying",
          }[phase]
        )
        // No verification exists yet, so the panel says "not verified" rather than
        // failing — and no artifact key is projected either (Requirement 40.4).
        expect(view.verificationStatus).toBeNull()
        expect(view.artifactKeys).toEqual([])

        // Requirement 42.13 — the relay carries nothing that is not in the row. It
        // derives no `verification` and no `report_file` on any path, which is what
        // makes "a `report_file` never precedes a passing `verification`" impossible to
        // violate here rather than merely unobserved.
        const { events } = deriveRelayEvents(EMPTY_CURSOR, row, [])
        const types = events.map((event) => event.type)
        expect(types).not.toContain("verification")
        expect(types).not.toContain("report_file")
      }
    })

    test("the completed run's stream is snapshot_ready then done, and the panel comes from the stored result", async () => {
      const runId = await enqueue()
      await walkToCompletion(runId)

      const response = await stream(
        new Request(`${APP_BASE_URL}/api/runs/${runId}/stream`),
        { params: Promise.resolve({ runId }) }
      )
      const events = await readRelayEvents(response, 2)

      expect(events.map((event) => event.type)).toEqual([
        "snapshot_ready",
        "done",
      ])
      expect(events[1]).toEqual({ type: "done", status: "completed" })

      // Requirement 42.12 — the panel a reconnecting client renders comes from the stored
      // verification, not from an event it may never have received. The relay emitted no
      // `verification` above, and this is the object that stands in for it.
      const { latest } = await latestForRun(runId)
      expect(latest).toBeDefined()
      expect(toVerificationView(latest!).status).toBe("pass")
      expect(await readLatestVerificationStatus(runId)).toBe("pass")

      // No AgentCore invocation was made by the relay: the run was invoked by the tick, in
      // a request that has already returned, so there is no upstream stream to attach to.
      expect(agentcore.calls).toHaveLength(1)
    })

    test("closing the stream mid-phase changes no outcome", async () => {
      const runId = await enqueue()
      await runTick()
      await postPhase(runId, { phase: "collecting", current: 0, total: 1 })
      await postPhase(runId, {
        phase: "compiling",
        current: 1,
        total: BLOCK_COUNT,
      })

      // Open a stream over the in-flight row and cut it, exactly as a client navigating
      // away does — through the request's own `AbortSignal`, which is the signal the
      // route listens for, so its teardown runs rather than being bypassed.
      const cut = new AbortController()
      const opened = await stream(
        new Request(`${APP_BASE_URL}/api/runs/${runId}/stream`, {
          signal: cut.signal,
        }),
        { params: Promise.resolve({ runId }) }
      )
      expect(opened.status).toBe(200)
      cut.abort()

      const before = await readRow(runId)

      // The rest of the walk, with nobody watching.
      await postPhase(runId, { phase: "rendering" })
      await postPhase(runId, { phase: "verifying" })
      await postVerification(runId, "pass")
      await postPhase(runId, {
        phase: "completed",
        snapshot_id: "a3f9".repeat(16),
        resource_count: RESOURCE_COUNT,
        gap_count: 0,
      })

      const after = await readRow(runId)
      expect(before.status).toBe("compiling")
      expect(after.status).toBe("completed")
      expect(await readLatestVerificationStatus(runId)).toBe("pass")

      // And the download gate is open, which is the outcome that would have been lost if
      // the relay had been load-bearing.
      writeSnapshotObject(runId)
      const run = (await findOwnedRun(userId, runId))!
      expect(recordedArtifactKeys(run).size).toBeGreaterThan(0)
      expect(
        (await requestDownload(reportArtifactKey(userId, runId, "report.docx")))
          .status
      ).toBe(200)
      expect((await loadRunGaps(run)).length).toBe(0)
    })
  }
)

/**
 * Every `data:` payload the relay route emitted, reading until it has `expected` events
 * or the budget runs out, then cancelling.
 *
 * Real timers, deliberately: the poll loop awaits real Postgres reads, and faking timers
 * here would also fake the driver's own. Cancelling is what lets a case about an **open**
 * stream finish at all, and it models a client navigating away, so the route's abort
 * handling is exercised rather than bypassed.
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
