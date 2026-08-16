import { invalidInput, notFound, unauthorized } from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import {
  RELAY_HEARTBEAT_MS,
  RELAY_IDLE_CLOSE_MS,
  RELAY_POLL_MS,
} from "@/lib/events"
import { loadRunGaps, type RunGap } from "@/lib/runs/gaps"
import { runIdParamSchema } from "@/lib/runs/input"
import {
  EMPTY_CURSOR,
  deriveRelayEvents,
  heartbeatEvent,
  sseFrame,
  type RelayCursor,
} from "@/lib/runs/relay"
import { findOwnedRun } from "@/lib/runs/state"
import { isTerminalStatus } from "@/lib/runs/state"

/**
 * `GET /api/runs/[runId]/stream` — the cosmetic SSE relay (Requirement 40).
 *
 * A **live view over `report_runs`**, and nothing more. Every event it emits is
 * derived from that row and the stored gap list (Requirement 40.5), and **it makes no
 * AgentCore invocation** (Requirement 40.10): the invocation was started by the cron
 * tick, in a different request that has already returned, so there is no upstream
 * stream to attach to and attaching would re-run the collection.
 *
 * If this stream drops, **nothing is lost**. The client reopens within a few seconds
 * and rebuilds displayed state from the row through `GET /api/runs/[runId]`
 * (Requirements 40.4, 40.11). That is what makes closing it after two idle minutes a
 * reasonable thing to do rather than a failure.
 *
 * ## The headers, and why each one
 *
 * `export const runtime = "nodejs"` is mandatory (Requirement 40.1): a long-lived SSE
 * response and the Postgres driver both need Node, and the edge runtime has neither.
 *
 * | header | value | why |
 * |---|---|---|
 * | `Content-Type` | `text/event-stream` | selects the streaming response shape |
 * | `Cache-Control` | `no-cache, no-transform` | `no-transform` is the load-bearing half: a compressing proxy will buffer a stream to find something worth compressing, which turns a live view into a two-minute silence followed by a flush |
 * | `X-Accel-Buffering` | `no` | nginx's own opt-out of response buffering, which `no-transform` does not cover |
 * | `Connection` | `keep-alive` | stated rather than assumed, for intermediaries that downgrade otherwise |
 *
 * ## The three timers
 *
 * The row is polled every {@link RELAY_POLL_MS}, a `heartbeat` goes out every
 * {@link RELAY_HEARTBEAT_MS} while the row is non-terminal, and the stream closes after
 * {@link RELAY_IDLE_CLOSE_MS} in which nothing but heartbeats was emitted
 * (Requirement 40.3). All three are driven by **one** loop with one `setTimeout` per
 * tick rather than three independent intervals: three intervals would need three
 * clearing paths on teardown, and a missed clear on an aborted request is a poll that
 * keeps querying Postgres for a browser that has gone.
 *
 * The heartbeat matters more than it looks. Inventory and metrics collection can run
 * for minutes with nothing to say, and without a heartbeat an intermediary closes an
 * idle connection — so the run looks failed while it is in fact still working.
 *
 * ## Authorization
 *
 * The session is resolved and the run is read **scoped by `user_id`** before any
 * stream is opened (Requirement 40.9). Another user's run resolves as **not found**,
 * with no stream opened and no field of the row disclosed — not as forbidden, because
 * "forbidden" confirms the run exists and its status is a fact about somebody else's
 * customer. The check happens once, at open: a session that expires mid-stream is not
 * re-checked, which is deliberate — the stream carries nothing the client did not
 * already have at open, and it closes on its own within two minutes.
 */
export const runtime = "nodejs"

/**
 * The awaited-params shape Next 16 requires for a dynamic route handler: `params` is a
 * **Promise**, and synchronous access was removed
 * (`02-guides/upgrading/version-16.md`).
 */
type StreamRouteContext = Readonly<{ params: Promise<{ runId: string }> }>

/** Requirement 40.2, plus the two intermediary opt-outs. */
const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
}

