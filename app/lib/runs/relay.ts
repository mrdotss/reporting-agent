import type { ReportRun, RunErrorCode, RunStatus } from "@/lib/db/schema"
import {
  PHASE_PROGRESS_UNIT,
  PHASE_TOOL_STEP,
  type EventType,
} from "@/lib/events"
import type { RunGap } from "@/lib/runs/gaps"
import { isTerminalStatus } from "@/lib/runs/state"

/**
 * The relay's event derivation — **pure** (Requirement 40).
 *
 * **Not `server-only`.** No I/O, no clock, no database: a cursor and a row's fields
 * go in, and the events that poll should emit come out. The route owns the polling,
 * the heartbeat timer and the idle close; this module owns *what an event says*, which
 * is the part with rules worth machine-checking.
 *
 * ## The relay is cosmetic, and that shapes everything here
 *
 * `report_runs` is authoritative (Requirement 36.6). This stream is a **live view over
 * that row** for a browser that happens to be watching, and **if it drops, nothing is
 * lost** — on reconnect the client replays from the row through
 * `GET /api/runs/[runId]`. Two consequences are load-bearing:
 *
 *   * Requirement 40.5: no event may carry state that cannot be reconstructed from
 *     the row and the stored gap list. So there is no counter here that the row does
 *     not hold, no elapsed time, no "phases seen so far" — the {@link RelayCursor}
 *     exists only to avoid re-emitting what this *connection* already sent, and a
 *     fresh connection with an empty cursor produces a complete picture.
 *   * Requirement 40.10: **no AgentCore invocation.** This is the single most likely
 *     place for an implementer to go wrong, because a relay that invokes the runtime
 *     and forwards its stream is the obvious shape and the sibling project has one.
 *     It is the wrong precedent here: the invocation was started by the cron tick, **in
 *     a different request that has already returned**, so there is no upstream stream
 *     to attach to — and attaching would re-run the collection.
 *
 * ## What is deliberately absent from `snapshot_ready`
 *
 * The agent's own `snapshot_ready` carries `grain` and the window's `utc_offset`,
 * `start_utc` and `end_utc`. The relay's does **not**, because those live in the
 * snapshot document rather than in the row or the gap list, and Requirement 40.5 says
 * an event's payload may draw on nothing outside those two sources. The run detail
 * page reads them server-side through `lib/runs/gaps.ts#loadRunProvenance` and renders
 * them in the provenance panel, which is a page render rather than a relay event.
 *
 * Emitting them here would mean either widening the relay's sources — so a dropped
 * S3 read becomes a broken stream — or inventing a grain, and a stated grain that
 * was not the collector's is worse than an omitted one.
 */

/** One event as it goes on the wire: a declared `type` plus its payload. */
export type RelayEvent = { readonly type: EventType } & Readonly<
  Record<string, unknown>
>

/**
 * What this connection has already emitted.
 *
 * Every field is about the **connection**, not about the run, which is what keeps
 * Requirement 40.5 true: a new connection starts from {@link EMPTY_CURSOR} and emits a
 * complete picture from the row, so nothing here needs to survive a reconnect.
 */
export type RelayCursor = {
  /** The status whose `tool` step is currently open, if any. */
  readonly openStep: RunStatus | null
  /** The last `done` value emitted per step id, so successive values never decrease. */
  readonly lastDone: Readonly<Record<string, number>>
  /** The last `progress` triple emitted, so an unchanged one is not re-sent. */
  readonly lastProgress: string | null
  /** Set once `done` has been emitted; nothing may follow it. */
  readonly finished: boolean
}

export const EMPTY_CURSOR: RelayCursor = Object.freeze({
  openStep: null,
  lastDone: Object.freeze({}),
  lastProgress: null,
  finished: false,
})

/**
 * The fields of the row the relay reads.
 *
 * A `Pick`, so the function's inputs are its type and a column added to
 * `report_runs` cannot silently become relay state. `progress_token_hash`,
 * `claimed_by` and `dedupe_key` are absent because they are absent from every
 * browser-facing shape in this app; `scope` is absent because a run's requested scope
 * is not something a progress view needs.
 */
