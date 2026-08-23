import "server-only"

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore"

import type { RunScope } from "@/lib/db/schema"
import { requireEnv } from "@/lib/env"

/**
 * `InvokeAgentRuntime` — the app's only path to the agent (Requirement 41).
 *
 * Three decisions in this module are load-bearing, and each of them is a
 * boundary guard's rule rather than a preference:
 *
 * **`import "server-only"` is the first line** (Requirement 6.1). Everything
 * here handles the customer's Azure credentials and the run-scoped
 * `progress_token`; a client component importing it should be a build error, not
 * a review comment.
 *
 * **The ARN is read from `process.env.RPT_RUNTIME_ARN` at call time**
 * (Requirements 41.1, 6.3) — never captured at module load, never written into
 * source. A module-level `const` would freeze the value at import, so a
 * redeployed runtime would need a process restart to be reachable, and it would
 * turn a missing variable into a module-load crash in whatever imported this
 * transitively rather than a named error at the moment something invoked.
 * `test/boundaries.static.test.ts` fails on the literal `arn:aws:` +
 * `bedrock-agentcore:` appearing in any source file, which is what keeps a
 * hardcoded ARN from being the shortcut it otherwise would be.
 *
 * **{@link AgentInvokeContext} is closed at twelve fields** (Requirement 41.5).
 * The type *is* the enforcement: "and no further field in that `context`" is not
 * a rule anybody has to remember, because an extra key is a type error at the
 * one place that constructs the object.
 */

/** How the payload's `command` is spelled — the agent's `COMMANDS` set. */
export const COMMAND_GENERATE_REPORT = "generate_report"
export const COMMAND_PREFLIGHT = "preflight"

/**
 * A layout preview of a definition the consultant has **not saved**
 * (Requirement 14.5).
 *
 * The definition travels inline rather than as a stored version id, and that is
 * the whole point: the wizard previews what is on screen, and a preview of a
 * saved version would be a preview of something else. It also means a preview
 * creates no version — Requirement 11.4 keeps a draft out of
 * `report_template_versions`, and a "preview" that quietly published one to have
 * an id to send would defeat it.
 */
export const COMMAND_RENDER_PREVIEW = "render_preview"

/**
 * The distinct dimensions of one subscription's inventory, for the wizard's
 * pickers (Requirement 9.3).
 *
 * A **command**, so no model decides whether to look. The endpoint behind it exists
 * because the app issues no Azure request and holds no Azure access token: the
 * Resource Graph query runs inside the container the customer's credentials were
 * shipped to anyway, and the four dimensions come back on the terminal `done`
 * event with no new event type added for them.
 */
export const COMMAND_LIST_INVENTORY = "list_inventory"

/** The default report timezone (Requirement 41.5). The customer is UTC+07:00. */
export const DEFAULT_TIMEZONE = "Asia/Jakarta"

/**
 * The MIME type the runtime is asked to answer in (Requirement 41.7).
 *
 * The runtime streams SSE, so this is not cosmetic: it selects the streaming
 * response shape rather than a buffered JSON body.
 */
export const INVOKE_ACCEPT = "text/event-stream"

/** The payload is JSON, whatever the response is. */
export const INVOKE_CONTENT_TYPE = "application/json"

/**
 * The invocation `context` — **exactly** the twelve fields of Requirement 41.5,
 * and the set is closed.
 *
 * Snake_case because these names cross a language boundary: they are read by
 * `agent/src/reporting_agent/main.py` and by `azure/preflight.py`, and one
 * spelling on both sides is worth more than each side's local convention.
 *
 * Three of these are the customer's Azure credentials and one is a credential of
 * ours:
 *
 * `tenant_id`, `client_id` and `client_secret` are resolved from the run's
 * `connected_subscriptions` row on the server and decrypted at invoke time
 * (Requirement 41.3). No value for any of the three is ever accepted from a
 * browser request (Requirement 41.4).
 *
 * `progress_token` is a **secret too**, and gets the same treatment. It is easy
 * to under-rate as "only" an internal callback credential, but it authorizes
 * writes to the run state machine, so a leaked token lets someone mark a run
 * `completed`. It is never logged and never echoed into an event — the agent
 * registers it with its redaction guard, and `lib/aws/redact.ts` strips it on
 * the way to the browser.
 *
 * `actor_id` is the run's `user_id` (Requirement 41.11), which is what makes the
 * S3 prefix the runtime writes under the same prefix
 * `lib/aws/s3.ts#keyBelongsToActor` compares a download request against.
 */
