/**
 * Signature image validation (Requirement 13.6) — pure, no I/O.
 *
 * "Not a recognised raster image" is checked by **content**, not by a declared
 * `Content-Type` header or a file extension: both are attacker- and
 * client-controlled labels an uploader can set to anything, so accepting them
 * at face value would let a non-image object land under a `signatures/` key
 * where a later render assumes an image it can decode. Sniffing the first bytes
 * against each format's real magic number is the same class of check
 * `azure-integration.md` already applies to metric values — trust the payload,
 * not the label attached to it.
 */

export const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024
/** 2 MiB. Generous for a scanned signature or a transparent-background PNG,
 * and small enough that a signature upload cannot become a way to fill the
 * artifact bucket. */

export type RecognisedImageFormat = "png" | "jpeg"

const PNG_MAGIC = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const JPEG_MAGIC = Uint8Array.of(0xff, 0xd8, 0xff)

function startsWith(bytes: Uint8Array, magic: Uint8Array): boolean {
  if (bytes.length < magic.length) return false
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false
  }
  return true
}

/**
 * Sniff `bytes`' real format from its magic number, or `null` if it matches
 * neither recognised raster format. Content-only — never reads a
 * `Content-Type` header or a file name, because both are supplied by the
 * uploader and neither is what this function is checking.
 */
export function sniffImageFormat(bytes: Uint8Array): RecognisedImageFormat | null {
  if (startsWith(bytes, PNG_MAGIC)) return "png"
  if (startsWith(bytes, JPEG_MAGIC)) return "jpeg"
  return null
}

export type SignatureRejection = { readonly reason: string }

/**
 * Validate an uploaded signature's bytes against Requirement 13.6's two
 * refusals — not a recognised raster image, or over the declared byte
 * ceiling — and state which one, so the wizard can show the real reason
 * rather than a generic "upload failed."
 *
 * Order matters: size is checked first because it is cheap and catches the
 * common case (a huge unrelated file) without needing to inspect its
 * content, but a file that is BOTH oversized and not an image still reports
 * the size reason first — only one reason is returned, and stating the
 * cheaper-to-explain one first is a reasonable tie-break, not a claim that
 * one refusal is more "true" than the other.
 */
export function validateSignatureUpload(
  bytes: Uint8Array
): { readonly format: RecognisedImageFormat } | SignatureRejection {
  if (bytes.length === 0) {
    return { reason: "The uploaded file is empty." }
  }
  if (bytes.length > SIGNATURE_MAX_BYTES) {
    return {
      reason:
        `The uploaded file is ${bytes.length} bytes, which exceeds the ` +
        `${SIGNATURE_MAX_BYTES}-byte ceiling for a signature image.`,
    }
  }

  const format = sniffImageFormat(bytes)
  if (format === null) {
    return {
      reason:
        "The uploaded file is not a recognised raster image (PNG or JPEG). " +
        "Its content was checked directly rather than trusting the declared " +
        "file type.",
    }
  }

  return { format }
}
