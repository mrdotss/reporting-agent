import { z } from "zod"

import { runErrorCode, type ReportRun, type RunStatus } from "@/lib/db/schema"

/**
 * The progress callback's boundary schema and its **pure** decision function
 * (Requirement 38).
 *
 * **Pure, and deliberately not `server-only`.** No I/O, no clock, no environment,
 * no secret: a parsed body and the row's current state go in, and either a
 * rejection or the exact set of columns to write comes out. The route does the
 * three things that are genuinely about the request — validate the token, read the
 * row, apply the write — and nothing else.
 *
 * The split exists because Requirement 38 is mostly a *decision table*, and the
 * table has cases that are easy to get subtly wrong and expensive to reach through
 * a route handler: a repeat of a terminal status must be refused (38.8), a repeat of
 * a **non**-terminal status must be accepted and must still write the counts
 * (38.13), a lower `current` for the same phase must leave the counts alone while
 * applying the rest (38.14), and `TIMEOUT` must be refused outright (38.11). Each
 * of those is one line here and one assertion in the test file.
 *
 * ## `current` on the wire, `progress_current` in the column, `done` in the event
 *
 * The callback field is named **`current`** while the emitted SSE `progress` event's
 * field is named **`done`**. That is deliberate and renames nothing: the callback
 * names a column, the event names a field of the declared vocabulary
 * (Requirement 14.8), and the relay maps `progress_current → done` when it emits
 * (Requirement 40.15). Three names for one number is worse than it sounds only if
 * the mapping is implicit; it is stated here, in `progressColumns`, and in the
 * relay.
 */

// --- The schema -------------------------------------------------------------

/**
 * The phases the **agent** may present.
 *
 * `queued` and `claimed` are absent because the reaper owns them: an agent
 * presenting `claimed` is claiming to have done the claiming. `compiling`,
 * `rendering` and `verifying` are absent because this spec does not drive them
 * (Requirement 36.2) — a callback naming one would be refused by the transition
 * table anyway, and refusing it at the schema says so with a field path.
 *
 * Mirrors `AGENT_PHASES` in `agent/src/reporting_agent/progress.py`.
 */
export const AGENT_PHASES = ["collecting", "completed", "failed"] as const

export type AgentPhase = (typeof AGENT_PHASES)[number]

/** An `error_message` long enough to be useful and bounded enough to store. */
export const MAX_ERROR_MESSAGE_LENGTH = 2000

/** A progress label is a badge — "Inventory", "Metrics" — not a sentence. */
export const MAX_PROGRESS_LABEL_LENGTH = 64

/**
 * `POST /api/internal/runs/[runId]/progress` (Requirements 38.1, 38.7, 38.12).
 *
 * There is **no token field**, and its absence is Requirement 38.2 expressed as a
 * schema: the token travels in the `X-Rpt-Progress-Token` header, never in the
 * request target and never in the body. `.strict()` means a body that carries one
 * anyway is *rejected* rather than having it quietly ignored — which matters,
 * because a caller that put a credential in a body it believed was accepted would
 * have no signal that it had done so.
 *
 * `error_code` is drawn from the Postgres enum's own values rather than a restated
 * list, so a code the column cannot hold can never reach the write. `TIMEOUT` is
 * *accepted by the schema* and refused by {@link decideTransition} — deliberately,
 * so the refusal carries the reason "the reaper is the only writer of TIMEOUT"
 * rather than an anonymous enum mismatch on a field path.
 */
export const progressCallbackSchema = z
  .object({
    run_id: z.string().min(1),
    phase: z.enum(AGENT_PHASES),
    error_code: z.enum(runErrorCode.enumValues).optional(),
    error_message: z.string().max(MAX_ERROR_MESSAGE_LENGTH).optional(),
    /** The snapshot's `content_hash`: 64 lowercase hex. */
    snapshot_id: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    resource_count: z.number().int().nonnegative().optional(),
    gap_count: z.number().int().nonnegative().optional(),
    /** Requirement 38.1 — the in-flight count. Named `current`; see the docstring. */
    current: z.number().int().nonnegative().optional(),
    total: z.number().int().positive().optional(),
    label: z.string().max(MAX_PROGRESS_LABEL_LENGTH).optional(),
  })
  .strict()

export type ProgressCallback = z.output<typeof progressCallbackSchema>

// --- The decision -----------------------------------------------------------

/**
 * Why a callback was refused.
 *
 * Every one of these resolves to the **same** HTTP response — a 404 with a fixed
 * body — because Requirement 38.6 requires one response identical for a bad token
 * and an unknown run, and widening that to every rejection is what stops the
 * endpoint from being an oracle for run state. A caller cannot learn from the
 * response whether the run exists, what status it carries, or which of these
 * happened.
 *
 * The reason is still carried, as a value, so the **server log** can say which. That
 * is the only consumer.
 */
