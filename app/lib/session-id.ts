import { createHash, randomBytes } from "node:crypto"

/**
 * AgentCore runtime session ids.
 *
 * `InvokeAgentRuntime` requires `runtimeSessionId` to be 33–128 characters.
 * Every id here satisfies that bound *by construction*: a SHA-256 hex digest
 * is 64 lowercase-hex characters for any input, and 48 random bytes encode to
 * 64 base64url characters. There is no length validation because there is no
 * input that could violate the bound (Req 8.1).
 *
 * Pure and secret-free, so deliberately not `server-only`.
 */

/** Namespace prefixes — a thread id and a run id carrying the same string
 * value must derive different session ids (Req 8.6). Versioned so a future
 * derivation change is a new namespace rather than a silent reinterpretation
 * of ids already in use. */
const THREAD_NS = "rpt:session:thread:v1:"
const RUN_NS = "rpt:session:run:v1:"

/** Random bytes drawn for a fresh session id (Req 8.4). */
const RANDOM_BYTES = 48

/**
 * SHA-256 over the namespace-prefixed input, hex encoded.
 *
 * Deterministic (Req 8.2), 64 characters (Req 8.1), lowercase hexadecimal
 * alphabet only (Req 8.3), and injective in practice so distinct inputs within
 * one namespace derive distinct ids (Req 8.7).
 */
function derive(namespace: string, value: string): string {
  return createHash("sha256")
    .update(namespace + value, "utf8")
    .digest("hex")
}

/**
 * The stable session id for a chat thread, so agent memory stays continuous
 * across turns (Req 8.1, 8.2, 8.3, 8.7).
 */
export function sessionIdForThread(threadId: string): string {
  return derive(THREAD_NS, threadId)
}

/**
 * The stable session id for a report run, derived from the run id so a retried
 * invocation of the same run presents the same session id (Req 8.5).
 */
export function sessionIdForRun(runId: string): string {
  return derive(RUN_NS, runId)
}

/**
 * A fresh random session id: 48 random bytes as base64url, i.e. 64 unpadded
 * characters from the base64url alphabet (Req 8.4).
 */
export function newSessionId(): string {
  return randomBytes(RANDOM_BYTES).toString("base64url")
}
