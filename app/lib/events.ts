/**
 * The SSE event vocabulary — one contract, expressed in two languages.
 *
 * The declaration below is mirrored in `agent/src/reporting_agent/events.py`
 * (Requirement 40.7), and `app/test/event-mirror.static.test.ts` extracts the
 * quoted strings from between the sentinel comments in both files and compares
 * the two sets (Requirement 40.13). The literals therefore sit on their own,
 * between sentinels, rather than inside a mapped type or an enum: the guard
 * needs neither a TypeScript parser nor a Python parser, so the guard itself
 * cannot drift from what it guards.
 *
 * **The full vocabulary is declared; a subset is emitted.** This spec's runtime
 * drives six of the ten types. `delta`, `chart`, `verification` and
 * `report_file` belong to the specs that add prose, charts and the
 * compile/render/verify pipeline — those specs add *emitters*, not vocabulary,
 * so the mirror never has to be renegotiated.
 *
 * Pure, secret-free and shared with the client, so deliberately not
 * `server-only`: the stream-parsing hook imports `isDeclaredEventType` to
 * ignore an event type it does not know rather than crash on it
 * (Requirement 40.6).
 */

// --- BEGIN EVENT TYPES (mirrored in agent/src/reporting_agent/events.py) ---
export const EVENT_TYPES = [
  "delta",
  "tool",
  "progress",
  "heartbeat",
  "snapshot_ready",
  "chart",
  "verification",
  "report_file",
  "error",
  "done",
] as const
// --- END EVENT TYPES ---

/** One of the ten declared event types. */
export type EventType = (typeof EVENT_TYPES)[number]

/** The terminal event, and the only one permitted to be last. */
export const TERMINAL_EVENT_TYPE = "done" satisfies EventType

const DECLARED: ReadonlySet<string> = new Set<string>(EVENT_TYPES)

/**
 * Is this a declared event type?
 *
 * An older client meeting a newer type must degrade, not crash: an undeclared
 * type is ignored, applies no state change, and the stream keeps being read
 * (Requirement 40.6). That is a narrowing predicate rather than a throwing
 * parse for exactly that reason.
 */
export function isDeclaredEventType(value: unknown): value is EventType {
  return typeof value === "string" && DECLARED.has(value)
}

// --- Per-phase constants ----------------------------------------------------

/**
 * The unit a `progress` event's counts are in, **per phase** (Requirement 40.15).
 *
 * Declared here as a constant rather than carried on the run row, and the
 * requirement is explicit about that: `unit` comes "from the unit that phase
 * declares in `app/lib/events.ts` as a per-phase constant rather than as run
 * state". So there is no `progress_unit` column, and the relay cannot emit a unit
 * a client has never seen — the vocabulary owns it.
 *
 * Keyed by the run status the phase corresponds to, because that is what the relay
 * has in hand: Requirement 40.15 also sets a `progress` event's `id` from the row's
 * `status`, so one lookup serves both fields and they cannot disagree about which
 * phase is being described.
 *
 * `collecting` is the only phase this spec drives that carries a countable unit of
 * work. The three undriven phases are absent rather than mapped to a placeholder: a
 * status with no entry here is a status that emits no `progress` event, which is the
 * same outcome Requirement 40.14 requires of a phase whose counts are absent.
 */
export const PHASE_PROGRESS_UNIT: Readonly<Record<string, string>> =
  Object.freeze({
    collecting: "resources",
  })

/**
 * The `tool` step this spec's relay opens for each non-terminal phase.
 *
 * `name` is drawn from the tool names the agent's own `tool` events use, so a client
 * that later receives real agent events and relay-derived ones renders one timeline
 * rather than two. `label` is the badge the activity timeline shows.
 *
 * The relay derives these from the row's `status`, which is why the `id` of a
 * `progress` event is that same status: the step and the progress bar attached to it
 * are the same phase, named the same way, with no correlation table in between.
 */
export const PHASE_TOOL_STEP: Readonly<
  Record<string, { readonly name: string; readonly label: string }>
> = Object.freeze({
  queued: Object.freeze({ name: "collect_inventory", label: "Queued" }),
  claimed: Object.freeze({ name: "collect_inventory", label: "Starting" }),
  collecting: Object.freeze({ name: "collect_metrics", label: "Collecting" }),
})

// --- Relay timings ----------------------------------------------------------

/**
 * How often the relay re-reads the `report_runs` row (Requirement 40.10).
 *
 * Two seconds, which is what makes the determinate bar at most ~7 seconds stale
 * worst case — the agent's 5-second progress throttle plus this poll — on a run that
 * lasts 8 to 12 minutes. Shared with the hook so the client's reconnect budget is
 * expressed against the same number the server polls at.
 */
export const RELAY_POLL_MS = 2_000

/** How often a `heartbeat` is emitted while the row is non-terminal (Req 40.10). */
export const RELAY_HEARTBEAT_MS = 15_000

/**
 * How long the relay will emit nothing but heartbeats before closing
 * (Requirement 40.3).
 *
 * The relay is a **live view whose loss costs nothing**, so closing it is cheaper
 * than keeping a connection alive through an intermediary that may cut it anyway —
 * CloudFront defaults to a 30-second origin-response timeout and an ALB to a
 * 60-second idle timeout, and both kill SSE far more often than any app-level limit
 * does. For a run sitting in `collecting` for ten minutes this means the relay closes
 * roughly every two minutes and the client reopens; that churn is intentional,
 * because a disposable view that reconnects cleanly is strictly better than a
 * long-lived one that has to be correct.
 */
export const RELAY_IDLE_CLOSE_MS = 120_000

/**
 * How long the client waits before reopening a stream for a non-terminal run
 * (Requirement 40.11).
 *
 * Under the 5 seconds the requirement allows, and deliberately not zero: an
 * immediate reopen against a relay that is closing for a reason other than its idle
 * window — a deploy roll, a proxy — turns one dropped connection into a reconnect
 * loop.
 */
export const RELAY_REOPEN_MS = 2_000