export type TransitionRejection =
  | "terminal_row"
  | "unreachable_target"
  | "timeout_reserved"
  | "error_code_not_permitted"
  | "missing_error_code"

/**
 * The columns to write, or a rejection.
 *
 * `write` is a partial row rather than a full one, and the fields it *omits* are as
 * load-bearing as the ones it sets: a same-status refresh omits `status` entirely
 * (Requirement 38.13), and an out-of-order `current` omits all three progress
 * columns (Requirement 38.14). Omission means "leave the column alone", which is a
 * thing a partial `UPDATE ... SET` expresses exactly and a full row cannot.
 */
export type TransitionDecision =
  | { readonly ok: false; readonly rejection: TransitionRejection }
  | {
      readonly ok: true
      /** `true` when `status` changes; `false` for a same-phase refresh. */
      readonly changesStatus: boolean
      readonly write: ProgressWrite
    }

/**
 * Exactly the columns a progress callback may write.
 *
 * `updatedAt` is absent because the caller sets it unconditionally — Requirement
 * 36.3 says every write that changes another column refreshes it, and leaving it
 * out of this type means there is no path on which a decision could forget.
 * `progressTokenHash` is absent because Requirement 38.12 forbids writing any
 * column derived from the presented token: the type is where that is enforced,
 * rather than a rule somebody has to remember while writing the statement.
 */
export type ProgressWrite = {
  readonly status?: RunStatus
  readonly phaseDeadline?: Date | null
  readonly errorCode?: (typeof runErrorCode.enumValues)[number] | null
  readonly errorMessage?: string | null
  readonly snapshotId?: string
  readonly resourceCount?: number
  readonly gapCount?: number
  readonly progressCurrent?: number | null
  readonly progressTotal?: number | null
  readonly progressLabel?: string | null
}

/** The fields of the row this decision reads. A `Pick`, so its inputs are its type. */
export type ProgressRowState = Pick<
  ReportRun,
  "status" | "progressCurrent" | "progressTotal" | "progressLabel"
>

/** The `error_message` recorded when a `failed` callback carried none. */
export const DEFAULT_FAILURE_MESSAGE =
  "The run failed. The runtime reported no message with the failure."

/**
 * Decide what one callback writes (Requirements 38.7, 38.8, 38.10–38.14).
 *
 * The order of the checks below is the order the requirements force, and each early
 * return is a case that must write **nothing**:
 *
 *  1. **A terminal row rejects everything** (38.8), including a repeat of the
 *     terminal status it already carries. Checked first, so a `failed` row cannot be
 *     reopened by a late `collecting` callback and a `completed` row cannot have its
 *     counts rewritten. This is the guard that makes a delivered run's audit row
 *     final.
 *  2. **`TIMEOUT` is refused outright** (38.11). The reaper is its only writer,
 *     because a timed-out run's container may already be gone — so a callback
 *     presenting it is either confused or forged, and in both cases it is claiming
 *     to have observed something it cannot have.
 *  3. **The target must be `{current} ∪ DRIVEN[current]`** (38.10), which is what
 *     stops a replayed or out-of-order callback from moving a run backwards.
 *  4. **A `failed` target's code must be one the agent may present** (38.11).
 *  5. Then the write is assembled, differently for the terminal and non-terminal
 *     cases (38.7, 38.12, 38.13, 38.14).
 *
 * `dependencies` are the two things this function cannot know on its own — the
 * transition table and the phase budget — passed in rather than imported so this
 * module stays free of `server-only` and the table has exactly one definition,
 * in `lib/runs/state.ts`.
 */