export interface AgentInvokeContext {
  /** The run's `user_id`. Scopes agent memory and prefixes every artifact key. */
  actor_id: string
  /** The customer's Azure subscription GUID, unmasked — this is server-side. */
  subscription_id: string
  /** **Secret.** */
  tenant_id: string
  /** **Secret.** */
  client_id: string
  /** **Secret.** Decrypted from `client_secret_enc` at invoke time. */
  client_secret: string
  /** IANA zone name; decides local-day bucketing, so it is not cosmetic. */
  timezone: string
  /** The customer label the consultant gave this connection. */
  display_name: string
  fidelity_tier: "baseline" | "enhanced"
  /** Set on the `enhanced` tier, `null` on `baseline` — a genuine absence. */
  log_analytics_workspace_id: string | null
  run_id: string
  /** Built from `RPT_APP_BASE_URL` (Requirement 41.6). */
  progress_url: string
  /** **Secret.** Run-scoped HMAC; authorizes writes to the state machine. */
  progress_token: string
}

/**
 * The context a **preview** invocation carries, and it is deliberately tiny.
 *
 * A preview renders a stored snapshot. It issues no Azure request, so it needs
 * no `client_secret`, no `tenant_id` and no `client_id`; it writes no run state,
 * so it needs no `progress_url` and no `progress_token`. Every one of those is a
 * secret, and the cheapest way to guarantee a code path cannot leak one is for
 * the path to never receive it.
 *
 * Expressed as its own type rather than as `Partial<AgentInvokeContext>` so the
 * absence is a decision the type records rather than a set of fields somebody
 * forgot. Requirement 41.5 closes the full context at twelve fields; this closes
 * the preview context at two, and the guard in `test/boundaries.static.test.ts`
 * that asserts no secret crosses a browser boundary has one less path to walk.
 *
 * `run_id` carries the **preview id**. The runtime's step events want an id and
 * this is the one that identifies the work; no `report_runs` row exists for it,
 * which is exactly right — a preview is not a run.
 */
export interface PreviewInvokeContext {
  actor_id: string
  run_id: string
}

/**
 * The deterministic commands this spec's runtime accepts, and **nothing else**.
 *
 * There is no `prompt` member and no `prompt` field on either variant
 * (Requirement 41.8). That absence is the product invariant expressed as a type:
 * report generation must be reachable without a model deciding to call a tool,
 * so the shape that reaches the runtime cannot carry a prompt for it to consider.
 *
 * `compare_runs` and `verify_report` belong to the specs that add the
 * compile/render/verify pipeline; naming one here would let the app send a
 * command the runtime has no route for.
 */
/**
 * One historical-trend candidate in the invoke payload (Requirement 18.4).
 *
 * Matches the wire shape `compile/historical.py` receives. The field names use
 * snake_case to match the agent's Python dataclass and the rest of the payload.
 */
export interface HistoricalCandidatePayload {
  readonly id: string
  readonly period_start: string
  readonly period_end: string
  readonly timezone: string
  readonly status: string
  readonly verification_id: string | null
  readonly verification_status: string | null
  readonly verification_created_at: string | null
  readonly verification_snapshot_sha256: string | null
}

