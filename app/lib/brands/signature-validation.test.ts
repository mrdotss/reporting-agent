import { describe, expect, test } from "vitest"

import {
  SIGNATURE_MAX_BYTES,
  sniffImageFormat,
  validateSignatureUpload,
} from "@/lib/brands/signature-validation"

const PNG_HEADER = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const JPEG_HEADER = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)
const PDF_HEADER = Uint8Array.from(
  Array.from("%PDF-1.4", (c) => c.charCodeAt(0))
)

function bytesOf(length: number, header: Uint8Array = new Uint8Array()): Uint8Array {
  const out = new Uint8Array(length)
  out.set(header)
  return out
}

describe("sniffImageFormat — content, never the label", () => {
  test("a real PNG header is recognised as png", () => {
    expect(sniffImageFormat(bytesOf(20, PNG_HEADER))).toBe("png")
  })

  test("a real JPEG header is recognised as jpeg", () => {
    expect(sniffImageFormat(bytesOf(20, JPEG_HEADER))).toBe("jpeg")
  })

  test("a PDF header is not recognised", () => {
    expect(sniffImageFormat(bytesOf(20, PDF_HEADER))).toBeNull()
  })

  test("a file shorter than any magic number is not recognised", () => {
    expect(sniffImageFormat(Uint8Array.of(0x89, 0x50))).toBeNull()
  })

  test("an empty buffer is not recognised", () => {
    expect(sniffImageFormat(new Uint8Array())).toBeNull()
  })

  test("bytes that merely start similarly to PNG but diverge are rejected", () => {
    const almost = Uint8Array.from(PNG_HEADER)
    almost[3] = 0x00 // corrupt one magic byte
    expect(sniffImageFormat(bytesOf(20, almost))).toBeNull()
  })
})

describe("validateSignatureUpload — Requirement 13.6's two refusals", () => {
  test("a valid PNG under the ceiling is accepted", () => {
    const result = validateSignatureUpload(bytesOf(1024, PNG_HEADER))
    expect(result).toEqual({ format: "png" })
  })

  test("a valid JPEG under the ceiling is accepted", () => {
    const result = validateSignatureUpload(bytesOf(1024, JPEG_HEADER))
    expect(result).toEqual({ format: "jpeg" })
  })

  test("an empty file is rejected with its own reason", () => {
    const result = validateSignatureUpload(new Uint8Array())
    expect("reason" in result).toBe(true)
    expect((result as { reason: string }).reason).toContain("empty")
  })

  test("a file over the byte ceiling is rejected, stating the ceiling", () => {
    const result = validateSignatureUpload(
      bytesOf(SIGNATURE_MAX_BYTES + 1, PNG_HEADER)
    )
    expect("reason" in result).toBe(true)
    expect((result as { reason: string }).reason).toContain(
      String(SIGNATURE_MAX_BYTES)
    )
  })

  test("a file exactly at the ceiling is accepted — the bound is inclusive", () => {
    const result = validateSignatureUpload(bytesOf(SIGNATURE_MAX_BYTES, PNG_HEADER))
    expect(result).toEqual({ format: "png" })
  })

  test("a non-image file under the ceiling is rejected, stating the reason", () => {
    const result = validateSignatureUpload(bytesOf(1024, PDF_HEADER))
    expect("reason" in result).toBe(true)
    expect((result as { reason: string }).reason).toContain(
      "not a recognised raster image"
    )
  })

  test("declaring a fake extension does not change the outcome — content wins", () => {
    // The function takes only bytes; there is no filename parameter to
    // mislead it with. This test documents that fact rather than exercising
    // a branch, since a mislabeled-but-real-PNG upload is exactly what
    // sniffing exists to still accept.
    const result = validateSignatureUpload(bytesOf(1024, PNG_HEADER))
    expect(result).toEqual({ format: "png" })
  })
})
