import { MissingRuntimeConfigError } from "@/lib/aws/agentcore"
import {
  internalError,
  invalidInput,
  json,
  malformedBody,
  notFound,
  readJsonBody,
  unauthorized,
  unprocessable,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { sendMessageSchema } from "@/lib/chat/input"
import { assistantMessageFrom } from "@/lib/chat/outcome"
import { chatLimiter } from "@/lib/chat/rate-limit"
import { buildChatTurn } from "@/lib/chat/sources"
import {
  appendMessage,
  ChatThreadNotFoundError,
  listMessages,
  readThread,
} from "@/lib/chat/store"
import { streamChatTurn } from "@/lib/chat/stream"
import { fallbackTitle, generateTitle } from "@/lib/chat/title"
import type { ChatStep, ChatStreamEvent } from "@/lib/chat/views"
import { sessionIdForThread } from "@/lib/session-id"

/**
 * `POST /api/chat/threads/[threadId]/messages` — ask one question, streamed
 * (ask-chat Req 1, 7).
 *
 * The order is what makes the history trustworthy:
 *
 *   1. the thread is read and the user's membership checked (404 otherwise);
 *   2. the attachments are **re-authorized now** (`buildChatTurn`) — a report whose
 *      verification was superseded since it was attached is not read;
 *   3. the question is stored before the runtime is invoked, so a turn that fails still
 *      shows what was asked;
 *   4. the runtime's steps and text are relayed as SSE;
 *   5. the answer is stored with its citations and any proposal, resolved from the opaque
 *      target id to the customer and connector it stood for.
 *
 * Step 5 runs even when the browser has gone away: `start` keeps going after the reader
 * cancels, and a write to a closed stream is swallowed. A teammate opening the thread
 * later sees the answer the asker's closed tab never did.
 *
 * One runtime session per thread (`sessionIdForThread`), so follow-up questions land on a
 * warm environment instead of paying a cold start each turn.
 */
export const runtime = "nodejs"

type MessagesRouteContext = Readonly<{ params: Promise<{ threadId: string }> }>

const UNANSWERED = "The assistant could not answer this question. Try again in a moment."

export async function POST(request: Request, context: MessagesRouteContext): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()
  const { threadId } = await context.params

  const body = await readJsonBody(request)
  if (body === undefined) return malformedBody()
  const parsed = sendMessageSchema.safeParse(body)
  if (!parsed.success) return invalidInput(parsed.error)
  const prompt = parsed.data.prompt

  let thread
  try {
    thread = await readThread(user.id, threadId)
  } catch (thrown) {
    if (thrown instanceof ChatThreadNotFoundError) return notFound()
    console.error(`[api/chat/messages] read failed: ${describe(thrown)}`)
    return internalError()
  }

  if (!chatLimiter().allow(user.id)) {
    return json(429, {
      error: {
        message: "You are sending questions too quickly. Wait a minute and try again.",
        code: "RATE_LIMITED",
      },
    })
  }

  let turn
  let firstTurn
  let appended
  try {
    const previous = await listMessages(thread)
    firstTurn = previous.length === 0
    turn = await buildChatTurn({ userId: user.id, thread, prompt, previous })
    if (turn.attachedRuns + turn.attachedScans + turn.attachedLive === 0) {
      return unprocessable(
        "Attach a verified report, a scanned connector or live metrics before asking. An " +
          "answer here can only cite what is attached.",
        "NO_READABLE_ATTACHMENTS"
      )
    }
    appended = await appendMessage(thread, {
      role: "user",
      text: prompt,
      authorId: user.id,
      citations: {},
      steps: [],
    })
  } catch (thrown) {
    console.error(`[api/chat/messages] preparing the turn failed: ${describe(thrown)}`)
    return internalError()
  }

  const chatTurn = turn
  const userMessage = appended
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      const send = (event: ChatStreamEvent) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          open = false
        }
      }

      send({ type: "user_message", message: userMessage.message })

      let text = ""
      const steps: ChatStep[] = []
      let outcome: Record<string, unknown> | undefined
      let failure: string | undefined

      try {
        for await (const event of streamChatTurn({
          sessionId: sessionIdForThread(userMessage.thread.id),
          actorId: user.id,
          command: chatTurn.command,
        })) {
          if (event.type === "tool") {
            const step = { name: event.name, label: event.label, status: event.status }
            if (event.phase === "start") steps.push(step)
            send({ type: "step", step, phase: event.phase })
          } else if (event.type === "delta") {
            text += event.text
            send({ type: "delta", text: event.text })
          } else if (event.type === "error") {
            failure = UNANSWERED
          } else if (event.status === "completed") {
            outcome = event.outcome
          } else {
            failure ??= UNANSWERED
          }
        }
      } catch (thrown) {
        failure =
          thrown instanceof MissingRuntimeConfigError
            ? "The assistant is not configured on this deployment."
            : "The assistant could not be reached. Try again in a moment."
        console.error(`[api/chat/messages] the turn failed: ${describe(thrown)}`)
      }

      const assistant = assistantMessageFrom({
        authorId: user.id,
        text,
        steps,
        outcome,
        failure,
        targets: chatTurn.targets,
      })

      try {
        const title = firstTurn
          ? assistant.failed || assistant.refused
            ? fallbackTitle(prompt)
            : await generateTitle(prompt)
          : undefined
        const saved = await appendMessage(userMessage.thread, assistant, { title })
        send({ type: "message", message: saved.message, thread: saved.thread })
      } catch (thrown) {
        console.error(`[api/chat/messages] saving the answer failed: ${describe(thrown)}`)
        send({ type: "error", message: "The answer could not be saved. Reload the conversation." })
      }

      if (open) {
        try {
          controller.close()
        } catch {
          // The browser already closed it.
        }
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown
}
