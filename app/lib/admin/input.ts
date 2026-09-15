import { z } from "zod"

/** `POST /api/admin/ask-access` — grant or remove Ask for one account (roles-and-ask-access Req 7). */
export const askAccessInputSchema = z
  .object({
    userId: z.string().min(1).max(200),
    enabled: z.boolean(),
  })
  .strict()
