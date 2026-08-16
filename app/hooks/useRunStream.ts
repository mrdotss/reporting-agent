"use client"

import { useCallback, useEffect, useState } from "react"

import type { RunView } from "@/lib/db/views"
import {
  PHASE_TOOL_STEP,
  RELAY_REOPEN_MS,
  isDeclaredEventType,
} from "@/lib/events"
import type { RunGap } from "@/lib/runs/gaps"

/**
 * `useRunStream` — the one place a run's SSE stream is parsed (Requirement 40.8).
 *
 * Presentation components receive {@link RunStreamState} and do no parsing, which is
 * Requirement 40.8 and also the thing that makes the timeline testable: a component
 * that parsed events would need a stream to render, and this hook needs no DOM to
 * assert.
 *
 * ## The row is the record; the stream is a view
 *
 * The hook is seeded with a server-rendered {@link RunView} and, on every reconnect,
 * **re-fetches the row before rendering** (Requirements 40.4, 40.11). It requests no
 * event replay: there is nothing to replay from, and everything the stream said is
 * either already applied or reconstructible.
 *
 * That is why terminal state is read from `run.status`, `run.errorCode` and
 * `run.errorMessage` as well as from events (Requirement 36.7). **`TIMEOUT` arrives
 * with no event to carry it** — the reaper writes it when the run's container may
 * already be gone — so a client that trusted only the stream would show a timed-out
 * run as still collecting, forever.
 *
 * ## An undeclared event type is ignored, not fatal
 *
 * Requirement 40.6. The dispatch is a lookup against `isDeclaredEventType` followed by
 * a `switch` with no `default` throw, so a newer runtime emitting a type this build has
 * never heard of applies no state change and the stream keeps being read. That is also
 * why the relay puts the type **inside** the JSON payload rather than in the SSE
 * `event:` field: one `onmessage` handler can ignore a type, whereas per-type
 * listeners would silently drop it at no listener at all.
 */

/** One step on the activity timeline. */
export type RunStep = {
  readonly id: string
  readonly name: string
  readonly label: string
  /** What the system is doing, in words. */
  readonly status: string
  /** `false` until the matching `tool` end arrives. */
  readonly complete: boolean
  /** Present only while both counts are known — see Requirement 40.14. */
  readonly progress: {
    readonly done: number
    readonly total: number
    readonly unit: string
    readonly label: string | null
  } | null
}

/** What a presentation component receives. */
export type RunStreamState = {
  /** The row, re-fetched on every reconnect. Authoritative. */
  readonly run: RunView
  /** The gap list, from the row's snapshot once terminal. */
  readonly gaps: readonly RunGap[]
  /** The activity timeline, in the order the steps opened. */
  readonly steps: readonly RunStep[]
  /** `true` once the run's status is terminal. No further stream is opened. */
  readonly finished: boolean
  /** `true` while a stream is open. `false` between the close and the reopen. */
  readonly connected: boolean
}

/** The event shapes this hook reads. Parsed defensively; every field optional. */
type UnknownEvent = Record<string, unknown>

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Is this run's status terminal?
 *
 * Duplicated from `lib/runs/state.ts#isTerminalStatus` rather than imported, and the
 * duplication is imposed rather than chosen: that module carries
 * `import "server-only"`, so a client component naming it is a build error. The set is
 * two values fixed by the state machine, and `RunView["status"]` is the schema's own
 * enum union — so a status renamed in Postgres fails to compile here.
 */
function isTerminal(status: RunView["status"]): boolean {
  return status === "completed" || status === "failed"
}

/** Apply one declared event to the step list. Pure. */
function applyEvent(
  steps: readonly RunStep[],
  type: string,
  event: UnknownEvent
): readonly RunStep[] {
  if (type === "tool") {
    const id = asString(event.id)
    if (id === undefined) return steps

    if (event.phase === "start") {
      const existing = steps.find((step) => step.id === id)
      // A reconnect replays the open step, so an id that is already present is
      // refreshed rather than duplicated. Without this, every reconnect would add
      // another "Collecting" row to a timeline that is describing one phase.
      if (existing !== undefined) {
        return steps.map((step) =>
          step.id === id
            ? {
                ...step,
                name: asString(event.name) ?? step.name,
                label: asString(event.label) ?? step.label,
                status: asString(event.status) ?? step.status,
                complete: false,
              }
            : step
        )
      }

      return [
        ...steps,
        {
          id,
          name: asString(event.name) ?? PHASE_TOOL_STEP[id]?.name ?? id,
          label: asString(event.label) ?? PHASE_TOOL_STEP[id]?.label ?? id,
          status: asString(event.status) ?? "Working",
          complete: false,
          progress: null,
        },
      ]
    }

    if (event.phase === "end") {
      return steps.map((step) =>
        step.id === id ? { ...step, complete: true } : step
      )
    }

    return steps
  }

  if (type === "progress") {
    const id = asString(event.id)
    const done = asNumber(event.done)
    const total = asNumber(event.total)
    const unit = asString(event.unit)

    // Requirement 14.8 — a `progress` event references an **open** step. One that
    // names an unknown id is dropped rather than used to invent a step, because a
    // step with a bar and no name is worse than no step. `unit` is required for the
    // same reason: a bar labelled "142 / 200" with no noun is a number without a
    // meaning, and the relay always sends one.
    if (
      id === undefined ||
      done === undefined ||
      total === undefined ||
      unit === undefined
    ) {
      return steps
    }
    if (!steps.some((step) => step.id === id)) return steps

    return steps.map((step) =>
      step.id === id
        ? {
            ...step,
            progress: {
              // Non-decreasing on the client too. The relay already guarantees it and
              // the row enforces it before that, so this is the third line of
              // defence — cheap, and it means a bar can never visibly jump backwards
              // whatever arrives.
              done: Math.max(done, step.progress?.done ?? done),
              total,
              unit,
              label: asString(event.label) ?? null,
            },
          }
        : step
    )
  }

  return steps
}

