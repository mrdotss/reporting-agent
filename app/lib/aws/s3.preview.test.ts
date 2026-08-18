import { describe, expect, test } from "vitest"

import {
  ARTIFACT_SEGMENT_PREVIEWS,
  parseArtifactKey,
  previewBelongsToActor,
  previewHtmlKey,
  previewKey,
} from "@/lib/aws/s3"

/**
 * The preview key space, and the one property it exists to have
 * (Requirements 43.3, 14.6).
 *
 * **A preview is not a report, and the key space is what makes that true.**
 * `parseArtifactKey` admits exactly `snapshots` or exactly `reports`, so a
 * preview key returns `null` from it and `presignArtifact` refuses — the report
 * download path is structurally unable to serve a preview however the caller
 * asks. The first describe below is that claim, asserted directly.
 *
 * The second is the ordinary authorization property, restated for the second
 * predicate because it is a second predicate: `previewBelongsToActor` is not
 * `keyBelongsToActor` with a different segment, it is a separate function, and a
 * separate function is separately able to be wrong.
 */

const ACTOR = "alice"

describe("Requirement 43.3 — the report path cannot parse a preview key", () => {
  test("a preview key does not parse as a downloadable artifact", () => {
    expect(parseArtifactKey(previewKey(ACTOR, "pv-1"))).toBeNull()
    expect(parseArtifactKey(previewHtmlKey(ACTOR, "pv-1"))).toBeNull()
  })

  test("the previews segment is not one of the downloadable two", () => {
    // Stated against the constant rather than the string, so widening
    // `DOWNLOADABLE_SEGMENTS` to include previews fails here rather than
    // silently making the report route able to serve one.
    expect(parseArtifactKey(`${ACTOR}/${ARTIFACT_SEGMENT_PREVIEWS}/r/x`)).toBeNull()
  })

  test("the two keys of one preview share a prefix and differ in the leaf", () => {
    expect(previewKey(ACTOR, "pv-1")).toBe("alice/previews/pv-1/preview.pdf")
    expect(previewHtmlKey(ACTOR, "pv-1")).toBe("alice/previews/pv-1/preview.html")
  })
})

describe("previewBelongsToActor — exact segment equality", () => {
  test("this actor's own preview is admitted", () => {
    expect(previewBelongsToActor(ACTOR, previewKey(ACTOR, "pv-1"))).toBe(true)
    expect(previewBelongsToActor(ACTOR, previewHtmlKey(ACTOR, "pv-1"))).toBe(true)
  })

  test("a prefix of this actor's id is refused", () => {
    // The one that kills `key.startsWith(actorId)`. `alice-evil` starts with
    // `alice`, and a prefix test would hand alice a URL to somebody else's
    // object.
    expect(previewBelongsToActor(ACTOR, "alice-evil/previews/pv-1/preview.pdf")).toBe(
      false
    )
  })

  test("a second segment that is not exactly `previews` is refused", () => {
    for (const segment of ["Previews", "previews2", "reports", "", "snapshots"]) {
      expect(
        previewBelongsToActor(ACTOR, `${ACTOR}/${segment}/pv-1/preview.pdf`),
        segment
      ).toBe(false)
    }
  })

  test("a leaf that is not one of the two produced names is refused", () => {
    for (const leaf of ["preview.docx", "report.pdf", "", "preview.pdf.bak"]) {
      expect(previewBelongsToActor(ACTOR, `${ACTOR}/previews/pv-1/${leaf}`), leaf).toBe(
        false
      )
    }
  })

  test("a key with the wrong segment count is refused", () => {
    for (const key of [
      `${ACTOR}/previews/preview.pdf`,
      `${ACTOR}/previews/pv-1/deeper/preview.pdf`,
      `${ACTOR}/previews//preview.pdf`,
      `/${ACTOR}/previews/pv-1/preview.pdf`,
    ]) {
      expect(previewBelongsToActor(ACTOR, key), key).toBe(false)
    }
  })

  test("an empty actor id admits nothing", () => {
    // Otherwise a caller with no resolved session would match a key whose first
    // segment is the empty string.
    expect(previewBelongsToActor("", "/previews/pv-1/preview.pdf")).toBe(false)
  })
})
