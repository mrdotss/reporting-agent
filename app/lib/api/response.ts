import type { z } from "zod"

/**
 * The JSON response shapes every route handler answers in.
 *
 * **Pure, and deliberately not `server-only`.** It builds `Response` objects out
 * of plain data: no database, no environment, no secret. It is not marked because
 * there is nothing here to leak, and because a client that wants to type the error
 * body it receives should be able to name {@link ApiErrorBody}.
 *
 * It exists because eight route handlers land in this spec and they have to agree
 * about three things a caller parses: the error envelope, the status codes, and
 * `Cache-Control`. Eight local `new Response(JSON.stringify(...))` calls is how one
 * of them ends up returning a bare string, or omitting `no-store` on a body
 * carrying somebody's subscriptions.
 *
 * ## `no-store` on every response, not just the sensitive ones
 *
 * Every response built here carries `Cache-Control: no-store`. The bodies are
 * per-user projections and, in one case, a presigned URL, and a route that got the
 * header wrong would be cached by an intermediary and served to the next
 * requester. Making it unconditional means no handler has to decide, and a handler
 * that needs a cacheable response has to say so explicitly rather than get one by
 * forgetting.
 *
 * ## Why the error body is this shape
 *
 * ```jsonc
 * { "error": { "message": "…", "code": "SCOPE_UNVERIFIED", "fields": [ … ] } }
 * ```
 *
 * A nested object rather than a bare `{ message }`, so a success body and an error
 * body are distinguishable by the presence of one key at any status — which is what
 * lets a client that mishandles a status code still fail loudly instead of reading
 * `undefined` fields off a rejection.
 */

/** The one error envelope. */
export type ApiErrorBody = {
  readonly error: {
    /** Human-readable, and safe to display. Never carries a submitted value. */
    readonly message: string
    /** A machine code where one exists — a run error code, or a named case. */
    readonly code?: string
    /** Per-field messages from a schema rejection, when there are any. */
    readonly fields?: readonly {
      readonly path: string
      readonly message: string
    }[]
  }
}

/**
 * `Cache-Control` for everything below.
 *
 * `no-store` rather than `no-cache`: `no-cache` permits storing the response and
 * revalidating it, which for a body carrying a masked subscription id or a
 * presigned URL is storage we do not want to have happened.
 */
const NO_STORE = "no-store"

/** A JSON response at `status`, never cached. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": NO_STORE,
    },
  })
}

/**
 * `401`, for a request with no valid session (Requirement 7.6).
 *
 * A status rather than a redirect: a `fetch` that follows a 307 to `/login`
 * receives that page's HTML with a 200, so a caller expecting JSON sees a parse
 * error instead of "not signed in". `lib/auth/guard.ts` documents the same split.
 */
export function unauthorized(): Response {
  return json(401, {
    error: { message: "Sign in to continue.", code: "UNAUTHENTICATED" },
  } satisfies ApiErrorBody)
}

/**
 * `404`, for a resource that is not this user's (Requirements 9.8, 37.12).
 *
 * Not found, **not** forbidden. A "forbidden" answer confirms the row exists, and
 * its existence is itself a fact about somebody else's customer. The message names
 * nothing.
 */
export function notFound(): Response {
  return json(404, {
    error: { message: "Not found.", code: "NOT_FOUND" },
  } satisfies ApiErrorBody)
}

/** `400`, for a body that is not JSON at all. */
export function malformedBody(): Response {
  return json(400, {
    error: {
      message: "The request body could not be read as JSON.",
      code: "MALFORMED_BODY",
    },
  } satisfies ApiErrorBody)
}

/** `400` with a message this handler wrote. */
export function badRequest(message: string, code?: string): Response {
  return json(400, { error: { message, code } } satisfies ApiErrorBody)
}

/**
 * `422`, for input that parsed but names a state the server will not enter.
 *
 * Distinct from `400`: the body was well-formed and understood. A rejected
 * preflight is the case this exists for — the submission was fine, the *answer* was
 * that subscription-scope read could not be proved.
 */
export function unprocessable(message: string, code?: string): Response {
  return json(422, { error: { message, code } } satisfies ApiErrorBody)
}

/** `409`, for a request that lost a race or duplicates an existing row. */
export function conflict(message: string, code?: string): Response {
  return json(409, { error: { message, code } } satisfies ApiErrorBody)
}

/**
 * `503`, for a deployment that is missing configuration this route needs.
 *
 * The message names **no variable**. `MissingEnvError` and
 * `MissingRuntimeConfigError` both name theirs, which is right for a server log
 * and wrong for a browser: the variable's name is a fact about our deployment, and
 * the consultant reading this can act on neither it nor its absence.
 */
export function serviceUnavailable(message: string, code?: string): Response {
  return json(503, { error: { message, code } } satisfies ApiErrorBody)
}

/**
 * `500`, for a failure with no better statement available.
 *
 * The message is fixed and carries nothing from the thrown value. Everything a
 * server error could usefully say about itself — a SQLSTATE, a redacted driver
 * message — is something to log, and the modules that throw already redact what
 * they throw.
 */
export function internalError(): Response {
  return json(500, {
    error: {
      message: "The request could not be completed.",
      code: "INTERNAL_ERROR",
    },
  } satisfies ApiErrorBody)
}

/**
 * `400` from a zod rejection, carrying **only** each issue's path and message.
 *
 * The `ZodError` itself is never serialized. `ZodError.message` is a JSON dump of
 * every issue, and an issue's shape varies by code — the safe subset is the path
 * and the message, both of which name a field rather than quote a value. Since the
 * schemas in `lib/subscriptions/input.ts` attach their own messages to the
 * secret-bearing fields, the result states the accepted format and length without
 * ever echoing what was submitted.
 *
 * The top-level `message` is the first issue's, so a caller that renders only
 * `error.message` still says something specific.
 */
export function invalidInput(error: z.ZodError): Response {
  const fields = error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }))

  return json(400, {
    error: {
      message: fields[0]?.message ?? "The request could not be validated.",
      code: "INVALID_INPUT",
      fields,
    },
  } satisfies ApiErrorBody)
}

/**
 * The request's JSON body, or `undefined` if it is not JSON.
 *
 * `undefined` rather than a throw, so a handler answers {@link malformedBody}
 * instead of a 500. Returns `unknown`: the value has not been validated yet, and
 * typing it as anything else here is the `as SomeType` Requirement 7.7 forbids,
 * one function earlier than usual.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown
  } catch {
    return undefined
  }
}

/**
 * A URL's search parameters as a plain object, for a zod schema to parse.
 *
 * The last value wins for a repeated key. A route that genuinely accepts a
 * repeated parameter needs `getAll` and its own schema; flattening here is what
 * makes the common case — a route whose accepted set is empty, or a handful of
 * scalars — a single `safeParse` rather than a hand-walk of the entries.
 */
export function searchParamsObject(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams)
}