export async function GET(
  request: Request,
  context: StreamRouteContext
): Promise<Response> {
  const user = await requireSessionForApi()
  // Requirement 40.9 — no valid session resolves without a stream. A 401 rather than
  // a 404 here because the *absence of a session* is not a fact about any row, and a
  // client needs to be able to tell "sign in again" from "that run is not yours".
  if (user === null) return unauthorized()

  const params = runIdParamSchema.safeParse(await context.params)
  if (!params.success) return invalidInput(params.error)

  const runId = params.data.runId

  // Requirement 40.9 — read before opening anything, scoped by `user_id` inside the
  // statement, so another user's run matches no row and no field of it is read.
  const initial = await findOwnedRun(user.id, runId)
  if (initial === undefined) return notFound()

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor: RelayCursor = EMPTY_CURSOR
      let closed = false

      /** Milliseconds since anything other than a heartbeat was emitted. */
      let idleMs = 0
      /** Milliseconds since the last heartbeat. */
      let sinceHeartbeatMs = 0

      const send = (frame: string): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(frame))
        } catch {
          // The consumer went away between the abort signal and this write. Nothing
          // to report: the relay is a view, and the row is the record.
          closed = true
        }
      }

      const finish = (): void => {
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch {
          // Already closed by the consumer's disconnect. Not an error.
        }
      }

      // The client navigating away, or an intermediary hanging up. Without this the
      // loop below would keep polling Postgres for a browser that has gone.
      request.signal.addEventListener("abort", finish, { once: true })

      const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => {
          const handle = setTimeout(resolve, ms)
          // Resolve immediately on abort rather than waiting out the poll interval,
          // so teardown is prompt and the timer is always cleared.
          request.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(handle)
              resolve()
            },
            { once: true }
          )
        })

      /**
       * One poll: read the row, emit what changed, and answer whether to continue.
       *
       * The gap list is loaded **only** once the row is terminal, and `loadRunGaps`
       * returns `[]` for a non-terminal row without making a request — so a run
       * collecting for ten minutes costs one Postgres read per poll and no S3 call at
       * all.
       */
      const poll = async (): Promise<boolean> => {
        const row = await findOwnedRun(user.id, runId)

        if (row === undefined) {
          // The run was deleted mid-stream. Nothing to say about a row that is gone,
          // and the client's next fetch of it will 404 — which is the answer.
          return false
        }

        let gaps: readonly RunGap[] = []
        if (isTerminalStatus(row.status)) {
          // Never throws: a completed run whose snapshot object cannot be read is
          // still a completed run, and failing the stream over a gap list would turn
          // a cosmetic problem into an apparent run failure.
          gaps = await loadRunGaps(row)
        }

        const derived = deriveRelayEvents(cursor, row, gaps)
        cursor = derived.cursor

        for (const event of derived.events) send(sseFrame(event))

        if (derived.events.length > 0) idleMs = 0

        // Requirement 40.12 — a terminal state is emitted, then the stream closes,
        // and the client opens no further stream for that run.
        return !cursor.finished
      }

      try {
        // The first poll happens immediately, so a client that connected to a run
        // already in flight sees its current step without waiting two seconds.
        let keepGoing = await poll()

        while (keepGoing && !closed) {
          await sleep(RELAY_POLL_MS)
          if (closed) break

          idleMs += RELAY_POLL_MS
          sinceHeartbeatMs += RELAY_POLL_MS

          keepGoing = await poll()
          if (!keepGoing || closed) break

          if (sinceHeartbeatMs >= RELAY_HEARTBEAT_MS) {
            // A timestamp and nothing else: no phase, no counts, no run id. A
            // heartbeat that carried state would be a second source for something the
            // row already holds, and `idleMs` deliberately does **not** reset for it —
            // otherwise the idle window would never expire.
            send(sseFrame(heartbeatEvent(new Date())))
            sinceHeartbeatMs = 0
          }

          // Requirement 40.3 — 120 consecutive seconds carrying nothing but
          // heartbeats closes the stream. The client reopens and rebuilds from the
          // row, which costs it one fetch and costs the run nothing.
          if (idleMs >= RELAY_IDLE_CLOSE_MS) break
        }
      } catch (thrown) {
        // A failed poll — a lost connection, most likely. The stream closes and the
        // client reopens; the run is unaffected, because this handler writes nothing.
        console.error(
          `[api/runs/[runId]/stream] the relay for run ${runId} stopped: ` +
            `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
        )
      } finally {
        finish()
      }
    },
  })

  return new Response(stream, { status: 200, headers: SSE_HEADERS })
}