/** What the hook needs to fetch a row and open a stream. */
export type UseRunStreamOptions = {
  /** The server-rendered row this hook starts from. */
  readonly initialRun: RunView
  /** The server-rendered gap list, if the run was already terminal. */
  readonly initialGaps?: readonly RunGap[]
}

export function useRunStream({
  initialRun,
  initialGaps = [],
}: UseRunStreamOptions): RunStreamState {
  const [run, setRun] = useState<RunView>(initialRun)
  const [gaps, setGaps] = useState<readonly RunGap[]>(initialGaps)
  const [steps, setSteps] = useState<readonly RunStep[]>([])
  /**
   * Whether a stream is currently open.
   *
   * Reported to callers as `connected` only while the run is non-terminal — see the
   * return statement. Derived there rather than written to `false` from the effect,
   * because setting state unconditionally in an effect body is both a needless extra
   * render and something React 19's lint rules reject outright.
   */
  const [streamOpen, setStreamOpen] = useState(false)

  const runId = initialRun.id
  const finished = isTerminal(run.status)

  /**
   * Re-read the row before rendering a reconnect (Requirement 40.4).
   *
   * Returns whether the run is terminal, so the caller can decide not to reopen. A
   * failed fetch is swallowed and reported as non-terminal: the row is unchanged and
   * the next reconnect tries again, which is strictly better than showing a run as
   * finished because a fetch failed.
   */
  const refetch = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
        // The row is per-user and changes every few seconds; a cached copy would be
        // a stale run status rendered as current.
        cache: "no-store",
      })

      if (!response.ok) return false

      const body = (await response.json()) as {
        run?: RunView
        gaps?: readonly RunGap[]
      }

      if (body.run !== undefined) {
        setRun(body.run)
        setGaps(body.gaps ?? [])
        return isTerminal(body.run.status)
      }

      return false
    } catch {
      return false
    }
  }, [runId])

  useEffect(() => {
    // Requirement 40.12 — a terminal run gets no stream at all. This is the branch
    // that makes "the client opens no further stream" true rather than aspirational,
    // and it also means a completed run's detail page opens no connection on load.
    //
    // `finished` is read directly rather than through a ref. A ref would have to be
    // written during render to stay current, which React 19's own lint rule forbids
    // — and it would buy nothing here, because `finished` is already a dependency of
    // this effect, so the teardown happens the moment the run goes terminal.
    if (finished) return

    let disposed = false
    let source: EventSource | null = null
    let reopenHandle: ReturnType<typeof setTimeout> | undefined

    const open = (): void => {
      if (disposed) return

      source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`)

      source.onopen = () => {
        if (!disposed) setStreamOpen(true)
      }

      source.onmessage = (message: MessageEvent<string>) => {
        if (disposed) return

        let payload: unknown
        try {
          payload = JSON.parse(message.data)
        } catch {
          // Not JSON. Ignored rather than fatal, for the same reason an undeclared
          // type is: the relay is a view, and a frame we cannot read costs nothing.
          return
        }

        if (typeof payload !== "object" || payload === null) return

        const event = payload as UnknownEvent
        const type = event.type

        // Requirement 40.6 — an undeclared type applies no state change and the
        // stream keeps being read.
        if (!isDeclaredEventType(type)) return

        if (type === "heartbeat") return

        if (type === "done") {
          // The row is the record, so the terminal state is taken from a re-read
          // rather than from the event's own `status` field. `void` because
          // `onmessage` cannot be async without swallowing the rejection.
          void refetch()
          return
        }

        setSteps((current) => applyEvent(current, type, event))
      }

      source.onerror = () => {
        // `EventSource` reports a closed stream as an error, and the relay closes on
        // purpose every two idle minutes — so this is the ordinary path, not an
        // exceptional one. Close explicitly to stop the browser's own reconnect,
        // which would reopen without re-reading the row.
        source?.close()
        source = null

        if (!disposed) setStreamOpen(false)

        // Requirement 40.11 — reopen within 5 seconds while the run is non-terminal,
        // and rebuild displayed state from the row **before** rendering.
        reopenHandle = setTimeout(() => {
          if (disposed) return

          void refetch().then((terminal) => {
            if (disposed || terminal) return
            open()
          })
        }, RELAY_REOPEN_MS)
      }
    }

    open()

    return () => {
      disposed = true
      if (reopenHandle !== undefined) clearTimeout(reopenHandle)
      source?.close()
      setStreamOpen(false)
    }
    // `finished` is in the dependency list so the effect tears the stream down the
    // moment the run goes terminal, rather than waiting for the relay to close it.
  }, [runId, refetch, finished])

  return { run, gaps, steps, finished, connected: !finished && streamOpen }
}
