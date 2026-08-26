import { z } from "zod"

/**
 * The named boundary schemas for the scan routes (Requirement 4.4).
 *
 * **Pure, and deliberately not `server-only`.** No I/O, no database, no
 * environment, no secret held. The same reasoning as `lib/subscriptions/input.ts`:
 * a client that needs to know the accepted shape of a request should be able to
 * name the schema.
 */

// --- The dynamic segment ----------------------------------------------------

/**
 * An upper bound on a path segment, so a pathological URL is refused before it
 * becomes a bound parameter.
 */
const SUBSCRIPTION_ID_PARAM_MAX_LENGTH = 200

const SUBSCRIPTION_ID_PARAM_MESSAGE =
  "The connected subscription id is missing from the request path."

/**
 * `[id]` in `/api/subscriptions/[id]/scan` — the same bounded non-empty string
 * as the inventory route's param schema. Not `z.uuid()` for the same reasons.
 */
export const scanParamsSchema = z
  .object({
    id: z
      .string({ error: SUBSCRIPTION_ID_PARAM_MESSAGE })
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .min(1, { error: SUBSCRIPTION_ID_PARAM_MESSAGE })
          .max(SUBSCRIPTION_ID_PARAM_MAX_LENGTH, {
            error: SUBSCRIPTION_ID_PARAM_MESSAGE,
          })
      ),
  })
  .strict()

export type ScanParams = z.output<typeof scanParamsSchema>

/**
 * `POST /api/subscriptions/[id]/scan` — an empty body, because the scan takes
 * no configuration from the caller. `.strict()` so an unrecognized key is a
 * rejection rather than something to drop quietly.
 */
export const scanPostBodySchema = z.object({}).strict()

export type ScanPostBody = z.output<typeof scanPostBodySchema>

/**
 * `GET /api/subscriptions/[id]/scan` — no search parameters.
 */
export const scanQuerySchema = z.object({}).strict()

export type ScanQuery = z.output<typeof scanQuerySchema>
