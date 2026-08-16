import "server-only"

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

/**
 * AES-256-GCM for secrets held at rest — the Azure `client_secret` above all
 * (Requirement 4).
 *
 * The envelope is one base64 string laying out `iv | tag | ciphertext`, so a
 * single column holds everything decryption needs and nothing it does not.
 *
 * Two error types, deliberately: a rotated or mistyped key and a tampered
 * value are different operational events, and one `Error` cannot carry that
 * distinction (Requirement 4.11). No message here carries plaintext,
 * ciphertext or key material (Requirement 4.10).
 */

const ENV_VAR = "APP_ENCRYPTION_KEY"
const ALGORITHM = "aes-256-gcm"

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/** An envelope shorter than this cannot even hold its own IV and tag. */
const ENVELOPE_HEADER_BYTES = IV_BYTES + TAG_BYTES

/** Standard and URL-safe base64 alphabets, with optional padding. */
const BASE64_KEY_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/

/** `APP_ENCRYPTION_KEY` is absent, or does not resolve to 32 bytes. */
export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EncryptionKeyError"
  }
}

/** An envelope is malformed, or its authentication tag does not verify. */
export class CiphertextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CiphertextError"
  }
}

/**
 * Node's base64 decoder is lenient: it skips characters it does not recognise
 * and drops a trailing partial group, so a 20-byte value and a line of prose
 * both "decode". Validate the alphabet, then trust the decoded length rather
 * than the input's shape.
 */
function decodeBase64Key(candidate: string): Buffer | null {
  if (!BASE64_KEY_PATTERN.test(candidate)) return null
  const decoded = Buffer.from(candidate, "base64")
  return decoded.length === KEY_BYTES ? decoded : null
}

/**
 * Resolve the 32-byte key from `APP_ENCRYPTION_KEY` **at call time**, so a key
 * rotated in the environment takes effect without a module reload
 * (Requirement 4.7). Accepts a base64 encoding of 32 bytes or 32 raw bytes;
 * the two shapes cannot collide, because base64 of 32 bytes is at least 43
 * characters.
 *
 * Exported because `lib/runs/progress-token.ts` keys its HMAC from these same
 * bytes — one key, resolved one way, in one place.
 */
export function resolveEncryptionKey(): Buffer {
  const configured = process.env[ENV_VAR]
  const candidate = configured === undefined ? "" : configured.trim()

  if (candidate.length === 0) {
    throw new EncryptionKeyError(
      `${ENV_VAR} is not set. It must be a base64 encoding of ${KEY_BYTES} ` +
        `bytes, or ${KEY_BYTES} raw bytes.`
    )
  }

  const fromBase64 = decodeBase64Key(candidate)
  if (fromBase64 !== null) return fromBase64

  const fromRawBytes = Buffer.from(candidate, "utf8")
  if (fromRawBytes.length === KEY_BYTES) return fromRawBytes

  throw new EncryptionKeyError(
    `${ENV_VAR} does not resolve to exactly ${KEY_BYTES} bytes. It must be a ` +
      `base64 encoding of ${KEY_BYTES} bytes, or ${KEY_BYTES} raw bytes. Its ` +
      `value is excluded from this message.`
  )
}

/**
 * Encrypt a UTF-8 string, returning base64 of `iv | tag | ciphertext`
 * (Requirement 4.2). The IV is fresh from `randomBytes` on every call, so the
 * same plaintext encrypts to two different envelopes (Requirements 4.3, 4.9).
 *
 * The empty string is a legitimate plaintext: it yields a 28-byte envelope
 * carrying an IV and a tag over no ciphertext.
 */
export function encryptSecret(plaintext: string): string {
  const key = resolveEncryptionKey()
  const iv = randomBytes(IV_BYTES)

  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  })
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])

  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")
}

/**
 * Decrypt an envelope produced by {@link encryptSecret}, returning the
 * original UTF-8 string.
 *
 * Throws `CiphertextError` for an envelope too short to hold its own IV and
 * tag (Requirement 4.6) and for a tag that does not verify — a modified value,
 * or one encrypted under a different key (Requirement 4.5). Throws
 * `EncryptionKeyError`, distinctly, when the key itself does not resolve
 * (Requirement 4.11); key resolution therefore sits outside the try block, so
 * a key problem is never reported as a tampering problem.
 */
export function decryptSecret(blob: string): string {
  const key = resolveEncryptionKey()
  const envelope = Buffer.from(blob, "base64")

  if (envelope.length < ENVELOPE_HEADER_BYTES) {
    throw new CiphertextError(
      `The encrypted value is too short: it decodes to fewer than ` +
        `${ENVELOPE_HEADER_BYTES} bytes, which cannot hold a ${IV_BYTES}-byte ` +
        `initialization vector and a ${TAG_BYTES}-byte authentication tag.`
    )
  }

  const iv = envelope.subarray(0, IV_BYTES)
  const tag = envelope.subarray(IV_BYTES, ENVELOPE_HEADER_BYTES)
  const ciphertext = envelope.subarray(ENVELOPE_HEADER_BYTES)

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES,
    })
    decipher.setAuthTag(tag)
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8")
  } catch {
    throw new CiphertextError(
      "The encrypted value failed authentication: its authentication tag " +
        "does not verify under the resolved key, so the value was modified " +
        "or was encrypted under a different key."
    )
  }
}