export type RelayRowState = Pick<
  ReportRun,
  | "status"
  | "errorCode"
  | "errorMessage"
  | "snapshotId"
  | "resourceCount"
  | "gapCount"
  | "progressCurrent"
  | "progressTotal"
  | "progressLabel"
  | "periodStart"
  | "periodEnd"
  | "timezone"
>

/** The prose the relay attaches to a terminal `error` event, per code. */
const TERMINAL_PROSE: Readonly<Partial<Record<RunErrorCode, string>>> =
  Object.freeze({
    TIMEOUT:
      "This run exceeded its phase deadline and was failed automatically. " +
      "That usually means the container stopped before it could report a " +
      "result; nothing was delivered.",
  })

/**
 * The `tool` step id for a status.
 *
 * The status **is** the id (Requirement 40.15 sets a `progress` event's `id` from the
 * row's `status`), so the step and the progress bar attached to it are the same phase
 * named the same way, with no correlation table in between. A separate opaque id would
 * be one more thing to keep consistent across a reconnect for no gain.
 */
function stepIdFor(status: RunStatus): string {
  return status
}

/** The events that close an open step, if one is open. */
function closeStep(cursor: RelayCursor): RelayEvent[] {
  if (cursor.openStep === null) return []

  const step = PHASE_TOOL_STEP[cursor.openStep]
  if (step === undefined) return []

  return [
    {
      type: "tool",
      phase: "end",
      id: stepIdFor(cursor.openStep),
      name: step.name,
    },
  ]
}

/**
 * Derive the events one poll should emit, and the cursor that follows
 * (Requirements 40.5, 40.10, 40.12, 40.14, 40.15).
 *
 * Pure. `gaps` is the stored gap list, which is empty for a non-terminal run and is
 * only read once the row goes terminal.
 *
 * The ordering below is the ordering the contract guarantees, and the UI is allowed
 * to rely on it: `snapshot_ready` precedes any terminal event, and `done` is always
 * last. Nothing is emitted after `done` — {@link RelayCursor.finished} is checked
 * first, so a poll that somehow ran after the terminal event produces nothing rather
 * than a second `done`.
 *
 * This spec's relay emits **six** of the ten declared types: `tool`, `progress`,
 * `heartbeat` (from the route's timer), `snapshot_ready`, `error` and `done`. It never
 * emits `verification` or `report_file`, because nothing here compiles, renders or
 * verifies a document — which is also what makes the "no `report_file` without a
 * passing `verification` before it" ordering guarantee impossible to violate here.
 */
