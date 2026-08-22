import { describe, expect, test } from "vitest"

import {
  TIMED_OUT,
  releaseIterator,
  settle,
  withDeadline,
} from "@/lib/aws/agent-stream"

/**
 * `lib/aws/agent-stream.ts` — the deadline half.
 *
 * The framing half (`splitSseFrames`, `parseSseFrame`) is exercised by
 * `lib/subscriptions/preflight.test.ts`, which is where those cases were written and
 * where they still describe something: how a preflight reads a runtime's answer.
 * What has no test anywhere else is the deadline, and one specific property of it.
 *
 * ## The property, and why it needs its own test
 *
 * `Promise.race` resolves with whichever arm settles **first**. A work promise that
 * is already settled, or that settles on a microtask, therefore beats a timer every
 * single time — including a `setTimeout(fn, 0)`, which Node clamps to one
 * millisecond anyway. So a deadline expressed *only* as a race is not a deadline: it
 * holds for a slow producer and silently stops existing for a fast one, and the fast
 * one is the case where a bound matters most, because that is the runtime flooding
 * buffered frames.
 *
 * The consequence of getting this wrong is not a late answer. It is a **hang**: the
 * reader loops on work that keeps winning, the timer never runs, and the request
 * never returns. That failure mode is also why it is tested here on a promise rather
 * than through a stream — an unbounded stream fixture starves the test runner's own
 * timeout and hangs the suite instead of failing it.
 */

const READY = { ok: true as const, value: 42 }

describe("withDeadline — an exhausted budget is decided without racing", () => {
  test.each([0, -1, -30_000])(
    "a remaining budget of %s milliseconds times out even when the work is ready",
    async (remaining) => {
      // The mutation-checked case: with the clock check removed, this resolves to the
      // ready value, and every caller's bound becomes a function of how fast the
      // other side is.
      await expect(
        withDeadline(Promise.resolve(READY), remaining)
      ).resolves.toBe(TIMED_OUT)
    }
  )

  test("a positive budget resolves with work that is already settled", async () => {
    // The control. Without it, a `withDeadline` that returned `TIMED_OUT`
    // unconditionally would satisfy every case above.
    await expect(withDeadline(Promise.resolve(READY), 1_000)).resolves.toEqual(
      READY
    )
  })

  test("work that settles inside the budget wins", async () => {
    const work = settle(
      new Promise<number>((resolve) => setTimeout(() => resolve(7), 5))
    )

    await expect(withDeadline(work, 500)).resolves.toEqual({
      ok: true,
      value: 7,
    })
  })

  test("work slower than the budget times out", async () => {
    const work = settle(
      new Promise<number>((resolve) => setTimeout(() => resolve(7), 200))
    )

    await expect(withDeadline(work, 10)).resolves.toBe(TIMED_OUT)
  })

  test("a repeated fast read still reaches the budget rather than looping", async () => {
    // The loop every caller runs, in miniature. Bounded at 10_000 iterations so a
    // regression fails here in milliseconds instead of hanging the suite: the count
    // is the assertion, and a deadline that never fires exhausts it.
    const deadline = Date.now() - 1
    let reads = 0

    for (; reads < 10_000; reads += 1) {
      const step = await withDeadline(
        Promise.resolve(READY),
        deadline - Date.now()
      )
      if (step === TIMED_OUT) break
    }

    expect(reads).toBe(0)
  })
})

describe("settle — a rejection becomes a value, so a race cannot leave one unhandled", () => {
  test("a resolution is reported as ok", async () => {
    await expect(settle(Promise.resolve("v"))).resolves.toEqual({
      ok: true,
      value: "v",
    })
  })

  test("a rejection is reported as not ok, carrying the error", async () => {
    const error = new Error("the connection dropped")

    await expect(settle(Promise.reject(error))).resolves.toEqual({
      ok: false,
      error,
    })
  })

  test("a rejection that loses a race is not an unhandled rejection", async () => {
    // The reason the work is settled *before* the race rather than raced directly. In
    // a Node server an unhandled rejection is a process-level warning triggered by
    // nothing worse than a slow runtime.
    const slowFailure = settle(
      new Promise<number>((_resolve, reject) =>
        setTimeout(() => reject(new Error("too late")), 20)
      )
    )

    await expect(withDeadline(slowFailure, 5)).resolves.toBe(TIMED_OUT)
    // Awaited afterwards to prove it was already handled: an unsettled rejection
    // would have surfaced as a process warning by now.
    await expect(slowFailure).resolves.toMatchObject({ ok: false })
  })
})

describe("releaseIterator — abandoning a stream cannot throw", () => {
  test("an iterator with a return method is released", async () => {
    let released = false
    const iterator: AsyncIterator<Uint8Array> = {
      async next() {
        return { done: true, value: undefined }
      },
      async return() {
        released = true
        return { done: true as const, value: undefined }
      },
    }

    await releaseIterator(iterator)

    expect(released).toBe(true)
  })

  test("an iterator with no return method is tolerated", async () => {
    const iterator: AsyncIterator<Uint8Array> = {
      async next() {
        return { done: true, value: undefined }
      },
    }

    await expect(releaseIterator(iterator)).resolves.toBeUndefined()
  })

  test("a return method that throws is swallowed", async () => {
    // This runs while abandoning a stream that may already be broken, and the outcome
    // is decided by then. A throw here would replace a stated timeout with an
    // unrelated 500.
    const iterator: AsyncIterator<Uint8Array> = {
      async next() {
        return { done: true, value: undefined }
      },
      async return(): Promise<IteratorResult<Uint8Array>> {
        throw new Error("already destroyed")
      },
    }

    await expect(releaseIterator(iterator)).resolves.toBeUndefined()
  })
})
