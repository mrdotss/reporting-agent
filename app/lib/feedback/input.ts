import { z } from "zod"

/**
 * What the Send feedback dialog posts, and the words for each kind. **Pure**, so the
 * dialog, the route and the Admin list share one vocabulary.
 */

export const FEEDBACK_KINDS = ["idea", "problem", "question", "praise"] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

export const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = {
  idea: "Idea",
  problem: "Problem",
  question: "Question",
  praise: "Praise",
}

export const FEEDBACK_MESSAGE_MAX = 4000

/** `POST /api/feedback`. The workspace and the sender come from the session, never the body. */
export const feedbackInputSchema = z
  .object({
    kind: z.enum(FEEDBACK_KINDS),
    message: z.string().trim().min(1, "Write a few words first.").max(FEEDBACK_MESSAGE_MAX),
    // A path inside this app, as the dialog read it: no scheme, no host.
    pagePath: z
      .string()
      .max(500)
      .regex(/^\/[^\s]*$/)
      .nullable()
      .optional(),
    canReply: z.boolean(),
  })
  .strict()

export type FeedbackInput = z.infer<typeof feedbackInputSchema>

/** `PATCH /api/admin/feedback/:id` — mark one message done, or open again. */
export const feedbackStatusSchema = z.object({ done: z.boolean() }).strict()
