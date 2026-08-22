import "server-only"

/**
 * Reading one AgentCore SSE response, and bounding how long that read may take.
 *
 * Extracted from `lib/subscriptions/preflight.ts`, which held every function
 * below, when `lib/subscriptions/inventory.ts` became the **second** caller that
 * invokes a deterministic command, reads its answer off the terminal `done` event
 * and gives up after 30 seconds. The alternative was a second frame reader and a
 * second deadline race, which is two implementations of one wire contract — and
 * the two would have diverged on exactly the details that are easy to get wrong
 * and invisible when wrong:
 *
 *   * a frame split across two network chunks, which a reader that decoded each
 *     chunk independently would drop rather than reassemble;
 *   * `\r\n\r\n` as the frame separator, which a reader knowing only `\n\n` would
 *     accumulate into one unterminated frame and then time out — a failure that
 *     looks exactly like an unresponsive runtime;
 *   * a promise that rejects *after* the deadline won, which is an unhandled
 *     rejection in a Node server triggered by nothing worse than a slow runtime.
 *
 * Everything here is either pure or a thin wrapper over a timer, and nothing here
 * decides an outcome. Each caller owns its own vocabulary — a preflight rejection
 * is not an unavailable inventory — so this module deliberately exposes the
 * mechanics and no verdict.
 *
 * `server-only` because it lives under `lib/aws/`, where the sweep in
 * `test/boundaries.static.test.ts` requires the marker on every module. It is also
 * correct on its own terms: these functions consume a stream that only ever exists
 * inside a server handler.
 */

// --- Framing ----------------------------------------------------------------

/**
 * `\n\n` terminates an SSE frame, and `\r\n\r\n` does too.
 *
 * Both spellings are handled because the separator is chosen by whatever
 * serialized the stream, not by us.
 */
const FRAME_SEPARATOR = /\r?\n\r?\n/

/**
 * Split a buffer into complete SSE frames plus the trailing partial one.
 *
 * Pure, and exported for its own test: the whole correctness of a reader is that a
 * frame split across two network chunks is reassembled rather than dropped, and
 * that is a property of this function.
 *
 * The final element is always the remainder — possibly empty — so a buffer ending
 * exactly on a separator yields no phantom empty frame.
 */
export function splitSseFrames(buffer: string): {
  frames: readonly string[]
  rest: string
} {
  const parts = buffer.split(FRAME_SEPARATOR)
  const rest = parts.pop() ?? ""

  return { frames: parts, rest }
}

/**
 * The JSON payload of one SSE frame, or `undefined`.
 *
 * Joins every `data:` line with a newline, as the SSE grammar requires for a
 * multi-line payload, and ignores everything else — a comment line (`: keep
 * alive`), an `event:` name, an `id:` or a `retry:`. A single leading space after
 * the colon is part of the framing and is stripped; further whitespace is part of
 * the value.
 *
 * Returns `undefined` rather than throwing for a frame with no data and for a
 * payload that is not JSON. Neither is a reason to fail the read: the stream is
 * consumed looking for specific facts, and a frame that does not carry one is
 * simply not the frame being looked for.
 */
export function parseSseFrame(frame: string): unknown {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).replace(/^ /, ""))

  if (data.length === 0) return undefined

  try {
    return JSON.parse(data.join("\n"))
  } catch {
    return undefined
  }
}

// --- The deadline -----------------------------------------------------------

/** A promise that never rejects, so a race cannot leave one unhandled. */
export type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

export function settle<T>(work: Promise<T>): Promise<Settled<T>> {
  return work.then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const
  )
}

/** The race's timeout arm, distinguishable from any settled value. */
export const TIMED_OUT = Symbol("agent stream deadline")

/**
 * Race already-settled work against a deadline, clearing the timer either way.
 *
 * The work is settled **before** the race rather than raced directly: a promise
 * that rejects after the timer won would otherwise be an unhandled rejection,
 * which in a Node server is a process-level warning (and, under some
 * configurations, an exit) triggered by nothing worse than a slow runtime.
 *
 * The timer is always cleared, so a fast answer does not leave a 30-second handle
 * holding the event loop open — which is also what keeps a test suite from
 * hanging for half a minute after its assertions have passed.
 */
export async function withDeadline<T>(
  work: Promise<Settled<T>>,
  remainingMs: number
): Promise<Settled<T> | typeof TIMED_OUT> {
  // An exhausted budget is decided here rather than by a zero-delay timer, and the
  // difference is not cosmetic. `Promise.race` resolves with whichever arm settles
  // first, and a work promise that is *already* settled — or that settles on a
  // microtask, or on a timer Node has clamped to the same millisecond — beats a
  // timer every time. A caller reading a stream that delivers buffered frames back
  // to back would therefore never see this fire, and its 30-second bound would hold
  // only for a runtime slow enough to let the event loop breathe. Checking the clock
  // first makes the bound a property of the elapsed time instead of a property of
  // how fast the other side happens to be.
  if (remainingMs <= 0) return TIMED_OUT

  let handle: ReturnType<typeof setTimeout> | undefined

  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    handle = setTimeout(() => resolve(TIMED_OUT), remainingMs)
  })

  try {
    return await Promise.race([work, deadline])
  } finally {
    if (handle !== undefined) clearTimeout(handle)
  }
}

/**
 * Release a stream the reader is abandoning.
 *
 * Called on the timeout path and on the path where the terminal event arrived
 * before the stream ended. Without it the underlying socket stays open until the
 * runtime closes it, and a read that timed out would keep consuming a connection
 * for as long as the container kept talking.
 *
 * Failures are swallowed: this runs while abandoning a stream that may already be
 * broken, and the outcome is decided by then.
 */
export async function releaseIterator(
  iterator: AsyncIterator<Uint8Array>
): Promise<void> {
  try {
    await iterator.return?.()
  } catch {
    // Nothing to do and nothing to say: the answer is already decided.
  }
}
