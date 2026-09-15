import { z } from "zod"

import { CHAT_PROMPT_MAX, CHAT_TITLE_MAX } from "@/lib/chat/views"
import { MAX_LIVE_RESOURCES } from "@/lib/live-metrics/window"

/**
 * The request bodies of the chat routes (ask-chat Req 7, 8), each `.strict()`.
 *
 * Kept out of the route modules because a Next route file may export only its handlers and
 * route segment config.
 */

export const chatAttachmentsSchema = z
  .object({
    runIds: z.array(z.string().min(1).max(128)).max(6).default([]),
    connectorIds: z.array(z.string().min(1).max(128)).max(4).default([]),
    liveIds: z.array(z.string().min(1).max(128)).max(4).default([]),
  })
  .strict()

export const createThreadSchema = z
  .object({
    attachments: chatAttachmentsSchema.default({ runIds: [], connectorIds: [], liveIds: [] }),
  })
  .strict()

export const updateThreadSchema = z
  .object({
    title: z.string().trim().min(1).max(CHAT_TITLE_MAX).optional(),
    attachments: chatAttachmentsSchema.optional(),
  })
  .strict()

export const sendMessageSchema = z
  .object({
    prompt: z
      .string({ error: "Write a question first." })
      .trim()
      .min(1, { error: "Write a question first." })
      .max(CHAT_PROMPT_MAX, { error: `A question can be at most ${CHAT_PROMPT_MAX} characters.` }),
  })
  .strict()

export const proposalActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("request"),
      templateId: z.string().trim().min(1).max(128),
      revisionHistoryRow: z
        .object({
          revision: z.string().trim().min(1).max(32),
          note: z.string().trim().min(1).max(200),
          author: z.string().trim().min(1).max(120),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ action: z.literal("dismiss") }).strict(),
])

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Use a YYYY-MM-DD date." })

/** `POST /api/chat/live-metrics`. The window's semantic checks are `windowProblem`'s. */
export const livePullSchema = z
  .object({
    connectedSubscriptionId: z.string().trim().min(1).max(128),
    resourceIds: z
      .array(z.string().trim().min(1).max(512))
      .min(1, { error: "Pick at least one machine." })
      .max(MAX_LIVE_RESOURCES, { error: `Pick at most ${MAX_LIVE_RESOURCES} machines.` }),
    window: z.object({ start: localDate, end: localDate }).strict(),
  })
  .strict()