export function decideTransition(
  row: ProgressRowState,
  callback: ProgressCallback,
  now: Date,
  dependencies: {
    /** `{current} ∪ DRIVEN[current]`, from `lib/runs/state.ts`. */
    readonly acceptedTargets: (status: RunStatus) => readonly RunStatus[]
    /** The entered phase's budget, from `lib/runs/state.ts`. */
    readonly phaseDeadlineFor: (status: RunStatus, now: Date) => Date | null
    /** The codes the agent may present on a `failed` transition. */
    readonly agentErrorCodes: ReadonlySet<string>
    /** The codes only the app writes — `TIMEOUT`, `SECRET_UNREADABLE`. */
    readonly appWrittenCodes: ReadonlySet<string>
  }
): TransitionDecision {
  const target: RunStatus = callback.phase

  // 1 — Requirement 38.8. `acceptedTargets` returns `[]` for a terminal row, so
  //     step 3 would also refuse this — but the rejection reason differs and the
  //     log line is the only place it shows, so the case is named.
  if (dependencies.acceptedTargets(row.status).length === 0) {
    return { ok: false, rejection: "terminal_row" }
  }

  // 2 — Requirement 38.11, checked before the transition table so the reason is
  //     "TIMEOUT is reserved" rather than "that target is unreachable".
  if (
    callback.error_code !== undefined &&
    dependencies.appWrittenCodes.has(callback.error_code)
  ) {
    return { ok: false, rejection: "timeout_reserved" }
  }

  // 3 — Requirement 38.10.
  if (!dependencies.acceptedTargets(row.status).includes(target)) {
    return { ok: false, rejection: "unreachable_target" }
  }

  // 4 — Requirement 38.11's other half, and the CHECK constraint's precondition:
  //     a `failed` row must carry a code, and the code must be one of the set.
  if (target === "failed") {
    if (callback.error_code === undefined) {
      return { ok: false, rejection: "missing_error_code" }
    }
    if (!dependencies.agentErrorCodes.has(callback.error_code)) {
      return { ok: false, rejection: "error_code_not_permitted" }
    }
  }

  const changesStatus = target !== row.status

  // Requirement 38.12 — a terminal transition records its terminal fields and
  // clears `phase_deadline` **together with** all three progress columns, so a
  // terminal row carries no stale in-flight count.
  if (target === "failed") {
    return {
      ok: true,
      changesStatus,
      write: {
        status: "failed",
        errorCode: callback.error_code,
        errorMessage: callback.error_message ?? DEFAULT_FAILURE_MESSAGE,
        phaseDeadline: null,
        progressCurrent: null,
        progressTotal: null,
        progressLabel: null,
      },
    }
  }

  if (target === "completed") {
    return {
      ok: true,
      changesStatus,
      write: {
        status: "completed",
        // Explicitly `null`, not merely unset. The CHECK forbids a `completed` row
        // from carrying a code, and writing the pair together means the completed
        // row is written whole rather than relying on the previous status never
        // having recorded one.
        errorCode: null,
        errorMessage: null,
        // Requirement 38.12 names these three as the terminal fields for
        // `completed`. Each is written only when presented: a callback that
        // omitted `snapshot_id` should not blank a value already recorded.
        ...(callback.snapshot_id === undefined
          ? {}
          : { snapshotId: callback.snapshot_id }),
        ...(callback.resource_count === undefined
          ? {}
          : { resourceCount: callback.resource_count }),
        ...(callback.gap_count === undefined
          ? {}
          : { gapCount: callback.gap_count }),
        phaseDeadline: null,
        progressCurrent: null,
        progressTotal: null,
        progressLabel: null,
      },
    }
  }

  // A non-terminal target. Requirement 38.7 for a transition, 38.13 for a
  // same-status refresh — and the two differ **only** in whether `status` is set.
  // The deadline is refreshed either way, which is what stops a phase that is
  // making visible progress from being reaped for taking a while.
  return {
    ok: true,
    changesStatus,
    write: {
      ...(changesStatus ? { status: target } : {}),
      phaseDeadline: dependencies.phaseDeadlineFor(target, now),
      ...progressColumns(row, callback, target),
    },
  }
}

/**
 * The three progress columns a non-terminal callback writes, or `{}`.
 *
 * `{}` — leave all three alone — in exactly one case, Requirement 38.14: the
 * presented `current` is **below** the `progress_current` already stored while the
 * row's `status` already equals the presented target. Requirement 14.8 requires
 * successive `done` values for one step to be non-decreasing, and the reporter's
 * single retry can land out of order, so the **row** enforces monotonicity rather
 * than trusting the caller to.
 *
 * The `status` equality is part of the condition, not incidental: a *transition*
 * into a phase legitimately resets the count to zero, and treating that as an
 * out-of-order arrival would freeze the bar at the previous phase's total.
 *
 * All three move together. Writing a new `current` while keeping an old `total`
 * would produce `847 / 200`, and writing a new `total` while keeping an old
 * `current` would make the bar jump backwards — so the guard covers the triple
 * rather than the one field it is named for.
 */
function progressColumns(
  row: ProgressRowState,
  callback: ProgressCallback,
  target: RunStatus
): ProgressWrite {
  const sameStatus = row.status === target

  if (
    sameStatus &&
    callback.current !== undefined &&
    row.progressCurrent !== null &&
    callback.current < row.progressCurrent
  ) {
    return {}
  }

  // Requirement 38.7/38.13 — "each of `progress_current`, `progress_total` and
  // `progress_label` the request presents". A field the callback omitted is
  // written as `null` rather than left alone, so a phase that stops carrying a
  // countable unit of work clears the bar instead of leaving the previous phase's
  // numbers on screen. `null` for either count is what makes the relay emit no
  // `progress` event at all (Requirement 40.14).
  return {
    progressCurrent: callback.current ?? null,
    progressTotal: callback.total ?? null,
    progressLabel: callback.label ?? null,
  }
}
