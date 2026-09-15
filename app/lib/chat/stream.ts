import "server-only"

import {
  invokeAgentRuntime,
  MissingRuntimeConfigError,
  type ChatCommand,
} from "@/lib/aws/agentcore"
import {
  parseSseFrame,
  releaseIterator,
  settle,
  splitSseFrames,
  TIMED_OUT,
  withDeadline,
} from "@/lib/aws/agent-stream"
import { redactForBrowser } from "@/lib/aws/redact"

/**
 * One chat turn against the runtime, as a sequence of the events the Ask page needs
 * (ask-chat Req 1).
 *
 * The runtime's `chat` command speaks the declared vocabulary: `tool` steps, `delta` text,
 * `error`, and `done` carrying the turn's outcome. Every frame passes through
 * {@link redactForBrowser} before anything reads it, although a chat invocation carries no
 * credential to redact — the redaction is the rule for every stream that reaches a browser,
 * and a rule with an exemption is the rule that later gets widened.
 *
 * The deadline is re-raced on every read, as `lib/subscriptions/inventory.ts` does, so a
 * runtime emitting heartbeats forever is still bounded.
 */

export const CHAT_TURN_TIMEOUT_MS = 120_000

export type RuntimeChatEvent =
  | {
      readonly type: "tool"
      readonly phase: "start" | "end"
      readonly name: string
      readonly label: string
      readonly status: string
    }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | { readonly type: "done"; readonly status: string; readonly outcome: Record<string, unknown> }

export async function* streamChatTurn(a: {
  readonly sessionId: string
  readonly actorId: string
  readonly command: ChatCommand
  readonly timeoutMs?: number
}): AsyncGenerator<RuntimeChatEvent> {
  const deadline = Date.now() + (a.timeoutMs ?? CHAT_TURN_TIMEOUT_MS)

  const opened = await withDeadline(
    settle(
      invokeAgentRuntime({
        sessionId: a.sessionId,
        context: { actor_id: a.actorId },
        command: a.command,
      })
    ),
    deadline - Date.now()
  )

  if (opened === TIMED_OUT) {
    yield { type: "error", code: "TIMEOUT", message: "The assistant did not start in time." }
    return
  }
  if (!opened.ok) {
    if (opened.error instanceof MissingRuntimeConfigError) throw opened.error
    yield { type: "error", code: "UNREACHABLE", message: "The assistant could not be reached." }
    return
  }

  const iterator = opened.value[Symbol.asyncIterator]()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    for (;;) {
      const step = await withDeadline(settle(iterator.next()), deadline - Date.now())

      if (step === TIMED_OUT) {
        yield { type: "error", code: "TIMEOUT", message: "The assistant took too long to answer." }
        return
      }
      if (!step.ok || step.value.done === true) {
        yield {
          type: "error",
          code: "TRUNCATED",
          message: "The assistant's answer ended before it finished.",
        }
        return
      }

      buffer += decoder.decode(step.value.value, { stream: true })
      const { frames, rest } = splitSseFrames(buffer)
      buffer = rest

      for (const frame of frames) {
        const event = toChatEvent(redactForBrowser(parseSseFrame(frame)))
        if (event === undefined) continue
        yield event
        if (event.type === "done") return
      }
    }
  } finally {
    await releaseIterator(iterator)
  }
}

function toChatEvent(payload: unknown): RuntimeChatEvent | undefined {
  if (payload === null || typeof payload !== "object") return undefined
  const record = payload as Record<string, unknown>

  switch (record.type) {
    case "tool":
      if (
        (record.phase === "start" || record.phase === "end") &&
        typeof record.name === "string"
      ) {
        return {
          type: "tool",
          phase: record.phase,
          name: record.name,
          label: typeof record.label === "string" ? record.label : record.name,
          status: typeof record.status === "string" ? record.status : "",
        }
      }
      return undefined
    case "delta":
      return typeof record.text === "string" ? { type: "delta", text: record.text } : undefined
    case "error":
      return {
        type: "error",
        code: typeof record.code === "string" ? record.code : "INTERNAL_ERROR",
        message: typeof record.message === "string" ? record.message : "",
      }
    case "done": {
      const { type: _type, run_id: _run, status, ...outcome } = record
      void _type
      void _run
      return { type: "done", status: typeof status === "string" ? status : "failed", outcome }
    }
    default:
      return undefined
  }
}
