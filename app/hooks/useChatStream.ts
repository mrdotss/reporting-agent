"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type {
  ChatMessageView,
  ChatStep,
  ChatStreamEvent,
  ChatThreadView,
} from "@/lib/chat/views"

/**
 * Send one question and follow its answer as it streams (ask-chat Req 1).
 *
 * `EventSource` only speaks GET, and a question is a POST, so this reads the response body
 * with a stream reader and splits SSE frames itself. The route stores the answer whether
 * or not this hook is still listening, so unmounting aborts the read and loses nothing.
 *
 * **The answer is revealed evenly, not as it lands.** The runtime forwards whatever the
 * model's stream hands it, which arrives in uneven bursts — several sentences at once, then
 * a pause — and that reads as stuttering. Received text is buffered and released a few
 * characters per frame, fast enough to keep up with the model and never ahead of it. When
 * the turn ends the rest is released at once, so nothing is ever left unshown.
 */

/** Characters per frame, chosen from how far behind the reveal is. */
function revealStep(backlog: number): number {
  return Math.max(1, Math.ceil(backlog / 12))
}

export type LiveTurn = {
  readonly question: string
  readonly steps: readonly (ChatStep & { readonly done: boolean })[]
  readonly text: string
  /** What the assistant said it is about to do, before the answer starts. */
  readonly intent: string
  /** The answer model's reasoning so far, numbers masked by the runtime. */
  readonly thinking: string
  /** When the reasoning started, as `Date.now()`, for the running timer. */
  readonly thinkingSince?: number
  /** Seconds it reasoned, fixed when the answer's first words arrive. */
  readonly thoughtSeconds?: number
}

export type SendResult =
  | { readonly ok: true; readonly message: ChatMessageView; readonly thread: ChatThreadView }
  | { readonly ok: false; readonly error: string }

export function parseStreamFrames(buffer: string): { events: ChatStreamEvent[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/)
  const rest = parts.pop() ?? ""
  const events: ChatStreamEvent[] = []
  for (const part of parts) {
    const data = part
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
    if (!data) continue
    try {
      events.push(JSON.parse(data) as ChatStreamEvent)
    } catch {
      // A frame that is not JSON carries nothing this hook reads.
    }
  }
  return { events, rest }
}

export function useChatStream(options: {
  readonly onUserMessage?: (message: ChatMessageView) => void
} = {}) {
  const [live, setLive] = useState<LiveTurn | null>(null)
  const abort = useRef<AbortController | null>(null)
  const onUserMessage = useRef(options.onUserMessage)
  const received = useRef("")
  const shown = useRef(0)
  const frame = useRef<number | null>(null)

  const stopReveal = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
  }, [])

  /** Release a few more characters, and keep going while any are held back. */
  const reveal = useCallback(() => {
    frame.current = null
    const backlog = received.current.length - shown.current
    if (backlog <= 0) return
    shown.current += revealStep(backlog)
    const text = received.current.slice(0, shown.current)
    setLive((turn) =>
      turn === null
        ? turn
        : {
            ...turn,
            text,
            thoughtSeconds:
              turn.thoughtSeconds ??
              (turn.thinkingSince === undefined
                ? undefined
                : Math.round((Date.now() - turn.thinkingSince) / 1000)),
          }
    )
    if (shown.current < received.current.length) frame.current = requestAnimationFrame(reveal)
  }, [])

  /** Show everything received so far, immediately. */
  const revealAll = useCallback(() => {
    stopReveal()
    if (shown.current >= received.current.length) return
    shown.current = received.current.length
    const text = received.current
    setLive((turn) => (turn === null ? turn : { ...turn, text }))
  }, [stopReveal])

  useEffect(() => {
    onUserMessage.current = options.onUserMessage
  }, [options.onUserMessage])

  useEffect(
    () => () => {
      abort.current?.abort()
      stopReveal()
    },
    [stopReveal]
  )

  const send = useCallback(async (threadId: string, question: string, model?: string): Promise<SendResult> => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    received.current = ""
    shown.current = 0
    stopReveal()
    setLive({ question, steps: [], text: "", intent: "", thinking: "" })

    try {
      const response = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(model === undefined ? { prompt: question } : { prompt: question, model }),
        signal: controller.signal,
      })

      if (!response.ok || response.body === null) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null
        return { ok: false, error: body?.error?.message ?? "The question could not be sent." }
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let result: SendResult = {
        ok: false,
        error: "The answer stopped before it finished. Reload the conversation.",
      }

      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const { events, rest } = parseStreamFrames(buffer)
        buffer = rest

        for (const event of events) {
          switch (event.type) {
            case "user_message":
              onUserMessage.current?.(event.message)
              break
            case "step":
              setLive((turn) =>
                turn === null
                  ? turn
                  : {
                      ...turn,
                      steps:
                        event.phase === "start"
                          ? [...turn.steps, { ...event.step, done: false }]
                          : turn.steps.map((step) =>
                              step.name === event.step.name ? { ...step, done: true } : step
                            ),
                    }
              )
              break
            case "delta":
              received.current += event.text
              if (frame.current === null) frame.current = requestAnimationFrame(reveal)
              break
            case "intent":
              setLive((turn) => (turn === null || turn.text ? turn : { ...turn, intent: event.text }))
              break
            case "thinking":
              setLive((turn) =>
                turn === null
                  ? turn
                  : {
                      ...turn,
                      thinking: turn.thinking + event.text,
                      thinkingSince: turn.thinkingSince ?? Date.now(),
                    }
              )
              break
            case "message":
              revealAll()
              result = { ok: true, message: event.message, thread: event.thread }
              break
            case "error":
              result = { ok: false, error: event.message }
              break
          }
        }
      }
      return result
    } catch (thrown) {
      if (thrown instanceof DOMException && thrown.name === "AbortError") {
        return { ok: false, error: "" }
      }
      return { ok: false, error: "The question could not be sent. Check your connection." }
    } finally {
      if (abort.current === controller) abort.current = null
      stopReveal()
      setLive(null)
    }
  }, [reveal, revealAll, stopReveal])

  return { live, send }
}