export type InvokeCommand =
  /**
   * `generate_report`, in the two shapes the runtime's contract admits.
   *
   * The pinned version and its definition travel **together or not at all**, which
   * the union expresses rather than leaving to a convention: a payload naming a
   * version with no definition would be a snapshot-only run wearing a report run's
   * label, and the runtime would have no way to tell that was not intended.
   */
  | {
      command: typeof COMMAND_GENERATE_REPORT
      /**
       * The version the run pinned at enqueue (Requirement 9.6). The runtime
       * checks the run against this version and no other.
       */
      template_version_id: string
      /**
       * That version's definition, **inline**.
       *
       * The runtime has no access to this app's database, so a payload naming a
       * version id and nothing else would leave it with no template to compile.
       * Its own contract states the consequence plainly: *a payload carrying no
       * `definition` is a snapshot-only run* — legal, and not what a
       * `generate_report` triggered from the report form is asking for. Sending
       * the id without the definition is therefore not a smaller version of this
       * command; it is a different one, and it silently produces no document.
       *
       * `unknown` rather than `TemplateDefinition`, matching `render_preview`: the
       * value is the stored `definition` jsonb, and the authority on whether it
       * compiles is the runtime's `_assert_compilable`, which fails the run as
       * `TEMPLATE_INVALID` before a single metric is requested. A second typed
       * copy of that rule here would be a third statement of a schema the mirror
       * guard already keeps in two places.
       */
      definition: unknown
      /** Local calendar dates in the context's `timezone`, `YYYY-MM-DD`. */
      period: { start: string; end: string }
      scope: RunScope
      /**
       * Historical-trend candidates (Requirement 18.4).
       *
       * Up to 200 prior runs of the same template row and subscription, each
       * carrying its latest verification. The agent's `compile/historical.py`
       * receives this as a supplied candidate list and applies the pure selector.
       *
       * Optional: absent for snapshot-only reruns and for runs whose pinned
       * definition declares no `historical_trend` block. The selector treats
       * an absent list as an empty trend.
       */
      historical_candidates?: readonly HistoricalCandidatePayload[]
    }
  /**
   * A **snapshot-only** run: no pinned version, so no document.
   *
   * Still legal by the runtime's contract, and reachable here for exactly one row
   * shape — a foundation-era `report_runs` row whose `template_version_id` is
   * `null`. `?: never` rather than omitting the keys, so a caller cannot satisfy
   * this member while setting one of the two and think it satisfied the other.
   */
  | {
      command: typeof COMMAND_GENERATE_REPORT
      template_version_id?: never
      definition?: never
      period: { start: string; end: string }
      scope: RunScope
    }
  | { command: typeof COMMAND_PREFLIGHT }
  /**
   * `list_inventory` — no field but the command.
   *
   * Everything it reads is already in the `context`: the subscription id and the
   * three credential fields. There is no run id because there is no row, and no
   * scope because the query covers the whole subscription — a scope argument would
   * be a filter on the very list the pickers exist to offer.
   */
  | { command: typeof COMMAND_LIST_INVENTORY }
  | {
      command: typeof COMMAND_RENDER_PREVIEW
      /** Minted per activation; the key the runtime writes under. */
      preview_id: string
      /** A **completed** run the actor owns, whose snapshot supplies the figures. */
      snapshot_run_id: string
      /**
       * The composed definition, inline.
       *
       * `unknown` rather than a typed definition: this is a draft mid-authoring,
       * so it is exactly the shape the validator has *not* yet accepted. The
       * runtime validates it (`_assert_compilable`) and fails the preview if it
       * cannot compile, which is the right place for that verdict — the app
       * would otherwise hold a second copy of a rule the mirror guard already
       * covers twice.
       */
      definition: unknown
    }

/**
 * `RPT_RUNTIME_ARN` is unset or empty (Requirement 41.2).
 *
 * Typed, and thrown **before** any SDK call, so a caller can tell a
 * configuration mistake from a service failure. The tick's gate depends on that
 * distinction: an unconfigured deployment must not consume a claim and mark a
 * run failed as though the runtime had refused it.
 *
 * The message names the variable and excludes its value, the same rule
 * `lib/env.ts` follows.
 */
export class MissingRuntimeConfigError extends Error {
  readonly variableName: string

  constructor(variableName: string) {
    super(
      `${variableName} is not set, or is set to an empty or whitespace-only ` +
        `value, so the AgentCore runtime cannot be addressed. No SDK call was ` +
        `made. Set it in the environment; app/.env.example describes the ` +
        `expected shape. Its value is excluded from this message.`
    )
    this.name = "MissingRuntimeConfigError"
    this.variableName = variableName
  }
}

