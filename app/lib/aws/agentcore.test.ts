import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { AgentInvokeContext, InvokeCommand } from "@/lib/aws/agentcore"
import {
  COMMAND_GENERATE_REPORT,
  COMMAND_PREFLIGHT,
  DEFAULT_TIMEZONE,
  INVOKE_ACCEPT,
  INVOKE_CONTENT_TYPE,
  MissingRuntimeConfigError,
  buildInvokePayload,
  invokeAgentRuntime,
  resolveRuntimeArn,
} from "@/lib/aws/agentcore"

/**
 * `lib/aws/agentcore.ts` — the invocation contract (Requirements 41.1, 41.2,
 * 41.5, 41.8, 6.3).
 *
 * Three claims are worth machine-checking here, and each of them is the kind that
 * a plausible implementation gets wrong quietly:
 *
 *  1. **The ARN is read at call time.** A module-level capture passes every test
 *     that sets the variable before importing, so the test that matters changes
 *     the variable *between* two calls and asserts the second one sees the new
 *     value.
 *  2. **`AgentInvokeContext` is closed at twelve fields.** Asserted at the type
 *     level as well as over a fixture's keys, so a thirteenth field added to the
 *     interface fails `pnpm typecheck` rather than waiting for someone to notice
 *     the fixture is stale.
 *  3. **No `prompt` field exists on either command.** The deterministic pipeline
 *     must be reachable without a model decision, so the absence is a property of
 *     the type, not a convention.
 *
 * The SDK is faked. What is under test is the request this module builds and the
 * order in which it does its work — not AWS.
 */

const { sent } = vi.hoisted(() => ({
  sent: [] as {
    region: string | undefined
    input: Record<string, unknown>
  }[],
}))

vi.mock("@aws-sdk/client-bedrock-agentcore", () => {
  class InvokeAgentRuntimeCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }

  class BedrockAgentCoreClient {
    constructor(readonly config: { region?: string }) {}

    async send(command: InvokeAgentRuntimeCommand) {
      sent.push({ region: this.config.region, input: command.input })

      async function* bytes(): AsyncGenerator<Uint8Array> {
        yield new TextEncoder().encode('data: {"type":"done"}\n\n')
      }

      return {
        response: bytes(),
        contentType: "text/event-stream",
        statusCode: 200,
      }
    }
  }

  return { BedrockAgentCoreClient, InvokeAgentRuntimeCommand }
})

// --- Fixtures ---------------------------------------------------------------

const ARN =
  "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/reporting-abc123"

const REGION = "us-east-1"

/**
 * Requirement 41.5's twelve field names, written out once.
 *
 * Deliberately a literal list rather than `Object.keys` of the fixture: the
 * fixture is what it is checked *against*, and a list derived from the thing
 * under test asserts nothing.
 */
const CONTEXT_FIELDS = [
  "actor_id",
  "subscription_id",
  "tenant_id",
  "client_id",
  "client_secret",
  "timezone",
  "display_name",
  "fidelity_tier",
  "log_analytics_workspace_id",
  "run_id",
  "progress_url",
  "progress_token",
] as const

type DeclaredContextField = (typeof CONTEXT_FIELDS)[number]

/**
 * `true` only when the two key sets are mutually assignable.
 *
 * This is the closure guard: adding a field to `AgentInvokeContext` without
 * adding it to {@link CONTEXT_FIELDS} — or the reverse — makes the constant below
 * a type error, so "and no further field in that `context`" fails `pnpm
 * typecheck` instead of being a rule someone has to remember.
 */
type KeysMatch<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false

const CONTEXT_IS_CLOSED: KeysMatch<
  keyof AgentInvokeContext,
  DeclaredContextField
> = true

/** `true` only when `T` has no `prompt` key (Requirement 41.8). */
type HasNoPrompt<T> = "prompt" extends keyof T ? false : true

const GENERATE_REPORT_HAS_NO_PROMPT: HasNoPrompt<
  Extract<InvokeCommand, { command: "generate_report" }>
> = true

const PREFLIGHT_HAS_NO_PROMPT: HasNoPrompt<
  Extract<InvokeCommand, { command: "preflight" }>
> = true

const SECRET = "azure-client-secret-value"
const TOKEN = "run-scoped-progress-token"