export function deriveRelayEvents(
  cursor: RelayCursor,
  row: RelayRowState,
  gaps: readonly RunGap[]
): { readonly events: readonly RelayEvent[]; readonly cursor: RelayCursor } {
  if (cursor.finished) return { events: [], cursor }

  const events: RelayEvent[] = []
  let next: RelayCursor = cursor

  // --- Terminal --------------------------------------------------------------

  if (isTerminalStatus(row.status)) {
    events.push(...closeStep(next))

    if (row.status === "completed") {
      events.push({
        type: "snapshot_ready",
        // `null` rather than omitted when the terminal callback carried no id. The
        // row is the record, and a payload that quietly dropped an absent field
        // would make "the snapshot id is unknown" look like "there is no snapshot
        // section".
        snapshot_id: row.snapshotId,
        resource_count: row.resourceCount,
        gap_count: row.gapCount,
        // Only what the row holds: the local calendar dates and the zone. The
        // grain and the resolved offset are in the snapshot document, not here —
        // see the module docstring.
        window: {
          start: row.periodStart,
          end: row.periodEnd,
          timezone: row.timezone,
        },
        gaps,
      })
    } else {
      events.push({
        type: "error",
        // The CHECK constraint guarantees a `failed` row carries a code, so the
        // fallback is unreachable through the database — it is here because the type
        // is nullable and a `!` would be a claim this module cannot back.
        code: row.errorCode ?? "TIMEOUT",
        terminal: true,
        message:
          row.errorMessage ??
          (row.errorCode === null
            ? TERMINAL_PROSE.TIMEOUT
            : TERMINAL_PROSE[row.errorCode]) ??
          "This run failed. No report was produced.",
      })
    }

    events.push({ type: "done", status: row.status })

    return {
      events,
      cursor: { ...next, openStep: null, finished: true },
    }
  }

  // --- Non-terminal ----------------------------------------------------------

  // A phase change closes the previous step and opens the new one. Both in one poll,
  // so a client that connected mid-run sees the step it is in rather than waiting for
  // the next transition to learn there is one.
  if (next.openStep !== row.status) {
    events.push(...closeStep(next))

    const step = PHASE_TOOL_STEP[row.status]
    if (step !== undefined) {
      events.push({
        type: "tool",
        phase: "start",
        id: stepIdFor(row.status),
        name: step.name,
        label: step.label,
        status: statusPhraseFor(row.status),
      })
    }

    next = { ...next, openStep: row.status }
  }

  // Requirement 40.14 — **no** `progress` event while either count is absent, so a
  // phase carrying no countable work produces no false determinate bar. Both counts,
  // not either: a total with no current has nothing to render and a current with no
  // total has no denominator.
  if (row.progressCurrent !== null && row.progressTotal !== null) {
    const id = stepIdFor(row.status)
    const unit = PHASE_PROGRESS_UNIT[row.status]

    // A phase with no declared unit emits no progress event. Requirement 40.15 takes
    // `unit` from a per-phase constant rather than from run state, so a phase the
    // vocabulary does not describe has no honest unit to name.
    if (unit !== undefined) {
      const fingerprint = `${id}|${row.progressCurrent}|${row.progressTotal}|${row.progressLabel ?? ""}`
      const lastDone = next.lastDone[id]

      // Requirement 40.15's last clause. The row already enforces monotonicity — the
      // progress endpoint refuses a lower `current` for the same phase — so this is
      // the second line of defence rather than the first, and it fails *closed*: a
      // decrease emits nothing rather than emitting a value that moves the bar
      // backwards.
      const wouldDecrease =
        lastDone !== undefined && row.progressCurrent < lastDone

      // An unchanged triple is not re-sent. Without this the relay would emit an
      // identical `progress` event every two seconds for the whole of a phase that
      // is between callbacks — hundreds of events saying nothing new.
      if (!wouldDecrease && fingerprint !== next.lastProgress) {
        events.push({
          type: "progress",
          // Exactly the five declared field names of Requirement 14.8, renaming
          // none and adding none. `done` is the event's name for the column called
          // `progress_current` and for the callback field called `current`; the
          // mapping happens here and nowhere else (Requirement 40.15).
          id,
          done: row.progressCurrent,
          total: row.progressTotal,
          unit,
          label: row.progressLabel,
        })

        next = {
          ...next,
          lastDone: { ...next.lastDone, [id]: row.progressCurrent },
          lastProgress: fingerprint,
        }
      }
    }
  }

  return { events, cursor: next }
}

/**
 * The `status` phrase a `tool` start carries — what the system is doing, in words.
 *
 * Derived from the row's status, so it is reconstructible from the one source
 * Requirement 40.5 allows. Present tense and specific, because this is the line the
 * activity timeline shows beside a spinner for minutes at a time and "Working…" is
 * indistinguishable from a hang.
 */
function statusPhraseFor(status: RunStatus): string {
  switch (status) {
    case "queued":
      return "Waiting for a worker to pick this run up"
    case "claimed":
      return "Starting the collection runtime"
    case "collecting":
      return "Enumerating resources and pulling metrics"
    default:
      return "Working"
  }
}

/** A `heartbeat` — a timestamp and nothing else (Requirement 40.10). */
export function heartbeatEvent(now: Date): RelayEvent {
  return { type: "heartbeat", ts: now.toISOString() }
}

/**
 * One event as an SSE frame.
 *
 * `data:` only, with no `event:` name: the type travels **inside** the JSON payload,
 * which is what lets the client's single `onmessage` handler dispatch on
 * `isDeclaredEventType` and ignore an undeclared type (Requirement 40.6). Naming the
 * frame instead would require an `addEventListener` per type, and an undeclared type
 * would then arrive at no listener at all — silently dropped rather than deliberately
 * ignored, which is the same behaviour for the wrong reason and impossible to assert.
 *
 * The trailing blank line terminates the frame. `JSON.stringify` cannot emit a raw
 * newline inside a string, so a payload can never split a frame.
 */
export function sseFrame(event: RelayEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}