/**
 * Cached on `globalThis`, for the reason `lib/db/index.ts` caches its pool
 * there: Next's dev server re-evaluates a module on every hot reload while the
 * process survives, so a module-level `const` would leak one client — and its
 * connection agent — per edit.
 *
 * Keyed by region so a region changed in the environment builds a new client
 * rather than reusing one pointed at the old one. The **ARN** is deliberately
 * not part of this key: it is not client configuration, it is a per-call
 * argument, and reading it per call is Requirement 41.1.
 */
const cache = globalThis as typeof globalThis & {
  __rptAgentCoreClient?: BedrockAgentCoreClient
  __rptAgentCoreRegion?: string
}

/** The client for the region currently in the environment. */
function getClient(): BedrockAgentCoreClient {
  const region = requireEnv("AWS_REGION")

  if (
    cache.__rptAgentCoreClient !== undefined &&
    cache.__rptAgentCoreRegion === region
  ) {
    return cache.__rptAgentCoreClient
  }

  const client = new BedrockAgentCoreClient({ region })
  cache.__rptAgentCoreClient = client
  cache.__rptAgentCoreRegion = region
  return client
}

/**
 * Resolve the runtime ARN from the environment (Requirements 41.1, 41.2).
 *
 * Exported so the tick can fail a configuration problem before it claims work,
 * rather than discovering it per row after the claim is already committed.
 */
export function resolveRuntimeArn(): string {
  const configured = process.env.RPT_RUNTIME_ARN

  if (configured === undefined || configured.trim().length === 0) {
    throw new MissingRuntimeConfigError("RPT_RUNTIME_ARN")
  }

  return configured
}

/**
 * The bytes of one invoke payload: the command, flattened, plus the context
 * (Requirement 41.8).
 *
 * Separated from the send so it is assertable without an AWS client, and so
 * there is exactly one place the wire shape is written. The command's fields are
 * spread **before** `context`, so no command field can shadow it.
 */
export function buildInvokePayload(
  command: InvokeCommand,
  context: AgentInvokeContext | PreviewInvokeContext
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ...command, context }))
}

/**
 * Invoke the runtime and return its response stream.
 *
 * `runtimeSessionId` is supplied by the caller — `lib/session-id.ts` derives it,
 * from the run's id for a run (Requirement 8.5) — so this module holds no
 * derivation of its own and the 33–128 bound stays satisfied in one place.
 *
 * Returns the raw byte stream. Parsing SSE frames out of it is the caller's
 * business: the tick discards the bytes without parsing an event
 * (Requirement 39.6), while the preflight route consumes the short stream
 * inline. Neither reading is privileged here.
 *
 * Nothing in this function logs the payload or the context. There is no
 * "helpful" debug line to remove later, because a single `console.log` of the
 * argument would put the customer's client secret and this run's
 * `progress_token` into the app's log stream.
 */
export async function invokeAgentRuntime(a: {
  sessionId: string
  context: AgentInvokeContext | PreviewInvokeContext
  command: InvokeCommand
}): Promise<AsyncIterable<Uint8Array>> {
  // Before the client, so an unconfigured deployment makes no SDK call at all
  // (Requirement 41.2) — not even a credential resolution.
  const agentRuntimeArn = resolveRuntimeArn()

  const response = await getClient().send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn,
      runtimeSessionId: a.sessionId,
      contentType: INVOKE_CONTENT_TYPE,
      accept: INVOKE_ACCEPT,
      payload: buildInvokePayload(a.command, a.context),
    })
  )

  const stream = response.response

  if (stream === undefined || !isByteStream(stream)) {
    throw new Error(
      `The AgentCore runtime returned no readable response stream ` +
        `(statusCode ${response.statusCode ?? "unknown"}), so the invocation ` +
        `did not start.`
    )
  }

  return stream
}

/**
 * Is this the Node streaming shape — an async iterable of bytes?
 *
 * `StreamingBlobTypes` is a union across runtimes: a `Readable` on Node, a
 * `ReadableStream` or `Blob` in a browser. This app's route handlers all declare
 * `export const runtime = "nodejs"`, so the Node member is the one that occurs;
 * the check is here so the other members fail as a stated error rather than as a
 * `TypeError` from a `for await` three frames away.
 */
function isByteStream(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] ===
      "function"
  )
}