const CONTEXT: AgentInvokeContext = {
  actor_id: "user-01HZX9",
  subscription_id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  tenant_id: "tenant-01HZX9",
  client_id: "client-01HZX9",
  client_secret: SECRET,
  timezone: DEFAULT_TIMEZONE,
  display_name: "Contoso production",
  fidelity_tier: "baseline",
  log_analytics_workspace_id: null,
  run_id: "run-01HZX9",
  progress_url:
    "https://reporting.example.com/api/internal/runs/run-01HZX9/progress",
  progress_token: TOKEN,
}

const GENERATE: InvokeCommand = {
  command: COMMAND_GENERATE_REPORT,
  period: { start: "2026-07-01", end: "2026-07-31" },
  scope: {
    resource_types: ["Microsoft.Compute/virtualMachines"],
    resource_groups: [],
    tag_filters: {},
  },
}

// --- Environment ------------------------------------------------------------

/**
 * The environment is restored around every test, and the cached client is
 * dropped, so a test that changes the region genuinely rebuilds a client rather
 * than reusing one from a previous test.
 */
const clientCache = globalThis as typeof globalThis & {
  __rptAgentCoreClient?: unknown
  __rptAgentCoreRegion?: string
}

let savedArn: string | undefined
let savedRegion: string | undefined

beforeEach(() => {
  savedArn = process.env.RPT_RUNTIME_ARN
  savedRegion = process.env.AWS_REGION
  delete clientCache.__rptAgentCoreClient
  delete clientCache.__rptAgentCoreRegion
  sent.length = 0
})

afterEach(() => {
  if (savedArn === undefined) delete process.env.RPT_RUNTIME_ARN
  else process.env.RPT_RUNTIME_ARN = savedArn

  if (savedRegion === undefined) delete process.env.AWS_REGION
  else process.env.AWS_REGION = savedRegion
})

// ---------------------------------------------------------------------------

describe("Requirement 41.5 — the invoke context is closed at twelve fields", () => {
  test("the type's key set and the declared field list agree", () => {
    // The assertion is the type annotation on `CONTEXT_IS_CLOSED`; this test
    // exists so the constant is referenced and the count is stated in one place.
    expect(CONTEXT_IS_CLOSED).toBe(true)
    expect(CONTEXT_FIELDS).toHaveLength(12)
    expect(new Set(CONTEXT_FIELDS).size).toBe(12)
  })

  test("a built context carries exactly those twelve keys", () => {
    expect(Object.keys(CONTEXT).sort()).toEqual([...CONTEXT_FIELDS].sort())
  })

  test("timezone defaults to Asia/Jakarta", () => {
    // Not cosmetic: it decides local-day bucketing and therefore every daily
    // figure in the report.
    expect(DEFAULT_TIMEZONE).toBe("Asia/Jakarta")
  })
})

describe("Requirement 41.8 — no command carries a prompt", () => {
  test("neither variant has a `prompt` key", () => {
    expect(GENERATE_REPORT_HAS_NO_PROMPT).toBe(true)
    expect(PREFLIGHT_HAS_NO_PROMPT).toBe(true)
  })

  test("the two commands are the deterministic pair", () => {
    expect(COMMAND_GENERATE_REPORT).toBe("generate_report")
    expect(COMMAND_PREFLIGHT).toBe("preflight")
  })

  test("a serialized payload contains no `prompt` field at any depth", () => {
    const json = new TextDecoder().decode(buildInvokePayload(GENERATE, CONTEXT))

    expect(json).not.toContain("prompt")
    expect(JSON.parse(json)).toEqual({
      command: "generate_report",
      period: { start: "2026-07-01", end: "2026-07-31" },
      scope: {
        resource_types: ["Microsoft.Compute/virtualMachines"],
        resource_groups: [],
        tag_filters: {},
      },
      context: CONTEXT,
    })
  })

  test("a preflight payload carries the command and the context and nothing else", () => {
    const payload = JSON.parse(
      new TextDecoder().decode(
        buildInvokePayload({ command: COMMAND_PREFLIGHT }, CONTEXT)
      )
    ) as Record<string, unknown>

    expect(Object.keys(payload).sort()).toEqual(["command", "context"])
    expect(payload.command).toBe("preflight")
  })
})

describe("Requirements 41.1, 41.2, 6.3 — the ARN is resolved at call time", () => {
  test("the configured value is returned verbatim", () => {
    process.env.RPT_RUNTIME_ARN = ARN

    expect(resolveRuntimeArn()).toBe(ARN)
  })

  test("a value changed between calls resolves to the new value", () => {
    // The test a module-level capture fails. Nothing else in this file would
    // notice the difference.
    process.env.RPT_RUNTIME_ARN = ARN
    expect(resolveRuntimeArn()).toBe(ARN)

    const rotated = `${ARN}-v2`
    process.env.RPT_RUNTIME_ARN = rotated
    expect(resolveRuntimeArn()).toBe(rotated)
  })

  test.each([
    ["absent", undefined],
    ["empty", ""],
    ["whitespace-only", "   "],
  ])("a %s value throws MissingRuntimeConfigError", (_label, value) => {
    if (value === undefined) delete process.env.RPT_RUNTIME_ARN
    else process.env.RPT_RUNTIME_ARN = value

    expect(() => resolveRuntimeArn()).toThrow(MissingRuntimeConfigError)
  })

  test("the error names the variable and excludes its value", () => {
    process.env.RPT_RUNTIME_ARN = "  "

    let caught: MissingRuntimeConfigError | undefined
    try {
      resolveRuntimeArn()
    } catch (error) {
      caught = error as MissingRuntimeConfigError
    }

    expect(caught?.variableName).toBe("RPT_RUNTIME_ARN")
    expect(caught?.message).toContain("RPT_RUNTIME_ARN")
    // A value that is whitespace cannot be searched for usefully; what matters
    // is that the message states no value was included and names no other var.
    expect(caught?.message).toContain("excluded from this message")
  })
})

describe("Requirement 41.2 — an unconfigured runtime makes no SDK call", () => {
  test("the ARN is resolved before the client is built", async () => {
    // `AWS_REGION` is deleted too, so anything that reached `getClient()` would
    // throw `MissingEnvError` naming AWS_REGION instead. Getting
    // `MissingRuntimeConfigError` is the proof of ordering.
    delete process.env.RPT_RUNTIME_ARN
    delete process.env.AWS_REGION

    await expect(
      invokeAgentRuntime({
        sessionId: "s".repeat(64),
        context: CONTEXT,
        command: GENERATE,
      })
    ).rejects.toBeInstanceOf(MissingRuntimeConfigError)

    expect(sent).toHaveLength(0)
  })
})

describe("Requirement 41.7 — the request the runtime receives", () => {
  const SESSION_ID = "a".repeat(64)

  test("accept is text/event-stream and the payload is JSON", async () => {
    process.env.RPT_RUNTIME_ARN = ARN
    process.env.AWS_REGION = REGION

    const stream = await invokeAgentRuntime({
      sessionId: SESSION_ID,
      context: CONTEXT,
      command: GENERATE,
    })

    expect(INVOKE_ACCEPT).toBe("text/event-stream")
    expect(INVOKE_CONTENT_TYPE).toBe("application/json")
    expect(sent).toHaveLength(1)

    const { region, input } = sent[0]

    expect(region).toBe(REGION)
    expect(input.agentRuntimeArn).toBe(ARN)
    expect(input.runtimeSessionId).toBe(SESSION_ID)
    expect(input.accept).toBe("text/event-stream")
    expect(input.contentType).toBe("application/json")

    // The returned value is the response stream, iterable as bytes.
    const chunks: Uint8Array[] = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks).toHaveLength(1)
  })

  test("the payload carries the command, the period, the scope and the context", async () => {
    process.env.RPT_RUNTIME_ARN = ARN
    process.env.AWS_REGION = REGION

    await invokeAgentRuntime({
      sessionId: SESSION_ID,
      context: CONTEXT,
      command: GENERATE,
    })

    const payload = JSON.parse(
      new TextDecoder().decode(sent[0].input.payload as Uint8Array)
    ) as Record<string, unknown>

    expect(Object.keys(payload).sort()).toEqual([
      "command",
      "context",
      "period",
      "scope",
    ])
    expect(payload.context).toEqual(CONTEXT)
  })

  test("a rotated ARN reaches the next invocation", async () => {
    process.env.RPT_RUNTIME_ARN = ARN
    process.env.AWS_REGION = REGION

    await invokeAgentRuntime({
      sessionId: SESSION_ID,
      context: CONTEXT,
      command: { command: COMMAND_PREFLIGHT },
    })

    const rotated = `${ARN}-v2`
    process.env.RPT_RUNTIME_ARN = rotated

    await invokeAgentRuntime({
      sessionId: SESSION_ID,
      context: CONTEXT,
      command: { command: COMMAND_PREFLIGHT },
    })

    expect(sent.map(({ input }) => input.agentRuntimeArn)).toEqual([
      ARN,
      rotated,
    ])
  })
})
